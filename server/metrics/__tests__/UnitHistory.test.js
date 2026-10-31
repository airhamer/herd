import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UnitHistory, deviceReadings } from "../UnitHistory.js";
import { llmKey } from "../historyTiers.js";

const S = 1_000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const BASE = Date.UTC(2026, 3, 1); // minute- and quarter-hour aligned

function workdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A store on a hand-driven clock; `clock.at` is "now". */
function makeStore(opts = {}) {
  const clock = { at: opts.at ?? BASE };
  const store = new UnitHistory({ logError: () => {}, ...opts, now: () => clock.at });
  return { store, clock };
}

function sample(store, clock, at, values, extra = {}) {
  clock.at = at;
  store.recordSample([{ id: extra.id ?? "u", llmPorts: extra.llmPorts, values }], at);
}

// ─── GPU raw series ───────────────────────────────────────

test("raw: readings are kept at a minimum spacing and served as parallel arrays", () => {
  const { store } = makeStore();
  assert.equal(store.record("u", BASE, 10.04, 50, 33.36), true);
  assert.equal(store.record("u", BASE + 1_000, 99, 99, 99), false, "inside the 1.5 s gap");
  assert.equal(store.record("u", BASE + 1_500, 20, 51, null), true);
  assert.equal(store.record("u", BASE - 5_000, 1, 1, 1), false, "back in time");
  assert.deepEqual(store.get("u"), { t: [BASE, BASE + 1_500], u: [10, 20], c: [50, 51], p: [33.4, null], gpus: [] });
  assert.deepEqual(store.get("u", BASE + 1).t, [BASE + 1_500]);
  assert.deepEqual(store.get("nobody"), { t: [], u: [], c: [], p: [], gpus: [] });
});

test("raw: a reading with nothing finite, or no valid time, is refused", () => {
  const { store } = makeStore();
  assert.equal(store.record("u", BASE, null, NaN, undefined), false);
  assert.equal(store.record("u", NaN, 1, 1, 1), false);
  assert.equal(store.record("u", BASE, null, null, null, [{ index: 0, usage: 5 }]), true, "a card reading counts");
});

test("raw: old readings are cut in chunks while recording and exactly on flush", (t) => {
  const file = path.join(workdir(t), "gpu.json");
  const { store, clock } = makeStore({ file, maxAgeMs: 10 * M, minGapMs: 0 });
  for (let i = 0; i < 100; i++) store.record("u", BASE + i * 10 * S, i, 0, 0);
  // Cutoff at the last reading is 990 s − 600 s = 390 s. Trimming waits until
  // the oldest reading is a minute past due, so it lags by up to ~70 s.
  const oldest = store.get("u").t[0];
  assert.ok(oldest <= BASE + 390 * S && oldest >= BASE + 320 * S, `oldest at ${(oldest - BASE) / S} s`);
  clock.at = BASE + 2 * D;
  store.record("v", clock.at, 1, 1, 1);
  store.flush();
  assert.deepEqual(store.get("u").t, [], "the stale unit is gone after flush");
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).sparks), ["v"]);
});

test("raw: the dense file survives a restart, older readings and bad entries dropped", (t) => {
  const file = path.join(workdir(t), "gpu.json");
  const first = makeStore({ file });
  first.store.record("u", BASE, 1, 2, 3);
  first.store.record("u", BASE + 4 * H, 4, 5, 6);
  first.store.flush();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const second = makeStore({ file, at: BASE + 9 * H });
  assert.deepEqual(second.store.get("u"), { t: [BASE + 4 * H], u: [4], c: [5], p: [6], gpus: [] });

  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, sparks: { u: { t: [BASE, BASE, "x", BASE + 2], u: [1, 2, 3, "y"], c: [], p: [] }, w: 5 } })
  );
  const third = makeStore({ file, at: BASE + M });
  assert.deepEqual(third.store.get("u"), { t: [BASE, BASE + 2], u: [1, null], c: [null, null], p: [null, null], gpus: [] });
});

