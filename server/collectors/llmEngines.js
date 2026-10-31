/**
 * Engine-native parsers for LlmProbe (STAT1, #34).
 *
 * Pure functions: each takes one engine payload (Prometheus text or JSON) and
 * returns plain numbers or null. Nothing here invents a value: a field the
 * engine does not publish stays null, never 0.
 *
 * The decode / prefill / queue formulas for vLLM and SGLang follow
 * hasso5703's dashboard (`engine_metrics.py`), adapted from the Python:
 *
 *   Source: github.com/hasso5703/dgx-spark-qwen38, dashboard/engine_metrics.py
 *
 *   MIT License
 *
 *   Copyright (c) 2026 hasso5703
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 *
 * Everything else is written from each engine's documented API contract.
 */

/**
 * Source tiers (Page §3). Lower is better.
 *   counter — engine Prometheus / JSON counters differenced by herd
 *   native  — a rate or gauge the engine computes itself (/slots, /health, /v1/stats, /stats)
 *   proxy   — measured at a proxy in front of the engine
 *   client  — measured by a client (bench)
 */
export const SOURCE_TIERS = Object.freeze({ counter: 1, native: 2, proxy: 3, client: 4 });

/** Backends added by STAT1. Legacy: vllm, sglang, llama.cpp, ds4, exl3, q27. */
export const NATIVE_BACKENDS = Object.freeze([
  "tensorfold",
  "freetoken",
  "strata",
  "locals",
  "splash",
  "lmstudio",
  "ollama",
  "tabbyapi",
]);

/** owned_by values that name an engine exactly (case-insensitive). */
const EXACT_OWNED_BY = Object.freeze({
  tensorfold: "tensorfold",
  freetoken: "freetoken",
  locals: "locals",
  splash: "splash",
  strata: "strata",
  tabbyapi: "tabbyapi",
});

/**
 * Exact owned_by → backend. Partial matches (e.g. "splashai") do not count.
 * @param {unknown} ownedBy
 * @returns {string | null}
 */
export function backendFromOwnedBy(ownedBy) {
  if (typeof ownedBy !== "string") return null;
  return EXACT_OWNED_BY[ownedBy.trim().toLowerCase()] ?? null;
}

// ─── Small numeric helpers ─────────────────────────────────────────────────

