// Tests for server/fleet/waveSequencer.js — run with `node --test`.
//
// The sequencer consumes a FleetConnection; tests inject a plain-object
// fake exposing exactly the seam (getSnapshot + isOnline, the surface
// fleet/connection.js documents). Every timestamp comes from an injected
// now() — no real timers, no intervals, nothing time-dependent. The gate
// advance logic and the 6-minute grace transitions are the subject.

import test from "node:test";
import assert from "node:assert/strict";

import { createWaveSequencer, RECOVER_GRACE_MS } from "../waveSequencer.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** The seam: only getSnapshot + isOnline are consumed. */
function fakeConn(snapshots = {}, online = []) {
  const snaps = { ...snapshots };
  const on = new Set(online);
  return {
    snaps,
    on,
    getSnapshot: (id) => (id in snaps ? snaps[id] : null),
    isOnline: (id) => on.has(id),
  };
}

/** A /telemetry snapshot with the updates view merged at `updates` (SPEC §6.2 mount). */
function makeSnap(nodeId, stOver = {}, opts = {}) {
  return {
    nodeId,
    online: true,
    llm: opts.llm !== undefined ? opts.llm : [],
    updates: {
      snapshot: { probedAt: 1000, agentReachable: true, dgxConfigured: true },
      state: {
        inProgress: false,
        stage: null,
        startedAt: null,
        finishedAt: null,
        bootId: "boot-1",
        lastOutcome: null,
        lastOutcomeDetail: null,
        events: [],
        ...stOver,
      },
    },
  };
}

/** A node that passed the gate: success outcome, not in progress, LLM ok. */
function healthySnap(nodeId, over = {}) {
  return makeSnap(
    nodeId,
    { lastOutcome: "success", finishedAt: over.finishedAt ?? 5000, startedAt: 1000 },
    { llm: over.llm ?? [] }
  );
}

function healthyConn(ids, opts = {}) {
  const snapshots = {};
  for (const id of ids) snapshots[id] = opts.snap ? opts.snap(id) : healthySnap(id);
  return fakeConn(snapshots, ids);
}

function planOf(groups, startedAt = null) {
  return {
    groups: groups.map((nodeIds) => ({ nodeIds, reason: "tp-pair" })),
    createdAt: 1,
    startedAt,
    waveStates: groups.map(() => "pending"),
  };
}

function makeSeq(plan, connection, { graceMs, now = () => 0 } = {}) {
  return createWaveSequencer({
    nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
    connection,
    plan,
    now,
    ...(graceMs !== undefined ? { graceMs } : {}),
  });
}

// ── Factory guards ──────────────────────────────────────────────────────────

test("createWaveSequencer: contract guards (connection surface, nodes array)", () => {
  assert.throws(() => createWaveSequencer({}), /getSnapshot \+ isOnline/);
  assert.throws(() => createWaveSequencer({ connection: {} }), /getSnapshot \+ isOnline/);
  assert.throws(
    () => createWaveSequencer({ nodes: null, connection: fakeConn() }),
    /nodes must be an array/
  );
  // plan optional/absent is legal, not an error:
  const s = makeSeq(null, fakeConn());
  assert.deepEqual(s.getWaveStates(), []);
});

// ── isFullyAvailable: the four checks ──────────────────────────────────────

test("isFullyAvailable: all four checks pass → true", () => {
  const conn = healthyConn(["a"], {
    snap: (id) => healthySnap(id, { llm: [{ port: 8080, backend: "sglang" }] }),
  });
  assert.equal(makeSeq(planOf([["a"]], 1000), conn).isFullyAvailable("a"), true);
});

