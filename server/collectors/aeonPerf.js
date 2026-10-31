/**
 * AEON aeon-perf-v1 ladder: prompt sets, request tiling and cell aggregation.
 *
 * Adapted from AEON Bench Pod `mvp/pod/perf_grid.py` (MIT License,
 * Copyright (c) 2026 AEON-7, https://github.com/AEON-7/Aeon-Bench-Pod).
 * The prompt sets and the aggregation rules are ported from that file so
 * Herd's numbers line up with AEON's board. Licence text:
 * server/collectors/data/NOTICE.md. No sparkDash code is used.
 *
 * Pure module: no network, no clock. DecodeBench.js runs the requests and
 * hands the per-request timings to `aggregateCell` / `aggregateLevel`.
 *
 * AEON's two aggregate rates (do not confuse them):
 *   agg_decode_tps     peak wave concurrent-window tok/s. Each wave holds
 *                      `conc` requests started together; its rate is
 *                      Σ output_tokens / (max decode_t1 − min decode_t0).
 *                      The cell reports the peak wave. A one-request wave
 *                      reports that request's decode_tps.
 *   agg_saturated_est  decode_tps_mean × conc (Herd stores it as
 *                      `agg_sum_tps`, labelled separately).
 */

export const AEON_SUITE_ID = "aeon-perf-v1";
export const AEON_SUITE_VERSION = "1";
export const AEON_LADDER = Object.freeze([1, 4, 8, 16, 32]);
export const AEON_MAX_TOKENS = 256;
export const AEON_TEMPERATURE = 0;
export const AEON_SOURCE_URL =
  "https://github.com/AEON-7/Aeon-Bench-Pod/blob/main/mvp/pod/perf_grid.py";

const pad = (n, w) => String(n).padStart(w, "0");
const range = (from, toExcl) => Array.from({ length: toExcl - from }, (_, k) => from + k);

// ─── prompt sets (perf_grid.py PROMPTS; ~1,500-token long prompt each) ──

function longMath() {
  const lines = range(1, 61).map(
    (i) =>
      `2026-${pad((i % 12) + 1, 2)}-${pad((i % 28) + 1, 2)}  txn-${pad(i, 4)}  vendor-${pad(i % 17, 2)}` +
      `  amount: ${((i * 37) % 995) + 5}.${pad(i % 100, 2)} USD  memo: recurring service charge unit ${i % 9}`
  );
  return (
    "Below is a transaction ledger.\n" +
    lines.join("\n") +
    "\nHow many transactions are listed above? Reply with the number only."
  );
}

function longReasoning() {
  const lines = range(1, 66).map(
    (i) =>
      `Fact ${i}: person P${i % 23} was observed in room R${(i * 7) % 12} at hour ${(i * 3) % 24}` +
      ` holding badge B${i % 7} and wearing tag T${(i * 5) % 31}.`
  );
  return (
    "Consider the following facts.\n" +
    lines.join("\n") +
    "\nBased only on the facts above, name one room id that person P3 appears in." +
    " Reply with the room id only."
  );
}

function longCoding() {
  const chunks = range(1, 56).map(
    (i) =>
      `def util_${pad(i, 3)}(x):\n` +
      `    """helper ${i}: scales the input by ${i % 13} then offsets by ${i % 7}."""\n` +
      `    return x * ${i % 13} + ${i % 7}\n`
  );
  return (
    "Here is a Python module.\n```python\n" +
    chunks.join("\n") +
    "```\nHow many function definitions appear in the module above?" +
    " Reply with the number only."
  );
}

function longProse() {
  const lines = range(1, 46).map(
    (i) =>
      `In the ${i}th hour the harbor town kept its slow watch, and lamplighter ${i % 9}` +
      ` counted ${((i * 3) % 40) + 1} boats returning under a copper sky while bell ${i % 5} tolled.`
  );
  return (
    "Read the passage below.\n" +
    lines.join(" ") +
    "\nSummarize the passage above in exactly one sentence."
  );
}

