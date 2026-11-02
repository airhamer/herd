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

// ─── Guard / keepalive proxy (GUARD1 #95) ─────────────────────────────────
//
// Different animal from the S4.1a guards above: this probes a keepalive proxy
// that FRONTS an LLM engine (gx10-1c2c:8081 in the fleet — engine behind it on
// 127.0.0.1:8080). The proxy answers GET /health (fallback GET /) and may or
// may not expose metrics. Following the SRV1 (#93) probe-truth convention, an
// auth-gate reply (401/403) from the proxy is ALIVE: the gate rejecting us
// still proves the process behind it answers.

/**
 * @typedef {Object} GuardProxyTarget one configured guard proxy.
 * @property {string} [id]
 * @property {string} [label]
 * @property {string} [baseUrl] origin without path suffix, e.g. http://192.168.50.226:8081
 * @property {string} [apiKeyRef] "env:VAR" / "file:/path" secret ref (never a
 *   raw key); resolved through opts.resolveApiKeyRef when probing.
 */

/**
 * @typedef {Object} GuardProxyEngine engine-behind-proxy lookup result.
 * @property {string|null} sparkId
 * @property {string|null} name service name on that spark
 * @property {string|null} engine engine label (e.g. "vllm")
 * @property {string|null} model served model when the SRV1 probe chain saw one
 * @property {number|null} enginePort the engine's own port
 */

/**
 * @typedef {Object} GuardProxyResult
 * @property {string|null} id
 * @property {string|null} label
 * @property {string|null} baseUrl the trimmed base URL, null when unusable
 * @property {boolean} present an endpoint answered (2xx or auth-gate)
 * @property {boolean} alive same as present; explicit for the panel badge
 * @property {boolean} authGate true when liveness came from a 401/403 gate
 * @property {"alive"|"down"|"not-configured"} status
 * @property {number|null} uptimeSeconds when the proxy body exposes uptime
 * @property {number|null} requestCount recent/total request count when exposed
 * @property {boolean} hasMetrics true when at least one metric was readable
 * @property {GuardProxyEngine|null} engine attached by the route (SRV1 chain)
 * @property {string} checkedAt ISO string from opts.now().
 * @property {string|null} reason null when alive, else "not-configured" /
 *   "unreachable" | "timeout" | "malformed" | "http-<code>".
 */

/** First numeric field wins; uptime fields are seconds by convention. */
const UPTIME_FIELDS = ["uptimeSeconds", "uptime_seconds", "uptime"];
/** Recent-count fields are checked before total-count fields. */
const REQUEST_COUNT_FIELDS = [
  "recentRequests",
  "recent_requests",
  "requestsRecent",
  "requests_recent",
  "requestCount",
  "request_count",
  "requests",
  "requestsTotal",
  "requests_total",
  "requestCountTotal",
];

