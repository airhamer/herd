// REAL-WIRING integration test (BATCH6C-BRIEF ruling 4 — durable program rule:
// real module wiring, never stubbed exported shapes).
//
// Imports the REAL createUpdatesProxy + the REAL createWaveSequencer. The
// fake boundary is the node HTTP layer only: a fake fetch (Batch-5
// injection convention, opts.fetch) serves each node's GET /updates body
// exactly as agent/http.js does ({ snapshot, state, schedules }). The
// sequencer is wired EXACTLY as server/index.js does it —
//   updateStates: () => proxy.getCachedStates()
// — over production-shaped /telemetry snapshots: NO `updates` mount, because
// that is what the real agent build sends (the exact gap Batch 6c closes).
// No HTTP server, no timers, no real ports, no real /api/v1/update_reboot.

import test from "node:test";
import assert from "node:assert/strict";

import { createUpdatesProxy } from "../updatesProxy.js";
import { createWaveSequencer } from "../waveSequencer.js";

// ── Minimal fake node layer (same contract as updatesProxy.test.js) ────────

function node(id) {
  return { id, name: id, endpoint: `192.168.50.${100 + id.charCodeAt(0)}:30091`, lanIp: null };
}

const urlFor = (n) => `http://${n.endpoint}/updates`;
const okRes = (body) => ({ ok: true, status: 200, json: async () => body });

function updatesBody(over = {}) {
  return {
    snapshot: {
      probedAt: 1000,
      agentReachable: true,
      swBuild: "7.2.3",
      otaAvailable: null,
      packages: [],
      firmware: [],
      updatesDisabled: false,
    },
    state: {
      inProgress: false,
      stage: null,
      startedAt: null,
      finishedAt: null,
      bootId: "boot-1",
      lastOutcome: null,
      lastOutcomeDetail: null,
      events: [],
    },
    schedules: [],
    ...over,
  };
}

const IDLE_OK = { lastOutcome: "success", startedAt: 1000, finishedAt: 5000 };
const REBOOTING = {
  inProgress: true,
  stage: "reboot",
  startedAt: 1500,
  events: [{ at: 1500, stage: "reboot", message: "rebooting now" }],
};

function fakeFetch(handlers = {}) {
  const h = { ...handlers };
  const fn = async (url) => {
    const r = h[String(url)];
    if (r === "throw") throw new Error(`ENETUNREACH ${url}`);
    if (r === undefined) throw new TypeError(`unhandled url ${url}`);
    return r;
  };
  return { fn, set: (u, v) => { h[u] = v; } };
}

/** Production /telemetry reality: snapshots WITHOUT any `updates` mount. */
function prodConn(ids, { neverPolled = [] } = {}) {
  const on = new Set(ids);
  const unpolled = new Set(neverPolled);
  return {
    getSnapshot: (id) =>
      on.has(id) && !unpolled.has(id) ? { nodeId: id, online: true, llm: [] } : null,
    isOnline: (id) => on.has(id),
  };
}

const NODES = [node("a"), node("b"), node("c")];
const PLAN = {
  groups: [
    { nodeIds: ["a", "b"], reason: "tp-pair" },
    { nodeIds: ["c"], reason: "manual" },
  ],
  createdAt: 1,
  startedAt: 1000,
  waveStates: ["pending", "pending"],
};

/** index.js wiring, verbatim: proxy fan-out → getCachedStates → gate. */
function wired(handlers, { now = () => 2000, conn } = {}) {
  const { fn, set } = fakeFetch(handlers);
  const proxy = createUpdatesProxy({ nodes: NODES, fetch: fn, now });
  const sequencer = createWaveSequencer({
    nodes: NODES,
    connection: conn,
    plan: PLAN,
    now,
    updateStates: () => proxy.getCachedStates(),
  });
  return { proxy, sequencer, set };
}

// ── Gate opens on cached fan-out evidence alone (the production gap) ─────