function longInstruction() {
  const lines = range(1, 56).map(
    (i) =>
      `Rule ${i}: when the input index equals ${i}, respond in lowercase, keep the reply under` +
      ` ${(i % 9) + 3} words, and never mention the number ${(i * 11) % 97}.`
  );
  return (
    "Here is a rulebook.\n" +
    lines.join("\n") +
    "\nFollowing only Rule 7, write the single word ok."
  );
}

/** @type {Readonly<Record<string, readonly string[]>>} */
export const AEON_PROMPTS = Object.freeze({
  Math: Object.freeze([
    "Compute 847 * 63. Reply with the number only.",
    "What is 15% of 2400? Reply with the number only.",
    "Solve for x: 3x + 11 = 47. Reply with the number only.",
    longMath(),
  ]),
  Reasoning: Object.freeze([
    "If all bloops are razzies and all razzies are lazzies, are all bloops lazzies? Answer yes or no.",
    "A farmer has 17 sheep; all but 9 run away. How many are left? Reply with the number only.",
    "Which is heavier: a kilogram of steel or a kilogram of feathers? Answer in one word.",
    longReasoning(),
  ]),
  Coding: Object.freeze([
    "Write a Python function that reverses a string.",
    "Write a one-line Python list comprehension that squares the numbers 1 through 10.",
    "What does this print? print(sum(range(5))) Reply with the number only.",
    longCoding(),
  ]),
  Prose: Object.freeze([
    "Write a haiku about mountains.",
    "Write one sentence describing rain on a tin roof.",
    "Give a two-sentence opening for a mystery novel set in a lighthouse.",
    longProse(),
  ]),
  Instruction: Object.freeze([
    "Reply with exactly the word PONG.",
    "List three primary colors, one per line, with no other text.",
    "Write the word echo exactly five times, separated by commas.",
    longInstruction(),
  ]),
});

export const AEON_CATEGORIES = Object.freeze(Object.keys(AEON_PROMPTS));

/** AEON case id for one cell: `perf.direct.<cat>.c<n>` (cat lower-cased; "overall" for the level). */
export function aeonCaseId(category, conc) {
  return `perf.direct.${String(category).toLowerCase()}.c${conc}`;
}