test("isFullyAvailable: EACH check rejects independently (negative cases)", () => {
  // 1. offline
  let conn = fakeConn({ a: healthySnap("a") }, []); // online set empty
  assert.equal(makeSeq(planOf([["a"]], 1000), conn).isFullyAvailable("a"), false);
  // 2a. no outcome yet
  conn = fakeConn({ a: makeSnap("a") }, ["a"]);
  assert.equal(makeSeq(planOf([["a"]], 1000), conn).isFullyAvailable("a"), false);
  // 2b. failed outcome
  conn = fakeConn({ a: makeSnap("a", { lastOutcome: "error", finishedAt: 6000 }) }, ["a"]);
  assert.equal(makeSeq(planOf([["a"]], 1000), conn).isFullyAvailable("a"), false);
  // 3. update still in progress (even with a success tail)
  conn = fakeConn(
    { a: makeSnap("a", { inProgress: true, stage: "upgrade_packages", lastOutcome: "success", startedAt: 1000 }) },
    ["a"]
  );
  assert.equal(makeSeq(planOf([["a"]], 1000), conn).isFullyAvailable("a"), false);
  // 4. LLM endpoint unhealthy (probe could not resolve a backend)
  conn = fakeConn({ a: healthySnap("a", { llm: [{ port: 8000, backend: null }] }) }, ["a"]);
  assert.equal(makeSeq(planOf([["a"]], 1000), conn).isFullyAvailable("a"), false);
  // 4-vacuous: no LLM metrics on this node → check does not apply
  conn = fakeConn({ a: healthySnap("a", { llm: [] }) }, ["a"]);
  assert.equal(makeSeq(planOf([["a"]], 1000), conn).isFullyAvailable("a"), true);
});

test("isFullyAvailable: snapshot WITHOUT update state fails CLOSED (no evidence, no open gate)", () => {
  // The current agent /telemetry build carries no `updates` block — absence
  // must never be read as "available" (it is not evidence of success).
  const conn = fakeConn({ a: { nodeId: "a", online: true, llm: [] } }, ["a"]);
  assert.equal(makeSeq(planOf([["a"]], 1000), conn).isFullyAvailable("a"), false);
});

// ── Gate advance (conditional, not clock-based) ─────────────────────────────

test("gate closed while a member updates: wave running, canAdvance false, open", () => {
  const conn = fakeConn(
    {
      a: healthySnap("a"),
      b: makeSnap("b", { inProgress: true, stage: "upgrade_packages", startedAt: 2000 }),
    },
    ["a", "b"]
  );
  const s = makeSeq(planOf([["a", "b"], ["c"]], 1000), conn);
  assert.deepEqual(s.getWaveStates(), ["running", "pending"]);
  assert.equal(s.canAdvance(), false);
  assert.equal(s.isWaveOpen(), true);
  assert.equal(s.getCurrentWave(), 0);
});

test("gate opens when ALL members pass; next wave may fire", () => {
  const conn = healthyConn(["a", "b"]);
  const s = makeSeq(planOf([["a", "b"], ["c"]], 1000), conn);
  assert.deepEqual(s.getWaveStates(), ["healthy", "pending"]);
  assert.equal(s.canAdvance(), true);
  assert.equal(s.isWaveOpen(), false);
  assert.equal(s.getCurrentWave(), null);
});

test("TP pair goes together: one member's unhealthy LLM holds the whole wave", () => {
  // §3.1: updating a TP pair one node at a time is exactly what the group is
  // for — the pair advances only when BOTH are fully available.
  const conn = fakeConn(
    {
      b: healthySnap("b", { llm: [{ port: 8000, backend: "sglang" }] }),
      c: healthySnap("c", { llm: [{ port: 8000, backend: null }] }),
    },
    ["b", "c"]
  );
  const plan = planOf([["b", "c"]], 1000);
  const s = makeSeq(plan, conn);
  assert.deepEqual(s.getWaveStates(), ["running"], "outcome exists but the gate is not open");
  assert.equal(s.canAdvance(), false);
  // LLM comes back → the SAME plan, no clock involved, opens the gate.
  conn.snaps.c = healthySnap("c", { llm: [{ port: 8000, backend: "vllm" }] });
  assert.deepEqual(s.getWaveStates(), ["healthy"]);
  assert.equal(s.canAdvance(), false, "single-wave plan: nothing remains to advance");
});

