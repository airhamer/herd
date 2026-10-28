/**
 * elephant-ai memory-health probe (S5.1a): read-only status checks for the
 * external AI-memory services — the Qdrant collections store (REST) and the
 * embedder. Pure and dependency-injected: every fetch goes through
 * `opts.fetchImpl`, so tests never touch the network and the production
 * caller (server/index.js GET /api/memory-health) passes global fetch.
 *
 * Lenient everywhere: a missing or malformed service is DATA, not an error.
 * No probe rejects; failures settle as `present: false` with a `reason`
 * ("unreachable" | "timeout" | "malformed" | "http-<code>" — same vocabulary
 * as guardProbe.js).
 *
 * Naming note: the fleet snapshot already uses a `memory` field for
 * per-node RAM MB; everything here is about AI-memory services, hence the
 * `memory-health` / `MemoryService` / `memoryHealth` naming throughout.
 */

/** Status vocabulary. Anything else the raw JSON carries becomes "unknown". */
const MEMORY_STATUSES = new Set(["ok", "degraded"]);

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * @typedef {Object} MemoryTarget one configured memory service.
 * @property {string} [id]
 * @property {string} [label]
 * @property {string} [kind] "qdrant" | "embedder" | anything-else (anything
 *   that is not "embedder" — including a missing kind — uses the qdrant probe
 *   order). Extra fields ignored.
 * @property {string} [baseUrl] origin without any path suffix.
 */

/**
 * @typedef {Object} MemoryServiceResult
 * @property {string|null} id
 * @property {string|null} label
 * @property {string|null} kind
 * @property {boolean} present true only for usable JSON with reason null.
 * @property {"ok"|"degraded"|"unknown"} status
 * @property {string|null} version non-empty string when the raw JSON carries one.
 * @property {number|null} modelCount array length from a successful /v1/models, else null.
 * @property {string} checkedAt ISO string from opts.now().
 * @property {string|null} reason null when present, else why the probe failed.
 */

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** /v1/models contract: object JSON carrying an array `data` field. */
const isModelsPayload = (v) => isObj(v) && Array.isArray(v.data);

/**
 * Status value from the raw `status` string: in-vocabulary words pass, other
 * strings become "unknown". A successful probe with NO usable status field
 * reports "ok": presence of valid JSON per the kind contract IS the health
 * signal for these services (Qdrant /health returns {status:"ok"}; the root
 * and /api/version payloads carry only version fields).
 *
 * @param {unknown} raw raw `status` field value.
 * @returns {"ok"|"degraded"|"unknown"}
 */
function normalizeStatusValue(raw) {
  if (typeof raw !== "string") return "ok";
  return MEMORY_STATUSES.has(raw) ? raw : "unknown";
}

/**
 * Pure: target + candidate JSON from a memory endpoint + probe reason → the
 * flat service shape. A non-null `reason` forces present:false even with
 * usable raw data; a missing reason with unusable raw data reports "malformed".
 *
 * @param {MemoryTarget} [target] source of id/label/kind pass-through.
 * @param {unknown} raw candidate JSON, or null when the probe produced none.
 * @param {{ reason?: string|null, now?: () => number }} [opts]
 * @returns {MemoryServiceResult}
 */
export function normalizeMemoryStatus(target, raw, opts = {}) {
  const { reason = null, now = Date.now } = opts;
  const usable = isObj(raw) && reason === null;
  // modelCount clamp: only an array `data` yields a count; junk → null.
  const modelCount =
    usable && Array.isArray(raw.data) && Number.isInteger(raw.data.length) && raw.data.length >= 0
      ? raw.data.length
      : null;
  const version = usable && typeof raw.version === "string" && raw.version ? raw.version : null;
  return {
    id: target?.id ?? null,
    label: target?.label ?? null,
    kind: target?.kind ?? null,
    present: usable,
    status: usable ? normalizeStatusValue(raw.status) : "unknown",
    version,
    modelCount,
    checkedAt: new Date(now()).toISOString(),
    reason: usable ? null : reason ?? "malformed",
  };
}

/**
 * Probe one memory service. Order by kind, first success wins:
 * - "qdrant" (and anything else, incl. missing kind): GET <baseUrl>/health
 *   (object JSON), else fallback GET <baseUrl>/ (root JSON carrying version).
 * - "embedder": GET <baseUrl>/v1/models (object JSON with array `data`),
 *   else fallback GET <baseUrl>/api/version (JSON carrying version).
 *
 * Never throws. Non-2xx / throw / timeout / bad JSON → reason
 * ("unreachable" | "timeout" | "malformed" | "http-<code>").
 *
 * @param {MemoryTarget} target
 * @param {{ fetchImpl: (url: string, init?: any) => Promise<any>, timeoutMs?: number, now?: () => number }} opts
 *   fetchImpl is REQUIRED (dependency injection); production passes
 *   globalThis.fetch. A missing fetchImpl or baseUrl settles as
 *   present:false reason "malformed" rather than throwing at the caller.
 * @returns {Promise<MemoryServiceResult>}
 */
export async function probeMemoryService(target, opts = {}) {
  const { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = opts;
  const baseUrl = typeof target?.baseUrl === "string" ? target.baseUrl.replace(/\/+$/, "") : "";
  if (!baseUrl || typeof fetchImpl !== "function") {
    return normalizeMemoryStatus(target, null, { reason: "malformed", now });
  }

  /** One GET; 2xx + JSON passing `accept` wins, anything else yields a reason. */
  async function attempt(url, accept = isObj) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
      if (!res?.ok) return { ok: false, reason: `http-${res?.status ?? 0}` };
      let data;
      try {
        data = await res.json();
      } catch {
        return { ok: false, reason: "malformed" };
      }
      if (!accept(data)) return { ok: false, reason: "malformed" };
      return { ok: true, data };
    } catch {
      return { ok: false, reason: controller.signal.aborted ? "timeout" : "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }

  const isEmbedder = target?.kind === "embedder";
  const primary = isEmbedder
    ? await attempt(`${baseUrl}/v1/models`, isModelsPayload)
    : await attempt(`${baseUrl}/health`);
  if (primary.ok) return normalizeMemoryStatus(target, primary.data, { now });
  const fallback = await attempt(isEmbedder ? `${baseUrl}/api/version` : `${baseUrl}/`);
  if (fallback.ok) return normalizeMemoryStatus(target, fallback.data, { now });
  return normalizeMemoryStatus(target, null, { reason: fallback.reason, now });
}

/**
 * Probe many services concurrently. Promise.allSettled wrapper: neither the
 * call nor any entry ever rejects, and order/ids of the list are preserved.
 * A probe that unexpectedly throws (e.g. a broken opts.now) becomes a
 * present:false entry with reason "unreachable" and a real-time checkedAt.
 *
 * @param {MemoryTarget[]} targets non-arrays are treated as empty.
 * @param {{ fetchImpl: (url: string, init?: any) => Promise<any>, timeoutMs?: number, now?: () => number }} opts
 * @returns {Promise<MemoryServiceResult[]>}
 */
export async function probeAllMemoryServices(targets, opts = {}) {
  const list = Array.isArray(targets) ? targets : [];
  const settled = await Promise.allSettled(list.map((target) => probeMemoryService(target, opts)));
  return settled.map((outcome, i) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : normalizeMemoryStatus(list[i], null, { reason: "unreachable" })
  );
}