test("raw: a missing file starts empty; an unreadable one is set aside, not overwritten", (t) => {
  const dir = workdir(t);
  assert.deepEqual(makeStore({ file: path.join(dir, "none.json") }).store.get("u").t, []);
  const file = path.join(dir, "gpu.json");
  fs.writeFileSync(file, "{ broken");
  const { store } = makeStore({ file });
  assert.deepEqual(store.get("u").t, []);
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith("gpu.json.corrupt-"));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), "utf8"), "{ broken");
  store.record("u", BASE, 1, 1, 1);
  store.flush();
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), "utf8"), "{ broken");
});

test("deviceReadings: only for hosts with several cards, honouring availability", () => {
  const card = (index, extra = {}) => ({ index, name: `GPU ${index}`, usage: 50, temperature: 60, power: { draw: 150, limit: 100 }, ...extra });
  assert.deepEqual(deviceReadings([card(0)]), []);
  assert.deepEqual(deviceReadings(undefined), []);
  assert.deepEqual(
    deviceReadings([card(0), card(1, { metricAvailability: { temperature: false, powerLimit: false }, name: 7 }), { index: -1 }]),
    [
      { index: 0, name: "GPU 0", usage: 50, temperature: 60, powerPct: 100 },
      { index: 1, name: null, usage: 50, temperature: null, powerPct: null },
    ]
  );
  assert.equal(deviceReadings(Array.from({ length: 20 }, (_, i) => card(i))).length, 16);
});

test("per-card series run parallel to the aggregate, padded with nulls both ways", () => {
  const { store } = makeStore({ minGapMs: 0 });
  const dev = (index, usage) => ({ index, name: `G${index}`, usage, temperature: 40, powerPct: 10 });
  store.record("h", BASE, 50, 40, 10, [dev(0, 10), dev(1, 90)]);
  store.record("h", BASE + S, 60, 40, 10, [dev(0, 20), dev(1, 91), dev(2, 5)]);
  store.record("h", BASE + 2 * S, 70, 40, 10, [dev(0, 30), dev(2, 6)]);
  const got = store.get("h");
  assert.deepEqual(got.u, [50, 60, 70], "the aggregate is untouched");
  assert.deepEqual(
    got.gpus.map((g) => [g.index, g.name, g.u]),
    [
      [0, "G0", [10, 20, 30]],
      [1, "G1", [90, 91, null]],
      [2, "G2", [null, 5, 6]],
    ]
  );
  assert.deepEqual(store.get("h", BASE + 2 * S).gpus.map((g) => g.index), [0, 2], "a card with nothing in the window is hidden");
  // More than 16 distinct cards are never tracked.
  for (let i = 3; i < 30; i++) store.record("h", BASE + (i + 3) * S, 1, 1, 1, [dev(i, 1)]);
  assert.equal(store.get("h").gpus.length, 16);
});

test("a card that only ever had nulls left in the window is dropped when trimmed", () => {
  const { store } = makeStore({ minGapMs: 0, maxAgeMs: 10 * S });
  const dev = (index, usage) => ({ index, name: null, usage, temperature: null, powerPct: null });
  store.record("h", BASE, 1, 1, 1, [dev(0, 1), dev(1, 1)]);
  for (let i = 1; i <= 140; i++) store.record("h", BASE + i * S, 1, 1, 1, [dev(0, 1), dev(5, 1)]);
  assert.deepEqual(store.get("h").gpus.map((g) => g.index), [0, 5]);
  assert.equal(store.dense.units.get("h").cards.has(1), false);
});

test("cards round-trip through the file, and files without cards still load", (t) => {
  const file = path.join(workdir(t), "gpu.json");
  const a = makeStore({ file });
  a.store.record("h", BASE, 1, 2, 3, [
    { index: 0, name: "A", usage: 4, temperature: 5, powerPct: 6 },
    { index: 3, name: "B", usage: 7, temperature: null, powerPct: null },
  ]);
  a.store.flush();
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(onDisk, {
    version: 1,
    sparks: { h: { t: [BASE], u: [1], c: [2], p: [3], g: { 0: { n: "A", u: [4], c: [5], p: [6] }, 3: { n: "B", u: [7], c: [null], p: [null] } } } },
  });
  assert.deepEqual(makeStore({ file }).store.get("h").gpus.map((g) => [g.index, g.name, g.u]), [
    [0, "A", [4]],
    [3, "B", [7]],
  ]);
  fs.writeFileSync(file, JSON.stringify({ version: 1, sparks: { s: { t: [BASE], u: [9], c: [8], p: [7] } } }));
  assert.deepEqual(makeStore({ file }).store.get("s"), { t: [BASE], u: [9], c: [8], p: [7], gpus: [] });
});

