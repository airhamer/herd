/**
 * Guard-proxy probe (S4.1a): read-only status checks for the external guard
 * processes that front LLM endpoints. Pure and dependency-injected: every
 * fetch goes through `opts.fetchImpl`, so tests never touch the network and
 * the production caller (server/index.js GET /api/guard) passes global fetch.
 *
 * Lenient everywhere: a missing or malformed guard is DATA, not an error.
 * No probe rejects; failures settle as `present: false` with a `reason`
 * ("unreachable" | "timeout" | "malformed" | "http-<code>").
 */

/** Normalized status vocabulary. Anything else becomes "unknown". */
const GUARD_STATUSES = new Set(["running", "degraded", "stopped"]);

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * @typedef {Object} GuardEndpoint one configured guard.
 * @property {string} [id]
 * @property {string} [label]
 * @property {string} [baseUrl] origin without the /guard/status suffix; extra fields ignored.
 */

/**
 * @typedef {Object} GuardTimelineEntry
 * @property {string|null} at ISO-ish timestamp, null when unusable.
 * @property {string|null} kind
 * @property {string|null} detail
 */

/**
 * @typedef {Object} GuardResult
 * @property {string|null} id
 * @property {string|null} label
 * @property {boolean} present
 * @property {"running"|"degraded"|"stopped"|"unknown"} status
 * @property {number|null} heldRequests count ≥ 0, null when absent/malformed.
 * @property {GuardTimelineEntry[]} crashTimeline
 * @property {string} checkedAt ISO string from opts.now().
 * @property {string|null} reason null when present, else why the probe failed.
 */

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** @param {unknown} raw @returns {string} one of the four status values. */
function normalizeStatus(raw) {
  return typeof raw === "string" && GUARD_STATUSES.has(raw) ? raw : "unknown";
}

/** @param {unknown} raw @returns {number|null} count when finite and ≥ 0. */
function normalizeHeld(raw) {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/**
 * One timeline entry → {at, kind, detail} with coerced fields, or null to drop.
 * Dropped: non-objects and entries with neither a usable `at` nor a `kind`.
 */
function coerceTimelineEntry(entry) {
  if (!isObj(entry)) return null;
  const at =
    typeof entry.at === "string" && entry.at ? entry.at
    : typeof entry.at === "number" && Number.isFinite(entry.at) ? new Date(entry.at).toISOString()
    : null;
  const kind = typeof entry.kind === "string" && entry.kind ? entry.kind : null;
  const detail = typeof entry.detail === "string" && entry.detail ? entry.detail : null;
  if (at === null && kind === null) return null;
  return { at, kind, detail };
}

/**
 * Pure: raw candidate JSON from a guard endpoint + probe reason → the flat
 * fleet shape. A non-null `reason` forces present:false even with usable raw
 * data; a missing reason with unusable raw data reports "malformed".
 *
 * @param {GuardEndpoint} [endpoint] source of id/label pass-through.
 * @param {unknown} raw candidate JSON, or null when the probe produced none.
 * @param {{ reason?: string|null, now?: () => number }} [opts]
 * @returns {GuardResult}
 */
export function normalizeGuardStatus(endpoint, raw, opts = {}) {
  const { reason = null, now = Date.now } = opts;
  const usable = isObj(raw) && reason === null;
  return {
    id: endpoint?.id ?? null,
    label: endpoint?.label ?? null,
    present: usable,
    status: usable ? normalizeStatus(raw.status) : "unknown",
    heldRequests: usable ? normalizeHeld(raw.heldRequests) : null,
    crashTimeline: usable && Array.isArray(raw.crashTimeline)
      ? raw.crashTimeline.map(coerceTimelineEntry).filter(Boolean)
      : [],
    checkedAt: new Date(now()).toISOString(),
    reason: usable ? null : reason ?? "malformed",
  };
}

/**
 * Probe one guard endpoint: GET <baseUrl>/guard/status first; on any failure
 * fall back to GET <baseUrl>/health and use only its `status`. Never throws.
 *
 * @param {GuardEndpoint} endpoint
 * @param {{ fetchImpl: (url: string, init?: any) => Promise<any>, timeoutMs?: number, now?: () => number }} opts
 *   fetchImpl is REQUIRED (dependency injection); production passes
 *   globalThis.fetch. A missing fetchImpl or baseUrl settles as
 *   present:false reason "malformed" rather than throwing at the caller.
 * @returns {Promise<GuardResult>}
 */
export async function probeGuard(endpoint, opts = {}) {
  const { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = opts;
  const baseUrl = typeof endpoint?.baseUrl === "string" ? endpoint.baseUrl.replace(/\/+$/, "") : "";
  if (!baseUrl || typeof fetchImpl !== "function") {
    return normalizeGuardStatus(endpoint, null, { reason: "malformed", now });
  }

  /** One GET; 2xx + object JSON wins, anything else yields a reason. */
  async function attempt(url) {
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
      if (!isObj(data)) return { ok: false, reason: "malformed" };
      return { ok: true, data };
    } catch {
      return { ok: false, reason: controller.signal.aborted ? "timeout" : "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }

  const primary = await attempt(`${baseUrl}/guard/status`);
  if (primary.ok) return normalizeGuardStatus(endpoint, primary.data, { now });
  const fallback = await attempt(`${baseUrl}/health`);
  if (fallback.ok) return normalizeGuardStatus(endpoint, { status: fallback.data.status }, { now });
  return normalizeGuardStatus(endpoint, null, { reason: fallback.reason, now });
}

/**
 * Probe many endpoints concurrently. Promise.allSettled wrapper: neither the
 * call nor any entry ever rejects, and order/ids of the list are preserved.
 * A probe that unexpectedly throws (e.g. a broken opts.now) becomes a
 * present:false entry with reason "unreachable" and a real-time checkedAt.
 *
 * @param {GuardEndpoint[]} endpoints non-arrays are treated as empty.
 * @param {{ fetchImpl: (url: string, init?: any) => Promise<any>, timeoutMs?: number, now?: () => number }} opts
 * @returns {Promise<GuardResult[]>}
 */
export async function probeAll(endpoints, opts = {}) {
  const list = Array.isArray(endpoints) ? endpoints : [];
  const settled = await Promise.allSettled(list.map((endpoint) => probeGuard(endpoint, opts)));
  return settled.map((outcome, i) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : normalizeGuardStatus(list[i], null, { reason: "unreachable" })
  );
}
