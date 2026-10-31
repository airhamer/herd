// Monthly energy history: behaviour from docs/specs/monthly-energy.md (herd LIC1 clean-room tests).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { FleetEnergyTracker } from "../../energy/FleetEnergyTracker.js";
import { MonthlyEnergyArchive, monthKey, monthRange } from "../../energy/FleetEnergyMonthly.js";
import { registerFleetEnergyRoute } from "../../energy/FleetEnergyRuntime.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOON_OCT_5 = Date.UTC(2026, 9, 5, 12, 0);
const m = (n) => NOON_OCT_5 + n * MIN;
// Every node draws 100 W GPU + 5.2 W idle CPU + 23 W base = 128.2 W.
const NODE_WH_PER_MIN = 128.2 / 60;

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-monthly-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    window: path.join(dir, "fleet-energy.json"),
    monthly: path.join(dir, "fleet-energy-monthly.json"),
  };
}

function unit(id, outputTokens) {
  return {
    id,
    online: true,
    telemetryFresh: true,
    role: "head",
    llmPorts: [8000],
    metrics: {
      cpu: { usage: 0 },
      gpu: { power: { draw: 100 } },
      llm: [{ available: true, totalOutputTokens: outputTokens }],
    },
  };
}

/** Sample the fleet every 2 s over [from, to]; `perSample` output tokens per sample. */
function run(tracker, ids, from, to, perSample = 0) {
  let tokens = 0;
  for (let at = from; at <= to; at += 2_000) {
    tracker.record(ids.map((id) => unit(id, tokens)), at);
    tokens += perSample;
  }
}

/** A stored two-node minute ("x", "y") with `wh` per node and full coverage. */
function minuteBucket(minuteStartMs, wh = 1, overrides = {}) {
  return {
    minuteStartMs,
    nodeWh: { x: wh, y: wh },
    nodeCoverageMs: { x: MIN, y: MIN },
    fleetWattMs: wh * 2 * 3_600_000,
    fleetCoverageMs: MIN,
    outputTokens: 0,
    coveredOutputTokens: 0,
    ...overrides,
  };
}