/** Keep only ladder rungs, sorted and unique; empty input → the full ladder. */
export function normalizeAeonLadder(raw) {
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) return [...AEON_LADDER];
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const n = typeof v === "string" ? parseInt(v, 10) : Number(v);
    if (AEON_LADDER.includes(n) && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/** Requests one category cell sends at a level: max(prompts, conc). */
export function aeonCellSize(conc, repeats = 1) {
  return Math.max(Math.max(1, repeats) * 4, conc);
}

/** Total requests for a ladder (5 categories per rung). */
export function aeonRequestCount(ladder) {
  return ladder.reduce((s, c) => s + AEON_CATEGORIES.length * aeonCellSize(c), 0);
}

/**
 * perf_grid.py `_bust`: unique tag per replica so every stream pays real
 * prefill (no prefix-cache hit across replicas, levels or runs).
 */
export function aeonBust(prompt, i, salt = "") {
  return `[measurement ${salt}${pad(i, 4)}] ${prompt}`;
}

/** Salt for one cell: per-run nonce + level + first three letters of the category. */
export function aeonSalt(nonce, conc, category) {
  return `${nonce}-c${conc}-${String(category).slice(0, 3)}-`;
}

/** The busted prompts for one cell, tiled to max(4, conc) and cut into waves of `conc`. */
export function aeonCellWaves(category, conc, nonce) {
  const base = AEON_PROMPTS[category];
  if (!base) throw new Error(`Unknown AEON category ${category}`);
  const n = aeonCellSize(conc);
  const salt = aeonSalt(nonce, conc, category);
  const tasks = range(0, n).map((i) => aeonBust(base[i % base.length], i, salt));
  const waves = [];
  for (let i = 0; i < tasks.length; i += conc) waves.push(tasks.slice(i, i + conc));
  return waves;
}

/** The OpenAI chat body AEON sends (OpenAITarget._chat_stream). */
export function aeonRequestBody(modelId, prompt) {
  return {
    model: modelId || undefined,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    temperature: AEON_TEMPERATURE,
    max_tokens: AEON_MAX_TOKENS,
    stream_options: { include_usage: true },
  };
}

// ─── aggregation (perf_grid.py _mean / _pct / _r / _wave_throughput / _agg) ──

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Round to `nd` decimals (None → null), like perf_grid.py `_r`. */
export function aeonRound(x, nd = 2) {
  if (!isNum(x)) return null;
  const f = 10 ** nd;
  return Math.round(x * f) / f;
}

function meanOf(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Percentile with linear interpolation (perf_grid.py `_pct`). */
export function aeonPercentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const k = (p / 100) * (s.length - 1);
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (s[hi] - s[lo]) * (k - lo);
}

/**
 * Concurrent-window rate of one wave (successful requests of that wave).
 * @returns {{ rate: number | null, span: number | null }}
 */
export function aeonWaveThroughput(wave) {
  if (!wave || wave.length === 0) return { rate: null, span: null };
  if (wave.length === 1 && isNum(wave[0].decode_tps)) {
    return { rate: wave[0].decode_tps, span: null };
  }
  const starts = wave.map((r) => r.decode_t0).filter(isNum);
  const ends = wave.map((r) => r.decode_t1).filter(isNum);
  if (!starts.length || !ends.length) return { rate: null, span: null };
  const span = Math.max(...ends) - Math.min(...starts);
  if (!(span > 0)) return { rate: null, span: null };
  const toks = wave.reduce((s, r) => s + (r.output_tokens || 0), 0);
  return { rate: toks / span, span };
}

/**
 * Aggregate one cell (perf_grid.py `_agg`, client token counts).
 *
 * @param {object[][]} waves  successful requests grouped by the wave they ran in
 * @param {number} wallS      cell wall clock in seconds
 * @param {{ conc: number, nErrors?: number }} opts
 */
export function aggregateCell(waves, wallS, { conc, nErrors = 0 }) {
  const reqs = waves.flat();
  const pick = (k) => reqs.map((r) => r[k]).filter((v) => v !== null && v !== undefined);
  const ttfts = pick("ttft_ms");
  const dtps = pick("decode_tps");
  const ptps = pick("prefill_tps");
  const e2es = pick("e2e_ms");
  const tpots = pick("tpot_ms");
  const outSum = reqs.reduce((s, r) => s + (r.output_tokens || 0), 0);
  const inSum = reqs.reduce((s, r) => s + (r.input_tokens || 0), 0);
  const decodeMean = aeonRound(meanOf(dtps));
  const tokWall = wallS > 0 ? aeonRound(outSum / wallS) : null;
  const concN = Number.isInteger(conc) && conc > 0 ? conc : null;
  const saturated = decodeMean !== null && concN ? aeonRound(decodeMean * concN) : null;

  let agg = null;
  let aggSource = null;
  let windowS = null;
  /** @type {{ rate: number, span: number | null }[]} */
  const rates = [];
  for (const wave of waves) {
    const r = aeonWaveThroughput(wave);
    if (r.rate !== null) rates.push(/** @type {{ rate: number, span: number | null }} */ (r));
  }
  if (rates.length) {
    const peak = rates.reduce((best, r) => (r.rate > best.rate ? r : best));
    agg = aeonRound(peak.rate);
    aggSource = "wave_peak_concurrent_window";
    if (peak.span !== null) windowS = aeonRound(peak.span, 3);
  }
  if (agg === null && concN === 1 && dtps.length) {
    agg = aeonRound(Math.max(...dtps));
    aggSource = "c1_decode_peak";
  }
  if (agg === null && saturated !== null) {
    agg = saturated;
    aggSource = "saturated_est_decode_x_conc";
  }
  if (agg === null) {
    agg = tokWall;
    aggSource = tokWall !== null ? "tokens_per_wall" : null;
  }

  return {
    n: reqs.length,
    n_errors: nErrors,
    ttft_ms_mean: aeonRound(meanOf(ttfts)),
    ttft_ms_p50: aeonRound(aeonPercentile(ttfts, 50)),
    ttft_ms_p95: aeonRound(aeonPercentile(ttfts, 95)),
    decode_tps_mean: decodeMean,
    prefill_tps_mean: aeonRound(meanOf(ptps)),
    e2e_ms_mean: aeonRound(meanOf(e2es)),
    tpot_ms_mean: aeonRound(meanOf(tpots), 3),
    tpot_ms_p50: aeonRound(aeonPercentile(tpots, 50), 3),
    tpot_ms_p95: aeonRound(aeonPercentile(tpots, 95), 3),
    output_tokens_total: outSum,
    input_tokens_total: inSum,
    agg_decode_tps: agg,
    agg_source: aggSource,
    concurrent_window_s: windowS,
    agg_saturated_est: saturated,
    conc: concN,
    wave_count: rates.length || null,
    tokens_per_wall_s: tokWall,
    tokens_source: "client",
  };
}

/**
 * Level summary: categories ran one after another, so the overall peak is
 * the best category cell (AEON `peak_category_cell`), never a
 * cross-category pseudo-wave. Other overall stats pool every request over
 * the summed cell walls.
 *
 * @param {Record<string, { cell: ReturnType<typeof aggregateCell>, waves: object[][], wallS: number }>} cells
 * @param {number} conc
 */
export function aggregateLevel(cells, conc) {
  const entries = Object.values(cells);
  const allWaves = entries.flatMap((c) => c.waves);
  const wallSum = entries.reduce((s, c) => s + c.wallS, 0);
  const nErrors = entries.reduce((s, c) => s + (c.cell.n_errors || 0), 0);
  const overall = aggregateCell(allWaves, wallSum, { conc, nErrors });
  let best = null;
  for (const c of entries) {
    if (isNum(c.cell.agg_decode_tps) && (!best || c.cell.agg_decode_tps > best.agg_decode_tps)) best = c.cell;
  }
  if (best) {
    overall.agg_decode_tps = best.agg_decode_tps;
    overall.agg_source = "peak_category_cell";
    overall.concurrent_window_s = best.concurrent_window_s;
  }
  return { overall, wallClockS: aeonRound(wallSum, 3) };
}

/**
 * One request's AEON row from a Herd streaming result
 * (LlmStreaming.runStreamingRequest). Times are seconds on the
 * performance.now() clock, as perf_grid.py uses perf_counter.
 *
 * @param {any} r
 * @param {string} category
 */
export function aeonRequestRow(r, category) {
  const ttft = r.tFirst != null ? aeonRound(r.ttftMs) : null;
  const decode = isNum(r.decodeTps) && r.decodeTps > 0 ? aeonRound(r.decodeTps) : null;
  const inTok = isNum(r.prefillTokens) && r.prefillTokens > 0 ? r.prefillTokens : null;
  const tEnd = isNum(r.t0) && isNum(r.totalMs) ? r.t0 + r.totalMs : null;
  const d0 = r.tFirst != null ? r.tFirst / 1000 : null;
  const d1 = d0 === null ? null : decode !== null && r.tLast != null ? r.tLast / 1000 : tEnd !== null ? tEnd / 1000 : null;
  return {
    category,
    ttft_ms: ttft,
    decode_tps: decode,
    prefill_tps: inTok && ttft && ttft > 0 ? aeonRound(inTok / (ttft / 1000)) : null,
    e2e_ms: aeonRound(r.totalMs),
    tpot_ms: decode ? aeonRound(1000 / decode, 3) : null,
    output_tokens: r.completionTokens || 0,
    input_tokens: inTok,
    decode_t0: d0,
    decode_t1: d1,
  };
}
