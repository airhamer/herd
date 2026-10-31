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
 *   3. GET /v1/models (OpenAI-compat)  → vllm (owned_by signal / /metrics)
 * Ollama probe failure (no /api/version) falls through to the vllm path.
 * Unreachable port → entry with backend: null (one entry per port).
 *
 * Auth: some LLM servers gate their info endpoints behind an api-key
 * (sglang --api-key, vllm --api-key). Pass opts.authTokens as a
 * Record<"port", token> and the probes for that port carry
 * `Authorization: Bearer <token>` (no token configured → no header).
 */

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
    // STAT2 (#35): raw cumulative engine counters for the dashboard's
    // windowed metrics (server/metrics/EngineWindow.js). null when the
    // engine serves no Prometheus page.
    engineCounters: null,
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
 * Sum all Prometheus series matching `name` (optional label sets).
 * @param {string} body
 * @param {string} name
 * @returns {number | null}
 */
function getPromMetric(body, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)\\s*$`, "gm");
  let sum = 0;
  let found = false;
  let m;
  while ((m = re.exec(body)) !== null) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v)) {
      sum += v;
      found = true;
    }
  }
  return found ? sum : null;
}

/**
 * Sum of `name` over the series whose `key` label equals `value`.
 * @param {string} body
 * @param {string} name
 * @param {string} key
 * @param {string} value
 * @returns {number | null}
 */
function getPromMetricWhere(body, name, key, value) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc}\\{([^}]*)\\}\\s+([\\d.eE+-]+)\\s*$`, "gm");
  const want = `${key}="${value}"`;
  let sum = 0;
  let found = false;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (!m[1].split(",").some((l) => l.trim() === want)) continue;
    const v = parseFloat(m[2]);
    if (Number.isFinite(v)) {
      sum += v;
      found = true;
    }
  }
  return found ? sum : null;
}

/**
 * STAT2 (#35): the cumulative counters the dashboard's EngineWindow
 * differences, under its engine-neutral names. Metric names follow
 * hasso5703's dashboard (dgx-spark-qwen38, dashboard/engine_metrics.py, MIT;
 * notice in server/collectors/llmEngines.js). null when the page carries no
 * engine counter at all.
 * @param {"vllm"|"sglang"} engine
 * @param {string} txt
 * @returns {Record<string, number|null> | null}
 */
export function engineCounters(engine, txt) {
  if (!txt) return null;
  /** @type {Record<string, number|null>} */
  let out;
  if (engine === "vllm") {
    const v = (n) => getPromMetric(txt, `vllm:${n}`);
    const generated = v("generation_tokens_total");
    const ttftCount = v("time_to_first_token_seconds_count");
    out = {
      generated,
      prompt: v("prompt_tokens_total"),
      cached: v("prompt_tokens_cached_total"),
      // ITL count is steps: decoded = generated less the first tokens.
      decoded: generated,
      first: ttftCount,
      itlSum: v("inter_token_latency_seconds_sum"),
      prefillComputed: v("request_prefill_kv_computed_tokens_sum"),
      prefillSeconds: v("request_prefill_time_seconds_sum"),
      queueSum: v("request_queue_time_seconds_sum"),
      queueCount: v("request_queue_time_seconds_count"),
      ttftSum: v("time_to_first_token_seconds_sum"),
      ttftCount,
      specAccepted: v("spec_decode_num_accepted_tokens_total"),
      specDrafts: v("spec_decode_num_drafts_total"),
      specVerify: null,
      idleSeconds: null,
    };
  } else {
    const v = (n) => getPromMetric(txt, `sglang:${n}`) ?? getPromMetric(txt, `sglang_${n}`);
    const w = (n, k, val) =>
      getPromMetricWhere(txt, `sglang:${n}`, k, val) ?? getPromMetricWhere(txt, `sglang_${n}`, k, val);
    const decoded = v("inter_token_latency_seconds_count");
    out = {
      generated: v("generation_tokens_total"),
      prompt: v("prompt_tokens_total"),
      cached: w("cached_tokens_total", "cache_source", "device") ?? v("cached_tokens_total"),
      // ITL count is already tokens and holds no first tokens.
      decoded,
      first: decoded == null ? null : 0,
      itlSum: v("inter_token_latency_seconds_sum"),
      prefillComputed: w("realtime_tokens_total", "mode", "prefill_compute"),
      prefillSeconds: w("per_stage_req_latency_seconds_sum", "stage", "prefill_forward"),
      queueSum: v("queue_time_seconds_sum"),
      queueCount: v("queue_time_seconds_count"),
      ttftSum: v("time_to_first_token_seconds_sum"),
      ttftCount: v("time_to_first_token_seconds_count"),
      specAccepted: null,
      specDrafts: null,
      specVerify: v("spec_verify_calls_total"),
      idleSeconds: v("scheduler_idle_seconds_total"),
    };
  }
  return Object.values(out).some((x) => x != null) ? out : null;
}

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

/**
 * Probe one port; always resolves (backend: null when unreachable).
 * @param {number} port
 * @param {(url: string, opts?: object) => Promise<any>} fetchFn
 * @returns {Promise<Record<string, any>>}
 */
async function probePort(port, fetchFn, headers) {
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
        m.engineCounters = engineCounters("sglang", txt);
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

    // 3. OpenAI-compatible (vLLM)
    const models = await fetchJson(fetchFn, `${base}/v1/models`, headers);
    const model = models?.data?.[0];
    if (model && typeof model === "object") {
      m.backend = "vllm";
      applyVllmModel(m, model);
      const txt = await fetchText(fetchFn, `${base}/metrics`, headers);
      if (txt) {
        applyVllmMetrics(m, txt);
        m.engineCounters = engineCounters("vllm", txt);
      }
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
 *   authTokens?: Record<string, string>
 * }} [opts]
 * @returns {Promise<Array<Record<string, any>>>} one entry per port; [] when no valid port
 */
export async function collectLlm(ports, { fetch: fetchFn = fetch, authTokens = null } = {}) {
  const portList = normalizeLlmPorts(ports);
  if (portList.length === 0) return [];
  return Promise.all(portList.map((port) => probePort(port, fetchFn, portHeaders(authTokens, port))));
}
