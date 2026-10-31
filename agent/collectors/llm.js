/**
 * llm.js — probe local LLM servers (sglang / ollama / vllm) over HTTP.
 *
 * LlmMetrics[] (Batch 1A working type; raw probe data, attached to the
 * snapshot as the extra `llm` property and mapped to VersionInfo[]).
 *
 * Detection order (mirrors sparkDash LlmProbe + B12b ollama extension):
 *   1. GET /get_server_info            → sglang (native endpoint)
 *   2. GET /api/version (+ /api/tags, /api/ps)
 *                                      → ollama (native API). MUST run before
 *      the OpenAI-compat check: ollama also serves /v1/models with
 *      owned_by=library, which would mis-detect as vllm.
 *   3. GET /v1/models (OpenAI-compat)  → vllm by default; STAT3 (#36) names
 *      ds4, q27, TensorFold, Splash, llama.cpp, Strata, EXL3, FreeToken,
 *      Locals and TabbyAPI from owned_by, their /metrics series, /health or
 *      /v1/stats, and ships each engine's raw counters (llmCounters.js).
 * Ollama probe failure (no /api/version) falls through to the vllm path.
 * Unreachable port → entry with backend: null (one entry per port).
 *
 * Auth: some LLM servers gate their info endpoints behind an api-key
 * (sglang --api-key, vllm --api-key). Pass opts.authTokens as a
 * Record<"port", token> and the probes for that port carry
 * `Authorization: Bearer <token>` (no token configured → no header).
 */

import {
  counterMeta,
  countersFromJson,
  countersFromPrometheus,
  engineFromPrometheus,
  getPromMetric,
} from "./llmCounters.js";

// STAT2 / STAT3: raw counter exports live in llmCounters.js.
export {
  ENGINE_COUNTER_KEYS,
  ENGINE_COUNTERS_SCHEMA,
  countersFromJson,
  countersFromPrometheus,
  engineCounters,
  engineFromPrometheus,
} from "./llmCounters.js";

const TIMEOUT_MS = 1500;

/**
 * Shorten a Hugging Face hub cache path to "org/name"
 * (ported from LlmProbe.normalizeModelId).
 * @param {unknown} id
 * @returns {string | null}
 */
