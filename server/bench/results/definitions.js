/**
 * Named metric definitions for the bench results store.
 *
 * Every stored number carries the name of the definition it was computed
 * with. Different projects publish numbers under the same label
 * ("aggregate tok/s") that mean different things, so the store never
 * compares two numbers unless their definitions sit in the same
 * `comparable` group.
 *
 * Adding a definition is append-only: never change the meaning of an
 * existing name. Bump the `.vN` suffix instead.
 */

/** Metric kinds a result row may carry. */
export const METRICS = Object.freeze({
  decode_tps_stream: { unit: "tok/s", better: "higher", label: "Per-stream decode" },
  agg_window_tps: { unit: "tok/s", better: "higher", label: "Aggregate decode (window)" },
  agg_sum_tps: { unit: "tok/s", better: "higher", label: "Aggregate decode (sum of streams)" },
  prefill_tps: { unit: "tok/s", better: "higher", label: "Prefill" },
  server_generation_tps: { unit: "tok/s", better: "higher", label: "Engine-reported generation" },
  ttft_p50: { unit: "ms", better: "lower", label: "TTFT p50" },
  ttft_p95: { unit: "ms", better: "lower", label: "TTFT p95" },
  tpot_p95: { unit: "ms", better: "lower", label: "Time per output token p95" },
  accuracy_pct: { unit: "%", better: "higher", label: "Accuracy" },
  wh_per_1k_tokens: { unit: "Wh/1k tok", better: "lower", label: "Energy per 1k tokens" },
});

/**
 * Source tiers (Page §3). Lower tier = closer to the hardware/engine.
 * `reference` = a published number we did not measure (no tier).
 */
export const SOURCES = Object.freeze({
  counter: { tier: 1, label: "Engine/hardware counter" },
  native: { tier: 2, label: "Native tool (nvidia-smi, engine log)" },
  proxy: { tier: 3, label: "Proxy observation" },
  client: { tier: 4, label: "Client-side timing" },
  reference: { tier: null, label: "Published reference (not measured by Herd)" },
});

export const ORIGINS = Object.freeze(["herd", "reference", "aeon-pod"]);

/**
 * @typedef {object} MetricDefinition
 * @property {string} name        stable id, `<owner>.<what>.vN`
 * @property {string} metric      key of METRICS this definition produces
 * @property {string} owner       who publishes numbers under this definition
 * @property {string} comparable  equivalence group; only equal groups compare
 * @property {string} formula     plain-language formula
 * @property {string|null} url    where the definition is documented, if public
 */