test("long series: minute readings for a week in their own file; window() picks the depth", (t) => {
  const dir = workdir(t);
  const file = path.join(dir, "gpu.json");
  const longFile = path.join(dir, "gpu-long.json");
  const { store, clock } = makeStore({ file, longFile });
  assert.equal(store.maxWindowMs, 7 * D);
  for (let at = BASE; at <= BASE + 6 * D; at += 30 * S) {
    clock.at = at;
    store.record("u", at, 50, 60, 70);
  }
  const end = BASE + 6 * D;
  const dense = store.window("u", 8 * H, end);
  const long = store.window("u", 6 * D, end);
  assert.equal(dense.t.length, 8 * 120 + 1);
  assert.equal(long.t.length, 6 * 24 * 60 + 1);
  assert.equal(long.t[1] - long.t[0], M);
  store.flush();
  assert.equal(JSON.parse(fs.readFileSync(longFile, "utf8")).sparks.u.t.length, 6 * 24 * 60 + 1);
  assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).sparks.u.t.length <= 8 * 120 + 1);

  const reopened = makeStore({ file, longFile, at: end }).store;
  assert.equal(reopened.window("u", 6 * D, end).t.length, 6 * 24 * 60 + 1);
});

test("without a long series every window is the dense one (8 h by default)", () => {
  const { store } = makeStore({ minGapMs: 0 });
  assert.equal(store.long, null);
  assert.equal(store.maxWindowMs, 8 * H);
  for (let at = BASE; at <= BASE + 10 * H; at += 10 * M) store.record("u", at, 1, 1, 1);
  store._prune(BASE + 10 * H);
  const w = store.window("u", store.maxWindowMs, BASE + 10 * H);
  assert.equal(w.t[0], BASE + 2 * H);
  const inMemoryLong = makeStore({ longFile: null }).store;
  assert.notEqual(inMemoryLong.long, null);
  assert.equal(inMemoryLong.maxWindowMs, 7 * D);
});

// ─── Bucketed tiers ───────────────────────────────────────

test("tiers: minute buckets carry avg / max / n, and min for free memory only", () => {
  const { store, clock } = makeStore();
  sample(store, clock, BASE + 5 * S, { gpuUtil: 10, memFreeMB: 900 });
  sample(store, clock, BASE + 25 * S, { gpuUtil: 40, memFreeMB: 300 });
  sample(store, clock, BASE + M + S, { gpuUtil: 70, bogus: 5, cpuUtil: Infinity });
  const q = store.query("u", "1h", BASE + M + 2 * S);
  assert.deepEqual(q.points, [
    { t: BASE, gpuUtil: { avg: 25, max: 40 }, memFreeMB: { avg: 600, max: 900, min: 300 } },
    { t: BASE + M, gpuUtil: { avg: 70, max: 70 } },
  ]);
  assert.equal(q.stepMs, M);
  assert.equal(q.to - q.from, H);
  const file = store.serializeTiers(BASE + M + 2 * S);
  assert.deepEqual(file.units.u["1m"].series.gpuUtil.n, [2, 1]);
  assert.deepEqual(file.units.u["15m"].series.gpuUtil, { avg: [40], max: [70], n: [3] });
});

test("tiers: the 24 h range merges minute buckets three at a time, by weight", () => {
  const { store, clock } = makeStore();
  sample(store, clock, BASE, { cpuUtil: 10 });
  sample(store, clock, BASE + 2 * S, { cpuUtil: 20 });
  sample(store, clock, BASE + 2 * M, { cpuUtil: 70 });
  sample(store, clock, BASE + 3 * M, { cpuUtil: 1 });
  const q = store.query("u", "24h", BASE + 3 * M);
  assert.equal(q.stepMs, 3 * M);
  assert.deepEqual(q.points, [
    { t: BASE, cpuUtil: { avg: 33.33, max: 70 } },
    { t: BASE + 3 * M, cpuUtil: { avg: 1, max: 1 } },
  ]);
  assert.deepEqual(store.query("u", "7d", BASE + 3 * M).points, [{ t: BASE, cpuUtil: { avg: 25.25, max: 70 } }]);
  assert.throws(() => store.query("u", "12h"), /unknown range: 12h/);
  assert.throws(() => store.query("u", "constructor"), /unknown range/);
});