test("plan already fully healthy → open false, canAdvance false (nothing left)", () => {
  const conn = healthyConn(["a"]);
  const s = makeSeq(planOf([["a"]], 1000), conn);
  assert.deepEqual(s.getWaveStates(), ["healthy"]);
  assert.equal(s.isWaveOpen(), false);
  assert.equal(s.getCurrentWave(), null);
  assert.equal(s.canAdvance(), false);
});

test("later wave in flight: currentWave is THAT wave, earlier healthy wave leads", () => {
  const conn = healthyConn(["a"]);
  conn.snaps.b = makeSnap("b", { inProgress: true, stage: "upgrade_firmware", startedAt: 3000 });
  conn.on.add("b");
  const s = makeSeq(planOf([["a"], ["b"]], 1000), conn);
  assert.deepEqual(s.getWaveStates(), ["healthy", "running"]);
  assert.equal(s.getCurrentWave(), 1);
  assert.equal(s.isWaveOpen(), true);
  assert.equal(s.canAdvance(), false);
});

// ── Grace: rebooting → slow at 6 min, no action ever ────────────────────────

test("default grace is 6 minutes (RECOVER_GRACE_MS)", () => {
  assert.equal(RECOVER_GRACE_MS, 6 * 60_000);
});

test("grace transitions: rebooting before 6 min, slow at 6 min (boundary >=)", () => {
  let nowMs = 0;
  const conn = fakeConn(
    { a: makeSnap("a", { inProgress: true, stage: "reboot", startedAt: 0 }) },
    ["a"]
  );
  const s = makeSeq(planOf([["a"]], 0), conn, { now: () => nowMs });
  nowMs = RECOVER_GRACE_MS - 1;
  assert.deepEqual(s.getWaveStates(), ["rebooting"]);
  assert.equal(s.isWaveOpen(), true);
  assert.equal(s.canAdvance(), false);
  nowMs = RECOVER_GRACE_MS; // exact boundary flips
  assert.deepEqual(s.getWaveStates(), ["slow"]);
  assert.equal(s.isWaveOpen(), true, "slow is still an open wave");
  assert.equal(s.canAdvance(), false, "slow never opens the gate");
});

test("grace clock starts at the FIRST REBOOT EVENT, not startedAt (known answer)", () => {
  // update started at 0, the reboot stream event came at 100_000 → the
  // 6-minute window must run from 100_000, not from 0.
  let nowMs = 100_000 + RECOVER_GRACE_MS - 1;
  const conn = fakeConn(
    {
      a: makeSnap("a", {
        inProgress: true,
        stage: "reboot",
        startedAt: 0,
        events: [
          { at: 10_000, stage: "upgrade_packages", message: "packages" },
          { at: 100_000, stage: "reboot", message: "rebooting now" },
        ],
      }),
    },
    ["a"]
  );
  const s = makeSeq(planOf([["a"]], 0), conn, { now: () => nowMs });
  assert.deepEqual(s.getWaveStates(), ["rebooting"], "elapsed is 359.999s from the EVENT (not 100_000+grace from startedAt)");
  nowMs += 1;
  assert.deepEqual(s.getWaveStates(), ["slow"]);
});

test("knob graceMs (non-default 60s) flips slow at ITS boundary", () => {
  let nowMs = 59_000;
  const conn = fakeConn(
    { a: makeSnap("a", { inProgress: true, stage: "reboot", startedAt: 0 }) },
    ["a"]
  );
  const s = makeSeq(planOf([["a"]], 0), conn, { graceMs: 60_000, now: () => nowMs });
  assert.deepEqual(s.getWaveStates(), ["rebooting"]);
  nowMs = 60_000;
  assert.deepEqual(s.getWaveStates(), ["slow"], "knob honored, not the 6-min default");
});

