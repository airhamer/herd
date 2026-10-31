import test from "node:test";
import assert from "node:assert/strict";
import { COLLECTION_SUCCESS } from "../../collectors/SystemCollector.js";
import { SparkMonitor } from "../../sparks/SparkMonitor.js";
import { UnitHistory } from "../UnitHistory.js";
import {
  HISTORY_SAMPLE_INTERVAL_MS,
  createUnitHistoryRuntime,
  monitorFreshness,
  recordGpuSample,
  registerUnitHistoryRoutes,
  staleWindowMs,
} from "../UnitHistoryRuntime.js";

const S = 1_000;
const H = 3_600 * S;
const D = 24 * H;
const START = Date.UTC(2026, 5, 1);

const okTag = (obj) => Object.defineProperty(obj, COLLECTION_SUCCESS, { value: true, enumerable: false });

/** A monitor double: one collection time / outcome / cadence for every domain. */
function stubMonitor({ at = START, ok = true, cadence = 2 * S } = {}) {
  return { lastCollectedAt: () => at, collectionOk: () => ok, pollIntervalMs: () => cadence };
}

function snapshot(id, extra = {}) {
  return {
    id,
    kind: "spark",
    online: true,
    llmPorts: [],
    metrics: {
      gpu: okTag({ usage: 70, temperature: 60, power: { draw: 50, limit: 200 }, vram: { used: 1, total: 10, available: 9 } }),
      cpu: { usage: 9, temperature: 45, draw: 4, tdp: 60 },
    },
    ...extra,
  };
}

/** Runtime wired to a manual clock and a captured interval. */
function rig({ enabled = false, snaps = [snapshot("u")], monitors } = {}) {
  const clock = { at: START };
  const flags = { enabled };
  const store = new UnitHistory({ now: () => clock.at, logError: () => {} });
  const intervals = [];
  const runtime = createUnitHistoryRuntime({
    store,
    orderedSnapshots: () => snaps,
    monitors: monitors ?? new Map(snaps.map((s) => [s.id, stubMonitor({ at: START })])),
    isEnabled: () => flags.enabled,
    now: () => clock.at,
    setIntervalFn: (fn, ms) => {
      intervals.push({ fn, ms, cleared: false });
      return intervals.at(-1);
    },
    clearIntervalFn: (h) => {
      h.cleared = true;
    },
  });
  return { clock, flags, store, runtime, intervals };
}

test("stale window: three poll intervals, never below 15 s", () => {
  assert.equal(staleWindowMs(stubMonitor({ cadence: 1 * S }), "gpu"), 15 * S);
  assert.equal(staleWindowMs(stubMonitor({ cadence: 20 * S }), "gpu"), 60 * S);
  assert.equal(staleWindowMs(stubMonitor({ cadence: null }), "x"), 15 * S);
  assert.equal(staleWindowMs(undefined, "gpu"), 15 * S);
});

test("freshness needs an ok latest poll and a recent real reading", () => {
  const fresh = (m, at) => monitorFreshness(m, at)("gpu");
  assert.equal(fresh(stubMonitor({ cadence: 20 * S }), START + 50 * S), true);
  assert.equal(fresh(stubMonitor({ cadence: 20 * S }), START + 61 * S), false);
  assert.equal(fresh(stubMonitor({ cadence: 2 * S }), START + 16 * S), false);
  assert.equal(fresh(stubMonitor({ ok: false }), START), false);
  assert.equal(fresh(stubMonitor({ at: null }), START), false);
  assert.equal(fresh(null, START), false);
});

test("freshness works against a real SparkMonitor", async () => {
  const monitor = new SparkMonitor({ id: "m", name: "m", lanIp: "127.0.0.1", isLocal: true, llmMonitoring: false });
  monitor.collector.collectRam = async () => ({ used: 2, total: 16, percentage: 12 });
  monitor._running = true;
  await monitor._pollDomain("ram");
  monitor._running = false;
  const at = monitor.lastCollectedAt("ram");
  assert.equal(monitorFreshness(monitor, at + 10 * S)("ram"), true);
  assert.equal(monitorFreshness(monitor, at + 16 * S)("ram"), false);
  assert.equal(monitorFreshness(monitor, at)("storage"), false, "never polled");
});

test("GPU readings need a successful collection and honour availability flags", () => {
  const store = new UnitHistory({ now: () => START, minGapMs: 0, logError: () => {} });
  const snap = snapshot("u");
  assert.equal(recordGpuSample(store, snap, START), true);
  assert.deepEqual(store.get("u"), { t: [START], u: [70], c: [60], p: [25], gpus: [] });
  const untagged = snapshot("v", { metrics: { gpu: { usage: 1, temperature: 1, power: { draw: 1, limit: 1 } } } });
  assert.equal(recordGpuSample(store, untagged, START), false);
  assert.equal(recordGpuSample(store, { ...snap, online: false }, START + S), false);
  const masked = snapshot("w");
  masked.metrics.gpu.metricAvailability = { temperature: false, powerLimit: false };
  recordGpuSample(store, masked, START);
  assert.deepEqual(store.get("w"), { t: [START], u: [70], c: [null], p: [null], gpus: [] });
});