test("tiers: a unit with no values is a gap, and LLM endpoints are grouped by port", () => {
  const { store, clock } = makeStore();
  const ports = [9000, 8000];
  sample(store, clock, BASE, { gpuUtil: 5, [llmKey(9000, "genTps")]: 30, [llmKey(8000, "kvUsage")]: 0.5 }, { llmPorts: ports });
  sample(store, clock, BASE + M, null, { llmPorts: ports });
  sample(store, clock, BASE + 2 * M, {}, { llmPorts: ports });
  sample(store, clock, BASE + 3 * M, { gpuUtil: 6, [llmKey(9000, "prefillTps")]: 1234.5 }, { llmPorts: ports });
  const q = store.query("u", "1h", BASE + 3 * M);
  assert.deepEqual(q.points.map((p) => p.t), [BASE, BASE + 3 * M]);
  assert.deepEqual(q.llm, [
    { port: 8000, points: [{ t: BASE, kvUsage: { avg: 0.5, max: 0.5 } }] },
    {
      port: 9000,
      points: [
        { t: BASE, genTps: { avg: 30, max: 30 } },
        { t: BASE + 3 * M, prefillTps: { avg: 1235, max: 1235 } },
      ],
    },
  ]);
  // Dropping a port hides its series straight away.
  sample(store, clock, BASE + 4 * M, { gpuUtil: 1 }, { llmPorts: [9000] });
  assert.deepEqual(store.query("u", "1h").llm.map((e) => e.port), [9000]);
  assert.deepEqual(store.query("ghost", "1h", BASE).points, []);
  assert.deepEqual(store.query("ghost", "1h", BASE).llm, []);
});

test("tiers and the raw series are separate; remove() forgets a unit everywhere", () => {
  const { store, clock } = makeStore();
  sample(store, clock, BASE, { gpuUtil: 5 });
  assert.deepEqual(store.get("u").t, [], "tier samples do not feed the raw series");
  store.record("u", BASE, 1, 1, 1);
  assert.equal(store.query("u", "1h", BASE).points[0].gpuUtil.avg, 5, "raw readings do not feed the tiers");
  store.remove("u");
  assert.deepEqual(store.get("u").t, []);
  assert.deepEqual(store.query("u", "1h", BASE).points, []);
});

test("tiers: minute buckets leave after 48 h, quarter-hours after 30 days", () => {
  const { store, clock } = makeStore();
  sample(store, clock, BASE, { netRx: 1 });
  sample(store, clock, BASE + 48 * H, { netRx: 2 });
  let file = store.serializeTiers(BASE + 48 * H);
  assert.deepEqual(file.units.u["1m"].t, [BASE, BASE + 48 * H]);
  sample(store, clock, BASE + 48 * H + M, { netRx: 3 });
  file = store.serializeTiers(BASE + 48 * H + M);
  assert.equal(file.units.u["1m"].t[0], BASE + 48 * H);
  assert.equal(file.units.u["15m"].t[0], BASE);
  sample(store, clock, BASE + 30 * D + 15 * M, { netRx: 4 });
  file = store.serializeTiers(BASE + 30 * D + 15 * M);
  assert.equal(file.units.u["15m"].t[0], BASE + 48 * H);
});

// ─── Persistence of the tiers ─────────────────────────────

test("save() writes the tiers asynchronously at 0600 and they load back, the open bucket included", async (t) => {
  const tiersFile = path.join(workdir(t), "metrics-history.json");
  const a = makeStore({ tiersFile });
  sample(a.store, a.clock, BASE, { gpuTemp: 50 });
  sample(a.store, a.clock, BASE + 10 * S, { gpuTemp: 60, memFreeMB: 10 });
  await a.store.save();
  assert.equal(fs.statSync(tiersFile).mode & 0o777, 0o600);
  const disk = JSON.parse(fs.readFileSync(tiersFile, "utf8"));
  assert.equal(disk.version, 1);
  assert.equal(disk.savedAt, BASE + 10 * S);
  assert.deepEqual(disk.units.u["1m"], {
    t: [BASE],
    series: { gpuTemp: { avg: [55], max: [60], n: [2] }, memFreeMB: { avg: [10], max: [10], min: [10], n: [1] } },
  });
  const b = makeStore({ tiersFile, at: BASE + 20 * S });
  assert.deepEqual(b.store.query("u", "1h").points, a.store.query("u", "1h", BASE + 20 * S).points);
});

