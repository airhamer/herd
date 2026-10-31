import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BenchResultsStore } from "../../results/store.js";
import { makeResult } from "../../results/schema.js";
import { referenceRecord } from "../../results/__tests__/fixtures.js";
import { parseRunIds, upgradeCompare } from "../compare.js";
import { decodeRun, passes, qualityRun } from "./helpers.js";

function storeWith(t, ...runs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-upgrade-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new BenchResultsStore({ path: path.join(dir, "bench-results.json"), log: () => {} });
  for (const recs of runs) {
    const res = store.upsertMany(recs);
    assert.deepEqual(res.rejected, [], JSON.stringify(res.rejected));
  }
  return store;
}

test("parseRunIds splits, trims and dedupes", () => {
  assert.deepEqual(parseRunIds(" a, b ,a,,"), ["a", "b"]);
  assert.deepEqual(parseRunIds(["x", "x"]), ["x"]);
  assert.deepEqual(parseRunIds(undefined), []);
});

test("clean win: throughput outside the default band, quality flat", (t) => {
  const store = storeWith(
    t,
    decodeRun("b1", { c1: 50, c4: 180 }),
    decodeRun("b2", { c1: 60, c4: 220, engineVersion: "0.11.0", day: 2 }),
    qualityRun("q1", { gsm8k: passes(40, 30), mmlu: passes(40, 20) }),
    qualityRun("q2", { gsm8k: passes(40, 31), mmlu: passes(40, 20) }, { day: 2 })
  );
  const out = upgradeCompare(store, { baseline: "decode:b1,quality:q1", candidate: "decode:b2,quality:q2" });
  assert.equal(out.comparable, true);
  assert.equal(out.verdict.code, "worth_it");
  assert.deepEqual(
    out.throughput.map((c) => [c.cell, c.metric, c.delta_pct, c.noise_pct, c.noise_source, c.status]),
    [
      ["c1", "agg_window_tps", 20, 15, "default", "gain"],
      ["c4", "agg_window_tps", 22.22, 15, "default", "gain"],
    ]
  );
  assert.deepEqual(
    out.quality.map((q) => [q.category, q.delta_pp, q.status]),
    [
      ["gsm8k", 2.5, "noise"],
      ["mmlu", 0, "noise"],
    ]
  );
  assert.deepEqual(out.baseline.benches, ["DecodeBench", "QualityBench"]);
  assert.equal(out.candidate.lane.engine_version, "0.11.0");
  assert.deepEqual(out.unpaired, { baseline: [], candidate: [] });
});

test("gain inside noise reads as within noise", (t) => {
  const store = storeWith(t, decodeRun("b1", { c1: 50, c4: 180 }), decodeRun("b2", { c1: 53, c4: 190, day: 2 }));
  const out = upgradeCompare(store, { baseline: "decode:b1", candidate: "decode:b2" });
  assert.equal(out.verdict.code, "within_noise");
  assert.equal(out.verdict.quality, "not_measured");
  assert.deepEqual(out.throughput.map((c) => c.status), ["noise", "noise"]);
});

test("the noise band comes from repeated runs on the same lane when there are any", (t) => {
  const store = storeWith(
    t,
    decodeRun("b1", { c1: 50, c4: 180 }),
    decodeRun("b1r", { c1: 51, c4: 200, day: 3 }),
    decodeRun("b2", { c1: 50.5, c4: 225, engineVersion: "0.11.0", day: 2 })
  );
  const out = upgradeCompare(store, { baseline: "decode:b1", candidate: "decode:b2" });
  const c4 = out.throughput.find((c) => c.cell === "c4");
  assert.equal(c4.noise_source, "repeats");
  assert.equal(c4.measured_noise_pct, 10.53);
  assert.equal(c4.delta_pct, 25);
  assert.equal(c4.status, "gain");
  const c1 = out.throughput.find((c) => c.cell === "c1");
  assert.equal(c1.noise_pct, 3, "1.98% spread is floored at 3%");
  assert.equal(c1.status, "noise");
  assert.equal(out.verdict.code, "worth_it");
});

