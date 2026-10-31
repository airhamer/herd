import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NOISE_PCT,
  MIN_NOISE_PCT,
  decideVerdict,
  noiseBand,
  qualityCategoryStatus,
  spreadPct,
  throughputCellStatus,
  throughputStatus,
} from "../verdict.js";

const cell = (name, delta, noise = 15, headline = true) => ({
  cell: name,
  delta_pct: delta,
  noise_pct: noise,
  headline,
  status: throughputCellStatus(delta, noise),
});
const cat = (name, p, baselineOnly, candidateOnly) => {
  const mcnemar = { p, baseline_only: baselineOnly, candidate_only: candidateOnly };
  return { cell: name, mcnemar, status: qualityCategoryStatus(mcnemar) };
};

test("spread and noise band: measured from repeats, floored, 15% default", () => {
  assert.equal(spreadPct([100]), null);
  assert.equal(spreadPct([90, 110]), 20);
  assert.deepEqual(noiseBand([], [50]), { pct: DEFAULT_NOISE_PCT, source: "default", measured_pct: null });
  assert.deepEqual(noiseBand([95, 105], [100, 104, 102]), { pct: 10, source: "repeats", measured_pct: 10 });
  assert.equal(noiseBand([100, 100.5], []).pct, MIN_NOISE_PCT, "two near-identical runs do not shrink the band below the floor");
});

test("cell and run statuses", () => {
  assert.equal(throughputCellStatus(16, 15), "gain");
  assert.equal(throughputCellStatus(15, 15), "noise", "on the edge is still noise");
  assert.equal(throughputCellStatus(-20, 15), "loss");
  assert.equal(throughputCellStatus(null, 15), "unknown");
  assert.equal(throughputStatus([]), "none");
  assert.equal(throughputStatus([cell("c1", 20), cell("c4", -20)]), "mixed");
  assert.equal(throughputStatus([cell("c1", 20), cell("x", -40, 15, false)]), "gain", "detail cells do not vote");
  assert.equal(qualityCategoryStatus(null), "unpaired");
  assert.equal(qualityCategoryStatus({ p: 0.2, baseline_only: 3, candidate_only: 1 }), "noise");
  assert.equal(qualityCategoryStatus({ p: 0.01, baseline_only: 9, candidate_only: 1 }), "worse");
  assert.equal(qualityCategoryStatus({ p: 0.01, baseline_only: 1, candidate_only: 9 }), "better");
});

test("verdict: gain inside the noise band is not worth it", () => {
  const v = decideVerdict({ throughput: [cell("c1", 9), cell("c4", 12)], quality: [cat("gsm8k", 0.5, 2, 1)] });
  assert.equal(v.code, "within_noise");
  assert.equal(v.worth_it, false);
  assert.equal(v.throughput, "noise");
  assert.match(v.reasons.join(" "), /inside its noise band/);
});

test("verdict: a significant quality regression vetoes a throughput win", () => {
  const v = decideVerdict({ throughput: [cell("c1", 30), cell("c4", 40)], quality: [cat("mmlu", 0.3, 2, 1), cat("gsm8k", 0.002, 12, 1)] });
  assert.equal(v.code, "regression");
  assert.equal(v.worth_it, false);
  assert.equal(v.quality, "regression");
  assert.match(v.reasons[0], /quality gsm8k regresses significantly \(McNemar p = 0\.002\)/);
});

test("verdict: a throughput loss outside noise is a regression too", () => {
  const v = decideVerdict({ throughput: [cell("c1", 25), cell("c4", -22)], quality: [] });
  assert.equal(v.code, "regression");
  assert.match(v.reasons.join(" "), /c4 -22% is outside the ±15% noise band/);
});

test("verdict: clean win", () => {
  const v = decideVerdict({ throughput: [cell("c1", 18), cell("c4", 31)], quality: [cat("gsm8k", 0.4, 1, 3), cat("mmlu", 1, 0, 0)] });
  assert.equal(v.code, "worth_it");
  assert.equal(v.worth_it, true);
  assert.deepEqual(v.reasons, [
    "throughput c1 +18% is outside the ±15% noise band",
    "throughput c4 +31% is outside the ±15% noise band",
    "no quality category regresses significantly",
  ]);
});

test("verdict: a win without quality data says so; refusals win over everything", () => {
  const v = decideVerdict({ throughput: [cell("c1", 40)], quality: [] });
  assert.equal(v.code, "worth_it");
  assert.match(v.reasons.at(-1), /quality not measured/);
  const r = decideVerdict({ refused: ["hw_bucket differs (a vs b)"], throughput: [cell("c1", 40)] });
  assert.equal(r.code, "refused");
  assert.deepEqual(r.reasons, ["hw_bucket differs (a vs b)"]);
  assert.equal(decideVerdict({}).code, "refused");
});
