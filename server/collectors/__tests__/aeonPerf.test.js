/**
 * AEON aeon-perf-v1 ladder (#43): prompts, tiling, request body and the
 * wave-peak concurrent-window aggregate.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import crypto from "crypto";
import {
  AEON_CATEGORIES,
  AEON_LADDER,
  AEON_MAX_TOKENS,
  AEON_PROMPTS,
  aeonBust,
  aeonCaseId,
  aeonCellWaves,
  aeonPercentile,
  aeonRequestBody,
  aeonRequestCount,
  aeonRequestRow,
  aeonWaveThroughput,
  aggregateCell,
  aggregateLevel,
  normalizeAeonLadder,
} from "../aeonPerf.js";

test("prompts are AEON's, byte for byte (pinned hash of the frozen set)", () => {
  // sha256 of json.dumps(PROMPTS, separators=(",", ":")) from perf_grid.py.
  const h = crypto.createHash("sha256").update(JSON.stringify(AEON_PROMPTS)).digest("hex");
  assert.equal(h, "157121a8f326c3711475709b5dcc88295a578180f95a1643f2808502682b4cae");
  assert.deepEqual(AEON_CATEGORIES, ["Math", "Reasoning", "Coding", "Prose", "Instruction"]);
  for (const cat of AEON_CATEGORIES) {
    assert.equal(AEON_PROMPTS[cat].length, 4);
    // Each category's fourth prompt is the ~1,500-token long prompt.
    const chars = AEON_PROMPTS[cat][3].length;
    assert.ok(chars / 4 > 1300 && chars / 4 < 1800, `${cat} long prompt is ${chars} chars`);
  }
});

test("ladder, tiling and request counts follow AEON", () => {
  assert.deepEqual(AEON_LADDER, [1, 4, 8, 16, 32]);
  assert.equal(AEON_MAX_TOKENS, 256);
  assert.deepEqual(normalizeAeonLadder(undefined), [1, 4, 8, 16, 32]);
  assert.deepEqual(normalizeAeonLadder(["8", 2, 1, 8, 64]), [1, 8]);
  assert.deepEqual(normalizeAeonLadder([3]), []);
  assert.equal(aeonRequestCount([...AEON_LADDER]), 5 * (4 + 4 + 8 + 16 + 32));
  assert.equal(aeonRequestCount([...AEON_LADDER]), 320);

  const c1 = aeonCellWaves("Coding", 1, "abc123");
  assert.equal(c1.length, 4);
  assert.ok(c1.every((w) => w.length === 1));
  const c8 = aeonCellWaves("Reasoning", 8, "abc123");
  assert.deepEqual(c8.map((w) => w.length), [8]);
  const c32 = aeonCellWaves("Prose", 32, "abc123");
  assert.deepEqual(c32.map((w) => w.length), [32]);
  assert.equal(c32[0][5], aeonBust(AEON_PROMPTS.Prose[1], 5, "abc123-c32-Pro-"));
  assert.ok(c32[0][5].startsWith("[measurement abc123-c32-Pro-0005] "));
  assert.equal(new Set(c32[0]).size, 32, "every replica is cache-busted");
  assert.equal(aeonCaseId("Instruction", 16), "perf.direct.instruction.c16");
});

test("request body is exactly AEON's", () => {
  assert.deepEqual(aeonRequestBody("m", "hi"), {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    temperature: 0,
    max_tokens: 256,
    stream_options: { include_usage: true },
  });
});

const row = (t0, t1, out, decode = (out - 1) / (t1 - t0)) => ({
  ttft_ms: 100,
  decode_tps: decode,
  prefill_tps: 1000,
  e2e_ms: 1000,
  tpot_ms: 1000 / decode,
  output_tokens: out,
  input_tokens: 100,
  decode_t0: t0,
  decode_t1: t1,
});

test("wave window = Σ output tokens / (max t_last − min t_first)", () => {
  const wave = [row(0, 10, 101), row(2, 12, 101), row(4, 14, 101)];
  const r = aeonWaveThroughput(wave);
  assert.equal(r.span, 14);
  assert.equal(r.rate, 303 / 14);
  // one-request wave → that request's decode rate
  assert.deepEqual(aeonWaveThroughput([row(0, 10, 101)]), { rate: 10, span: null });
  assert.deepEqual(aeonWaveThroughput([]), { rate: null, span: null });
});

test("cell agg is the peak wave; agg_saturated_est is decode_mean × conc", () => {
  // conc 2: two waves; the second is faster.
  const waves = [
    [row(0, 10, 101), row(0, 10, 101)], // 202 / 10 = 20.2
    [row(10, 15, 101), row(11, 16, 101)], // 202 / 6 = 33.67
  ];
  const cell = aggregateCell(waves, 16, { conc: 2 });
  assert.equal(cell.agg_source, "wave_peak_concurrent_window");
  assert.equal(cell.agg_decode_tps, 33.67);
  assert.equal(cell.concurrent_window_s, 6);
  assert.equal(cell.wave_count, 2);
  assert.equal(cell.decode_tps_mean, 15); // (10 + 10 + 20 + 20) / 4
  assert.equal(cell.agg_saturated_est, 30);
  assert.equal(cell.n, 4);
  assert.equal(cell.tokens_per_wall_s, 25.25);
  // AEON's published example: 23.55 tok/s per stream × 8 streams.
  const eight = [[...Array(8)].map(() => row(0, 1, 2, 23.55))];
  assert.equal(aggregateCell(eight, 1, { conc: 8 }).agg_saturated_est, 188.4);
});

test("c1 cell: one-request waves report the peak single-stream decode", () => {
  const waves = [[row(0, 10, 101)], [row(20, 25, 101)], [row(30, 40, 51)]];
  const cell = aggregateCell(waves, 40, { conc: 1 });
  assert.equal(cell.agg_decode_tps, 20);
  assert.equal(cell.agg_source, "wave_peak_concurrent_window");
  assert.equal(cell.concurrent_window_s, null);
  assert.equal(cell.agg_saturated_est, cell.decode_tps_mean);
});

test("fallbacks: saturated estimate, then tokens per wall", () => {
  const noTimes = [[{ ...row(0, 1, 11, 10), decode_t0: null, decode_t1: null }, { ...row(0, 1, 11, 10), decode_t0: null, decode_t1: null }]];
  const a = aggregateCell(noTimes, 2, { conc: 2 });
  assert.equal(a.agg_source, "saturated_est_decode_x_conc");
  assert.equal(a.agg_decode_tps, 20);
  const none = [[{ ...row(0, 1, 11, 10), decode_tps: null, decode_t0: null, decode_t1: null }]];
  const b = aggregateCell(none, 2, { conc: 4 });
  assert.equal(b.agg_source, "tokens_per_wall");
  assert.equal(b.agg_decode_tps, 5.5);
  assert.equal(aggregateCell([], 0, { conc: 4 }).agg_decode_tps, null);
});

test("level overall agg = best category cell (peak_category_cell)", () => {
  const mk = (rate, wallS) => {
    const waves = [[row(0, 10, rate * 10 + 1), row(0, 10, rate * 10 + 1)]];
    return { cell: aggregateCell(waves, wallS, { conc: 2, nErrors: 1 }), waves, wallS };
  };
  const cells = { Coding: mk(10, 10), Math: mk(30, 10), Prose: mk(20, 10) };
  const { overall, wallClockS } = aggregateLevel(cells, 2);
  assert.equal(overall.agg_source, "peak_category_cell");
  assert.equal(overall.agg_decode_tps, cells.Math.cell.agg_decode_tps);
  assert.equal(overall.n, 6);
  assert.equal(overall.n_errors, 3);
  assert.equal(wallClockS, 30);
  assert.equal(overall.agg_saturated_est, Math.round(overall.decode_tps_mean * 2 * 100) / 100);
});

test("linear-interpolation percentiles", () => {
  assert.equal(aeonPercentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(aeonPercentile([10, 20], 95), 19.5);
  assert.equal(aeonPercentile([7], 95), 7);
  assert.equal(aeonPercentile([], 50), null);
});

test("request row maps a Herd stream to AEON fields (seconds clock)", () => {
  const r = aeonRequestRow(
    { ttftMs: 200, decodeTps: 50, prefillTokens: 400, completionTokens: 101, totalMs: 2200, t0: 1000, tFirst: 1200, tLast: 3200 },
    "Coding"
  );
  assert.deepEqual(r, {
    category: "Coding",
    ttft_ms: 200,
    decode_tps: 50,
    prefill_tps: 2000,
    e2e_ms: 2200,
    tpot_ms: 20,
    output_tokens: 101,
    input_tokens: 400,
    decode_t0: 1.2,
    decode_t1: 3.2,
  });
  const single = aeonRequestRow({ ttftMs: 5, decodeTps: null, completionTokens: 1, totalMs: 9, t0: 0, tFirst: 5, tLast: 5 }, "Coding");
  assert.equal(single.decode_tps, null);
  assert.equal(single.decode_t1, 0.009);
});