test("significant quality regression vetoes the throughput win", (t) => {
  const store = storeWith(
    t,
    decodeRun("b1", { c1: 50, c4: 180 }),
    decodeRun("b2", { c1: 65, c4: 240, day: 2 }),
    qualityRun("q1", { gsm8k: passes(40, 30), mmlu: passes(40, 20) }),
    qualityRun("q2", { gsm8k: passes(40, 18), mmlu: passes(40, 21) }, { day: 2 })
  );
  const out = upgradeCompare(store, { baseline: ["decode:b1", "quality:q1"], candidate: ["decode:b2", "quality:q2"] });
  assert.equal(out.verdict.code, "regression");
  const gsm = out.quality.find((q) => q.category === "gsm8k");
  assert.equal(gsm.status, "worse");
  assert.equal(gsm.mcnemar.baseline_only, 12);
  assert.ok(gsm.mcnemar.p < 0.001);
  assert.match(out.verdict.reasons[0], /quality gsm8k regresses significantly/);
});

test("mismatched hardware, conditions, suite version or bench sets are refused with reasons", (t) => {
  const store = storeWith(
    t,
    decodeRun("b1"),
    decodeRun("hw", { hw: "2× DGX Spark", day: 2 }),
    decodeRun("mt", { maxTokens: 512, day: 3 }),
    qualityRun("q1", { gsm8k: passes(10, 5) }),
    qualityRun("q2", { gsm8k: passes(10, 5) }, { suiteVersion: "2", day: 2 })
  );
  const hw = upgradeCompare(store, { baseline: "decode:b1", candidate: "decode:hw" });
  assert.equal(hw.comparable, false);
  assert.equal(hw.verdict.code, "refused");
  assert.deepEqual(hw.verdict.reasons, ["DecodeBench: hw_bucket differs (Single DGX Spark vs 2× DGX Spark)"]);
  assert.deepEqual(hw.throughput, []);
  assert.equal(hw.reference, null);

  const mt = upgradeCompare(store, { baseline: "decode:b1", candidate: "decode:mt" });
  assert.deepEqual(mt.verdict.reasons, [
    "DecodeBench c1: conditions.max_tokens differs (400 vs 512)",
    "DecodeBench c4: conditions.max_tokens differs (400 vs 512)",
  ]);

  const sv = upgradeCompare(store, { baseline: "quality:q1", candidate: "quality:q2" });
  assert.deepEqual(sv.verdict.reasons, ["QualityBench: suite_version differs (1 vs 2)"]);

  const oneSided = upgradeCompare(store, { baseline: "decode:b1,quality:q1", candidate: "decode:mt" });
  assert.ok(oneSided.verdict.reasons.includes("QualityBench run only on the baseline side; pick one on both sides or drop it"));
});

test("a headline metric whose definitions are not comparable is refused", (t) => {
  const b2 = decodeRun("b2", { day: 2 }).map((r) =>
    makeResult({
      ...r,
      metrics: r.metrics.map((m) => (m.metric === "agg_window_tps" ? { ...m, definition: "aeon.agg_tokens_per_cell_wall.v1" } : m)),
    })
  );
  const store = storeWith(t, decodeRun("b1"), b2);
  const out = upgradeCompare(store, { baseline: "decode:b1", candidate: "decode:b2" });
  assert.equal(out.verdict.code, "refused");
  assert.match(out.verdict.reasons[0], /DecodeBench c1: agg_window_tps definitions are not comparable \(herd\.decode\.agg_window\.v1 vs aeon\.agg_tokens_per_cell_wall\.v1\)/);
});

test("bad picks are errors, not verdicts", (t) => {
  const store = storeWith(t, decodeRun("b1"), decodeRun("b2", { day: 2 }), [makeResult(referenceRecord())]);
  const err = (q) => {
    try {
      upgradeCompare(store, q);
      return null;
    } catch (e) {
      return [e.status, e.message];
    }
  };
  assert.deepEqual(err({ baseline: "decode:b1", candidate: "decode:nope" }), [404, "candidate: unknown run decode:nope"]);
  assert.deepEqual(err({ baseline: "decode:b1", candidate: "decode:b1" }), [400, "the same run cannot be baseline and candidate (decode:b1)"]);
  assert.equal(err({ baseline: "decode:b1,decode:b2", candidate: "decode:b2" })[0], 400);
  assert.match(err({ baseline: "decode:b1,decode:b2", candidate: "x" })[1], /baseline: two DecodeBench runs/);
  assert.match(err({ baseline: "aeon-188", candidate: "decode:b2" })[1], /published reference, not a run/);
  assert.deepEqual(err({ baseline: "", candidate: "decode:b2" }), [400, "baseline: at least one run id is required"]);
});