/** First finite, non-negative number among `fields` of raw, else null. */
function pickMetric(raw, fields) {
  if (!isObj(raw)) return null;
  for (const field of fields) {
    const value = raw[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/**
 * Outcome → GuardProxyResult. `outcome` describes one probe pass:
 * { alive, authGate, body } when an endpoint answered, or { reason } when
 * neither /health nor / produced a usable reply. Pure, no fetch.
 *
 * @param {GuardProxyTarget} [target]
 * @param {{ alive?: boolean, authGate?: boolean, body?: unknown, reason?: string|null }} [outcome]
 * @param {{ now?: () => number }} [opts]
 * @returns {GuardProxyResult}
 */
export function normalizeGuardProxyStatus(target, outcome = {}, opts = {}) {
  const { now = Date.now } = opts;
  const baseUrl =
    typeof target?.baseUrl === "string" && target.baseUrl.trim()
      ? target.baseUrl.trim().replace(/\/+$/, "")
      : null;
  const alive = Boolean(outcome.alive);
  const authGate = alive && Boolean(outcome.authGate);
  // Metrics only come from a readable 2xx body; an auth-gate proves liveness
  // only, so the panel shows "no metrics endpoint" in that case.
  const uptimeSeconds = alive && !authGate ? pickMetric(outcome.body, UPTIME_FIELDS) : null;
  const requestCount = alive && !authGate ? pickMetric(outcome.body, REQUEST_COUNT_FIELDS) : null;
  const reason = alive ? null : outcome.reason ?? "unreachable";
  return {
    id: target?.id ?? null,
    label: target?.label ?? null,
    baseUrl,
    present: alive,
    alive,
    authGate,
    status: alive ? "alive" : baseUrl === null ? "not-configured" : "down",
    uptimeSeconds,
    requestCount,
    hasMetrics: alive && (uptimeSeconds !== null || requestCount !== null),
    engine: null,
    checkedAt: new Date(now()).toISOString(),
    reason,
  };
}

/**
 * Probe the configured guard/keepalive proxy: GET <baseUrl>/health first,
 * 401/403 count as alive (auth-gate, SRV1 convention); on any other failure
 * fall back to GET <baseUrl>/ and score that the same way. 2xx with a
 * non-JSON or array body still proves liveness — metrics are simply absent.
 * Never throws; never rejects. A missing baseUrl settles as
 * status "not-configured" reason "not-configured" (the panel's empty state).
 *
 * @param {GuardProxyTarget} target
 * @param {{ fetchImpl: (url: string, init?: any) => Promise<any>, timeoutMs?: number, now?: () => number,
 *   resolveApiKeyRef?: (ref: string|null|undefined, deps?: any) => string|null, env?: any, readFile?: any }} opts
 *   fetchImpl is REQUIRED (dependency injection); production passes
 *   globalThis.fetch. resolveApiKeyRef ("env:VAR"/"file:/path", same shapes as
 *   the SRV1 proxy keys) resolves target.apiKeyRef into a bearer token.
 * @returns {Promise<GuardProxyResult>}
 */
export async function probeKeepaliveProxy(target, opts = {}) {
  const { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now, resolveApiKeyRef } = opts;
  const base = normalizeGuardProxyStatus(target, { reason: "not-configured" }, { now });
  const baseUrl = base.baseUrl;
  if (!baseUrl || typeof fetchImpl !== "function") return base;

  let apiKey = null;
  if (typeof target?.apiKeyRef === "string" && target.apiKeyRef.trim() && resolveApiKeyRef) {
    try {
      apiKey = resolveApiKeyRef(target.apiKeyRef, opts) ?? null;
    } catch {
      apiKey = null;
    }
  }

  /** One GET → {alive,authGate,body} | {reason}. Never throws. */
  async function attempt(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { accept: "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetchImpl(url, { signal: controller.signal, headers });
      if (res?.status === 401 || res?.status === 403) return { alive: true, authGate: true };
      if (!res?.ok) return { reason: `http-${res?.status ?? 0}` };
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null; // alive, just no parseable metrics
      }
      return { alive: true, authGate: false, body };
    } catch {
      return { reason: controller.signal.aborted ? "timeout" : "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }

  const health = await attempt(`${baseUrl}/health`);
  if (health.alive) return normalizeGuardProxyStatus(target, health, { now });
  const root = await attempt(`${baseUrl}/`);
  return normalizeGuardProxyStatus(target, root, { now });
}

/**
 * Pure: find the engine a proxy fronts using data the fleet already has —
 * monitor snapshots carrying SRV1 service-truth rows (name/engine/model/port/
 * proxyPort, see SparkMonitor.probeServicesNow). A snapshot service whose
 * proxyPort equals the proxy's port is the engine behind it. Snapshots whose
 * lanIp/host matches the proxy host win over port-only matches.
 *
 * @param {Array<{id?: string, lanIp?: string, host?: string, services?: unknown[]}>>} snapshots
 * @param {{ port: number, host?: string|null }} target port from the proxy URL
 * @returns {GuardProxyEngine|null}
 */
export function findEngineBehindProxy(snapshots, target) {
  const port = Number.isInteger(target?.port) ? target.port : null;
  if (port == null) return null;
  const host = typeof target?.host === "string" && target.host ? target.host : null;
  let firstPortMatch = null;
  for (const snap of Array.isArray(snapshots) ? snapshots : []) {
    for (const svc of Array.isArray(snap?.services) ? snap.services : []) {
      if (svc?.proxyPort !== port) continue;
      const row = {
        sparkId: typeof snap?.id === "string" ? snap.id : null,
        name: typeof svc?.name === "string" && svc.name ? svc.name : null,
        engine: typeof svc?.engine === "string" && svc.engine ? svc.engine : null,
        model: typeof svc?.model === "string" && svc.model ? svc.model : null,
        enginePort: Number.isInteger(svc?.port) ? svc.port : null,
      };
      const hostMatches =
        host != null &&
        [snap?.lanIp, snap?.host].some((v) => typeof v === "string" && v && v === host);
      if (hostMatches) return row;
      firstPortMatch ??= row;
    }
  }
  return firstPortMatch;
}
