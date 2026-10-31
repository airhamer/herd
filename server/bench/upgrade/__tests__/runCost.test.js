import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetEnergyTracker } from "../../../energy/FleetEnergyTracker.js";
import { BenchResultsStore } from "../../results/store.js";
import { createResultsRecorder } from "../../results/recorder.js";
import { decodeJob, provenance } from "../../results/__tests__/fixtures.js";
import {
  MIN_ENERGY_COVERAGE,
  RUN_ENERGY_DEFINITION,
  energyMetricRow,
  memoryHeadroom,
  runEnergy,
  runOutputTokens,
} from "../runCost.js";
import { decodeRun } from "./helpers.js";

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

/** spark-a at a steady 100.2 W (72 W GPU + 5.2 W idle CPU + 23 W platform), sampled every 5 s. */
function steadyTracker(fromMs, toMs, gpuW = 72) {
  const tracker = new FleetEnergyTracker({ nodeIds: ["spark-a", "spark-b"], load: false, setIntervalFn: null });
  for (let t = fromMs; t <= toMs; t += 5000) {
    tracker.record([{ id: "spark-a", telemetryFresh: true, metrics: { gpu: { power: { draw: gpuW } }, cpu: { usage: 0 }, llm: [] } }], t);
  }
  return tracker;
}

test("windowEnergy integrates one node over a window, prorating edge minutes", () => {
  const tracker = steadyTracker(T0, T0 + 10 * 60_000);
  const full = tracker.windowEnergy("spark-a", T0 + 60_000, T0 + 6 * 60_000);
  assert.ok(Math.abs(full.wh - (100.2 * 5) / 60) < 1e-9, `5 min at 100.2 W, got ${full.wh}`);
  assert.equal(full.coverage, 1);
  assert.equal(full.window_ms, 300_000);
  const half = tracker.windowEnergy("spark-a", T0 + 60_000 + 30_000, T0 + 2 * 60_000);
  assert.ok(Math.abs(half.wh - 100.2 / 120) < 1e-9, "half a minute bucket is half its energy");
  assert.equal(tracker.windowEnergy("spark-b", T0, T0 + 60_000), null, "no samples for spark-b");
  assert.equal(tracker.windowEnergy("nope", T0, T0 + 60_000), null, "untracked node");
  assert.equal(tracker.windowEnergy("spark-a", T0 + 60_000, T0), null, "empty window");
  const partial = tracker.windowEnergy("spark-a", T0 + 5 * 60_000, T0 + 15 * 60_000);
  assert.equal(partial.coverage, 0.5);
});

test("runOutputTokens sums decode waves and AEON overall levels only", () => {
  assert.equal(runOutputTokens(decodeRun("b1")), 2000, "400 × c1 + 400 × c4");
  assert.equal(
    runOutputTokens([
      { settings: { scope: "overall", tokens_per_wall_s: 100, cell_wall_s: 12.5 } },
      { settings: { scope: "coding", tokens_per_wall_s: 100, cell_wall_s: 12.5 } },
    ]),
    1250
  );
  assert.equal(runOutputTokens([{ raw: { point: { completionTokens: 8 } } }]), null, "prefill volume is not used");
});

test("runEnergy reads the tracker for the run window and scales by coverage", () => {
  const recs = decodeRun("b1");
  const tracker = steadyTracker(T0, T0 + 5 * 60_000);
  const e = runEnergy(recs, (id, s, end) => tracker.windowEnergy(id, s, end));
  assert.equal(e.window_s, 300);
  assert.equal(e.coverage, 1);
  assert.equal(e.output_tokens, 2000);
  assert.equal(e.wh_per_1k_tokens, Math.round(((100.2 * 5) / 60 / 2) * 10000) / 10000);
  assert.deepEqual(energyMetricRow(e), {
    metric: "wh_per_1k_tokens",
    definition: RUN_ENERGY_DEFINITION,
    source: "native",
    value: e.wh_per_1k_tokens,
    n: null,
    window_s: 300,
    approximate: true,
  });

  const thin = runEnergy(recs, () => ({ wh: 1, coverage: MIN_ENERGY_COVERAGE - 0.1 }));
  assert.equal(thin.wh_per_1k_tokens, null, "under half the window covered: Wh kept, no Wh/1k figure");
  assert.equal(energyMetricRow(thin), null);
  assert.equal(runEnergy(recs, null), null);
  assert.equal(runEnergy(recs, () => { throw new Error("boom"); }), null);
});

test("memoryHeadroom keeps the lower of the start and end readings", () => {
  assert.deepEqual(memoryHeadroom({ available_mb: 40000, total_mb: 122000 }, { available_mb: 35000, total_mb: 122000 }), {
    total_mb: 122000,
    available_start_mb: 40000,
    available_end_mb: 35000,
    headroom_mb: 35000,
  });
  assert.equal(memoryHeadroom(null, { available_mb: 0 }), null);
  assert.equal(memoryHeadroom(null, { available_mb: 9000, total_mb: 64000 }).headroom_mb, 9000);
});

test("the recorder stores run energy and memory headroom on every record of the run", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-upgrade-rec-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new BenchResultsStore({ path: path.join(dir, "bench-results.json"), log: () => {} });
  const tracker = steadyTracker(T0, T0 + 5 * 60_000);
  const mem = [
    { available_mb: 50000, total_mb: 122000 },
    { available_mb: 42000, total_mb: 122000 },
  ];
  const rec = createResultsRecorder({
    store,
    energyWindow: (id, s, e) => tracker.windowEnergy(id, s, e),
    memoryNow: () => mem.shift() ?? null,
  });
  rec.noteStart("DecodeBench", "bench-1", provenance());
  rec.record("DecodeBench", decodeJob());
  for (const id of ["decode:bench-1:c1", "decode:bench-1:c4"]) {
    const r = store.get(id);
    assert.equal(r.settings.run_energy.source, "fleet-energy-tracker");
    assert.equal(r.settings.run_memory.headroom_mb, 42000);
    const row = r.metrics.find((m) => m.definition === RUN_ENERGY_DEFINITION);
    assert.equal(row.value, r.settings.run_energy.wh_per_1k_tokens);
    assert.equal(row.approximate, true);
  }
  const reloaded = new BenchResultsStore({ path: path.join(dir, "bench-results.json"), log: () => {} });
  assert.ok(reloaded.get("decode:bench-1:c4")?.settings.run_energy, "records with run cost survive a reload");

  // No hooks: records are exactly as before BENCH6.
  const plain = createResultsRecorder({ store });
  plain.record("DecodeBench", decodeJob({ benchId: "bench-2" }));
  assert.equal(store.get("decode:bench-2:c1").settings.run_energy, undefined);
  assert.ok(!store.get("decode:bench-2:c1").metrics.some((m) => m.metric === "wh_per_1k_tokens"));
});
