/**
 * Synthetic per-engine fixtures for LlmProbe (STAT1, #34).
 *
 * Every payload is synthetic: numbers are made up, but metric and field names
 * follow each engine's own documented exposition (Prometheus text or JSON).
 * A fixture is a list of polls; each poll maps a request path to a response.
 * Paths not listed answer 404, as a real engine does for routes it lacks.
 */

/** @typedef {{ status?: number, json?: unknown, text?: string }} FixtureResponse */

export const T0 = 1_000_000;
export const POLL_MS = 2_000;

const json = (body, status = 200) => ({ status, json: body });
const text = (body, status = 200) => ({ status, text: body });
/** vLLM answers GET /health with 200 and an empty body. */
const emptyOk = () => ({ status: 200, text: "" });

function prom(lines) {
  return `${lines.join("\n")}\n`;
}

// ─── vLLM ───────────────────────────────────────────────────────────────────
function vllmMetrics(i) {
  const prompt = 1000 + i * 4000;
  const cached = 200 + i * 3000;
  const gen = 500 + i * 120;
  const ttftCount = 4 + i;
  return prom([
    "# HELP vllm:prompt_tokens_total Number of prefill tokens processed.",
    "# TYPE vllm:prompt_tokens_total counter",
    `vllm:prompt_tokens_total{model_name="m"} ${prompt}`,
    `vllm:prompt_tokens_cached_total{model_name="m"} ${cached}`,
    `vllm:generation_tokens_total{model_name="m"} ${gen}`,
    `vllm:num_requests_running{model_name="m"} ${i === 2 ? 0 : 2}`,
    `vllm:num_requests_waiting{model_name="m"} ${i}`,
    `vllm:kv_cache_usage_perc{model_name="m"} ${0.1 + i * 0.05}`,
    `vllm:num_preemptions_total{model_name="m"} ${i}`,
    `vllm:prefix_cache_hits_total{model_name="m"} ${cached}`,
    `vllm:prefix_cache_queries_total{model_name="m"} ${prompt}`,
    `vllm:iteration_tokens_total_sum{model_name="m"} ${prompt + gen}`,
    `vllm:time_to_first_token_seconds_bucket{le="0.1",model_name="m"} ${ttftCount - 1}`,
    `vllm:time_to_first_token_seconds_bucket{le="1.0",model_name="m"} ${ttftCount}`,
    `vllm:time_to_first_token_seconds_bucket{le="+Inf",model_name="m"} ${ttftCount}`,
    `vllm:time_to_first_token_seconds_sum{model_name="m"} ${0.2 * ttftCount}`,
    `vllm:time_to_first_token_seconds_count{model_name="m"} ${ttftCount}`,
    `vllm:inter_token_latency_seconds_sum{model_name="m"} ${(gen - ttftCount) * 0.02}`,
    `vllm:inter_token_latency_seconds_count{model_name="m"} ${gen - ttftCount}`,
    `vllm:request_prefill_kv_computed_tokens_sum{model_name="m"} ${prompt - cached}`,
    `vllm:request_prefill_time_seconds_sum{model_name="m"} ${(prompt - cached) / 2000}`,
    `vllm:request_queue_time_seconds_sum{model_name="m"} ${0.05 * ttftCount}`,
    `vllm:request_queue_time_seconds_count{model_name="m"} ${ttftCount}`,
    `vllm:spec_decode_num_drafts_total{model_name="m"} ${100 + i * 10}`,
    `vllm:spec_decode_num_draft_tokens_total{model_name="m"} ${300 + i * 30}`,
    `vllm:spec_decode_num_accepted_tokens_total{model_name="m"} ${200 + i * 20}`,
  ]);
}

const vllm = [0, 1, 2].map((i) => ({
  "/v1/models": json({ data: [{ id: "Qwen/Qwen3-8B", owned_by: "vllm", max_model_len: 32768 }] }),
  "/health": emptyOk(),
  "/metrics": text(vllmMetrics(i)),
}));