/** @param {unknown} v @returns {number | null} */
export function num(v) {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** @param {number | null} v @param {number} [dp] */
export function round(v, dp = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** @param {unknown} v */
function isObj(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

// ─── Prometheus text ───────────────────────────────────────────────────────

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every sample of `name` as { labels, value }.
 * @param {string} body
 * @param {string} name
 */
export function promSamples(body, name) {
  const re = new RegExp(`^${esc(name)}(?:\\{([^}]*)\\})?\\s+([\\d.eE+-]+|NaN|[+-]Inf)\\s*$`, "gm");
  const out = [];
  let m;
  while ((m = re.exec(String(body || ""))) !== null) {
    const value = parseFloat(m[2]);
    if (!Number.isFinite(value)) continue;
    const labels = {};
    if (m[1]) {
      for (const lm of m[1].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[lm[1]] = lm[2];
    }
    out.push({ labels, value });
  }
  return out;
}

/**
 * Sum of `name`, optionally only the samples whose labels match `where`.
 * @param {string} body
 * @param {string} name
 * @param {Record<string, string>} [where]
 * @returns {number | null}
 */
export function promSum(body, name, where) {
  let found = false;
  let sum = 0;
  for (const s of promSamples(body, name)) {
    if (where && !Object.entries(where).every(([k, v]) => s.labels[k] === v)) continue;
    sum += s.value;
    found = true;
  }
  return found ? sum : null;
}

/** @param {string} body @param {string} name @returns {number | null} */
export function promMax(body, name) {
  let best = null;
  for (const s of promSamples(body, name)) best = best == null ? s.value : Math.max(best, s.value);
  return best;
}

/** First of several names that is present (sum). */
function promFirst(body, names, where) {
  for (const n of names) {
    const v = promSum(body, n, where);
    if (v != null) return v;
  }
  return null;
}

// ─── Deltas ────────────────────────────────────────────────────────────────

/**
 * Per-key deltas between two counter snapshots. Any decrease (restart) or a
 * missing side makes that key null.
 * @param {Record<string, number|null>|null} prev
 * @param {Record<string, number|null>} cur
 */
export function counterDeltas(prev, cur) {
  /** @type {Record<string, number|null>} */
  const d = {};
  let reset = false;
  for (const [k, v] of Object.entries(cur)) {
    const p = prev?.[k];
    if (v == null || p == null) {
      d[k] = null;
      continue;
    }
    if (v < p) {
      reset = true;
      d[k] = null;
      continue;
    }
    d[k] = v - p;
  }
  return { deltas: d, reset };
}

/** a / b when both are known and b > 0. */
function ratio(a, b) {
  return a != null && b != null && b > 0 ? a / b : null;
}

// ─── Hasso formulas (vLLM / SGLang counters) ───────────────────────────────

/**
 * Counters Hasso's formulas difference, for vLLM.
 * @param {string} txt
 */
export function vllmHassoCounters(txt) {
  const v = (n) => promSum(txt, `vllm:${n}`);
  return {
    decoded: v("generation_tokens_total"),
    first: v("time_to_first_token_seconds_count"),
    itlSum: v("inter_token_latency_seconds_sum"),
    prefillComputed: v("request_prefill_kv_computed_tokens_sum"),
    prefillSeconds: v("request_prefill_time_seconds_sum"),
    queueSum: v("request_queue_time_seconds_sum"),
    queueCount: v("request_queue_time_seconds_count"),
    specAccepted: v("spec_decode_num_accepted_tokens_total"),
    specDrafts: v("spec_decode_num_drafts_total"),
    prompt: v("prompt_tokens_total"),
    cached: v("prompt_tokens_cached_total"),
  };
}

/**
 * Counters Hasso's formulas difference, for SGLang (`sglang:` or `sglang_`).
 * @param {string} txt
 */
export function sglangHassoCounters(txt) {
  const v = (n, where) => promFirst(txt, [`sglang:${n}`, `sglang_${n}`], where);
  return {
    decoded: v("inter_token_latency_seconds_count"),
    first: null,
    itlSum: v("inter_token_latency_seconds_sum"),
    // prefill_forward only; chunked_prefill is a separate stage and is not added.
    prefillComputed: v("realtime_tokens_total", { mode: "prefill_compute" }),
    prefillSeconds: v("per_stage_req_latency_seconds_sum", { stage: "prefill_forward" }),
    queueSum: v("queue_time_seconds_sum"),
    queueCount: v("queue_time_seconds_count"),
    specVerify: v("spec_verify_calls_total"),
    generated: v("generation_tokens_total"),
  };
}

/**
 * Hasso rates from two counter snapshots.
 *   decode  = (Δdecoded − Δfirst) / Δitl_sum
 *   prefill = Δprefill_computed / Δprefill_seconds
 *   queue   = Δqueue_sum / Δqueue_count
 *   accept  = vLLM 1 + Δaccepted/Δdrafts; SGLang Δgenerated/Δverify_calls
 * Null when the window holds no samples.
 * @param {"vllm"|"sglang"} engine
 * @param {Record<string, number|null>|null} prev
 * @param {Record<string, number|null>} cur
 */
export function hassoRates(engine, prev, cur) {
  const none = { decodeTps: null, prefillTps: null, queueSeconds: null, acceptLength: null };
  if (!prev) return none;
  const { deltas: d, reset } = counterDeltas(prev, cur);
  if (reset) return none;
  const decodedNet =
    d.decoded == null ? null : engine === "vllm" ? (d.first == null ? null : d.decoded - d.first) : d.decoded;
  const decodeTps = decodedNet != null && decodedNet >= 0 ? ratio(decodedNet, d.itlSum) : null;
  const prefillTps = ratio(d.prefillComputed, d.prefillSeconds);
  const queueSeconds = ratio(d.queueSum, d.queueCount);
  let acceptLength = null;
  if (engine === "vllm") {
    const r = ratio(d.specAccepted, d.specDrafts);
    acceptLength = r == null ? null : 1 + r;
  } else {
    acceptLength = ratio(d.generated, d.specVerify);
  }
  return {
    decodeTps: round(decodeTps),
    prefillTps: round(prefillTps),
    queueSeconds: round(queueSeconds, 4),
    acceptLength: round(acceptLength, 3),
  };
}

/**
 * STAT2 (#35): the cumulative counters EngineWindow differences, under its
 * engine-neutral names (server/metrics/EngineWindow.js ENGINE_COUNTER_NAMES),
 * read off a vLLM or SGLang /metrics page. Names follow Hasso's NAMES table.
 * Prompt / cached totals are not read here: the probe passes its own.
 * @param {"vllm"|"sglang"} engine
 * @param {string} txt
 * @returns {Record<string, number|null>}
 */
export function engineWindowCounters(engine, txt) {
  if (engine === "vllm") {
    const v = (n) => promSum(txt, `vllm:${n}`);
    const generated = v("generation_tokens_total");
    const ttftCount = v("time_to_first_token_seconds_count");
    return {
      generated,
      // vLLM's ITL count is steps, so decoded = generated tokens, less the
      // first tokens (TTFT count) the ITL sum never timed.
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
  }
  const v = (n, where) => promFirst(txt, [`sglang:${n}`, `sglang_${n}`], where);
  const decoded = v("inter_token_latency_seconds_count");
  return {
    generated: v("generation_tokens_total"),
    // SGLang's ITL count is already tokens and holds no first tokens.
    decoded,
    first: decoded == null ? null : 0,
    itlSum: v("inter_token_latency_seconds_sum"),
    prefillComputed: v("realtime_tokens_total", { mode: "prefill_compute" }),
    prefillSeconds: v("per_stage_req_latency_seconds_sum", { stage: "prefill_forward" }),
    queueSum: v("queue_time_seconds_sum"),
    queueCount: v("queue_time_seconds_count"),
    ttftSum: v("time_to_first_token_seconds_sum"),
    ttftCount: v("time_to_first_token_seconds_count"),
    specAccepted: null,
    specDrafts: null,
    specVerify: v("spec_verify_calls_total"),
    // Only when a data line carries it: a missing counter must not read as busy.
    idleSeconds: v("scheduler_idle_seconds_total"),
  };
}

// ─── Detection signatures ──────────────────────────────────────────────────

/** Strata /health carries service: "strata". */
export function healthLooksLikeStrata(data) {
  return isObj(data) && data.service === "strata";
}

/** FreeToken /v1/stats: throughput + requests objects. */
export function statsLookLikeFreeToken(data) {
  return isObj(data) && isObj(data.throughput) && isObj(data.requests) &&
    ("decode_tps" in data.throughput || "prefill_tps" in data.throughput);
}

/** TensorFold Prometheus series. */
export function metricsLookLikeTensorfold(txt) {
  return /(?:^|\n)tensorfold:[a-z_]+(?:\{|\s)/m.test(String(txt || ""));
}

/** Splash Prometheus series. */
export function metricsLookLikeSplash(txt) {
  return /(?:^|\n)splash_(?:decode_output_tokens_total|prefill_input_tokens_total|scheduler_[a-z]+)(?:\{|\s)/m.test(
    String(txt || "")
  );
}

/** LM Studio /api/v0/models: list entries carry a string `state`. */
export function modelsLookLikeLmStudio(data) {
  const rows = isObj(data) && Array.isArray(data.data) ? data.data : null;
  return !!rows && rows.length > 0 && rows.every((r) => isObj(r) && typeof r.state === "string" && typeof r.id === "string");
}

/** Ollama /api/tags: { models: [{ name, ... }] }. */
export function tagsLookLikeOllama(data) {
  return isObj(data) && Array.isArray(data.models) && data.models.every((m) => isObj(m) && typeof m.name === "string");
}

// ─── Per-engine payload parsers ────────────────────────────────────────────

/**
 * TensorFold CUDA /health. The native Zig build answers {"status":"ok"} only;
 * then every field is null and /metrics carries the counters.
 * @param {unknown} h
 */
export function parseTensorfoldHealth(h) {
  if (!isObj(h)) return null;
  const streams = isObj(h.streams) ? h.streams : null;
  const pool = num(h.pool_tokens);
  const free = num(h.pool_free_tokens);
  const decoding = num(streams?.decoding);
  const prefilling = num(streams?.prefilling);
  const out = {
    version: typeof h.version === "string" ? h.version : null,
    prompt: num(h.prompt_tokens_total),
    cached: num(h.cached_tokens_total),
    completion: num(h.completion_tokens_total),
    prefillSeconds: num(h.prefill_seconds_total),
    running: num(h.requests_running) ?? (decoding != null && prefilling != null ? decoding + prefilling : null),
    slotsTotal: num(streams?.max) ?? num(h.max_batch_size),
    kvUsage: pool != null && pool > 0 && free != null ? 1 - free / pool : null,
  };
  const any = Object.entries(out).some(([k, v]) => k !== "version" && v != null);
  return any ? out : null;
}

/**
 * TensorFold Prometheus /metrics (native Zig build).
 * @param {string} txt
 */
export function parseTensorfoldMetrics(txt) {
  if (!metricsLookLikeTensorfold(txt)) return null;
  const v = (n, where) => promSum(txt, `tensorfold:${n}`, where);
  let kv = null;
  for (const s of promSamples(txt, "tensorfold:kv_cache_usage_ratio")) kv = kv == null ? s.value : Math.max(kv, s.value);
  const hits = v("prefix_cache_hits_total");
  return {
    prompt: v("prompt_tokens_total"),
    cached: v("prompt_tokens_cached_total") ?? hits ?? v("prompt_cache_cached_tokens"),
    generationFinished: v("generation_tokens_total"),
    generationRunning: v("generation_tokens_running"),
    running: v("requests_running"),
    waiting: v("requests_waiting"),
    kvUsage: kv,
    prefillSeconds: v("request_prefill_seconds_sum"),
    ttftSum: v("time_to_first_token_seconds_sum"),
    ttftCount: v("time_to_first_token_seconds_count"),
    prefixHits: hits,
    prefixQueries: v("prefix_cache_queries_total"),
  };
}

/**
 * FreeToken /v1/stats.
 * @param {unknown} s
 */
export function parseFreeTokenStats(s) {
  if (!statsLookLikeFreeToken(s)) return null;
  const t = s.throughput;
  const r = s.requests;
  const kv = isObj(s.kv) ? s.kv : {};
  const used = num(kv.used_pages);
  const total = num(kv.total_pages);
  const ttftMs = num(r.ttft_mean_ms);
  const p95 = num(r.p95_ms);
  return {
    decodeTps: num(t.decode_tps),
    prefillTps: num(t.prefill_tps),
    /** FreeToken computes decode_tps / prefill_tps over a 5 s window. */
    windowS: 5,
    active: num(r.active),
    completed: num(r.completed),
    /** p95_ms is end-to-end request latency, not TTFT. */
    e2eP95Seconds: p95 == null ? null : p95 / 1000,
    ttftMeanSeconds: ttftMs == null ? null : ttftMs / 1000,
    prompt: num(r.prompt_tokens_total),
    completion: num(r.completion_tokens_total),
    cached: num(r.cached_prompt_tokens_total),
    prefillSeconds: num(r.prefill_seconds_total),
    decodeSeconds: num(r.decode_seconds_total),
    decodeTokens: num(r.decode_tokens_total),
    kvUsage: used != null && total != null && total > 0 ? used / total : null,
  };
}

/**
 * Strata JSON /metrics.
 * @param {unknown} m
 */
export function parseStrataMetrics(m) {
  if (!isObj(m) || !isObj(m.live)) return null;
  const live = m.live;
  const totals = isObj(m.totals) ? m.totals : {};
  const engine = isObj(m.engine) ? m.engine : {};
  const slots = Array.isArray(live.slots) ? live.slots.filter(isObj) : [];
  const state = typeof live.state === "string" ? live.state : null;
  const decoding = slots.filter((s) => s.state === "decoding");
  const reading = state === "reading" || slots.some((s) => s.state === "reading");
  const outside = num(live.outside_slots) ?? 0;
  const idle = state === "idle" || state === "unloaded";

  let decodeTps = null;
  let decodeApprox = false;
  let decodeWindow = num(live.tok_s_window_s);
  if (idle) decodeTps = 0;
  else if (num(live.tok_s) != null) decodeTps = num(live.tok_s);
  else if (decoding.length > 0 && outside === 0 && decoding.every((s) => num(s.tok_s) != null)) {
    // Active-slot mean: each slot's own lifetime rate, summed.
    decodeTps = decoding.reduce((a, s) => a + num(s.tok_s), 0);
    decodeApprox = true;
    decodeWindow = null;
  } else if (decoding.length === 0 && outside === 0 && state != null) decodeTps = 0;

  let prefillTps = null;
  if (idle) prefillTps = 0;
  else if (reading) prefillTps = num(live.prefill_tok_s_mean);
  else if (state != null && outside === 0) prefillTps = 0;

  const offered = num(totals.drafts_offered);
  const accepted = num(totals.drafts_accepted);
  return {
    state,
    decodeTps,
    decodeApprox,
    decodeWindowS: decodeWindow,
    /** prefill_tok_s_mean is the last reported mean: approximate. */
    prefillTps,
    prefillApprox: reading && prefillTps != null,
    running: num(live.running),
    waiting: num(live.waiting) ?? num(live.queued),
    parallel: num(live.parallel),
    slotsActive: slots.length ? slots.filter((s) => s.state && s.state !== "idle").length : null,
    prompt: num(totals.prompt_tokens),
    cached: num(totals.reused),
    output: num(totals.output_tokens),
    maxContext: num(engine.max_context),
    model: typeof engine.model === "string" ? engine.model : null,
    acceptRate: offered != null && offered > 0 && accepted != null ? accepted / offered : null,
  };
}

const LOCALS_FIELDS = ["prompt_tokens", "cached_tokens", "completion_tokens", "tokens_out", "prefill_tokens", "prefill_s", "decode_s"];

/**
 * Locals /stats. Per-engine objects (e.g. `locals`, `stock`) carry counters;
 * they reset to zero when that engine restarts.
 * @param {unknown} s
 */
export function parseLocalsStats(s) {
  if (!isObj(s)) return null;
  /** @type {Record<string, Record<string, number|null>>} */
  const engines = {};
  for (const [name, v] of Object.entries(s)) {
    if (!isObj(v) || name === "memory") continue;
    if (!("completion_tokens" in v || "tokens_out" in v || "prompt_tokens" in v)) continue;
    const row = {};
    for (const f of LOCALS_FIELDS) row[f] = num(v[f]);
    engines[name] = row;
  }
  if (!Object.keys(engines).length) return null;
  const sum = (f) => {
    let found = false;
    let t = 0;
    for (const e of Object.values(engines)) {
      if (e[f] == null) continue;
      t += e[f];
      found = true;
    }
    return found ? t : null;
  };
  return {
    engines,
    model: typeof s.model === "string" ? s.model : null,
    active: Array.isArray(s.active) ? s.active.length : null,
    prompt: sum("prompt_tokens"),
    cached: sum("cached_tokens"),
    completion: sum("completion_tokens"),
    tokensOut: sum("tokens_out") ?? sum("completion_tokens"),
    prefillTokens: sum("prefill_tokens"),
    prefillSeconds: sum("prefill_s"),
  };
}

/**
 * Splash Prometheus /metrics. The `*_tokens_per_second` gauges are lifetime
 * averages and are deliberately not read.
 * @param {string} txt
 */
export function parseSplashMetrics(txt) {
  if (!metricsLookLikeSplash(txt)) return null;
  const v = (n) => promSum(txt, `splash_${n}`);
  const accepted = v("accepted_draft_tokens_total");
  const drafted = v("drafted_tokens_total");
  const ttftMs = v("ttft_p95_milliseconds");
  const itlMs = v("itl_p95_milliseconds");
  return {
    output: v("decode_output_tokens_total"),
    /** Computed (non-reused) prompt tokens. */
    prefillComputed: v("prefill_input_tokens_total"),
    reused: v("cache_reused_tokens_total"),
    prefilling: v("scheduler_prefilling"),
    decoding: v("scheduler_decoding"),
    queued: v("scheduler_queued"),
    ttftP95Seconds: ttftMs == null ? null : ttftMs / 1000,
    itlP95Seconds: itlMs == null ? null : itlMs / 1000,
    acceptRate: v("draft_acceptance_ratio") ?? (accepted != null && drafted != null && drafted > 0 ? accepted / drafted : null),
  };
}

/**
 * LM Studio /api/v0/models.
 * @param {unknown} data
 */
export function parseLmStudioModels(data) {
  if (!modelsLookLikeLmStudio(data)) return null;
  const rows = data.data;
  const loaded = rows.filter((r) => r.state === "loaded" && r.type !== "embeddings");
  const top = loaded[0] ?? null;
  return {
    installed: rows.map((r) => r.id),
    loadedModel: top ? top.id : null,
    contextLength: top ? num(top.loaded_context_length) ?? num(top.max_context_length) : null,
    loadedCount: loaded.length,
  };
}

/**
 * Ollama /api/tags (+ optional /api/ps).
 * @param {unknown} tags
 * @param {unknown} ps
 */
export function parseOllama(tags, ps) {
  if (!tagsLookLikeOllama(tags)) return null;
  const running = isObj(ps) && Array.isArray(ps.models) ? ps.models.filter(isObj) : null;
  const top = running?.[0] ?? null;
  return {
    installed: tags.models.map((m) => m.name),
    loadedModel: top ? (top.name ?? top.model ?? null) : null,
    contextLength: top ? num(top.context_length) : null,
    loadedCount: running ? running.length : null,
  };
}

/** Clamp cached ≤ prompt (cached can never exceed prompt tokens). */
export function clampCached(cached, prompt) {
  if (cached == null) return null;
  if (prompt == null) return cached;
  return Math.min(cached, prompt);
}
