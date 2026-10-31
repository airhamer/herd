// FleetEnergyTracker behaviour added for issue #33: per-host estimates,
// partial-fleet current watts and hourly bars, live re-scoping that survives
// a reload, and the generic per-host plausibility ceiling.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetEnergyTracker, estimateNodeWatts } from "../FleetEnergyTracker.js";

const MINUTE_MS = 60_000;
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
const input = (id, watts, fresh = true) => ({ id, telemetryFresh: fresh, power: watts === null ? null : { watts } });

test("estimateNodeWatts uses a per-host estimate when the input carries one", () => {
  assert.equal(estimateNodeWatts(input("a", 1500)), 1500, "no 240 W GB10 clamp for other hosts");
  assert.equal(estimateNodeWatts(input("a", 1500, false)), null);
  assert.equal(estimateNodeWatts(input("a", null)), null);
  assert.equal(estimateNodeWatts(input("a", 1e9)), 20_000);
  // A bare SparkMonitor snapshot still uses the GB10 formula.
  const bare = { telemetryFresh: true, metrics: { gpu: { power: { draw: 10 } }, cpu: { usage: 0 } } };
  assert.equal(estimateNodeWatts(bare), 10 + 5.2 + 23);
});

test("current watts and hourly bars cover the hosts that report, not only a full fleet", () => {
  const tracker = new FleetEnergyTracker({ nodeIds: ["a", "b", "c"], load: false });
  for (let i = 0; i <= 30; i += 1) {
    tracker.record([input("a", 300), input("b", 700), input("c", null)], T0 + i * 2_000);
  }
  const snap = tracker.snapshot(T0 + 60_000);
  assert.equal(snap.freshNodeCount, 2);
  assert.equal(snap.currentWatts30s, 1000);
  const lastHour = snap.hourlyWatts24h.at(-1);
  assert.ok(Math.abs(lastHour - 1000) < 1e-6, `hourly ${lastHour}`);
  assert.equal(snap.whPerOutputToken24h, null, "no tokens, no efficiency line");
  assert.equal(snap.coverage24hMs, 0, "full-fleet coverage still needs every unit");
});

test("current watts only averages samples over the latest set of reporting hosts", () => {
  const tracker = new FleetEnergyTracker({ nodeIds: ["a", "b"], load: false });
  tracker.record([input("a", 100), input("b", 100)], T0);
  tracker.record([input("a", 100), input("b", 100)], T0 + 2_000);
  tracker.record([input("a", 100), input("b", null)], T0 + 4_000);
  assert.equal(tracker.snapshot(T0 + 4_000).currentWatts30s, 100);
});

test("re-scoped units persist: a reload keeps a departed unit's minutes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-energy-scope-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  let now = T0;
  const first = new FleetEnergyTracker({ nodeIds: ["a", "gone"], filePath, now: () => now, setIntervalFn: () => 1, clearIntervalFn: () => {} });
  for (let i = 0; i <= 5; i += 1) {
    now = T0 + i * 2_000;
    first.record([input("a", 1200), input("gone", 600)], now);
  }
  const energy = first.snapshot(now).energy24hKwh;
  first.setNodeIds(["a", "new"]);
  first.close();

  const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.deepEqual(saved.nodeIds, ["a", "new"]);
  assert.ok(saved.buckets.every((bucket) => "gone" in bucket.nodeWh && "new" in bucket.nodeWh));

  const second = new FleetEnergyTracker({ nodeIds: ["a", "new"], filePath, now: () => now, setIntervalFn: () => 1, clearIntervalFn: () => {} });
  const reloaded = second.snapshot(now);
  assert.ok(Math.abs(reloaded.energy24hKwh - energy) < 1e-12, "the departed unit still counts");
  assert.deepEqual(reloaded.trackedNodeIds, ["a", "new"]);
  assert.ok(!fs.readdirSync(dir).some((name) => name.includes(".scope-")), "same scope: not retired");
  second.close();
});

test("a stored minute missing a scoped unit, or with mismatched maps, is rejected", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-energy-keys-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "fleet-energy.json");
  const ok = { minuteStartMs: T0, nodeWh: { a: 1, old: 2 }, nodeCoverageMs: { a: MINUTE_MS, old: MINUTE_MS }, fleetWattMs: 0, fleetCoverageMs: 0, outputTokens: 1 };
  const missing = { ...ok, minuteStartMs: T0 + MINUTE_MS, nodeWh: { old: 2 }, nodeCoverageMs: { old: MINUTE_MS }, outputTokens: 2 };
  const mismatched = { ...ok, minuteStartMs: T0 + 2 * MINUTE_MS, nodeCoverageMs: { a: MINUTE_MS }, outputTokens: 4 };
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, nodeIds: ["a"], buckets: [ok, missing, mismatched] }));
  const tracker = new FleetEnergyTracker({ nodeIds: ["a"], filePath, now: () => T0 + 3 * MINUTE_MS, setIntervalFn: () => 1, clearIntervalFn: () => {} });
  const snap = tracker.snapshot(T0 + 3 * MINUTE_MS);
  assert.equal(snap.outputTokens24h, 1);
  assert.ok(Math.abs(snap.energy24hKwh - 0.003) < 1e-12);
  tracker.close();
});