test("unpaired cells are listed and left out of the verdict", (t) => {
  const b2 = decodeRun("b2", { c1: 70, day: 2 }).filter((r) => r.id.endsWith(":c1"));
  const store = storeWith(t, decodeRun("b1"), b2);
  const out = upgradeCompare(store, { baseline: "decode:b1", candidate: "decode:b2" });
  assert.deepEqual(out.unpaired, { baseline: ["DecodeBench:c4"], candidate: [] });
  assert.deepEqual(out.throughput.map((c) => c.cell), ["c1"]);
  assert.equal(out.verdict.code, "worth_it");
});

test("cost: recorded run energy wins, else the tracker is read for the run window; memory headroom delta", (t) => {
  const b1 = decodeRun("b1").map((r) => ({
    ...r,
    settings: {
      ...r.settings,
      run_energy: { wh: 10, window_s: 300, coverage: 1, output_tokens: 2000, wh_per_1k_tokens: 5, source: "fleet-energy-tracker" },
      run_memory: { total_mb: 122000, available_start_mb: 40000, available_end_mb: 38000, headroom_mb: 38000 },
    },
  }));
  const b2 = decodeRun("b2", { day: 2 }).map((r) => ({
    ...r,
    settings: { ...r.settings, run_memory: { total_mb: 122000, available_start_mb: 30000, available_end_mb: 31000, headroom_mb: 30000 } },
  }));
  const store = storeWith(t, b1, b2);
  const calls = [];
  const energyWindow = (nodeId, s, e) => {
    calls.push([nodeId, new Date(s).toISOString(), (e - s) / 1000]);
    return { wh: 8, coverage: 1, coverage_ms: 300000, window_ms: 300000, estimated: true };
  };
  const out = upgradeCompare(store, { baseline: "decode:b1", candidate: "decode:b2" }, { energyWindow });
  assert.deepEqual(calls, [["spark-a", "2026-10-02T12:00:00.000Z", 300]], "only the side without a recorded figure reads the tracker");
  assert.equal(out.cost.energy.baseline.from, "recorded");
  assert.equal(out.cost.energy.candidate.from, "tracker_now");
  assert.equal(out.cost.energy.candidate.output_tokens, 2000);
  assert.equal(out.cost.energy.candidate.wh_per_1k_tokens, 4);
  assert.equal(out.cost.energy.delta_pct, -20);
  assert.equal(out.cost.memory.delta_mb, -8000);

  const none = upgradeCompare(store, { baseline: "decode:b2", candidate: "decode:b1" });
  assert.equal(none.cost.energy.baseline, null, "no tracker, nothing recorded → null, never guessed");
});

test("the nearest published reference is placed beside the verdict", (t) => {
  const store = storeWith(t, decodeRun("b1"), decodeRun("b2", { c4: 230, day: 2 }), [makeResult(referenceRecord())]);
  const out = upgradeCompare(store, { baseline: "decode:b1", candidate: "decode:b2" });
  assert.ok(out.reference, "a reference is offered");
  assert.equal(out.reference.reference.id, "reference:aeon-188");
  assert.equal(out.reference.cell, "c4");
  assert.equal(out.reference.metric, "agg_window_tps");
  assert.equal(out.reference.candidate, 230);
});

test("a published figure under another throughput definition is still offered", (t) => {
  const perStream = referenceRecord({
    id: "reference:mean-only",
    run: { ...referenceRecord().run, run_id: "mean-only" },
    metrics: [{ metric: "decode_tps_stream", value: 23.55, source: "reference", definition: "aeon.decode_tps_mean.v1" }],
  });
  const store = storeWith(t, decodeRun("b1"), decodeRun("b2", { c4: 230, day: 2 }), [makeResult(perStream)]);
  const out = upgradeCompare(store, { baseline: "decode:b1", candidate: "decode:b2" });
  assert.equal(out.reference?.reference.id, "reference:mean-only");
  assert.equal(out.reference.metric, "decode_tps_stream");
  assert.equal(out.reference.cell, "c4", "same concurrency scores higher");
  assert.equal(typeof out.reference.candidate, "number");
});