test("mid-update reachability loss reads as rebooting (not updating) and counts grace", () => {
  // SPEC §6.2: stream reboot OR loss of reachability while updating.
  let nowMs = 30_000;
  const conn = fakeConn(
    { a: makeSnap("a", { inProgress: true, stage: "upgrade_packages", startedAt: 0 }) },
    [] // went dark — never came back
  );
  const s = makeSeq(planOf([["a"]], 0), conn, { now: () => nowMs });
  assert.deepEqual(s.getWaveStates(), ["rebooting"]);
  assert.equal(s.isWaveOpen(), true);
  nowMs = RECOVER_GRACE_MS + 1;
  assert.deepEqual(s.getWaveStates(), ["slow"]);
  assert.equal(s.canAdvance(), false, "still waiting; NOTHING automated touches it (§3.2)");
});

// ── Stuck states hold the gate; guards work without a plan clock ────────────

test("failed member: gate stays shut, wave NOT open (operator may re-trigger)", () => {
  const conn = fakeConn(
    { a: makeSnap("a", { lastOutcome: "error", lastOutcomeDetail: "boom", finishedAt: 5000, startedAt: 1000 }) },
    ["a"]
  );
  const s = makeSeq(planOf([["a"], ["b"]], 1000), conn);
  assert.deepEqual(s.getWaveStates(), ["running", "pending"], "wave holds at running (stuck), not pending");
  assert.equal(s.isWaveOpen(), false, "a terminal error is not 'updating/rebooting/slow'");
  assert.equal(s.canAdvance(), false, "the gate never opens on a failed member");
});

test("outcome predating the plan is NOT attributed to it: wave is untouched/pending", () => {
  const conn = fakeConn(
    { a: makeSnap("a", { lastOutcome: "error", finishedAt: 500 }) }, // plan starts at 1000
    ["a"]
  );
  const s = makeSeq(planOf([["a"]], 1000), conn);
  assert.deepEqual(s.getWaveStates(), ["pending"]);
  assert.equal(s.canAdvance(), true, "wave 0 is fireable (no in-flight update)");
});

test("plan stored but NOT started: waves pending, canAdvance false, guard still live", () => {
  const conn = fakeConn({ a: healthySnap("a") }, ["a"]);
  const s = makeSeq(planOf([["a"]], null), conn);
  assert.deepEqual(s.getWaveStates(), ["pending"]);
  assert.equal(s.canAdvance(), false, "a not-started plan never advances (no wave to advance from)");
  assert.equal(s.isWaveOpen(), false);
  // §3.2 no-interference holds even un-started: any live update window protects.
  conn.snaps.a = makeSnap("a", { inProgress: true, stage: "upgrade_packages", startedAt: 2000 });
  assert.equal(s.isWaveOpen(), true);
});

test("no plan at all: everything empty/false (single-node operation unaffected)", () => {
  const conn = healthyConn(["a"]);
  const s = makeSeq(null, conn);
  assert.deepEqual(s.getWaveStates(), []);
  assert.equal(s.isWaveOpen(), false);
  assert.equal(s.getCurrentWave(), null);
  assert.equal(s.canAdvance(), false);
});

test("determinism: repeated derivation on unchanged input is identical", () => {
  const conn = fakeConn(
    {
      a: healthySnap("a"),
      b: makeSnap("b", { inProgress: true, stage: "reboot", startedAt: 500 }),
    },
    ["a", "b"]
  );
  const s = makeSeq(planOf([["a", "b"], ["c"]], 100), conn, { now: () => 7_000 });
  assert.deepEqual(s.getWaveStates(), s.getWaveStates());
  assert.equal(s.isWaveOpen(), s.isWaveOpen());
  assert.equal(s.getCurrentWave(), s.getCurrentWave());
  assert.deepEqual(s.getWaveStates(), ["rebooting", "pending"]);
});
