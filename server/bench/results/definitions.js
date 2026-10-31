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
    formula: "Median decode tok/s of repeated single-stream greedy (temperature 0) requests.",
    url: null,
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
    formula: "AEON wave_peak_concurrent_window: Σ tokens over the concurrent window of a wave.",
    url: null,
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
    formula: "AEON agg_saturated_est: Σ of per-stream mean decode rates.",
    url: null,
  },
  {
    name: "mia.agg_sum_per_request.v1",
    metric: "agg_sum_tps",
    owner: "MiaAI-Lab",
    comparable: "agg_sum_of_stream_rates",
    formula: "Sum of per-request decode speeds of the concurrent requests.",
    url: null,
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