test("odd unit ids (__proto__, constructor, toString) survive save and load", async (t) => {
  const tiersFile = path.join(workdir(t), "mh.json");
  const file = path.join(path.dirname(tiersFile), "gpu.json");
  const ids = ["__proto__", "constructor", "toString"];
  const a = makeStore({ tiersFile, file });
  a.store.recordSample(ids.map((id, i) => ({ id, values: { cpuUtil: i + 1 } })), BASE);
  for (const id of ids) a.store.record(id, BASE, 1, 1, 1);
  await a.store.save();
  const b = makeStore({ tiersFile, file, at: BASE + S });
  for (const [i, id] of ids.entries()) {
    assert.deepEqual(b.store.query(id, "1h").points, [{ t: BASE, cpuUtil: { avg: i + 1, max: i + 1 } }]);
    assert.deepEqual(b.store.get(id).t, [BASE]);
  }
  assert.deepEqual(Object.keys(b.store.serializeTiers().units).sort(), [...ids].sort());
});

test("overlapping save() calls share one write", async () => {
  const writes = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const { store, clock } = makeStore({
    tiersFile: "/virtual/mh.json",
    readFileSync: () => {
      throw Object.assign(new Error("none"), { code: "ENOENT" });
    },
    yieldFn: async () => {},
    writeAsync: async (file, text) => {
      writes.push(file);
      await gate;
      return true;
    },
  });
  sample(store, clock, BASE, { cpuUtil: 1 });
  const first = store.save();
  const second = store.save();
  assert.equal(first, second);
  release();
  await first;
  assert.deepEqual(writes, ["/virtual/mh.json"]);
  await store.save();
  assert.equal(writes.length, 1, "nothing changed, nothing written");
  sample(store, clock, BASE + S, { cpuUtil: 2 });
  await store.save();
  assert.equal(writes.length, 2);
});

test("flush() overtakes a save in flight, whose late rename is then refused", async () => {
  let pending;
  const syncWrites = [];
  const { store, clock } = makeStore({
    tiersFile: "/virtual/mh.json",
    readFileSync: () => {
      throw Object.assign(new Error("none"), { code: "ENOENT" });
    },
    yieldFn: async () => {},
    writeAsync: (file, text, mode, { shouldCommit }) =>
      new Promise((resolve) => {
        pending = () => resolve(shouldCommit());
      }),
    writeSync: (file, text) => syncWrites.push(JSON.parse(text).units.u["1m"].series.cpuUtil.avg),
  });
  sample(store, clock, BASE, { cpuUtil: 1 });
  const inFlight = store.save();
  await new Promise((r) => setImmediate(r));
  sample(store, clock, BASE + M, { cpuUtil: 3 });
  assert.equal(store.flush(), true);
  assert.deepEqual(syncWrites, [[1, 3]]);
  pending();
  await inFlight;
  assert.equal(store.flush(), false, "the flushed state counts as written");
});

test("save() hands the event loop back between units", async () => {
  const order = [];
  const { store } = makeStore({
    tiersFile: "/virtual/mh.json",
    readFileSync: () => {
      throw Object.assign(new Error("none"), { code: "ENOENT" });
    },
    yieldFn: async () => order.push("yield"),
    writeAsync: async () => {
      order.push("write");
      return true;
    },
  });
  store.recordSample(["a", "b", "c"].map((id) => ({ id, values: { cpuUtil: 1 } })), BASE);
  await store.save();
  assert.deepEqual(order, ["yield", "yield", "yield", "write"]);
});