// ─── SGLang ────────────────────────────────────────────────────────────────
function sglangMetrics(i) {
  const prompt = 2000 + i * 5000;
  const cached = 500 + i * 4000;
  const gen = 800 + i * 150;
  return prom([
    `sglang:prompt_tokens_total{model_name="m"} ${prompt}`,
    `sglang:generation_tokens_total{model_name="m"} ${gen}`,
    `sglang:cached_tokens_total{cache_source="device",model_name="m"} ${cached}`,
    `sglang:num_running_reqs{model_name="m"} ${i === 2 ? 0 : 1}`,
    `sglang:num_queue_reqs{model_name="m"} ${i}`,
    `sglang:token_usage{model_name="m"} ${0.2 + 0.1 * i}`,
    `sglang:time_to_first_token_seconds_sum{model_name="m"} ${0.3 * (3 + i)}`,
    `sglang:time_to_first_token_seconds_count{model_name="m"} ${3 + i}`,
    `sglang:inter_token_latency_seconds_sum{model_name="m"} ${gen * 0.025}`,
    `sglang:inter_token_latency_seconds_count{model_name="m"} ${gen}`,
    `sglang:realtime_tokens_total{mode="prefill_compute",model_name="m"} ${prompt - cached}`,
    `sglang:realtime_tokens_total{mode="prefill_cache",model_name="m"} ${cached}`,
    `sglang:per_stage_req_latency_seconds_sum{stage="prefill_forward",model_name="m"} ${(prompt - cached) / 1500}`,
    `sglang:per_stage_req_latency_seconds_sum{stage="chunked_prefill",model_name="m"} ${(prompt - cached) / 3000}`,
    `sglang:queue_time_seconds_sum{model_name="m"} ${0.01 * (3 + i)}`,
    `sglang:queue_time_seconds_count{model_name="m"} ${3 + i}`,
    `sglang:spec_verify_calls_total{model_name="m"} ${300 + i * 50}`,
  ]);
}

const sglang = [0, 1, 2].map((i) => ({
  "/v1/models": json({ data: [{ id: "Qwen/Qwen3-30B-A3B", owned_by: "sglang", max_model_len: 65536 }] }),
  "/server_info": json({ model_path: "Qwen/Qwen3-30B-A3B", context_length: 65536, max_running_requests: 8 }),
  "/v1/loads": json({ loads: [{ num_running_reqs: i === 2 ? 0 : 1, num_waiting_reqs: i }] }),
  "/model_info": json({ model_path: "Qwen/Qwen3-30B-A3B" }),
  "/metrics": text(sglangMetrics(i)),
}));

// ─── llama.cpp ─────────────────────────────────────────────────────────────
const llamacpp = [0, 1, 2].map((i) => ({
  "/slots": json([
    { id: 0, is_processing: i < 2, n_decoded: 10 + i * 60, n_prompt_tokens_processed: 400 + i * 100, n_prompt_tokens_cache: 300 + i * 50 },
    { id: 1, is_processing: false, n_decoded: 5, n_prompt_tokens_processed: 50, n_prompt_tokens_cache: 0 },
  ]),
  "/props": json({ model_alias: "gemma-3-12b", total_context_length: 8192 }),
  "/health": json({ status: "ok" }),
}));

// ─── ds4-server ────────────────────────────────────────────────────────────
const ds4 = [0, 1, 2].map((i) => ({
  "/v1/models": json({ data: [{ id: "deepseek-v4", owned_by: "ds4.c", context_length: 131072 }] }),
  "/metrics": text(prom([
    `ds4_tokens_decoded_total ${100 + i * 80}`,
    `ds4_tokens_prefilled_total{kind="computed"} ${1000 + i * 600}`,
    `ds4_tokens_prefilled_total{kind="cached"} ${4000 + i * 2000}`,
    `ds4_requests_inflight ${i === 2 ? 0 : 1}`,
    `ds4_banks_total 4`,
    `ds4_spec_accept_ratio 0.71`,
  ])),
}));