export function normalizeModelId(id) {
  if (id == null) return null;
  const s = String(id).trim();
  if (!s) return null;
  const hub = s.match(/(?:^|\/)models--([^/]+?)(?:\/snapshots\/[^/]+)?\/?$/);
  if (hub) return hub[1].replace(/--/g, "/");
  const mid = s.match(/models--([^/]+)\/snapshots\//);
  if (mid) return mid[1].replace(/--/g, "/");
  return s;
}

/** True when `id` looks like a Hugging Face hub cache directory. */
export function isHfHubCachePath(id) {
  if (id == null) return false;
  return /(?:^|\/)models--[^/]+/.test(String(id));
}

/** @param {unknown} n */
function numOrNull(n) {
  const v = typeof n === "string" ? Number(n) : n;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Normalize a ports argument to unique valid port numbers.
 * @param {number | string | Array<number | string> | null | undefined} ports
 * @returns {number[]}
 */
export function normalizeLlmPorts(ports) {
  if (ports == null) return [];
  const items = Array.isArray(ports)
    ? ports.map(String)
    : String(ports).split(",").map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  /** @type {number[]} */
  const out = [];
  for (const item of items) {
    const n = Number(String(item).trim());
    if (Number.isInteger(n) && n >= 1 && n <= 65535 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * Parse per-port LLM auth tokens from the LLM_AUTH_TOKENS env value:
 * "8080:<token>,8000:<token2>" → { "8080": "<token>", "8000": "<token2>" }.
 * Malformed parts (bad port, empty token, missing colon) are skipped, never
 * thrown on. Empty/missing input → {}.
 * @param {string | null | undefined} raw
 * @returns {Record<string, string>} port (string) → bearer token
 */
export function parseLlmAuthTokens(raw) {
  /** @type {Record<string, string>} */
  const out = {};
  if (typeof raw !== "string" || raw.trim() === "") return out;
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (t === "") continue;
    const i = t.indexOf(":");
    if (i <= 0) continue;
    const port = Number(t.slice(0, i).trim());
    const token = t.slice(i + 1).trim();
    if (Number.isInteger(port) && port >= 1 && port <= 65535 && token !== "") {
      out[String(port)] = token;
    }
  }
  return out;
}

/** @returns {Record<string, any>} */
function defaultLlm(port) {
  return {
    port,
    backend: null,
    version: null,
    modelId: null,
    // ollama only: installed model ids (/api/tags) and the loaded subset
    // (/api/ps); null for every other backend.
    installedModels: null,
    loadedModels: null,
    modelPath: null,
    contextLength: null,
    gpuMemoryUtilization: null,
    requestsRunning: null,
    requestsWaiting: null,
    requestsFinished: null,
    kvCacheUsage: null,
    preemptionsTotal: null,
    prefixCacheHitRate: null,
    ttftP95Seconds: null,
    e2eP95Seconds: null,
    itlP95Seconds: null,
    mtpAcceptanceRate: null,
    // STAT2 (#35) / STAT3 (#36): raw cumulative engine counters for the
    // dashboard's windowed metrics (server/metrics/EngineWindow.js), every
    // key of ENGINE_COUNTER_KEYS present; null when the engine publishes none.
    engineCounters: null,
    // STAT3: { schema, source, monoMs, wallMs, bootId } of that counter read.
    engineCountersMeta: null,
  };
}

/**
 * Per-port bearer headers, or null when the port has no token.
 * @param {Record<string, string> | null | undefined} authTokens
 * @param {number} port
 * @returns {Record<string,string> | null}
 */
function portHeaders(authTokens, port) {
  const token = authTokens && typeof authTokens === "object" ? authTokens[String(port)] : null;
  if (typeof token !== "string" || token === "") return null;
  return { Authorization: `Bearer ${token}` };
}

/**
 * Fetch a URL and parse JSON; null on any failure (incl. non-2xx).
 * @param {(url: string, opts?: object) => Promise<any>} fetchFn
 * @param {string} url
 * @param {Record<string,string> | null} [headers]
 */
async function fetchJson(fetchFn, url, headers) {
  try {
    const res = await fetchFn(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(headers ? { headers } : {}),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

/**
 * Fetch a URL as text; null on any failure (incl. non-2xx).
 * @param {(url: string, opts?: object) => Promise<any>} fetchFn
 * @param {string} url
 * @param {Record<string,string> | null} [headers]
 */
async function fetchText(fetchFn, url, headers) {
  try {
    const res = await fetchFn(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(headers ? { headers } : {}),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * SGLang load: /v1/loads preferred, /get_load fallback.
 * @param {(url: string, opts?: object) => Promise<any>} fetchFn
 * @param {string} base
 * @param {Record<string,string> | null} [headers]
 * @returns {Promise<{running:number, waiting:number} | null>}
 */
async function fetchSglangLoad(fetchFn, base, headers) {
  for (const p of ["/v1/loads", "/get_load"]) {
    const data = await fetchJson(fetchFn, `${base}${p}`, headers);
    if (data == null) continue;
    const rows = Array.isArray(data)
      ? data
      : Array.isArray(data?.loads)
        ? data.loads
        : data?.num_reqs != null || data?.num_running_reqs != null
          ? [data]
          : null;
    if (!rows || rows.length === 0) continue;
    let running = 0;
    let waiting = 0;
    let saw = false;
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      const w = Number(r.num_waiting_reqs);
      if (Number.isFinite(w) && w >= 0) {
        waiting += w;
        saw = true;
      }
      const run = Number(r.num_running_reqs);
      if (Number.isFinite(run) && run >= 0) {
        running += run;
        saw = true;
      } else {
        const t = Number(r.num_reqs);
        if (Number.isFinite(t) && t >= 0) {
          running += Math.max(0, t - (Number.isFinite(w) && w >= 0 ? w : 0));
          saw = true;
        }
      }
    }
    if (saw) return { running, waiting };
  }
  return null;
}

// ─── Prometheus helpers (ported from sparkDash LlmProbe) ──────────────────

/**
 * Parse a Prometheus histogram (cumulative buckets, summed across label sets).
 * @param {string} body
 * @param {string} metricPrefix full bucket series prefix, e.g. "vllm:time_to_first_token_seconds"
 * @param {string} countMetricName full `_count` series name
 * @returns {{buckets: Array<{upper:number, count:number}>, total: number | null}}
 */
function parseHistogram(body, metricPrefix, countMetricName) {
  const esc = metricPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bucketRe = new RegExp(
    `^${esc}_bucket\\{[^}]*\\ble="([^"]+)"[^}]*\\}\\s+([\\d.eE+-]+)\\s*$`,
    "gm"
  );
  const byUpper = new Map();
  let infCount = 0;
  let m;
  while ((m = bucketRe.exec(body)) !== null) {
    const count = parseFloat(m[2]);
    if (!Number.isFinite(count)) continue;
    const le = m[1];
    const upper = le === "+Inf" ? Infinity : parseFloat(le);
    if (upper !== Infinity && !Number.isFinite(upper)) continue;
    if (upper === Infinity) infCount += count;
    byUpper.set(upper, (byUpper.get(upper) || 0) + count);
  }
  const total = getPromMetric(body, countMetricName);
  // Prometheus invariant: +Inf bucket count == _count. Mismatch → refuse quantile.
  if (total != null && infCount > 0 && Math.abs(infCount - total) > 1e-6) {
    return { buckets: [], total: null };
  }
  const buckets = Array.from(byUpper, ([upper, count]) => ({ upper, count }));
  buckets.sort((a, b) => a.upper - b.upper);
  return { buckets, total };
}

/**
 * Prometheus-style linear interpolation for a histogram quantile.
 * @param {Array<{upper:number, count:number}>} buckets
 * @param {number | null} total
 * @param {number} quantile
 * @returns {number | null}
 */
function histogramQuantile(buckets, total, quantile) {
  if (!buckets || !buckets.length || total == null || total <= 0) return null;
  const target = total * quantile;
  let prevUpper = 0.0;
  let prevCount = 0.0;
  for (const { upper, count } of buckets) {
    if (count >= target) {
      if (!Number.isFinite(upper)) return null;
      if (count === prevCount) return upper;
      return prevUpper + (upper - prevUpper) * ((target - prevCount) / (count - prevCount));
    }
    prevUpper = upper;
    prevCount = count;
  }
  return null;
}

/**
 * P95 (seconds, 3-decimal) of a vllm-prefixed histogram; null when absent.
 * @param {string} txt
 * @param {string} name full metric name incl. "vllm:" prefix
 */
function histogramP95(txt, name) {
  const hist = parseHistogram(txt, name, `${name}_count`);
  const q = histogramQuantile(hist.buckets, hist.total, 0.95);
  return q == null ? null : Math.round(q * 1000) / 1000;
}

/** Apply stock vLLM /metrics tiles. @param {object} m LlmMetrics; @param {string} txt */
function applyVllmMetrics(m, txt) {
  m.kvCacheUsage = getPromMetric(txt, "vllm:kv_cache_usage_perc");
  m.requestsRunning = getPromMetric(txt, "vllm:num_requests_running");
  m.requestsWaiting = getPromMetric(txt, "vllm:num_requests_waiting");
  // Finished counter: vLLM's request_success_total (summed over all
  // finished_reason label sets — completed + aborted + errored requests).
  m.requestsFinished = getPromMetric(txt, "vllm:request_success_total");
  m.preemptionsTotal = getPromMetric(txt, "vllm:num_preemptions_total");
  const hits = getPromMetric(txt, "vllm:prefix_cache_hits_total");
  const queries = getPromMetric(txt, "vllm:prefix_cache_queries_total");
  m.prefixCacheHitRate =
    hits != null && queries != null && queries > 0
      ? Math.round((hits / queries) * 10000) / 10000
      : null;
  m.ttftP95Seconds = histogramP95(txt, "vllm:time_to_first_token_seconds");
  m.e2eP95Seconds = histogramP95(txt, "vllm:e2e_request_latency_seconds");
  m.itlP95Seconds = histogramP95(txt, "vllm:inter_token_latency_seconds");
  const accepted = getPromMetric(txt, "vllm:spec_decode_num_accepted_tokens_total");
  const drafted = getPromMetric(txt, "vllm:spec_decode_num_draft_tokens_total");
  m.mtpAcceptanceRate =
    accepted != null && drafted != null && drafted > 0
      ? Math.round((accepted / drafted) * 10000) / 10000
      : null;
}

/**
 * Apply SGLang /get_server_info fields.
 * @param {object} m LlmMetrics
 * @param {object} sg parsed server-info payload
 */
function applySglangInfo(m, sg) {
  if (sg.model_path != null && String(sg.model_path).trim()) {
    const s = String(sg.model_path).trim();
    m.modelPath = isHfHubCachePath(s) ? null : s;
    let id = normalizeModelId(s);
    if (id && id.startsWith("/")) id = id.split("/").pop(); // abs path → leaf name
    m.modelId = id;
  }
  m.contextLength = numOrNull(sg.context_length) ?? numOrNull(sg.max_total_tokens);
  if (sg.version != null) m.version = String(sg.version);
  m.gpuMemoryUtilization = numOrNull(sg.mem_fraction_static);
}

/**
 * Apply vLLM /v1/models first entry.
 * @param {object} m LlmMetrics
 * @param {object} model
 */
function applyVllmModel(m, model) {
  if (model?.id != null && String(model.id).trim()) {
    const s = String(model.id).trim();
    m.modelPath = isHfHubCachePath(s) ? null : s;
    let id = normalizeModelId(s);
    if (id && id.startsWith("/")) id = id.split("/").pop();
    m.modelId = id;
  }
  m.contextLength = numOrNull(model?.max_model_len ?? model?.context_length);
}

// ─── STAT3: engine identification and raw counters ────────────────────────

/** @param {unknown} v */
function isObj(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** owned_by values that name an engine (case-insensitive). */
const OWNED_BY_ENGINE = Object.freeze({
  tensorfold: "tensorfold",
  freetoken: "freetoken",
  locals: "locals",
  splash: "splash",
  strata: "strata",
  tabbyapi: "tabbyapi",
  llamacpp: "llama.cpp",
  "llama.cpp": "llama.cpp",
  q27: "q27",
  exl3: "exl3",
  "ds4.c": "ds4",
  ds4: "ds4",
  vllm: "vllm",
});

/**
 * @param {unknown} ownedBy
 * @returns {string | null}
 */
export function backendFromOwnedBy(ownedBy) {
  if (typeof ownedBy !== "string") return null;
  return OWNED_BY_ENGINE[ownedBy.trim().toLowerCase()] ?? null;
}

/** JSON body of a text page, or null when it is not a JSON object. */
function parseJsonText(txt) {
  if (typeof txt !== "string" || !/^\s*\{/.test(txt)) return null;
  try {
    const v = JSON.parse(txt);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** Strata JSON /metrics: { live: {...}, totals?: {...} }. */
function isStrataMetrics(v) {
  return isObj(v) && isObj(v.live);
}

/** FreeToken /v1/stats: throughput + requests objects. */
function looksLikeFreeTokenStats(v) {
  return isObj(v) && isObj(v.throughput) && isObj(v.requests);
}

/**
 * @param {Record<string, any>} m
 * @param {Record<string, number|null> | null} counters
 * @param {"prometheus"|"json"} source
 * @param {object} [clock]
 */
function setCounters(m, counters, source, clock) {
  m.engineCounters = counters;
  m.engineCountersMeta = counters ? counterMeta(source, clock) : null;
}

/**
 * Raw counters (and the levels the same page carries) for an OpenAI-compatible
 * engine. Pages already fetched for identification are reused.
 * @param {Record<string, any>} m
 * @param {{ txt: string|null, pageJson: object|null, health: unknown, stats: unknown,
 *   fetchFn: Function, base: string, headers: Record<string,string>|null, clock?: object }} ctx
 */
async function applyEngineCounters(m, ctx) {
  const { txt, pageJson, fetchFn, base, headers, clock } = ctx;
  switch (m.backend) {
    case "vllm":
      if (txt) {
        applyVllmMetrics(m, txt);
        setCounters(m, countersFromPrometheus("vllm", txt), "prometheus", clock);
      }
      return;
    case "ds4":
    case "q27":
    case "splash":
    case "llama.cpp":
      if (txt) {
        applyPromLevels(m, txt);
        setCounters(m, countersFromPrometheus(m.backend, txt), "prometheus", clock);
      }
      return;
    case "tensorfold": {
      // CUDA build: JSON totals on /health; native build: tensorfold:* series.
      const fromHealth = countersFromJson("tensorfold", ctx.health);
      if (fromHealth) setCounters(m, fromHealth, "json", clock);
      else if (txt) setCounters(m, countersFromPrometheus("tensorfold", txt), "prometheus", clock);
      if (txt) applyPromLevels(m, txt);
      return;
    }
    case "exl3": {
      const h = ctx.health;
      if (isObj(h)) {
        if (typeof h.busy === "boolean") m.requestsRunning = h.busy ? 1 : 0;
        if (m.contextLength == null) m.contextLength = numOrNull(h.context_length);
        setCounters(m, countersFromJson("exl3", h), "json", clock);
      }
      return;
    }
    case "strata": {
      const met = isStrataMetrics(pageJson) ? pageJson : parseJsonText(await fetchText(fetchFn, `${base}/metrics`, headers));
      if (isObj(met)) {
        const live = isObj(met.live) ? met.live : {};
        m.requestsRunning = numOrNull(live.running);
        m.requestsWaiting = numOrNull(live.waiting) ?? numOrNull(live.queued);
        setCounters(m, countersFromJson("strata", met), "json", clock);
      }
      return;
    }
    case "freetoken": {
      const st = ctx.stats !== undefined ? ctx.stats : await fetchJson(fetchFn, `${base}/v1/stats`, headers);
      if (looksLikeFreeTokenStats(st)) {
        m.requestsRunning = numOrNull(st.requests.active);
        const kv = isObj(st.kv) ? st.kv : {};
        const used = numOrNull(kv.used_pages);
        const total = numOrNull(kv.total_pages);
        m.kvCacheUsage = used != null && total != null && total > 0 ? used / total : null;
        setCounters(m, countersFromJson("freetoken", st), "json", clock);
      }
      return;
    }
    case "locals": {
      const st = await fetchJson(fetchFn, `${base}/stats`, headers);
      if (isObj(st)) {
        if (Array.isArray(st.active)) m.requestsRunning = st.active.length;
        setCounters(m, countersFromJson("locals", st), "json", clock);
      }
      return;
    }
    default:
      // tabbyapi: totals need an admin key; label only.
      return;
  }
}

/**
 * Running / waiting / KV gauges from the non-vLLM Prometheus engines.
 * @param {Record<string, any>} m
 * @param {string} txt
 */
function applyPromLevels(m, txt) {
  const g = (n) => getPromMetric(txt, n);
  switch (m.backend) {
    case "ds4":
      m.requestsRunning = g("ds4_requests_inflight");
      return;
    case "q27":
      m.requestsRunning = g("q27_requests_inflight");
      m.kvCacheUsage = g("q27_kv_usage_perc");
      m.preemptionsTotal = g("q27_preemptions_total");
      return;
    case "splash": {
      const pre = g("splash_scheduler_prefilling");
      const dec = g("splash_scheduler_decoding");
      m.requestsRunning = pre != null || dec != null ? (pre ?? 0) + (dec ?? 0) : null;
      m.requestsWaiting = g("splash_scheduler_queued");
      return;
    }
    case "llama.cpp":
      m.requestsRunning = g("llamacpp:requests_processing");
      m.requestsWaiting = g("llamacpp:requests_deferred");
      m.kvCacheUsage = g("llamacpp:kv_cache_usage_ratio");
      return;
    case "tensorfold": {
      m.requestsRunning = g("tensorfold:requests_running");
      m.requestsWaiting = g("tensorfold:requests_waiting");
      return;
    }
    default:
      return;
  }
}

/**
 * Probe one port; always resolves (backend: null when unreachable).
 * @param {number} port
 * @param {(url: string, opts?: object) => Promise<any>} fetchFn
 * @returns {Promise<Record<string, any>>}
 */
async function probePort(port, fetchFn, headers, clock) {
  const base = `http://127.0.0.1:${port}`;
  const m = defaultLlm(port);
  try {
    // 1. SGLang native endpoint
    const sg = await fetchJson(fetchFn, `${base}/get_server_info`, headers);
    if (sg && typeof sg === "object" && !Array.isArray(sg)) {
      m.backend = "sglang";
      applySglangInfo(m, sg);
      const load = await fetchSglangLoad(fetchFn, base, headers);
      m.requestsRunning = load?.running ?? null;
      m.requestsWaiting = load?.waiting ?? null;
      // Prometheus is optional on SGLang (--enable-metrics).
      const txt = await fetchText(fetchFn, `${base}/metrics`, headers);
      if (txt) {
        setCounters(m, countersFromPrometheus("sglang", txt), "prometheus", clock);
        const kv = getPromMetric(txt, "sglang:token_usage") ?? getPromMetric(txt, "sglang_token_usage");
        if (kv != null && m.kvCacheUsage == null) m.kvCacheUsage = kv;
      }
      return m;
    }

    // 2. Ollama native API (before the OpenAI-compat branch: ollama's
    //    /v1/models reports owned_by=library and would mis-detect as vllm).
    const ver = await fetchJson(fetchFn, `${base}/api/version`, headers);
    if (
      ver &&
      typeof ver === "object" &&
      !Array.isArray(ver) &&
      typeof ver.version === "string" &&
      ver.version.trim() !== ""
    ) {
      m.backend = "ollama";
      m.version = ver.version.trim();
      const tags = await fetchJson(fetchFn, `${base}/api/tags`, headers);
      const ps = await fetchJson(fetchFn, `${base}/api/ps`, headers);
      const names = (payload) =>
        Array.isArray(payload?.models)
          ? payload.models
              .map((mo) => (mo && typeof mo.name === "string" ? mo.name.trim() : ""))
              .filter(Boolean)
          : [];
      m.installedModels = names(tags);
      m.loadedModels = names(ps).filter((id) => m.installedModels.includes(id));
      m.modelId = m.loadedModels[0] ?? m.installedModels[0] ?? null;
      return m;
    }

    // 3. OpenAI-compatible: vLLM by default; STAT3 tells the other engines
    //    apart (owned_by, then their /metrics series, then /health or
    //    /v1/stats) so each ships its own raw counters.
    const models = await fetchJson(fetchFn, `${base}/v1/models`, headers);
    const model = models?.data?.[0];
    if (model && typeof model === "object") {
      applyVllmModel(m, model);
      const page = await fetchText(fetchFn, `${base}/metrics`, headers);
      const pageJson = parseJsonText(page);
      const txt = pageJson == null ? page : null;
      let backend = backendFromOwnedBy(model.owned_by) ?? engineFromPrometheus(txt);
      if (backend == null && isStrataMetrics(pageJson)) backend = "strata";
      /** @type {unknown} */
      let health;
      if (backend == null || backend === "exl3" || backend === "tensorfold") {
        health = await fetchJson(fetchFn, `${base}/health`, headers);
        if (backend == null) {
          if (isObj(health) && health.service === "strata") backend = "strata";
          else if (isObj(health) && (health.backend === "exl3" || (health.ok === true && typeof health.busy === "boolean"))) {
            backend = "exl3";
          }
        }
      }
      /** @type {unknown} */
      let stats;
      if (backend == null || backend === "freetoken") {
        stats = await fetchJson(fetchFn, `${base}/v1/stats`, headers);
        if (backend == null && looksLikeFreeTokenStats(stats)) backend = "freetoken";
      }
      m.backend = backend ?? "vllm";
      await applyEngineCounters(m, { txt, pageJson, health, stats, fetchFn, base, headers, clock });
      return m;
    }

    return m; // unreachable / unknown
  } catch {
    return m;
  }
}

/**
 * Probe LLM servers over HTTP.
 * @param {number | string | Array<number | string>} ports
 * @param {{
 *   fetch?: (url: string, opts?: object) => Promise<any>,
 *   authTokens?: Record<string, string>,
 *   clock?: { monoNow?: () => number, wallNow?: () => number, bootId?: string }
 * }} [opts]  `clock` is a test hook for engineCountersMeta.
 * @returns {Promise<Array<Record<string, any>>>} one entry per port; [] when no valid port
 */
export async function collectLlm(ports, { fetch: fetchFn = fetch, authTokens = null, clock = undefined } = {}) {
  const portList = normalizeLlmPorts(ports);
  if (portList.length === 0) return [];
  return Promise.all(portList.map((port) => probePort(port, fetchFn, portHeaders(authTokens, port), clock)));
}