test("by default only the GPU raw series is sampled", () => {
  const { store, runtime, clock } = rig();
  runtime.sample();
  clock.at += 2 * S;
  runtime.sample();
  assert.equal(store.get("u").t.length, 2);
  assert.deepEqual(store.query("u", "1h", clock.at).points, []);
});

test("the setting is read every tick: on records, off stops", () => {
  const { store, runtime, clock, flags } = rig();
  runtime.sample();
  flags.enabled = true;
  clock.at += 2 * S;
  runtime.sample();
  flags.enabled = false;
  clock.at += 2 * S;
  runtime.sample();
  const [point] = store.query("u", "1h", clock.at).points;
  assert.equal(point.cpuUtil.avg, 9);
  assert.equal(store.serializeTiers(clock.at).units.u["1m"].series.cpuUtil.n[0], 1);
});

test("offline units and stale collections leave gaps", () => {
  const snaps = [snapshot("off", { online: false }), snapshot("stale")];
  const monitors = new Map([["stale", stubMonitor({ at: START - H })]]);
  const { store, runtime } = rig({ enabled: true, snaps, monitors });
  runtime.sample();
  assert.deepEqual(store.query("off", "1h", START).points, []);
  assert.deepEqual(store.query("stale", "1h", START).points, []);
});

test("start/stop: one 2 s interval; stop is final, flushes and is idempotent", () => {
  const { runtime, intervals, store } = rig({ enabled: true });
  let flushed = 0;
  const realStop = store.stop.bind(store);
  store.stop = () => {
    flushed++;
    return realStop();
  };
  assert.equal(runtime.start(), true);
  assert.equal(runtime.start(), true);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, HISTORY_SAMPLE_INTERVAL_MS);
  runtime.stop();
  runtime.stop();
  assert.equal(flushed, 1);
  assert.equal(intervals[0].cleared, true);
  assert.equal(runtime.start(), false);
  intervals[0].fn();
  assert.deepEqual(store.get("u").t, [], "a late tick after stop records nothing");
});

test("a store failure during stop is logged, not thrown", () => {
  const errors = [];
  const runtime = createUnitHistoryRuntime({
    store: {
      start() {},
      stop() {
        throw new Error("disk full");
      },
    },
    orderedSnapshots: () => [],
    monitors: new Map(),
    logError: (msg, err) => errors.push(err.message),
  });
  runtime.stop();
  assert.deepEqual(errors, ["disk full"]);
});

// ─── Routes ───────────────────────────────────────────────

/** Minimal Express stand-in: records GET handlers and replays requests. */
function fakeApp() {
  const routes = new Map();
  return {
    get: (route, handler) => routes.set(route, handler),
    call(route, params, query = {}) {
      const res = {
        statusCode: 200,
        body: undefined,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          this.body = body;
          return this;
        },
      };
      routes.get(route)({ params, query }, res);
      return res;
    },
  };
}

test("routes: unknown units are 404, ranges are validated, the setting is reported", () => {
  let enabled = false;
  const store = new UnitHistory({ now: () => START, logError: () => {} });
  store.recordSample([{ id: "u", values: { gpuUtil: 42 } }], START);
  store.record("u", START, 1, 2, 3);
  const app = fakeApp();
  registerUnitHistoryRoutes(app, { store, hasUnit: (id) => id === "u", isEnabled: () => enabled, now: () => START });
  const HIST = "/api/sparks/:id/history";
  const GPU = "/api/sparks/:id/gpu-history";

  assert.deepEqual(app.call(GPU, { id: "nope" }).body, { error: "Spark not found" });
  assert.equal(app.call(HIST, { id: "nope" }).statusCode, 404);
  for (const range of ["2h", "__proto__", "toString", ["1h", "6h"]]) {
    const res = app.call(HIST, { id: "u" }, { range });
    assert.equal(res.statusCode, 400, String(range));
    assert.deepEqual(res.body, { error: "range must be one of: 1h, 6h, 24h, 7d, 30d" });
  }
  assert.deepEqual(app.call(HIST, { id: "u" }).body, { enabled: false });
  enabled = true;
  const body = app.call(HIST, { id: "u" }).body;
  assert.equal(body.enabled, true);
  assert.equal(body.range, "1h");
  assert.deepEqual(body.points, [{ t: START, gpuUtil: { avg: 42, max: 42 } }]);
  assert.equal(app.call(HIST, { id: "u" }, { range: "30d" }).body.stepMs, 90 * 60 * S);
  assert.deepEqual(app.call(GPU, { id: "u" }).body, { t: [START], u: [1], c: [2], p: [3], gpus: [] });
});

test("gpu-history clamps windowMs to [1 min, the store's deepest window]", () => {
  const seen = [];
  const store = { maxWindowMs: 7 * D, window: (id, w) => (seen.push(w), {}) };
  const app = fakeApp();
  registerUnitHistoryRoutes(app, { store, hasUnit: () => true, isEnabled: () => true, now: () => START });
  for (const windowMs of [undefined, "abc", "5", String(2 * D), String(30 * D)]) {
    app.call("/api/sparks/:id/gpu-history", { id: "u" }, { windowMs });
  }
  assert.deepEqual(seen, [8 * H, 8 * H, 60 * S, 2 * D, 7 * D]);
});
