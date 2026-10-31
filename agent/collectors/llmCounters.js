/**
 * llmCounters.js — raw cumulative engine counters for the dashboard's
 * windowed metrics (STAT2 #35, STAT3 #36).
 *
 * The agent only reads counters; the dashboard server does every difference
 * (server/metrics/EngineWindow.js). Each LLM port entry carries
 *
 *   engineCounters      Record<ENGINE_COUNTER_KEYS, number|null> | null
 *   engineCountersMeta  { schema, source, monoMs, wallMs, bootId } | null
 *
 * Every key is always present (null when the engine does not publish it), so
 * the shape is the same for every engine. A counter that goes backwards is an
 * engine restart; the server starts its window again.
 *
 * Counter names (engine-neutral):
 *   generated              output tokens
 *   prompt / cached        prompt tokens, and those served from the prefix cache
 *   decoded / first / itlSum
 *                          tokens a decode stopwatch timed, first tokens it did
 *                          not, and that stopwatch in seconds. decode tok/s =
 *                          (Δdecoded − Δfirst) / ΔitlSum. vLLM: generation
 *                          tokens, TTFT count, ITL sum (its ITL count is
 *                          steps). SGLang / q27: ITL count and sum, first 0.
 *                          FreeToken / llama.cpp / Locals: decode tokens and
 *                          decode seconds, first 0.
 *   prefillComputed / prefillSeconds   computed (non-cached) prompt tokens and prefill seconds
 *   queueSum / queueCount              queue-time histogram
 *   ttftSum / ttftCount                time-to-first-token histogram
 *   e2eSum / e2eCount                  end-to-end request latency histogram
 *   requestsFinished                   finished requests
 *   preemptions                        preempted requests
 *   specAccepted / specDrafts          accepted draft tokens / draft steps (vLLM)
 *   specDraftTokens                    drafted (proposed) tokens
 *   specVerify                         speculative verify calls (SGLang)
 *   idleSeconds                        scheduler idle seconds (SGLang)
 *
 * The vLLM and SGLang names, and the decode / prefill counter choices for
 * them, follow hasso5703's dashboard (dgx-spark-qwen38,
 * dashboard/engine_metrics.py, MIT; full notice in
 * server/collectors/llmEngines.js and server/metrics/EngineWindow.js). The
 * other engines' mappings are herd's, from each engine's documented
 * endpoints. Zero dependencies; Node 18+.
 */

import { randomUUID } from "node:crypto";

/** Payload version of engineCounters + engineCountersMeta. 1 = STAT2 (no meta). */
export const ENGINE_COUNTERS_SCHEMA = 2;

export const ENGINE_COUNTER_KEYS = Object.freeze([
  "generated",
  "prompt",
  "cached",
  "decoded",
  "first",
  "itlSum",
  "prefillComputed",
  "prefillSeconds",
  "queueSum",
  "queueCount",
  "ttftSum",
  "ttftCount",
  "e2eSum",
  "e2eCount",
  "requestsFinished",
  "preemptions",
  "specAccepted",
  "specDrafts",
  "specDraftTokens",
  "specVerify",
  "idleSeconds",
]);

/** One id per agent process: a new id means the monotonic clock restarted. */
const BOOT_ID = randomUUID();

/**
 * Monotonic read time. `monoMs` only moves forward within one agent process
 * (performance.now()); `bootId` changes when the process restarts. `wallMs`
 * is for display only.
 * @param {{ monoNow?: () => number, wallNow?: () => number, bootId?: string }} [clock]
 */
export function counterStamp(clock = {}) {
  const mono = clock.monoNow ? clock.monoNow() : performance.now();
  const wall = clock.wallNow ? clock.wallNow() : Date.now();
  return {
    monoMs: Math.round(mono * 1000) / 1000,
    wallMs: Math.round(wall),
    bootId: clock.bootId ?? BOOT_ID,
  };
}

/**
 * Meta for a counter read.
 * @param {"prometheus"|"json"|"proxy"} source page the counters came from ("proxy": metered by the agent's usage relay, STAT4)
 * @param {Parameters<typeof counterStamp>[0]} [clock]
 */
export function counterMeta(source, clock) {
  return { schema: ENGINE_COUNTERS_SCHEMA, source, ...counterStamp(clock) };
}

// ─── Numbers ───────────────────────────────────────────────────────────────

