// GET /api/fleet-energy view: label, coverage, cost, host table (issue #33).
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { buildFleetEnergyView, ENERGY_LABEL } from "../view.js";
import { normalizeCurrency, normalizePrice, DEFAULT_ELECTRICITY_PRICE_PER_KWH } from "../pricing.js";
import { registerFleetEnergyRoute, runFleetEnergySamplerTick } from "../FleetEnergyRuntime.js";
import { FleetEnergyTracker } from "../FleetEnergyTracker.js";

const DAY_MS = 86_400_000;

function snapshot(overrides = {}) {
  return {
    estimated: true,
    trackedNodeIds: ["a", "b"],
    currentWatts30s: 500,
    energy24hKwh: 4,
    energy31dKwh: 100,
    nodeCoverage24hMs: { a: DAY_MS, b: DAY_MS / 2 },
    ...overrides,
  };
}

const hosts = [
  { id: "a", reporting: true, watts: 300, measuredWatts: 240, duplicateOf: null },
  { id: "b", reporting: true, watts: 200, measuredWatts: 60, duplicateOf: null },
  { id: "c", reporting: false, watts: null, measuredWatts: null, duplicateOf: null },
  { id: "d", reporting: true, watts: 100, measuredWatts: 100, duplicateOf: "a" },
];

test("coverage counts reporting hosts, measured share and 24 h host-time", () => {
  const view = buildFleetEnergyView(snapshot(), { hosts, settings: { electricityPricePerKwh: 0.2, electricityCurrency: "eur" } });
  assert.equal(view.label, ENERGY_LABEL);
  assert.equal(view.label, "estimated, not wall-metered");
  assert.deepEqual(view.coverage, {
    reportingHosts: 2,
    hostsInScope: 3,
    percent: 66.7,
    measuredSharePct: 60,
    coverage24hPct: 75,
  });
  assert.equal(view.hosts, hosts);
  assert.equal(view.energy24hKwh, 4, "the tracker contract is passed through");
});

test("cost uses the configured price and currency; 0 hides it", () => {
  const view = buildFleetEnergyView(snapshot(), { hosts, settings: { electricityPricePerKwh: 0.25, electricityCurrency: "eur" } });
  assert.deepEqual(view.cost, { currency: "EUR", pricePerKwh: 0.25, cost24h: 1, cost31d: 25, costPerDayAtCurrent: 3 });
  assert.equal(buildFleetEnergyView(snapshot(), { hosts, settings: { electricityPricePerKwh: 0 } }).cost, null);
  const empty = buildFleetEnergyView(snapshot({ energy24hKwh: null, energy31dKwh: null, currentWatts30s: null }), { settings: {} });
  assert.equal(empty.cost.pricePerKwh, DEFAULT_ELECTRICITY_PRICE_PER_KWH);
  assert.equal(empty.cost.cost24h, null);
  assert.equal(empty.cost.costPerDayAtCurrent, null);
  assert.equal(empty.coverage.measuredSharePct, null);
  assert.equal(empty.coverage.percent, 0);
});

test("price and currency normalisation", () => {
  assert.equal(normalizePrice("0.31"), 0.31);
  assert.equal(normalizePrice(-1), DEFAULT_ELECTRICITY_PRICE_PER_KWH);
  assert.equal(normalizePrice(1e6), 100);
  assert.equal(normalizeCurrency(" gbp "), "GBP");
  assert.equal(normalizeCurrency("pounds"), "USD");
});

test("sampler tick with collectInputs re-scopes the tracker and records per-host watts", () => {
  const tracker = new FleetEnergyTracker({ nodeIds: ["a"], load: false });
  let atMs = Date.UTC(2026, 9, 31, 6, 0, 0);
  const collectInputs = () => ({
    scope: ["a", "n1"],
    inputs: [
      { id: "a", telemetryFresh: true, power: { watts: 100 } },
      { id: "n1", telemetryFresh: true, power: { watts: 400 } },
    ],
  });
  assert.equal(runFleetEnergySamplerTick({ tracker, now: () => atMs, collectInputs }), true);
  atMs += 2_000;
  runFleetEnergySamplerTick({ tracker, now: () => atMs, collectInputs });
  const result = tracker.snapshot(atMs);
  assert.deepEqual(result.trackedNodeIds, ["a", "n1"]);
  assert.equal(result.currentWatts30s, 500);
  assert.equal(result.freshNodeCount, 2);
  assert.ok(Math.abs(result.energy24hKwh - (500 * 2) / 3_600_000) < 1e-12);
});

test("GET /api/fleet-energy serves the decorated view", async (t) => {
  const tracker = new FleetEnergyTracker({ nodeIds: ["a"], load: false });
  const app = express();
  registerFleetEnergyRoute(app, tracker, {
    decorate: (snap) => buildFleetEnergyView(snap, { hosts: [hosts[0]], settings: { electricityPricePerKwh: 0.1 } }),
  });
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/fleet-energy`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.label, "estimated, not wall-metered");
  assert.equal(body.coverage.hostsInScope, 1);
  assert.equal(body.cost.pricePerKwh, 0.1);
  assert.deepEqual(body.trackedNodeIds, ["a"]);
});
