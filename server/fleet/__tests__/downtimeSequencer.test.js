/**
 * downtimeSequencer.test.js — SC8 downtime/execute flow.
 * buildDowntimePreview is pure; executeDowntimeSequence takes the fake
 * fleet-connection surface + fakeFetch (zero real endpoints, zero servers —
 * same discipline as componentActions.test.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildDowntimePreview, executeDowntimeSequence } from "../downtimeSequencer.js";

const OK_PLAN = {
  stacks: [
    {
      stackId: "tp2-target",
      nodes: ["gx10-1c2c", "gx10-27c1"],
      components: [
        { nodeId: "gx10-1c2c", component: "old-llm-1", action: "stop", freesBytes: 100 },
        { nodeId: "gx10-1c2c", component: "new-llm-1", action: "start" },
      ],
    },
  ],
};

// ─── preview: contract guards (TypeError style, waveSequencer precedent) ───

test("buildDowntimePreview: contract guards", () => {
  const bad = [
    null,
    "string",
    [],
    {}, // no stacks
    { stacks: "no" },
    { stacks: [null] },
    { stacks: [{ nodes: [], components: [] }] }, // no stackId
    { stacks: [{ stackId: "", nodes: [], components: [] }] },
    { stacks: [OK_PLAN.stacks[0], OK_PLAN.stacks[0]] }, // duplicate stackId
    { stacks: [{ stackId: "s", nodes: "gx1", components: [] }] }, // nodes not array
    { stacks: [{ stackId: "s", nodes: [42], components: [] }] },
    { stacks: [{ stackId: "s", nodes: ["n"], components: "x" }] }, // components not array
    { stacks: [{ stackId: "s", nodes: ["n"], components: [null] }] },
    { stacks: [{ stackId: "s", nodes: ["n"], components: [{ nodeId: "n", component: "UPPER", action: "stop" }] }] }, // id grammar
    { stacks: [{ stackId: "s", nodes: ["n"], components: [{ nodeId: "n", component: "c", action: "switch" }] }] }, // v1 verb is gone
    { stacks: [{ stackId: "s", nodes: ["n"], components: [{ nodeId: "other", component: "c", action: "stop" }] }] }, // off-stack node
    { stacks: [{ stackId: "s", nodes: ["n"], components: [{ nodeId: "n", component: "c", action: "stop", freesBytes: -1 }] }] },
    { stacks: [], targetFreeBytes: "lots" },
    { stacks: [], targetFreeBytes: -5 },
  ];
  for (const b of bad) {
    assert.throws(() => buildDowntimePreview(b), TypeError, JSON.stringify(b));
  }
});

// ─── preview: ordering + per-stack parallel structure ──────────────────────

test("shutdown = reverse dependency order; startup = dependency order", () => {
  const p = buildDowntimePreview({
    stacks: [
      {
        stackId: "s",
        nodes: ["n"],
        components: [
          { nodeId: "n", component: "gpu-exporter", action: "stop", freesBytes: 5 },
          { nodeId: "n", component: "engine", action: "stop", freesBytes: 60 },
          { nodeId: "n", component: "llm", action: "stop", freesBytes: 40 },
          { nodeId: "n", component: "proxy", action: "restart" },
          { nodeId: "n", component: "replacement", action: "start" },
        ],
      },
    ],
  });
  assert.deepEqual(
    p.shutdownSequence.flat().map((s) => s.componentId),
    ["llm", "engine", "gpu-exporter"],
    "dependents stop BEFORE what they depend on"
  );
  assert.deepEqual(
    p.startupSequence.flat().map((s) => s.componentId),
    ["proxy", "replacement"],
    "restart rides the startup phase in the given order"
  );
});

test("waves: one stack's steps run in order ACROSS waves", () => {
  const p = buildDowntimePreview(OK_PLAN);
  assert.equal(p.shutdownSequence.length, 1);
  assert.equal(p.startupSequence.length, 1);
  assert.equal(p.shutdownSequence[0].length, 1);
});

test("waves: different stacks share a wave (parallel per stack)", () => {
  const p = buildDowntimePreview({
    stacks: [
      { stackId: "a", nodes: ["n1"], components: [
        { nodeId: "n1", component: "a1", action: "stop", freesBytes: 10 },
        { nodeId: "n1", component: "a2", action: "stop", freesBytes: 10 },
      ]},
      { stackId: "b", nodes: ["n2"], components: [
        { nodeId: "n2", component: "b1", action: "stop", freesBytes: 10 },
      ]},
    ],
  });
  // stack a stops b1-reversed [a2,a1]; stack b [b1] → wave0: a2+b1 parallel, wave1: a1 alone
  assert.deepEqual(p.shutdownSequence.map((w) => w.map((s) => s.componentId)), [
    ["a2", "b1"],
    ["a1"],
  ]);
  assert.equal(
    p.shutdownSequence.flat().every((s) => s.type === "stop"),
    true
  );
});

// ─── preview: feasibility math ─────────────────────────────────────────────

test("freeBytesProjected counts stops only; unknown counts 0", () => {
  const p = buildDowntimePreview({
    stacks: [
      {
        stackId: "s",
        nodes: ["n"],
        components: [
          { nodeId: "n", component: "a", action: "stop", freesBytes: 100 },
          { nodeId: "n", component: "b", action: "stop" }, // unknown → 0
          { nodeId: "n", component: "c", action: "restart", freesBytes: 999 }, // never counts
          { nodeId: "n", component: "d", action: "start", freesBytes: 999 }, // never counts
        ],
      },
    ],
    targetFreeBytes: 100,
  });
  assert.equal(p.freeBytesProjected, 100);
  assert.equal(p.feasible, true, "boundary >= is feasible");
  assert.equal(p.targetFreeBytes, 100);
  const infeasible = buildDowntimePreview({
    stacks: [{ stackId: "s", nodes: ["n"], components: [{ nodeId: "n", component: "a", action: "stop", freesBytes: 1 }] }],
    targetFreeBytes: 2,
  });
  const infeasible2 = buildDowntimePreview({
    stacks: [{ stackId: "s", nodes: ["n"], components: [{ nodeId: "n", component: "a", action: "stop", freesBytes: 1 }]}],
    targetFreeBytes: 2,
  });
  assert.equal(infeasible2.feasible, false);
});

test("empty plan: empty phases, target 0 feasible, target >0 infeasible", () => {
  const p = buildDowntimePreview({ stacks: [] });
  assert.deepEqual(p.shutdownSequence, []);
  assert.deepEqual(p.startupSequence, []);
  assert.equal(p.feasible, true);
  assert.equal(p.freeBytesProjected, 0);
  assert.equal(buildDowntimePreview({ stacks: [], targetFreeBytes: 1 }).feasible, false);
});

// ─── execute: contract guards ──────────────────────────────────────────────

const PREVIEW = buildDowntimePreview(OK_PLAN);
const connSurface = (online = true) => ({
  isOnline: () => online,
  nodes: [
    { id: "gx10-1c2c", lanIp: "10.0.0.1", agentPort: 8123 },
    { id: "gx10-27c1", lanIp: "10.0.0.2", agentPort: 8123 },
  ],
});

test("executeDowntimeSequence: contract guards (preview shape, connection surface)", async () => {
  await assert.rejects(() => executeDowntimeSequence(null, { connection: connSurface() }), TypeError);
  await assert.rejects(
    () => executeDowntimeSequence({ ...PREVIEW, shutdownSequence: "nope" }, { connection: connSurface() }),
    TypeError
  );
  await assert.rejects(
    () => executeDowntimeSequence({ ...PREVIEW, startupSequence: [[{ stackId: "s", nodeId: "n", componentId: "BAD", type: "stop" }]] }, { connection: connSurface() }),
    TypeError,
    "componentId grammar is re-guarded on the execute path"
  );
  await assert.rejects(
    () => executeDowntimeSequence(PREVIEW, { connection: { getSnapshot: () => null } }),
    TypeError,
    "connection must expose isOnline + nodes"
  );
});

test("execute: infeasible preview fails CLOSED — zero dispatch, zero results", async () => {
  let dialed = 0;
  const r = await executeDowntimeSequence({ ...PREVIEW, feasible: false, freeBytesProjected: 0, targetFreeBytes: 999 }, {
    connection: connSurface(),
    fetchImpl: async () => { dialed++; return { status: 200, ok: true, json: async () => ({ ok: true }) }; },
  });
  assert.equal(dialed, 0);
  assert.equal(r.ok, false);
  assert.equal(r.executed, 0);
  assert.deepEqual(r.results, []);
  assert.match(r.error, /not feasible/);
});

// ─── execute: live walk over the componentActions seam ─────────────────────

function okFetch(calls, perCall) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const out = typeof perCall === "function" ? perCall(calls.length) : perCall;
    if (out?.throw) throw new Error("connect ECONNREFUSED");
    return {
      status: out?.status ?? 200,
      ok: (out?.status ?? 200) >= 200 && (out?.status ?? 200) < 300,
      json: async () => out?.body ?? { ok: true },
    };
  };
}

test("execute: full walk — shutdown waves before startup, server-owned envelope per step", async () => {
  const calls = [];
  let seq = 0;
  const r = await executeDowntimeSequence(PREVIEW, {
    connection: connSurface(),
    actor: "dashboard:steve",
    actionId: () => `srv-${seq++}`,
    fetchImpl: okFetch(calls),
  });
  assert.equal(r.ok, true);
  assert.equal(r.stoppedAt, null);
  assert.equal(r.executed, 2);
  assert.deepEqual(
    calls.map((c) => [c.body.componentId, c.body.type]),
    [["old-llm-1", "stop"], ["new-llm-1", "start"]],
    "shutdown phase walks to completion before startup begins"
  );
  assert.deepEqual(
    calls.map((c) => c.url),
    ["http://10.0.0.1:8123/actions", "http://10.0.0.1:8123/actions"]
  );
  for (const [i, c] of calls.entries()) {
    assert.equal(c.body.version, 2, "server owns version");
    assert.equal(c.body.actionId, `srv-${i}`, "server owns actionId");
    assert.equal(c.body.nodeId, "gx10-1c2c", "server owns nodeId (route/node stamp, not plan text)");
    assert.equal(c.body.actor, "dashboard:steve", "server owns actor");
  }
  assert.deepEqual(
    r.results.map((x) => [x.phase, x.wave, x.ok, x.status, x.actionId]),
    [["shutdown", 0, true, 200, "srv-0"], ["startup", 0, true, 200, "srv-1"]]
  );
});

test("execute: same-wave steps dispatch in parallel; later waves wait", async () => {
  const parallel = buildDowntimePreview({
    stacks: [
      { stackId: "a", nodes: ["n1", "n2"], components: [
        { nodeId: "n1", component: "a1", action: "stop", freesBytes: 10 },
        { nodeId: "n1", component: "a2", action: "stop", freesBytes: 10 },
      ]},
      { stackId: "b", nodes: ["n2"], components: [
        { nodeId: "n2", component: "b1", action: "stop", freesBytes: 10 },
      ]},
    ],
  });
  let inFlight = 0;
  let maxInFlight = 0;
  const order = [];
  const fetchImpl = async (url, init) => {
    order.push(JSON.parse(init.body).componentId);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((res) => setTimeout(res, 5));
    inFlight--;
    return { status: 200, ok: true, json: async () => ({ ok: true }) };
  };
  const r = await executeDowntimeSequence(parallel, {
    connection: { isOnline: () => true, nodes: [
      { id: "n1", endpoint: "h1:1" }, { id: "n2", endpoint: "h2:1" },
    ] },
    fetchImpl,
  });
  assert.equal(r.ok, true);
  assert.equal(maxInFlight, 2, "wave 0 holds one step from each stack, dispatched together");
  assert.deepEqual(order, ["a2", "b1", "a1"], "the second wave's step waits for wave 0 to settle");
});

test("execute: a failing step stops later waves (fail closed, report)", async () => {
  const calls = [];
  const r = await executeDowntimeSequence(PREVIEW, {
    connection: connSurface(),
    fetchImpl: okFetch(calls, (n) => (n === 1 ? { status: 409, body: { error: "confirmation token expired" } } : undefined)),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.stoppedAt, { phase: "shutdown", wave: 0 });
  assert.equal(calls.length, 1, "the startup wave was never attempted");
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].ok, false);
  assert.equal(r.results[0].status, 502, "the seam's status mapping: upstream non-ok → 502");
  assert.equal(r.results[0].error, "confirmation token expired", "upstream error surfaces verbatim");
});

test("execute: async running counts as NOT success (no status polling in this seam)", async () => {
  const calls = [];
  const r = await executeDowntimeSequence(PREVIEW, {
    connection: connSurface(),
    fetchImpl: okFetch(calls, { status: 200, body: { ok: false, status: "running" } }),
  });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1, "a boot still in flight never advances the sequence");
  assert.equal(r.results[0].ok, false);
});

test("execute: offline node fails the wave pre-flight CLOSED — nothing in the wave is dialed", async () => {
  const calls = [];
  let online = true;
  const r = await executeDowntimeSequence(PREVIEW, {
    connection: { isOnline: (id) => id !== "gx10-1c2c" && online, nodes: connSurface().nodes },
    fetchImpl: okFetch(calls),
  });
  assert.equal(calls.length, 0, "pre-flight fails BEFORE any dispatch in the wave");
  assert.equal(r.ok, false);
  assert.deepEqual(r.stoppedAt, { phase: "shutdown", wave: 0 });
  assert.equal(r.results[0].status, null, "never dispatched");
  assert.match(r.results[0].error, /offline/);
});

test("execute: unknown node id fails closed the same way", async () => {
  const r = await executeDowntimeSequence(PREVIEW, {
    connection: { isOnline: () => true, nodes: [{ id: "someone-else", endpoint: "h:1" }] },
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ ok: true }) }),
  });
  assert.equal(r.executed, 0);
  assert.match(r.results[0].error, /no registry record/);
  assert.equal(r.stoppedAt.phase, "shutdown");
});

test("execute: transport failure maps through the proxy's 502 and stops the walk", async () => {
  const calls = [];
  const r = await executeDowntimeSequence(PREVIEW, {
    connection: connSurface(),
    fetchImpl: okFetch(calls, { throw: true }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.results[0].status, 502);
  assert.match(r.results[0].error, /Node agent unreachable/);
  assert.equal(calls.length, 1);
});