/** @param {unknown} v */
export function num(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** @param {unknown} v */
function isObj(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** a − b, or null when either is missing. Clamped at 0. */
function minus(a, b) {
  return a == null || b == null ? null : Math.max(0, a - b);
}

/** a + b, or null when either is missing. */
function plus(a, b) {
  return a == null || b == null ? null : a + b;
}

/**
 * Full counter record: every key present, unknown keys dropped. null when
 * no counter is known at all.
 * @param {Record<string, number|null|undefined>} partial
 * @returns {Record<string, number|null> | null}
 */
export function counterRecord(partial) {
  /** @type {Record<string, number|null>} */
  const out = {};
  let any = false;
  for (const k of ENGINE_COUNTER_KEYS) {
    const v = num(partial[k]);
    out[k] = v;
    if (v != null && k !== "first") any = true;
  }
  return any ? out : null;
}

// ─── Prometheus text ───────────────────────────────────────────────────────

function esc(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Sum all Prometheus series named `name` (any label set).
 * @param {string} body
 * @param {string} name
 * @returns {number | null}
 */
export function getPromMetric(body, name) {
  const re = new RegExp(`^${esc(name)}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+|NaN)\\s*$`, "gm");
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
export function getPromMetricWhere(body, name, key, value) {
  const re = new RegExp(`^${esc(name)}\\{([^}]*)\\}\\s+([\\d.eE+-]+)\\s*$`, "gm");
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

/** True when the page has a data line for any series starting with `prefix`. */
function hasSeries(txt, prefix) {
  return new RegExp(`(?:^|\\n)${esc(prefix)}[A-Za-z0-9_:]*(?:\\{|\\s)`).test(String(txt || ""));
}

/**
 * Which engine a Prometheus page belongs to, from its series names.
 * @param {string | null} txt
 * @returns {"vllm"|"sglang"|"ds4"|"q27"|"tensorfold"|"splash"|"llama.cpp"|null}
 */
export function engineFromPrometheus(txt) {
  if (!txt) return null;
  if (/(?:^|\n)ds4_tokens_decoded_total(?:\{|\s)/.test(txt)) return "ds4";
  if (/(?:^|\n)q27_(?:decode_tokens_(?:processed_)?total|requests_total)(?:\{|\s)/.test(txt)) return "q27";
  if (hasSeries(txt, "tensorfold:")) return "tensorfold";
  if (/(?:^|\n)splash_(?:decode_output_tokens_total|prefill_input_tokens_total|scheduler_[a-z]+)(?:\{|\s)/.test(txt)) {
    return "splash";
  }
  if (hasSeries(txt, "llamacpp:")) return "llama.cpp";
  if (hasSeries(txt, "sglang:") || hasSeries(txt, "sglang_")) return "sglang";
  if (hasSeries(txt, "vllm:")) return "vllm";
  return null;
}

// ─── Per-engine counters ───────────────────────────────────────────────────

/** @param {string} txt */
function vllmCounters(txt) {
  const v = (n) => getPromMetric(txt, `vllm:${n}`);
  const generated = v("generation_tokens_total");
  return {
    generated,
    prompt: v("prompt_tokens_total"),
    cached: v("prompt_tokens_cached_total"),
    // ITL count is steps: decoded = generated less the first tokens.
    decoded: generated,
    first: v("time_to_first_token_seconds_count"),
    itlSum: v("inter_token_latency_seconds_sum"),
    prefillComputed: v("request_prefill_kv_computed_tokens_sum"),
    prefillSeconds: v("request_prefill_time_seconds_sum"),
    queueSum: v("request_queue_time_seconds_sum"),
    queueCount: v("request_queue_time_seconds_count"),
    ttftSum: v("time_to_first_token_seconds_sum"),
    ttftCount: v("time_to_first_token_seconds_count"),
    e2eSum: v("e2e_request_latency_seconds_sum"),
    e2eCount: v("e2e_request_latency_seconds_count"),
    requestsFinished: v("request_success_total"),
    preemptions: v("num_preemptions_total"),
    specAccepted: v("spec_decode_num_accepted_tokens_total"),
    specDrafts: v("spec_decode_num_drafts_total"),
    specDraftTokens: v("spec_decode_num_draft_tokens_total"),
  };
}

/** @param {string} txt */
function sglangCounters(txt) {
  const v = (n) => getPromMetric(txt, `sglang:${n}`) ?? getPromMetric(txt, `sglang_${n}`);
  const w = (n, k, val) =>
    getPromMetricWhere(txt, `sglang:${n}`, k, val) ?? getPromMetricWhere(txt, `sglang_${n}`, k, val);
  const decoded = v("inter_token_latency_seconds_count");
  return {
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
    e2eSum: v("e2e_request_latency_seconds_sum"),
    e2eCount: v("e2e_request_latency_seconds_count"),
    requestsFinished: v("num_requests_total"),
    specVerify: v("spec_verify_calls_total"),
    idleSeconds: v("scheduler_idle_seconds_total"),
  };
}

/** ds4-server: decoded / prefilled token counters, prefill split by kind. */
function ds4Counters(txt) {
  const computed = getPromMetricWhere(txt, "ds4_tokens_prefilled_total", "kind", "computed");
  const cached = getPromMetricWhere(txt, "ds4_tokens_prefilled_total", "kind", "cached");
  return {
    generated: getPromMetric(txt, "ds4_tokens_decoded_total"),
    prompt: computed != null || cached != null ? (computed ?? 0) + (cached ?? 0) : getPromMetric(txt, "ds4_tokens_prefilled_total"),
    cached,
    prefillComputed: computed,
  };
}

/**
 * q27: live `*_processed_total` counters when the build has them, else the
 * completion-based totals. One family per page so the two never mix.
 */
function q27Counters(txt) {
  const live = getPromMetric(txt, "q27_decode_tokens_processed_total") != null;
  const t = (base) => getPromMetric(txt, live ? `q27_${base}_processed_total` : `q27_${base}_total`);
  const computed = t("prefill_computed_tokens");
  const cached = t("prefill_cached_tokens");
  const itlCount = getPromMetric(txt, "q27_itl_seconds_count");
  return {
    generated: t("decode_tokens"),
    prompt: plus(computed, cached),
    cached,
    prefillComputed: computed,
    // ITL histogram: one observation per inter-token gap, no first tokens.
    decoded: itlCount,
    first: itlCount == null ? null : 0,
    itlSum: getPromMetric(txt, "q27_itl_seconds_sum"),
    ttftSum: getPromMetric(txt, "q27_ttft_seconds_sum"),
    ttftCount: getPromMetric(txt, "q27_ttft_seconds_count"),
    e2eSum: getPromMetric(txt, "q27_e2e_seconds_sum"),
    e2eCount: getPromMetric(txt, "q27_e2e_seconds_count"),
    requestsFinished: getPromMetric(txt, "q27_requests_total"),
    preemptions: getPromMetric(txt, "q27_preemptions_total"),
  };
}

/**
 * TensorFold native build `tensorfold:*`. Generated counts finished requests
 * only (the running-token gauge drops when a request aborts).
 */
function tensorfoldPromCounters(txt) {
  const v = (n) => getPromMetric(txt, `tensorfold:${n}`);
  const prompt = v("prompt_tokens_total");
  const cached = v("prompt_tokens_cached_total") ?? v("prefix_cache_hits_total");
  return {
    generated: v("generation_tokens_total"),
    prompt,
    cached,
    prefillComputed: minus(prompt, cached),
    prefillSeconds: v("request_prefill_seconds_sum"),
    ttftSum: v("time_to_first_token_seconds_sum"),
    ttftCount: v("time_to_first_token_seconds_count"),
  };
}

/** Splash: computed and reused prompt tokens; lifetime tok/s gauges ignored. */
function splashCounters(txt) {
  const v = (n) => getPromMetric(txt, `splash_${n}`);
  const computed = v("prefill_input_tokens_total");
  const reused = v("cache_reused_tokens_total");
  return {
    generated: v("decode_output_tokens_total"),
    prompt: plus(computed, reused),
    cached: reused,
    prefillComputed: computed,
    specAccepted: v("accepted_draft_tokens_total"),
    specDraftTokens: v("drafted_tokens_total"),
  };
}

/** llama.cpp `--metrics`: processed prompt tokens and predicted tokens with their seconds. */
function llamaCppCounters(txt) {
  const v = (n) => getPromMetric(txt, `llamacpp:${n}`);
  const predicted = v("tokens_predicted_total");
  const predictedSec = v("tokens_predicted_seconds_total");
  return {
    generated: predicted,
    // prompt_tokens_total counts processed (computed) prompt tokens only.
    prefillComputed: v("prompt_tokens_total"),
    prefillSeconds: v("prompt_seconds_total"),
    decoded: predictedSec == null ? null : predicted,
    first: predictedSec == null || predicted == null ? null : 0,
    itlSum: predictedSec,
  };
}

/**
 * Counters from a Prometheus page.
 * @param {string} engine
 * @param {string | null} txt
 * @returns {Record<string, number|null> | null}
 */
export function countersFromPrometheus(engine, txt) {
  if (!txt) return null;
  switch (engine) {
    case "vllm":
      return counterRecord(vllmCounters(txt));
    case "sglang":
      return counterRecord(sglangCounters(txt));
    case "ds4":
      return counterRecord(ds4Counters(txt));
    case "q27":
      return counterRecord(q27Counters(txt));
    case "tensorfold":
      return counterRecord(tensorfoldPromCounters(txt));
    case "splash":
      return counterRecord(splashCounters(txt));
    case "llama.cpp":
      return counterRecord(llamaCppCounters(txt));
    default:
      return null;
  }
}

/** EXL3 tools/serve_openai.py /health totals. */
function exl3Counters(h) {
  return { generated: num(h.completion_tokens_total), prompt: num(h.prompt_tokens_total) };
}

/** TensorFold CUDA /health JSON totals. */
function tensorfoldHealthCounters(h) {
  const prompt = num(h.prompt_tokens_total);
  const cached = num(h.cached_tokens_total);
  return {
    generated: num(h.completion_tokens_total),
    prompt,
    cached,
    prefillComputed: minus(prompt, cached),
    prefillSeconds: num(h.prefill_seconds_total),
  };
}

/** FreeToken /v1/stats `requests` totals; decode tokens over decode seconds. */
function freetokenCounters(s) {
  const r = isObj(s.requests) ? s.requests : {};
  const prompt = num(r.prompt_tokens_total);
  const cached = num(r.cached_prompt_tokens_total);
  const decodeSec = num(r.decode_seconds_total);
  const decodeTok = num(r.decode_tokens_total);
  return {
    generated: num(r.completion_tokens_total),
    prompt,
    cached,
    prefillComputed: minus(prompt, cached),
    prefillSeconds: num(r.prefill_seconds_total),
    decoded: decodeSec == null ? null : decodeTok,
    first: decodeSec == null || decodeTok == null ? null : 0,
    itlSum: decodeSec,
    requestsFinished: num(r.completed),
  };
}

/** Strata JSON /metrics `totals`. */
function strataCounters(m) {
  const t = isObj(m.totals) ? m.totals : {};
  return {
    generated: num(t.output_tokens),
    prompt: num(t.prompt_tokens),
    cached: num(t.reused),
    specAccepted: num(t.drafts_accepted),
    specDraftTokens: num(t.drafts_offered),
  };
}

/** Locals /stats: per-engine objects summed (each resets when its engine restarts). */
function localsCounters(s) {
  const sum = (f) => {
    let found = false;
    let t = 0;
    for (const [name, v] of Object.entries(s)) {
      if (!isObj(v) || name === "memory") continue;
      if (!("completion_tokens" in v || "tokens_out" in v || "prompt_tokens" in v)) continue;
      const n = num(v[f]);
      if (n == null) continue;
      t += n;
      found = true;
    }
    return found ? t : null;
  };
  const out = sum("tokens_out") ?? sum("completion_tokens");
  const decodeSec = sum("decode_s");
  return {
    generated: sum("completion_tokens") ?? out,
    prompt: sum("prompt_tokens"),
    cached: sum("cached_tokens"),
    prefillComputed: sum("prefill_tokens"),
    prefillSeconds: sum("prefill_s"),
    decoded: decodeSec == null ? null : out,
    first: decodeSec == null || out == null ? null : 0,
    itlSum: decodeSec,
  };
}

/**
 * Counters from an engine's JSON stats payload.
 * @param {"exl3"|"tensorfold"|"freetoken"|"strata"|"locals"} engine
 * @param {unknown} data
 * @returns {Record<string, number|null> | null}
 */
export function countersFromJson(engine, data) {
  if (!isObj(data)) return null;
  switch (engine) {
    case "exl3":
      return counterRecord(exl3Counters(data));
    case "tensorfold":
      return counterRecord(tensorfoldHealthCounters(data));
    case "freetoken":
      return counterRecord(freetokenCounters(data));
    case "strata":
      return counterRecord(strataCounters(data));
    case "locals":
      return counterRecord(localsCounters(data));
    default:
      return null;
  }
}

/**
 * STAT2 entry point (kept): counters from a vLLM or SGLang Prometheus page.
 * @param {"vllm"|"sglang"} engine
 * @param {string} txt
 */
export function engineCounters(engine, txt) {
  return countersFromPrometheus(engine, txt);
}