test("units that left the fleet and ports a unit dropped are gone from the next file", (t) => {
  const tiersFile = path.join(workdir(t), "mh.json");
  const { store } = makeStore({ tiersFile });
  store.recordSample(
    [
      { id: "stay", llmPorts: [1, 2], values: { cpuUtil: 1, [llmKey(1, "genTps")]: 5, [llmKey(2, "genTps")]: 6 } },
      { id: "leave", values: { cpuUtil: 2 } },
    ],
    BASE
  );
  store.flush();
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(tiersFile, "utf8")).units).sort(), ["leave", "stay"]);
  // Only membership changes: that alone is worth a write.
  store.recordSample([{ id: "stay", llmPorts: [2], values: null }], BASE + S);
  assert.equal(store.flush(), true);
  const disk = JSON.parse(fs.readFileSync(tiersFile, "utf8"));
  assert.deepEqual(Object.keys(disk.units), ["stay"]);
  assert.deepEqual(Object.keys(disk.units.stay["1m"].series), ["cpuUtil", "llm:2:genTps"]);
});

test("a store whose tiers never record never touches the tiers file", (t) => {
  const dir = workdir(t);
  const tiersFile = path.join(dir, "mh.json");
  fs.writeFileSync(tiersFile, "not json at all");
  const { store } = makeStore({ tiersFile, file: path.join(dir, "gpu.json") });
  store.record("u", BASE, 1, 1, 1);
  store.flush();
  assert.equal(fs.readFileSync(tiersFile, "utf8"), "not json at all");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["gpu.json", "mh.json"]);
});

test("an unreadable or foreign tiers file is set aside, not overwritten", (t) => {
  for (const content of ["{oops", JSON.stringify({ version: 2, units: {} }), JSON.stringify({ version: 1 })]) {
    const dir = workdir(t);
    const tiersFile = path.join(dir, "mh.json");
    fs.writeFileSync(tiersFile, content);
    const { store, clock } = makeStore({ tiersFile });
    sample(store, clock, BASE, { cpuUtil: 1 });
    store.flush();
    const aside = fs.readdirSync(dir).find((f) => f.startsWith("mh.json.corrupt-"));
    assert.ok(aside, content);
    assert.equal(fs.readFileSync(path.join(dir, aside), "utf8"), content);
    assert.equal(JSON.parse(fs.readFileSync(tiersFile, "utf8")).units.u["1m"].series.cpuUtil.avg[0], 1);
  }
});

test("the GPU file is also written by save(), in its unchanged format", async (t) => {
  const file = path.join(workdir(t), "gpu.json");
  const { store } = makeStore({ file });
  store.record("u", BASE, 11, 22, 33);
  await store.save();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    version: 1,
    sparks: { u: { t: [BASE], u: [11], c: [22], p: [33], g: {} } },
  });
});

test("a month of buckets for a unit with one endpoint stays below 1.4 MB on disk", () => {
  const { store, clock } = makeStore();
  const values = {
    gpuUtil: 91.37, gpuTemp: 66.5, gpuPower: 81.23, memUsedMB: 110_000, memFreeMB: 9_123, cpuUtil: 17.25,
    cpuTemp: 61.5, ramUsedMB: 24_000, netRx: 2_345_678, netTx: 876_543,
    [llmKey(8000, "genTps")]: 38.21, [llmKey(8000, "prefillTps")]: 2_101.7, [llmKey(8000, "kvUsage")]: 0.0731,
  };
  const end = BASE + 30 * D;
  for (let at = BASE; at < end - 48 * H; at += 15 * M) sample(store, clock, at, values, { llmPorts: [8000] });
  for (let at = end - 48 * H; at < end; at += M) sample(store, clock, at, values, { llmPorts: [8000] });
  const bytes = Buffer.byteLength(JSON.stringify(store.serializeTiers(end)));
  assert.ok(bytes < 1.4 * 1024 * 1024, `${bytes} bytes`);
});

test("with the setting off nothing reaches the tiers file; pending buckets follow when it is back on", async (t) => {
  const tiersFile = path.join(workdir(t), "mh.json");
  let on = true;
  const { store, clock } = makeStore({ tiersFile, tiersEnabled: () => on });
  sample(store, clock, BASE, { cpuUtil: 1 });
  on = false;
  await store.save();
  assert.equal(store.flush(), false);
  assert.equal(fs.existsSync(tiersFile), false);
  on = true;
  await store.save();
  assert.equal(JSON.parse(fs.readFileSync(tiersFile, "utf8")).units.u["1m"].series.cpuUtil.avg[0], 1);
});