const near = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} is not within ${eps} of ${expected}`);

const tracker = (options) => new FleetEnergyTracker({ setIntervalFn: null, ...options });

// ── month arithmetic ─────────────────────────────────────────────────────────

test("monthKey and monthRange work in UTC and reject malformed keys", () => {
  assert.equal(monthKey(Date.UTC(2026, 11, 31, 23, 59, 59, 999)), "2026-12");
  assert.equal(monthKey(Date.UTC(2027, 0, 1)), "2027-01");
  assert.deepEqual(monthRange("2027-02"), [Date.UTC(2027, 1, 1), Date.UTC(2027, 2, 1)]);
  for (const bad of ["2026-13", "2026-1", "26-01", "", null, 202601]) assert.equal(monthRange(bad), null);
});

// ── the archive on its own ───────────────────────────────────────────────────

test("only minutes that ended at least 10 s ago are folded, and each only once", () => {
  const archive = new MonthlyEnergyArchive({ now: () => m(10) });
  const buckets = [minuteBucket(m(0)), minuteBucket(m(1)), minuteBucket(m(2))];
  // m(2) ends at m(3); at m(3)+5 s it is not settled yet.
  assert.equal(archive.foldBuckets(buckets, { nowMs: m(3) + 5_000 }), 2);
  assert.equal(archive.foldBuckets(buckets, { nowMs: m(3) + 5_000 }), 0);
  assert.equal(archive.foldBuckets(buckets, { nowMs: m(3) + 10_000 }), 1);
  assert.equal(archive.foldBuckets(buckets, { nowMs: m(9) }), 0);
  near(archive.snapshot(m(10)).months[0].nodes.x.wh, 3);
});

test("a month boundary splits minutes into their own UTC months", () => {
  const edge = Date.UTC(2026, 10, 1);
  const archive = new MonthlyEnergyArchive({ now: () => edge + 5 * MIN });
  archive.foldBuckets([minuteBucket(edge - MIN, 2), minuteBucket(edge, 3)], { nowMs: edge + 5 * MIN });
  const months = archive.snapshot(edge + 5 * MIN).months;
  assert.deepEqual(months.map((x) => x.month), ["2026-10", "2026-11"]);
  assert.deepEqual(months.map((x) => x.closed), [true, false]);
  near(months[0].totalWh, 4);
  near(months[1].totalWh, 6);
});

test("a minute with no measured node moves the watermark but adds nothing", () => {
  const archive = new MonthlyEnergyArchive();
  const nothing = { minuteStartMs: m(1), nodeWh: {}, nodeCoverageMs: {}, fleetWattMs: 0, fleetCoverageMs: MIN, outputTokens: 2, coveredOutputTokens: 7 };
  assert.equal(archive.foldBuckets([minuteBucket(m(0)), nothing], { nowMs: m(6) }), 1);
  assert.equal(archive.foldedThroughMs, m(2));
  const [month] = archive.snapshot().months;
  near(month.fleetWh, 2);
  assert.equal(month.fleetCoverageMs, MIN);
  assert.equal(month.coveredOutputTokens, 0);
});

test("a clock far in the future cannot push the watermark past real time", () => {
  const archive = new MonthlyEnergyArchive({ now: () => m(0) });
  assert.equal(archive.foldBuckets([minuteBucket(m(0) + 30 * DAY)], { nowMs: m(0) + 30 * DAY + 3 * MIN }), 0);
  assert.ok(archive.foldedThroughMs <= m(0) + DAY);
  assert.equal(archive.foldBuckets([minuteBucket(m(-3))], { nowMs: m(0) }), 1);
  near(archive.snapshot(m(0)).months[0].nodes.y.wh, 1);
});

test("a saved watermark more than a day ahead is pulled back on load; stored months stay", (t) => {
  const { monthly } = scratch(t);
  fs.writeFileSync(monthly, JSON.stringify({
    version: 1,
    savedAt: m(0),
    foldedThroughMs: m(0) + 200 * DAY,
    months: { "2026-08": { nodes: { x: { wh: 9, coverageMs: MIN } }, fleetWh: 9, fleetCoverageMs: MIN, outputTokens: 0, coveredOutputTokens: 0, tokenFleetWh: 0 } },
  }));
  const archive = new MonthlyEnergyArchive({ filePath: monthly, now: () => m(0) });
  assert.ok(archive.foldedThroughMs <= m(0));
  assert.equal(archive.foldBuckets([minuteBucket(m(1))], { nowMs: m(4) }), 1);
  const byKey = Object.fromEntries(archive.snapshot(m(4)).months.map((x) => [x.month, x]));
  assert.equal(byKey["2026-08"].nodes.x.wh, 9);
  assert.equal(byKey["2026-10"].nodes.x.wh, 1);
});

test("a corrupt archive file is renamed aside with the clock in its name", (t) => {
  const { dir, monthly } = scratch(t);
  fs.writeFileSync(monthly, "[[[");
  const archive = new MonthlyEnergyArchive({ filePath: monthly, now: () => 4321 });
  assert.deepEqual(archive.snapshot().months, []);
  assert.deepEqual(fs.readdirSync(dir), ["fleet-energy-monthly.unreadable-4321.json"]);
});

// ── tracker integration ──────────────────────────────────────────────────────

test("the tracker archives finished minutes as it records and keeps accruing", () => {
  const fleet = tracker({ nodeIds: ["x", "y"], now: () => m(6) });
  run(fleet, ["x", "y"], m(0), m(6));
  const first = fleet.monthlySnapshot(m(6)).months[0];
  assert.ok(first.nodes.x.wh > 5 * NODE_WH_PER_MIN - 0.01 && first.nodes.x.wh < 6 * NODE_WH_PER_MIN);
  assert.equal(fleet.monthlySnapshot(m(6)).months[0].totalWh, first.totalWh);
  run(fleet, ["x", "y"], m(7), m(10));
  assert.ok(fleet.monthlySnapshot(m(10)).months[0].totalWh > first.totalWh);
});

test("re-reading a minute through repeated snapshots and flushes never double counts", () => {
  const at = m(4) + 15_000;
  const fleet = tracker({ nodeIds: ["x"], now: () => at });
  run(fleet, ["x"], m(0), m(4));
  const once = fleet.monthlySnapshot(at).months[0].nodes.x.wh;
  fleet.flush();
  fleet.monthlySnapshot(at);
  assert.equal(fleet.monthlySnapshot(at).months[0].nodes.x.wh, once);
});

test("restarts reload the 31-day file without adding its minutes again", (t) => {
  const files = scratch(t);
  const base = { nodeIds: ["x", "y"], filePath: files.window, monthlyFilePath: files.monthly };

  const a = tracker({ ...base, now: () => m(5) });
  run(a, ["x", "y"], m(0), m(5));
  a.close();

  const b = tracker({ ...base, now: () => m(12) });
  const afterFirst = b.monthlySnapshot(m(12)).months[0].totalWh;
  near(afterFirst, 2 * 5 * NODE_WH_PER_MIN, 0.01);
  run(b, ["x", "y"], m(12), m(14));
  b.close();

  const c = tracker({ ...base, now: () => m(25) });
  const afterSecond = c.monthlySnapshot(m(25)).months[0].totalWh;
  assert.ok(afterSecond > afterFirst && afterSecond < afterFirst + 2 * 3 * NODE_WH_PER_MIN + 0.01, String(afterSecond));
  c.close();

  const d = tracker({ ...base, now: () => m(40) });
  assert.equal(d.monthlySnapshot(m(40)).months[0].totalWh, afterSecond);
  d.close();
  assert.equal(JSON.parse(fs.readFileSync(files.monthly, "utf8")).version, 1);
  assert.equal(fs.statSync(files.monthly).mode & 0o777, 0o600);
});

test("enabling the archive on an existing install back-fills from the window file", (t) => {
  const files = scratch(t);
  const legacy = tracker({ nodeIds: ["x"], filePath: files.window, now: () => m(0) });
  run(legacy, ["x"], m(0), m(4));
  legacy.close();
  assert.equal(fs.existsSync(files.monthly), false);

  const upgraded = tracker({ nodeIds: ["x"], filePath: files.window, monthlyFilePath: files.monthly, now: () => m(90) });
  assert.ok(upgraded.monthlySnapshot(m(90)).months[0].nodes.x.wh > 3 * NODE_WH_PER_MIN);
  upgraded.close();
});

test("changing fleet members keeps the previous members' energy in the month", (t) => {
  const files = scratch(t);
  const opts = { filePath: files.window, monthlyFilePath: files.monthly };
  const old = tracker({ ...opts, nodeIds: ["x", "y"], now: () => m(0) });
  run(old, ["x", "y"], m(0), m(4));
  old.close();

  const fresh = tracker({ ...opts, nodeIds: ["x", "z"], now: () => m(60) });
  run(fresh, ["x", "z"], m(60), m(63));
  const [month] = fresh.monthlySnapshot(m(63)).months;
  assert.deepEqual(month.nodeIds, ["x", "y", "z"]);
  assert.ok(month.nodes.y.wh > 3 * NODE_WH_PER_MIN);
  assert.ok(month.nodes.z.wh > 1.5 * NODE_WH_PER_MIN);
  assert.ok(month.nodes.x.wh > month.nodes.z.wh + 3 * NODE_WH_PER_MIN);
  fresh.close();
  assert.ok(fs.readdirSync(files.dir).some((n) => n.startsWith("fleet-energy.scope-")));
});

test("a foreign-scope file only contributes believable, well-formed minutes", (t) => {
  const files = scratch(t);
  const stored = [
    minuteBucket(m(0)), // the only good minute
    minuteBucket(m(1), 40), // far above what one unit can draw in a minute
    minuteBucket(m(2), 1, { nodeCoverageMs: { x: MIN, y: 3 * MIN } }),
    minuteBucket(m(3), 1, { fleetCoverageMs: 2 * MIN }),
    minuteBucket(m(4), 1, { nodeWh: { x: 1, y: -2 } }),
    minuteBucket(m(5), 1, { fleetWattMs: -1 }),
    minuteBucket(m(6), 1, { fleetWattMs: 5e11 }),
    minuteBucket(m(7), 1, { fleetWattMs: 2 }),
    minuteBucket(m(8), 1, { nodeWh: { x: 1, y: null } }),
    minuteBucket(m(9), 1, { nodeWh: { y: 1 } }),
    minuteBucket(m(10), 1, { outputTokens: -1 }),
    minuteBucket(m(11) + 500),
    minuteBucket(m(0), 2.5), // second copy of a minute is ignored
  ];
  fs.writeFileSync(files.window, JSON.stringify({ version: 1, savedAt: m(20), nodeIds: ["x", "y"], buckets: stored }));

  const fleet = tracker({ nodeIds: ["x", "z"], filePath: files.window, monthlyFilePath: files.monthly, now: () => m(30) });
  const months = fleet.monthlySnapshot(m(30)).months;
  assert.equal(months.length, 1);
  assert.deepEqual(months[0].nodeIds, ["x", "y"]);
  near(months[0].nodes.y.wh, 1);
  near(months[0].totalWh, 2);
  assert.equal(months[0].fleetCoverageMs, MIN);
  assert.equal(months[0].outputTokens, 0);
  fleet.close();
  assert.ok(fs.existsSync(path.join(files.dir, `fleet-energy.scope-${m(20)}.json`)));
});

test("a foreign-scope file without a node list contributes nothing", (t) => {
  const files = scratch(t);
  fs.writeFileSync(files.window, JSON.stringify({ version: 1, savedAt: m(0), nodeIds: [], buckets: [minuteBucket(m(0))] }));
  const fleet = tracker({ nodeIds: ["x", "z"], filePath: files.window, monthlyFilePath: files.monthly, now: () => m(30) });
  assert.deepEqual(fleet.monthlySnapshot(m(30)).months, []);
  fleet.close();
});

test("Wh per output token is null until tokens were counted", () => {
  const busy = tracker({ nodeIds: ["x"] });
  run(busy, ["x"], m(0), m(5), 25);
  const [month] = busy.monthlySnapshot(m(5) + 30_000).months;
  assert.ok(month.coveredOutputTokens > 0);
  assert.ok(month.whPerOutputToken > 0);

  const idle = tracker({ nodeIds: ["x"] });
  run(idle, ["x"], m(0), m(4));
  assert.equal(idle.monthlySnapshot(m(4) + 30_000).months[0].whPerOutputToken, null);
});

// ── HTTP ─────────────────────────────────────────────────────────────────────

test("GET returns the history; DELETE needs an explicit month or a confirmed wipe", async (t) => {
  const at = m(4) + 30_000;
  const fleet = tracker({ nodeIds: ["x", "y"], now: () => at });
  run(fleet, ["x", "y"], m(0), m(4));
  const app = express();
  registerFleetEnergyRoute(app, fleet);
  const server = app.listen(0);
  t.after(() => server.close());
  const url = (q = "") => `http://127.0.0.1:${server.address().port}/api/fleet-energy/monthly${q}`;
  const months = async () => (await (await fetch(url())).json()).months;
  const del = (q) => fetch(url(q), { method: "DELETE" });

  const body = await (await fetch(url())).json();
  assert.equal(body.estimated, true);
  assert.deepEqual(body.months.map((x) => x.month), ["2026-10"]);

  // The 31-day window has no DELETE route at all.
  assert.equal((await fetch(url().replace("/monthly", ""), { method: "DELETE" })).status, 404);

  for (const q of ["", "?month=2026-1", "?all=yes", "?all=true&confirm=please", "?month=2026-10&all=true"]) {
    assert.equal((await del(q)).status, 400, q);
  }
  const refused = await del("?all=true");
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /confirm=delete-all-history/);
  assert.equal((await months()).length, 1);

  assert.deepEqual(await (await del("?month=2026-09")).json(), { removed: 0 });
  assert.deepEqual(await (await del("?month=2026-10")).json(), { removed: 1 });
  assert.equal((await months()).length, 0);

  run(fleet, ["x", "y"], m(10), m(14));
  assert.equal((await months()).length, 1);
  const wiped = await del("?all=true&confirm=delete-all-history");
  assert.equal(wiped.status, 200);
  assert.deepEqual(await wiped.json(), { removed: 1 });
  assert.equal((await months()).length, 0);
});