// ─── EXL3 serve_openai.py ──────────────────────────────────────────────────
const exl3 = [0, 1, 2].map((i) => ({
  "/v1/models": json({ data: [{ id: "qwen3.8-27b-exl3", owned_by: "exl3" }] }),
  "/health": json({ ok: true, busy: i < 2, backend: "exl3", prompt_tokens_total: 300 + i * 900, completion_tokens_total: 40 + i * 70, context_length: 32768 }),
}));

// ─── q27 ───────────────────────────────────────────────────────────────────
const q27 = [0, 1, 2].map((i) => ({
  "/v1/models": json({ data: [{ id: "qwen3.6-27b", owned_by: "q27" }] }),
  "/metrics": text(prom([
    `q27_decode_tokens_processed_total{api="chat"} ${200 + i * 90}`,
    `q27_prefill_computed_tokens_processed_total{api="chat"} ${700 + i * 400}`,
    `q27_prefill_cached_tokens_processed_total{api="chat"} ${3000 + i * 1000}`,
    `q27_requests_total{api="chat"} ${5 + i}`,
    `q27_requests_inflight ${i === 2 ? 0 : 1}`,
    `q27_slots_total 2`,
    `q27_kv_usage_perc 0.33`,
    `q27_preemptions_total 0`,
    `q27_ttft_seconds_bucket{le="0.5"} ${4 + i}`,
    `q27_ttft_seconds_bucket{le="+Inf"} ${5 + i}`,
    `q27_ttft_seconds_sum ${1.5 + i * 0.4}`,
    `q27_ttft_seconds_count ${5 + i}`,
    `q27_spec_accept_ratio 0.6`,
  ])),
}));

/** The six engines herd supported before STAT1; their legacy fields are frozen. */
export const LEGACY_ENGINES = { vllm, sglang, "llama.cpp": llamacpp, ds4, exl3, q27 };

// ─── TensorFold: CUDA /health totals ───────────────────────────────────────
const tensorfoldHealth = [0, 1, 2].map((i) => ({
  "/v1/models": json({ data: [{ id: "glm-5.3-flash", owned_by: "tensorfold" }] }),
  "/health": json({
    status: "ok",
    version: "0.6.0",
    busy: i < 2,
    prompt_tokens_total: 10_000 + i * 20_000,
    cached_tokens_total: 8_000 + i * 19_000,
    completion_tokens_total: 1_000 + i * 300,
    prefill_seconds_total: 4 + i * 1,
    requests_running: i === 2 ? 0 : 3,
    streams: { max: 4, decoding: i === 2 ? 0 : 2, prefilling: i === 2 ? 0 : 1 },
    pool_tokens: 200_000,
    pool_free_tokens: 150_000,
  }),
}));

// ─── TensorFold: native Zig build, /metrics only ───────────────────────────
function tensorfoldMetrics(i) {
  const prompt = 5000 + i * 10_000;
  const cached = 4000 + i * 9500;
  return prom([
    `tensorfold:prompt_tokens_total ${prompt}`,
    `tensorfold:prompt_tokens_cached_total ${cached}`,
    `tensorfold:generation_tokens_total ${400 + (i === 2 ? 300 : 0)}`,
    `tensorfold:generation_tokens_running ${i === 0 ? 50 : i === 1 ? 250 : 0}`,
    `tensorfold:requests_running ${i === 2 ? 0 : 2}`,
    `tensorfold:requests_waiting ${i === 1 ? 1 : 0}`,
    `tensorfold:kv_cache_usage_ratio{pool="0"} 0.25`,
    `tensorfold:kv_cache_usage_ratio{pool="1"} 0.40`,
    `tensorfold:request_prefill_seconds_sum ${2 + i * 0.5}`,
    `tensorfold:time_to_first_token_seconds_sum ${1 + i * 0.6}`,
    `tensorfold:time_to_first_token_seconds_count ${2 + i}`,
  ]);
}
const tensorfoldMetricsOnly = [0, 1, 2].map((i) => ({
  "/v1/models": json({ data: [{ id: "qwen3.8-flash-next", owned_by: "tensorfold" }] }),
  "/health": json({ status: "ok" }),
  "/metrics": text(tensorfoldMetrics(i)),
}));

