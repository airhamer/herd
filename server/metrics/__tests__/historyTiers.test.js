import test from "node:test";
import assert from "node:assert/strict";
import {
  BUCKET_TIERS,
  HISTORY_RANGES,
  TierColumns,
  accMerge,
  accOf,
  accOut,
  isKnownKey,
  isRange,
  llmKey,
  parseLlmKey,
  regrid,
  wireRound,
} from "../historyTiers.js";

const M = 60_000;

test("tiers and ranges: each range fits its tier, on a stable grid of ≤ 500 points", () => {
  assert.deepEqual(BUCKET_TIERS.map((t) => [t.name, t.stepMs / M, t.retentionMs / M]), [
    ["1m", 1, 48 * 60],
    ["15m", 15, 30 * 24 * 60],
  ]);
  const summary = Object.entries(HISTORY_RANGES).map(([name, r]) => [name, BUCKET_TIERS[r.tier].name, r.stepMs / M]);
  assert.deepEqual(summary, [
    ["1h", "1m", 1],
    ["6h", "1m", 1],
    ["24h", "1m", 3],
    ["7d", "15m", 30],
    ["30d", "15m", 90],
  ]);
  for (const r of Object.values(HISTORY_RANGES)) {
    const tier = BUCKET_TIERS[r.tier];
    assert.ok(r.spanMs <= tier.retentionMs);
    assert.ok(r.spanMs / r.stepMs <= 500);
    assert.equal(r.stepMs % tier.stepMs, 0);
  }
  assert.equal(isRange("7d"), true);
  for (const bad of ["2h", "__proto__", "toString", "constructor", ["1h"], undefined]) assert.equal(isRange(bad), false);
});

test("series keys: unit names and llm:<port>:<series> only", () => {
  assert.equal(llmKey(8000, "genTps"), "llm:8000:genTps");
  assert.deepEqual(parseLlmKey("llm:8000:kvUsage"), { port: 8000, name: "kvUsage" });
  assert.equal(parseLlmKey("llm:8000:bogus"), null);
  assert.equal(parseLlmKey("llm:123456:genTps"), null);
  assert.equal(isKnownKey("gpuTemp"), true);
  assert.equal(isKnownKey("llm:1:prefillTps"), true);
  assert.equal(isKnownKey("diskIO"), false);
});

test("accumulators merge by weight and only free memory reports a minimum", () => {
  const a = accMerge(accMerge(accOf(10), accOf(20)), { sum: 90, max: 40, min: 20, n: 3 });
  assert.deepEqual(a, { sum: 120, max: 40, min: 10, n: 5 });
  assert.deepEqual(accOut("gpuUtil", a), { avg: 24, max: 40 });
  assert.deepEqual(accOut("memFreeMB", a), { avg: 24, max: 40, min: 10 });
  const fresh = accOf(1);
  const copy = accMerge(undefined, fresh);
  assert.notEqual(copy, fresh);
  assert.deepEqual(copy, fresh);
});

test("rounding for the wire: whole from 100, two places from 1, four below", () => {
  assert.equal(wireRound(1234.56), 1235);
  assert.equal(wireRound(-150.5), -150);
  assert.equal(wireRound(12.3456), 12.35);
  assert.equal(wireRound(0.123456), 0.1235);
});

test("columns: samples fold into aligned buckets, out-of-order ones included", () => {
  const cols = new TierColumns(BUCKET_TIERS[0]);
  cols.add(5 * M + 1_000, "cpuUtil", accOf(10));
  cols.add(5 * M + 30_000, "cpuUtil", accOf(30));
  cols.add(7 * M, "cpuUtil", accOf(50));
  cols.add(6 * M + 5, "memFreeMB", accOf(800)); // a clock that stepped back
  assert.deepEqual(cols.t, [5 * M, 6 * M, 7 * M]);
  const rows = cols.rowsSince(0);
  assert.deepEqual(
    rows.map((r) => [r.t / M, [...r.accs.keys()]]),
    [
      [5, ["cpuUtil"]],
      [6, ["memFreeMB"]],
      [7, ["cpuUtil"]],
    ]
  );
  assert.deepEqual(rows[0].accs.get("cpuUtil"), { sum: 40, max: 30, min: 20, n: 2 });
  assert.equal(cols.cut(6 * M), true);
  assert.deepEqual(cols.t, [6 * M, 7 * M]);
  assert.equal(cols.cut(0), false);
});

test("regrid merges rows into the coarser step by weight", () => {
  const rows = [
    { t: 0, accs: new Map([["x", { sum: 10, max: 10, min: 10, n: 1 }]]) },
    { t: M, accs: new Map([["x", { sum: 60, max: 40, min: 20, n: 2 }]]) },
    { t: 3 * M, accs: new Map([["x", { sum: 5, max: 5, min: 5, n: 1 }]]) },
  ];
  const out = regrid(rows, 3 * M);
  assert.deepEqual(out.map((r) => r.t), [0, 3 * M]);
  assert.deepEqual(out[0].accs.get("x"), { sum: 70, max: 40, min: 10, n: 3 });
});

test("file form: parallel columns, sorted keys, null/0 gaps; loading keeps only valid, aligned, retained cells", () => {
  const tier = BUCKET_TIERS[0];
  const cols = new TierColumns(tier);
  cols.add(0, "netTx", accOf(5));
  cols.add(0, "memFreeMB", accOf(700));
  cols.add(0, "memFreeMB", accOf(500));
  cols.add(M, "netTx", accOf(7));
  const form = cols.toFileForm(0);
  assert.deepEqual(form, {
    t: [0, M],
    series: {
      memFreeMB: { avg: [600, null], max: [700, null], min: [500, null], n: [2, 0] },
      netTx: { avg: [5, 7], max: [5, 7], n: [1, 1] },
    },
  });
  assert.equal(new TierColumns(tier).toFileForm(0), null);

  const now = 2 * 24 * 60 * M + M; // 48 h after t = M
  const loaded = TierColumns.fromFileForm(
    tier,
    {
      t: [0, M, M + 1, 3 * M],
      series: {
        netTx: { avg: [1, 2, 3, "x"], max: [1, 2, 3, 4], n: [1, 1, 1, 1] },
        bogus: { avg: [1, 1, 1, 1], max: [1, 1, 1, 1], n: [1, 1, 1, 1] },
        cpuUtil: { avg: [1, 1, 1, 1], max: [1, 1, 1, 1], n: [0, 1.5, 1, 1] },
      },
    },
    now
  );
  // t=0 is past the retention, M+1 is off the grid, the "x" and n=0/1.5 cells are invalid.
  assert.deepEqual(loaded.t, [M, 3 * M]);
  assert.deepEqual([...loaded.cols.keys()].sort(), ["cpuUtil", "netTx"]);
  assert.deepEqual(loaded.toFileForm(0).series.netTx, { avg: [2, null], max: [2, null], n: [1, 0] });
});