/** @type {MetricDefinition[]} */
const LIST = [
  // ── Per-stream decode ──────────────────────────────────────────────
  {
    name: "herd.decode.stream_mean.v1",
    metric: "decode_tps_stream",
    owner: "herd",
    comparable: "stream_post_first_token_mean",
    formula:
      "Mean over successful streams of (completion_tokens − 1) / (t_last_token − t_first_token), at the run's concurrency.",
    url: null,
  },
  {
    name: "hasso.single_stream_greedy_median.v1",
    metric: "decode_tps_stream",
    owner: "Hasso bench.sh",
    comparable: "single_stream_greedy_median",
    formula:
      "Hasso bench.sh greedy median: Python statistics.median of the timed runs of the code and reasoning probes (temperature 0, max_tokens 1200, two streamed runs each); per run (completion_tokens − 1) / (t_last_token − t_first_token), reasoning chunks counted. Math (temperature 0.6) and free prose never enter it.",
    url: "https://github.com/hasso5703/dgx-spark-qwen38/blob/main/bench.sh",
  },
  {
    name: "hasso.bench_probe_median.v1",
    metric: "decode_tps_stream",
    owner: "Hasso bench.sh",
    comparable: "hasso_bench_probe",
    formula:
      "One bench.sh probe (code / reasoning greedy, math peak at temperature 0.6, free prose greedy worst case): median of its two streamed single-stream runs, each (completion_tokens − 1) / (t_last_token − t_first_token).",
    url: "https://github.com/hasso5703/dgx-spark-qwen38/blob/main/bench.sh",
  },
  {
    name: "hasso.matrix_two_call_delta.v1",
    metric: "decode_tps_stream",
    owner: "Hasso bench-matrix.sh",
    comparable: "single_stream_two_call_delta",
    formula:
      "Hasso bench-matrix.sh battery v1, decode net of prefill: the same prompt sent twice, not streamed, temperature 0, at max_tokens 80 and 680; (completion_tokens₆₈₀ − completion_tokens₈₀) / (wall₆₈₀ − wall₈₀). Refused (no value) when Δtokens < 50 or Δwall < 2.0 s. One discarded warm-up call first.",
    url: "https://github.com/hasso5703/dgx-spark-qwen38/blob/main/bench-matrix.sh",
  },
  {
    name: "herd.showcase.stream_mean_estimated.v1",
    metric: "decode_tps_stream",
    owner: "herd",
    comparable: "showcase_stream_mean_estimated",
    formula:
      "Mean of Showcase per-stream decode rates; token counts may be estimated from streamed characters when the engine sends no usage, so not comparable with DecodeBench.",
    url: null,
  },
  // ── Fleet Showcase (SHOW1) ─────────────────────────────────────────
  {
    name: "herd.showcase.agg_window_estimated.v1",
    metric: "agg_window_tps",
    owner: "herd",
    comparable: "showcase_agg_window_estimated",
    formula:
      "Σ post-first-token tokens of one Showcase wave's ok streams (one Spark, or one fleet lane) / (max t_last_token − min t_first_token); tokens from usage.completion_tokens, else ~4 chars/token, so not comparable with DecodeBench.",
    url: null,
  },
  // ── Showcase concurrent window, usage tokens only (SHOW2, #40) ─────
  {
    name: "herd.showcase.agg_window.v1",
    metric: "agg_window_tps",
    owner: "herd",
    comparable: "agg_concurrent_window",
    formula:
      "Σ post-first-token tokens (usage.completion_tokens) of a Showcase wave's ok streams / (max t_last_token − min t_first_token); same definition as DecodeBench's concurrent window. Waves with any ~4 chars/token estimate use herd.showcase.agg_window_estimated.v1.",
    url: null,
  },
  {
    name: "herd.showcase.prefill_ttft.v1",
    metric: "prefill_tps",
    owner: "herd",
    comparable: "showcase_prefill_ttft_mean",
    formula:
      "Mean over a lane's Showcase streams of prompt_tokens / TTFT (short prompts, prefix cache allowed; includes queueing), so not comparable with PrefillBench.",
    url: null,
  },
  {
    name: "aeon.decode_tps_mean.v1",
    metric: "decode_tps_stream",
    owner: "AEON",
    comparable: "stream_post_first_token_mean",
    formula:
      "AEON aeon-perf-v1 decode_tps_mean: mean over successful requests of (output_tokens − 1) / (t_last_token − t_first_token).",
    url: "https://github.com/AEON-7/Aeon-Bench-Pod/blob/main/mvp/pod/perf_grid.py",
  },
  // ── Aggregate decode: concurrent window ────────────────────────────
  {
    name: "herd.decode.agg_window.v1",
    metric: "agg_window_tps",
    owner: "herd",
    comparable: "agg_concurrent_window",
    formula:
      "Σ post-first-token decode tokens over all streams / (max t_last_token − min t_first_token) of the wave.",
    url: null,
  },
  {
    name: "sparkdash.agg_window.v1",
    metric: "agg_window_tps",
    owner: "sparkDash DecodeBench",
    comparable: "agg_concurrent_window",
    formula: "Σ tokens over the concurrent window (max t_last − min t_first).",
    url: null,
  },
  {
    name: "aeon.wave_peak_concurrent_window.v1",
    metric: "agg_window_tps",
    owner: "AEON",
    comparable: "agg_concurrent_window",
    formula:
      "AEON wave_peak_concurrent_window (aeon-perf-v1 agg_decode_tps): requests run in waves of `concurrency`; a wave's rate is Σ output tokens / (max t_last_token − min t_first_token); the cell reports the peak wave, and a one-request wave reports that request's decode rate. Level overall = best category cell.",
    url: "https://github.com/AEON-7/Aeon-Bench-Pod/blob/main/mvp/pod/perf_grid.py",
  },
  // ── Aggregate decode: published-only definitions (BENCH5 reference registry) ──
  // Each sits in a group of its own: Herd measures nothing under them.
  {
    name: "hasso.vllm_bench_serve_output.v1",
    metric: "agg_window_tps",
    owner: "Hasso (vllm bench serve)",
    comparable: "vllm_bench_serve_output_throughput",
    formula:
      "vLLM's `vllm bench serve` output token throughput at a fixed number of concurrent streams: total output tokens / total benchmark duration. The duration runs from the first request sent to the last response done, so prefill and TTFT are inside it.",
    url: "https://github.com/hasso5703/dgx-spark-qwen38/blob/main/docs/kolibri-lane.md",
  },
  {
    name: "hasso.real_jobs_in_all.v1",
    metric: "agg_window_tps",
    owner: "Hasso",
    comparable: "hasso_real_jobs_in_all",
    formula:
      "Hasso's tok/s 'in all' on five real jobs at N concurrent requests, with the checkpoint's own sampling (reasoning tokens included): tokens produced by all the requests / the time they took together. The source does not say whether the clock starts at send or at first token, so it compares with nothing else.",
    url: "https://github.com/hasso5703/dgx-spark-qwen38/blob/main/docs/ornith-lane.md",
  },
  {
    name: "aeon.agg_tokens_per_cell_wall.v1",
    metric: "agg_window_tps",
    owner: "AEON",
    comparable: "tokens_per_cell_wall",
    formula:
      "AEON's legacy board aggregate (agg_decode_tps before the fix): Σ output tokens of a category cell / the cell's wall clock (TTFT + decode + drain). Not a decode rate; AEON's locked definition is aeon.wave_peak_concurrent_window.v1.",
    url: "https://github.com/AEON-7/Aeon-Bench-Pod/blob/main/docs/spark-perf-180-vs-74.md",
  },
  // ── Aggregate decode: sum of per-stream rates ──────────────────────
  {
    name: "herd.decode.agg_sum.v1",
    metric: "agg_sum_tps",
    owner: "herd",
    comparable: "agg_sum_of_stream_rates",
    formula: "Σ over successful streams of the per-stream decode rate (herd.decode.stream_mean.v1 × n).",
    url: null,
  },
  {
    name: "aeon.agg_saturated_est.v1",
    metric: "agg_sum_tps",
    owner: "AEON",
    comparable: "agg_sum_of_stream_rates",
    formula:
      "AEON agg_saturated_est (aeon-perf-v1): mean per-stream decode rate × concurrency, i.e. the Σ of per-stream rates of a full wave.",
    url: "https://github.com/AEON-7/Aeon-Bench-Pod/blob/main/mvp/pod/perf_grid.py",
  },
  {
    name: "mia.agg_sum_per_request.v1",
    metric: "agg_sum_tps",
    owner: "MiaAI-Lab",
    comparable: "agg_sum_of_stream_rates",
    formula: "Sum of per-request decode speeds of the concurrent requests.",
    url: "https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold#performance",
  },
  // ── Prefill ────────────────────────────────────────────────────────
  {
    name: "herd.prefill.single_request.v1",
    metric: "prefill_tps",
    owner: "herd",
    comparable: "prefill_single_request_cold",
    formula:
      "prompt_tokens / TTFT for one request with a unique salted prefix (no prefix-cache hit), sizes run sequentially.",
    url: null,
  },
  {
    name: "herd.decode.prefill_window.v1",
    metric: "prefill_tps",
    owner: "herd",
    comparable: "prefill_concurrent_window",
    formula: "Σ prompt tokens of a DecodeBench wave / (max t_first_token − min t_request_start).",
    url: null,
  },
  {
    name: "aeon.prefill_tps_mean.v1",
    metric: "prefill_tps",
    owner: "AEON",
    comparable: "prefill_per_request_mean",
    formula: "AEON aeon-perf-v1 prefill_tps_mean: mean over requests of prompt_tokens / TTFT (s), every prompt cache-busted.",
    url: "https://github.com/AEON-7/Aeon-Bench-Pod/blob/main/mvp/pod/perf_grid.py",
  },
  {
    name: "mia.sparkdash_prefill.v1",
    metric: "prefill_tps",
    owner: "MiaAI-Lab sparkDash",
    comparable: "mia_sparkdash_prefill",
    formula:
      "Prefill rate published by MiaAI-Lab's sparkDash Prefill benchmark for one prompt of the stated size. The formula is not stated (prompt tokens / TTFT reproduces one published row but not another), so it compares with nothing else.",
    url: "https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold#performance",
  },
  // ── Engine counters ────────────────────────────────────────────────
  {
    name: "herd.engine.generation_tps_counter.v1",
    metric: "server_generation_tps",
    owner: "herd",
    comparable: "engine_generation_counter",
    formula: "Engine-reported generation throughput sampled from its metrics endpoint during the run (mean).",
    url: null,
  },
  // ── Latency ────────────────────────────────────────────────────────
  {
    name: "herd.ttft.client_first_token.v1",
    metric: "ttft_p50",
    owner: "herd",
    comparable: "client_ttft_p50",
    formula: "p50 over successful streams of (first streamed token − request sent), measured by the Herd client.",
    url: null,
  },
  {
    name: "herd.ttft.client_first_token_p95.v1",
    metric: "ttft_p95",
    owner: "herd",
    comparable: "client_ttft_p95",
    formula: "p95 (nearest rank) over successful streams of (first streamed token − request sent).",
    url: null,
  },
  {
    name: "herd.tpot.client_stream.v1",
    metric: "tpot_p95",
    owner: "herd",
    comparable: "client_tpot_p95",
    formula: "p95 (nearest rank) over streams of 1000 / per-stream decode tok/s, in ms per output token.",
    url: null,
  },
  {
    name: "aeon.ttft_p95_linear.v1",
    metric: "ttft_p95",
    owner: "AEON",
    comparable: "client_ttft_p95_linear",
    formula: "AEON aeon-perf-v1 ttft_ms_p95: 95th percentile (linear interpolation) of client TTFT over successful requests.",
    url: "https://github.com/AEON-7/Aeon-Bench-Pod/blob/main/mvp/pod/perf_grid.py",
  },
  {
    name: "aeon.tpot_p95_linear.v1",
    metric: "tpot_p95",
    owner: "AEON",
    comparable: "client_tpot_p95_linear",
    formula: "AEON aeon-perf-v1 tpot_ms_p95: 95th percentile (linear interpolation) of 1000 / per-request decode tok/s.",
    url: "https://github.com/AEON-7/Aeon-Bench-Pod/blob/main/mvp/pod/perf_grid.py",
  },
  // ── Quality / energy (populated by later bench issues) ─────────────
  {
    name: "herd.quality.item_pass_rate.v1",
    metric: "accuracy_pct",
    owner: "herd",
    comparable: "item_pass_rate",
    formula: "100 × passed items / scored items of the prompt set; per-item vector kept in `quality`.",
    url: null,
  },
  {
    name: "herd.quality.category_mean.v1",
    metric: "accuracy_pct",
    owner: "herd",
    comparable: "quality_category_mean",
    formula:
      "Quality bench overall score: unweighted mean of the per-category item pass rates (herd.quality.item_pass_rate.v1) of the run's categories. Errored items are not scored.",
    url: null,
  },
  {
    name: "aeon.suite_case_mean_score.v1",
    metric: "accuracy_pct",
    owner: "AEON",
    comparable: "aeon_case_mean_score",
    formula:
      "AEON Bench Pod text suite (aeon-suite-v4): 100 × mean case score (0–1, partial credit from the case's deterministic checker; Tier-1 cases only with a frontier judge) over the scored cases of the category, or of the run for `overall`. Unscored cases (needs_frontier_judge, errors) are left out. The per-case vector counts score ≥ 0.5 as a pass.",
    url: "https://github.com/AEON-7/Aeon-Bench-Pod/blob/main/docs/run-a-benchmark.md",
  },
  {
    name: "aeon.agentic_task_mean_score.v1",
    metric: "accuracy_pct",
    owner: "AEON",
    comparable: "aeon_agentic_task_mean_score",
    formula:
      "AEON Bench Pod agentic suite (aeon-agentic-v2.5): 100 × mean task score (0–1, the task's checker run in the harness sandbox) over the scored tasks of one harness run (Hermes, OpenClaw or OpenCode). Harnesses differ, so only runs of the same harness compare. The per-task vector counts score ≥ 0.5 as a pass.",
    url: "https://github.com/AEON-7/Aeon-Bench-Pod/blob/main/docs/run-a-benchmark.md",
  },
  {
    name: "reference.accuracy_published.v1",
    metric: "accuracy_pct",
    owner: "reference",
    comparable: "published_accuracy",
    formula: "Accuracy as published by the reference source; scoring method per its URL.",
    url: null,
  },
  {
    name: "herd.energy.gpu_power_wave.v1",
    metric: "wh_per_1k_tokens",
    owner: "herd",
    comparable: "gpu_power_over_wave",
    formula:
      "Mean sampled GPU power (W) × wave duration (h) / (completion tokens / 1000). GPU board power only; approximate.",
    url: null,
  },
  {
    name: "herd.energy.node_tracker_run.v1",
    metric: "wh_per_1k_tokens",
    owner: "herd",
    comparable: "node_power_estimate_over_run",
    formula:
      "Fleet energy tracker estimate of the benched node's power (GPU draw + CPU estimate + 23 W platform) integrated over the run window, scaled up by sample coverage, / (output tokens of the run / 1000). Whole run, all concurrency levels; approximate (BENCH6).",
    url: null,
  },
];

export const DEFINITIONS = Object.freeze(
  Object.fromEntries(LIST.map((d) => [d.name, Object.freeze({ ...d })]))
);

/** @param {string} name */
export function getDefinition(name) {
  return Object.prototype.hasOwnProperty.call(DEFINITIONS, name) ? DEFINITIONS[name] : null;
}

/** All definitions as a plain array (API listing). */
export function listDefinitions() {
  return LIST.map((d) => ({ ...d, unit: METRICS[d.metric].unit }));
}

/**
 * True when two definition names may be compared number-to-number.
 * @param {string} a
 * @param {string} b
 */
export function definitionsComparable(a, b) {
  const da = getDefinition(a);
  const db = getDefinition(b);
  if (!da || !db) return false;
  return da.metric === db.metric && da.comparable === db.comparable;
}