// ─── FreeToken /v1/stats ───────────────────────────────────────────────────
const freetoken = [0, 1, 2].map((i) => ({
  "/v1/models": json({ data: [{ id: "hermes-brain", owned_by: "FreeToken" }] }),
  "/v1/stats": json({
    instance_id: "ft-1",
    model: "hermes-brain",
    uptime_s: 100 + i * 2,
    kv: { used_pages: 100 + i * 50, total_pages: 1000, page_size: 16 },
    throughput: { decode_tps: i === 2 ? 0 : 38.5, prefill_tps: i === 0 ? 1520.4 : 0 },
    requests: {
      active: i === 2 ? 0 : 1,
      completed: 10 + i,
      p95_ms: 9800,
      ttft_mean_ms: 812.5,
      prompt_tokens_total: 50_000 + i * 1000,
      completion_tokens_total: 4000 + i * 77,
      cached_prompt_tokens_total: 30_000 + i * 900,
    },
  }),
}));

// ─── Strata: /health service + JSON /metrics ───────────────────────────────
function strataMetrics(i) {
  const states = ["generating", "reading", "idle"];
  const state = states[i];
  const slots =
    i === 0
      ? [{ slot: 0, state: "decoding", prompt_tokens: 900, generated: 40, elapsed_s: 2.1, tok_s: 31.2 }, { slot: 1, state: "idle", held_tokens: 0 }]
      : i === 1
        ? [
            { slot: 0, state: "decoding", prompt_tokens: 900, generated: 100, elapsed_s: 4.1, tok_s: 30.4 },
            { slot: 1, state: "reading", prompt_tokens: 5000, generated: 0, elapsed_s: 0.8, tok_s: null },
          ]
        : [{ slot: 0, state: "idle", held_tokens: 1000 }, { slot: 1, state: "idle", held_tokens: 0 }];
  return {
    engine: { model: "qwen3.8-27b", max_context: 131072 },
    live: {
      state,
      queued: 0,
      tok_s: i === 0 ? 31.2 : null,
      tok_s_mean: i === 0 ? 30.9 : null,
      prefill_tok_s_mean: i === 1 ? 1840.0 : null,
      tok_s_window_s: i === 0 ? 2 : null,
      parallel: 2,
      running: i === 2 ? 0 : i === 1 ? 2 : 1,
      slots,
      outside_slots: 0,
      waiting: 0,
    },
    totals: { since: 0, requests: 7 + i, prompt_tokens: 20_000 + i * 900, reused: 15_000 + i * 600, output_tokens: 3000 + i * 61, prompt_ms: 9000, decode_ms: 90_000 },
  };
}
const strata = [0, 1, 2].map((i) => ({
  "/health": json({ status: "ok", max_context: 131072, model: "qwen3.8-27b", loaded: true, service: "strata" }),
  "/slots": json([{ id: 0 }, { id: 1 }]),
  "/v1/models": json({ data: [{ id: "qwen3.8-27b", owned_by: "strata" }] }),
  "/metrics": json(strataMetrics(i)),
}));

// ─── Locals (MLX): /stats ──────────────────────────────────────────────────
const locals = [0, 1, 2].map((i) => ({
  "/v1/models": json({ data: [{ id: "locals/qwen3.6-35b-a3b", owned_by: "locals" }] }),
  "/stats": json({
    model: "qwen3.6-35b-a3b",
    uptime_s: 50 + i * 2,
    requests: 3 + i,
    errors: 0,
    active: i === 2 ? [] : [{ engine: "locals", prompt_tokens: 2000, tokens: 30 + i * 80, started: 1 }],
    memory: { gpu_active_mb: 20_000, gpu_peak_mb: 22_000, gpu_cache_mb: 100, rss_mb: 900 },
    locals: {
      loaded: true,
      requests: 3 + i,
      prompt_tokens: 8000 + i * 2000,
      cached_tokens: 5000 + i * 1500,
      completion_tokens: 600 + i * 80,
      tokens_out: 600 + i * 80,
      prefill_tokens: 3000 + i * 500,
      prefill_s: 3 + i * 0.25,
      decode_s: 12 + i * 2,
    },
    stock: { loaded: false, requests: 0, prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0 },
  }),
  "/api/tags": json({ models: [{ name: "qwen3.6-35b-a3b", model: "qwen3.6-35b-a3b" }] }),
}));