test("real wiring: one member rebooting in /updates → wave OPEN with NO telemetry updates mount", async () => {
  const conn = prodConn(["a", "b"]);
  const { proxy, sequencer } = wired(
    {
      [urlFor(NODES[0])]: okRes(updatesBody({ state: { ...updatesBody().state, ...IDLE_OK } })),
      [urlFor(NODES[1])]: okRes(updatesBody({ state: { ...updatesBody().state, ...REBOOTING } })),
      // c never answers /updates and was never polled: absence, not evidence.
    },
    { conn }
  );
  await proxy.getAllViews(); // ONE fan-out drives everything below
  assert.equal(sequencer.isWaveOpen(), true, "cache evidence opens the gate");
  assert.equal(sequencer.getCurrentWave(), 0);
  assert.deepEqual(sequencer.getWaveStates(), ["rebooting", "pending"]);
  assert.equal(sequencer.canAdvance(), false);
  assert.equal(sequencer.isFullyAvailable("a"), true, "idle-success opens via cache");
  assert.equal(sequencer.isFullyAvailable("b"), false, "rebooting member never opens");
  assert.equal(sequencer.isFullyAvailable("c"), false, "no evidence → closed, never fabricated");

  // Regression witness — the SAME data on the Batch-6 wiring (no updateStates):
  const blind = createWaveSequencer({ nodes: NODES, connection: conn, plan: PLAN, now: () => 2000 });
  assert.deepEqual(blind.getWaveStates(), ["pending", "pending"], "the gate was blind without the cache");
  assert.equal(blind.isWaveOpen(), false);
});

test("real wiring: all wave-0 members idle-success → wave-0 healthy, advance allowed", async () => {
  const conn = prodConn(["a", "b", "c"]);
  const { proxy, sequencer } = wired(
    {
      [urlFor(NODES[0])]: okRes(updatesBody({ state: { ...updatesBody().state, ...IDLE_OK } })),
      [urlFor(NODES[1])]: okRes(updatesBody({ state: { ...updatesBody().state, ...IDLE_OK } })),
      [urlFor(NODES[2])]: okRes(updatesBody()), // no outcome yet → wave 1 still pending
    },
    { conn }
  );
  await proxy.getAllViews();
  assert.deepEqual(sequencer.getWaveStates(), ["healthy", "pending"]);
  assert.equal(sequencer.isWaveOpen(), false);
  assert.equal(sequencer.canAdvance(), true, "gate opens on cache evidence alone");
  assert.equal(sequencer.getCurrentWave(), null);
});

test("real wiring: fan-out NEVER succeeded → cache empty → gate FAILS CLOSED everywhere", async () => {
  const conn = prodConn(["a", "b", "c"]);
  const { proxy, sequencer } = wired(
    {
      [urlFor(NODES[0])]: "throw",
      [urlFor(NODES[1])]: "throw",
      [urlFor(NODES[2])]: "throw",
    },
    { conn }
  );
  await proxy.getAllViews(); // fan-out "fails" per node; getAllViews itself resolves
  assert.deepEqual(proxy.getCachedStates(), {}, "failed fan-out caches nothing");
  assert.equal(sequencer.isWaveOpen(), false, "absence of evidence never opens");
  assert.deepEqual(sequencer.getWaveStates(), ["pending", "pending"]);
  assert.equal(sequencer.isFullyAvailable("a"), false);
  assert.equal(sequencer.canAdvance(), true, "fireable pending ≠ opened (Batch-5 semantics hold)");
});

test("real wiring: later fan-out FAILURE keeps the gate on last-known cache evidence", async () => {
  const conn = prodConn(["a", "b"]);
  const handlers = {
    [urlFor(NODES[0])]: okRes(updatesBody({ state: { ...updatesBody().state, ...IDLE_OK } })),
    [urlFor(NODES[1])]: okRes(updatesBody({ state: { ...updatesBody().state, ...REBOOTING } })),
  };
  const { proxy, sequencer, set } = wired(handlers, { conn });
  await proxy.getAllViews();
  assert.equal(sequencer.isWaveOpen(), true);
  // Entire fleet goes dark (mid-reboot box is exactly this): 
  set(urlFor(NODES[0]), "throw");
  set(urlFor(NODES[1]), "throw");
  await proxy.getAllViews();
  assert.equal(sequencer.isWaveOpen(), true, "last-known evidence still holds the wave open");
  assert.deepEqual(sequencer.getWaveStates(), ["rebooting", "pending"]);
  assert.equal(sequencer.canAdvance(), false);
});