// ─── Splash (MLX): splash_* Prometheus ─────────────────────────────────────
const splash = [0, 1, 2].map((i) => ({
  "/v1/models": json({ data: [{ id: "glm-5.3-flash", owned_by: "splash" }] }),
  "/metrics": text(prom([
    `splash_decode_output_tokens_total ${900 + i * 70}`,
    `splash_prefill_input_tokens_total ${4000 + i * 1200}`,
    `splash_cache_reused_tokens_total ${10_000 + i * 6000}`,
    `splash_scheduler_prefilling ${i === 1 ? 1 : 0}`,
    `splash_scheduler_decoding ${i === 2 ? 0 : 1}`,
    `splash_scheduler_queued ${i === 1 ? 2 : 0}`,
    `splash_ttft_p95_milliseconds 420`,
    `splash_itl_p95_milliseconds 31`,
    `splash_draft_acceptance_ratio 0.64`,
    `splash_decode_tokens_per_second 45.1`,
    `splash_prefill_tokens_per_second 900.2`,
  ])),
}));

// ─── LM Studio: /api/v0/models (answers 200 + JSON on every path) ──────────
const lmstudioModels = json({
  object: "list",
  data: [
    { id: "text-embedding-nomic", type: "embeddings", state: "not-loaded", max_context_length: 2048 },
    { id: "qwen3-8b", type: "llm", publisher: "qwen", state: "loaded", max_context_length: 40960, loaded_context_length: 16384 },
  ],
});
const lmstudioCatchAll = json({ error: "Unexpected endpoint or method." });
const lmstudio = [0, 1, 2].map(() => ({
  "/v1/models": json({ data: [{ id: "qwen3-8b", owned_by: "organization_owner", object: "model" }] }),
  "/api/v0/models": lmstudioModels,
  "*": lmstudioCatchAll,
}));

// ─── Ollama: /api/tags + /api/ps ───────────────────────────────────────────
const ollama = [0, 1, 2].map(() => ({
  "/v1/models": json({ data: [{ id: "llama3.2:3b", owned_by: "library" }] }),
  "/api/tags": json({ models: [{ name: "llama3.2:3b", model: "llama3.2:3b", digest: "abc" }, { name: "qwen3:8b", model: "qwen3:8b", digest: "def" }] }),
  "/api/ps": json({ models: [{ name: "llama3.2:3b", model: "llama3.2:3b", context_length: 4096 }] }),
}));

export const NEW_ENGINES = {
  tensorfoldHealth,
  tensorfoldMetricsOnly,
  freetoken,
  strata,
  locals,
  splash,
  lmstudio,
  ollama,
};

/**
 * Build a fake `_fetch` that answers from `polls[ref.i]`.
 * @param {Array<Record<string, FixtureResponse>>} polls
 * @param {{ i: number }} ref
 */
export function fixtureFetch(polls, ref) {
  return async (url) => {
    const path = new URL(String(url)).pathname;
    const poll = polls[Math.min(ref.i, polls.length - 1)];
    const r = poll[path] ?? poll["*"];
    if (!r) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    }
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (r.json !== undefined) return r.json;
        return JSON.parse(r.text ?? "");
      },
      text: async () => (r.text !== undefined ? r.text : JSON.stringify(r.json)),
    };
  };
}

/**
 * Run every poll of a fixture through a fresh probe on a pinned clock.
 * @param {typeof import("../../LlmProbe.js").LlmProbe} LlmProbe
 * @param {Array<Record<string, FixtureResponse>>} polls
 */
export async function runFixture(LlmProbe, polls) {
  const ref = { i: 0, now: T0 };
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888, { now: () => ref.now });
  probe._fetch = fixtureFetch(polls, ref);
  const snaps = [];
  for (let i = 0; i < polls.length; i++) {
    ref.i = i;
    ref.now = T0 + i * POLL_MS;
    snaps.push(await probe.probe());
  }
  return snaps;
}
