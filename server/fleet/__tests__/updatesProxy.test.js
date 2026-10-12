// Tests for server/fleet/updatesProxy.js — run with `node --test`.
//
// Style mirrors __tests__/connection.test.js: fetch stubbed via the factory's
// `opts.fetch` injection point (no global stubbing needed), injected now()
// for every time-dependent assertion. Nothing here touches a real agent,
// a real port, or a real clock — the fan-out HTTP layer is the stub boundary.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createUpdatesProxy,
  createPlanStore,
  defaultUpdateState,
} from "../updatesProxy.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Deterministic distinct LAN octet per id (100–249) — mirrors connection.test.js. */
function octetFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 250;
  return 100 + h;
}

function node(id, over = {}) {
  const octet = octetFor(id);
  return {
    id,
    name: id,
    endpoint: `192.168.50.${octet}:30091`,
    lanIp: `192.168.50.${octet}`,
    role: "standalone",
    rank: null,
    groupId: null,
    headId: null,
    links: [],
    agentPort: 30091,
    isLocal: false,
    ...over,
  };
}

/**
 * Fake fetch with per-URL mutable handlers (same contract as connection.test.js):
 *   object → Response-like; "throw" → rejects; "hang" → resolves only on abort.
 */
function fakeFetch(initial = {}) {
  const handlers = { ...initial };
  const calls = [];
  const fn = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    const h = handlers[u];
    if (h === "throw") throw new Error(`ENETUNREACH ${u}`);
    if (h === "hang") {
      return new Promise((resolve, reject) => {
        const sig = init?.signal;
        if (sig) {
          if (sig.aborted) {
            reject(new Error("aborted"));
            return;
          }
          sig.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }
        // A hang with NO signal would deadlock getAllViews — completion of
        // "hang" tests is itself proof the timeout signal reached fetch.
      });
    }
    if (typeof h === "object" && h !== null) return h;
    throw new TypeError(`unhandled url ${u}`);
  };
  return { fn, calls, set: (u, h) => { handlers[String(u)] = h; } };
}

const okRes = (body) => ({ ok: true, status: 200, json: async () => body });
const errRes = (status = 500) => ({
  ok: false,
  status,
  json: async () => ({ error: "boom" }),
});

/** Valid GET /updates body (seam: agent/http.js → updates.fullView()). */
function body(over = {}) {
  return {
    snapshot: {
      probedAt: 1000,
      agentReachable: true,
      swBuild: "7.2.3",
      latestOtaApplied: { version: "7.6.0", date: "2026-09-17" },
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

const urlFor = (n) => `http://${n.endpoint}/updates`;

// ─── Factory surface ────────────────────────────────────────────────────────

test("createUpdatesProxy: surface + timeoutMs default and knob", () => {
  const proxy = createUpdatesProxy({ nodes: [], fetch: fakeFetch().fn });
  assert.equal(typeof proxy.getAllViews, "function");
  assert.equal(typeof proxy.buildView, "function");
  assert.equal(proxy.timeoutMs, 5000);
  const knobbed = createUpdatesProxy({
    nodes: [],
    fetch: fakeFetch().fn,
    timeoutMs: 1234,
  });
  assert.equal(knobbed.timeoutMs, 1234);
  assert.throws(() => createUpdatesProxy({ nodes: null }), /nodes must be an array/);
});

// ─── buildView: display / grace / waveIndex derivation (known-answer) ──────

const FIXED_NOW = 1_000_000;
function proxyWithClock(plan = null) {
  return createUpdatesProxy({
    nodes: [],
    fetch: fakeFetch().fn,
    plan,
    now: () => FIXED_NOW,
  });
}

test("buildView: happy body → reachable NodeUpdatesView, exact §9 key set", () => {
  const v = proxyWithClock().buildView(node("a"), body());
  assert.deepEqual(Object.keys(v).sort(), [
    "display",
    "graceElapsedMs",
    "nodeId",
    "reachable",
    "schedules",
    "snapshot",
    "state",
    "waveIndex",
  ]);
  assert.equal(v.nodeId, "a");
  assert.equal(v.reachable, true);
  assert.equal(v.display, "current");
  assert.equal(v.graceElapsedMs, null);
  assert.equal(v.waveIndex, null);
  assert.deepEqual(v.snapshot, body().snapshot); // passthrough, untouched
});

test("buildView: display derivation table (precedence included)", () => {
  const p = proxyWithClock();
  const n = node("a");
  const d = (stateOver, snapshotOver) =>
    p.buildView(
      n,
      body({
        state: { ...defaultUpdateState(), ...stateOver },
        ...(snapshotOver !== undefined ? { snapshot: snapshotOver } : {}),
      })
    ).display;
  assert.equal(d({ inProgress: true, stage: "reboot" }), "rebooting");
  assert.equal(d({ inProgress: true, stage: "upgrade_packages" }), "updating");
  assert.equal(d({ inProgress: true, stage: "reboot" }, null), "rebooting"); // inProgress wins over degraded
  assert.equal(d({ lastOutcome: "error" }), "failed");
  assert.equal(
    d({ lastOutcome: "error" }, { ...body().snapshot, otaAvailable: { version: "7.6.0" } }),
    "failed",
    "error outcome outranks available OTA"
  );
  assert.equal(
    d({}, { ...body().snapshot, otaAvailable: { version: "7.7.0" } }),
    "available"
  );
  assert.equal(d({}), "current");
  assert.equal(d({}, null), "current"); // degraded snapshot, no OTA → current
});

test("buildView: graceElapsedMs = now - startedAt while rebooting", () => {
  const v = proxyWithClock().buildView(
    node("a"),
    body({
      state: { ...defaultUpdateState(), inProgress: true, stage: "reboot", startedAt: FIXED_NOW - 90_000 },
    })
  );
  assert.equal(v.display, "rebooting");
  assert.equal(v.graceElapsedMs, 90_000); // known answer: 1_000_000 - 910_000
});

test("buildView: first reboot EVENT time beats startedAt (grace clock start)", () => {
  // startedAt long ago, but the reboot event just happened → grace counts
  // from the event, NOT from startedAt.
  const v = proxyWithClock().buildView(
    node("a"),
    body({
      state: {
        ...defaultUpdateState(),
        inProgress: true,
        stage: "reboot",
        startedAt: 0,
        events: [{ at: FIXED_NOW - 50_000, stage: "reboot", message: "rebooting now" }],
      },
    })
  );
  assert.equal(v.graceElapsedMs, 50_000, "not 1_000_000");
});

test("buildView: graceElapsedMs null for every non-rebooting state", () => {
  const p = proxyWithClock();
  assert.equal(
    p.buildView(node("a"), body({ state: { ...defaultUpdateState(), inProgress: true, stage: "update_cache", startedAt: 0 } }))
      .graceElapsedMs,
    null
  );
  assert.equal(
    p.buildView(node("a"), body({ state: { ...defaultUpdateState(), lastOutcome: "success", startedAt: 0 } }))
      .graceElapsedMs,
    null
  );
});

test("buildView: state defaults filled, extra fields passthrough, schedules passthrough", () => {
  const v = proxyWithClock().buildView(
    node("a"),
    body({
      state: { inProgress: true, stage: "upgrade_firmware", startedAt: 7, custom: "x", events: "nope" },
      schedules: [{ id: "s1", kind: "at" }],
    })
  );
  assert.equal(v.state.custom, "x");
  assert.equal(v.state.bootId, null, "missing declared field defaulted");
  assert.deepEqual(v.state.events, [], "non-array events coerced to []");
  assert.deepEqual(v.schedules, [{ id: "s1", kind: "at" }]);
});

test("buildView: malformed bodies THROW (escalate-don't-accommodate boundary)", () => {
  const p = proxyWithClock();
  assert.throws(() => p.buildView(node("a"), null), TypeError);
  assert.throws(() => p.buildView(node("a"), [1, 2]), TypeError);
  assert.throws(() => p.buildView(node("a"), { snapshot: {} }), /missing its DgxUpdateState/);
  assert.throws(() => p.buildView(node("a"), { state: [], schedules: [] }), /DgxUpdateState/);
});

test("buildView: waveIndex from plan membership; null without plan", () => {
  const plan = {
    groups: [
      { nodeIds: ["a"], reason: "standalone" },
      { nodeIds: ["b", "c"], reason: "tp-pair" },
    ],
    createdAt: 0,
    startedAt: null,
    waveStates: ["pending", "pending"],
  };
  const p = proxyWithClock(plan);
  assert.equal(p.buildView(node("a"), body()).waveIndex, 0);
  assert.equal(p.buildView(node("c"), body()).waveIndex, 1);
  assert.equal(p.buildView(node("ghost"), body()).waveIndex, null);
  assert.equal(proxyWithClock(null).buildView(node("a"), body()).waveIndex, null);
});

// ─── getAllViews: fan-out + graceful degradation ────────────────────────────

test("getAllViews: 2 healthy nodes → one view each, deterministic across runs", async () => {
  const nodes = [node("a"), node("b")];
  const { fn, calls } = fakeFetch({
    [urlFor(nodes[0])]: okRes(body()),
    [urlFor(nodes[1])]: okRes(body({ snapshot: { ...body().snapshot, otaAvailable: { version: "7.7.0" } } })),
  });
  const proxy = createUpdatesProxy({ nodes, fetch: fn, now: () => 42 });
  const run1 = await proxy.getAllViews();
  assert.equal(run1.length, 2);
  assert.deepEqual(run1.map((v) => [v.nodeId, v.reachable, v.display]), [
    ["a", true, "current"],
    ["b", true, "available"],
  ]);
  // Only the two /updates URLs were hit.
  assert.deepEqual([...new Set(calls.map((c) => c.url))].sort(), [urlFor(nodes[0]), urlFor(nodes[1])]);
  const run2 = await proxy.getAllViews();
  assert.deepEqual(run1, run2, "identical inputs → identical output (determinism)");
});

test("getAllViews: unreachable node, never polled → stale view, nothing fabricated", async () => {
  const nodes = [node("a")];
  const { fn } = fakeFetch({ [urlFor(nodes[0])]: "throw" });
  const [v] = await createUpdatesProxy({ nodes, fetch: fn }).getAllViews();
  assert.equal(v.reachable, false);
  assert.equal(v.display, "stale");
  assert.equal(v.snapshot, null, "no last view → null snapshot, never fabricated");
  assert.deepEqual(v.state, defaultUpdateState());
  assert.deepEqual(v.schedules, []);
  assert.equal(v.graceElapsedMs, null);
});

test("getAllViews: node dies AFTER a good view → last view kept, reachable:false", async () => {
  const nodes = [node("a")];
  const good = body({
    snapshot: { ...body().snapshot, otaAvailable: { version: "7.7.0" } },
    state: { ...defaultUpdateState(), lastOutcome: "success", finishedAt: 5 },
    schedules: [{ id: "s9", kind: "cron", cron: "0 3 * * 0" }],
  });
  const { fn, set } = fakeFetch({ [urlFor(nodes[0])]: okRes(good) });
  const proxy = createUpdatesProxy({ nodes, fetch: fn });
  const [v1] = await proxy.getAllViews();
  assert.equal(v1.display, "available");
  set(urlFor(nodes[0]), "throw");
  const [v2] = await proxy.getAllViews();
  assert.equal(v2.reachable, false);
  assert.equal(v2.display, "stale", "unreachable outranks the last-good display");
  assert.deepEqual(v2.snapshot, good.snapshot, "last snapshot RETAINED, not wiped");
  assert.deepEqual(v2.schedules, good.schedules);
  assert.equal(v2.state.lastOutcome, "success", "last state retained");
});

test("getAllViews: HTTP 500 → degraded, last view kept", async () => {
  const nodes = [node("a")];
  const { fn, set } = fakeFetch({ [urlFor(nodes[0])]: okRes(body()) });
  const proxy = createUpdatesProxy({ nodes, fetch: fn });
  await proxy.getAllViews();
  set(urlFor(nodes[0]), errRes(500));
  const [v] = await proxy.getAllViews();
  assert.equal(v.reachable, false);
  assert.equal(v.display, "stale");
  assert.ok(v.snapshot, "cache kept");
});

test("getAllViews: malformed JSON body → degraded, last view kept", async () => {
  const nodes = [node("a")];
  const badJson = {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token <");
    },
  };
  const { fn, set } = fakeFetch({ [urlFor(nodes[0])]: okRes(body()) });
  const proxy = createUpdatesProxy({ nodes, fetch: fn });
  await proxy.getAllViews();
  set(urlFor(nodes[0]), badJson);
  const [v] = await proxy.getAllViews();
  assert.equal(v.reachable, false);
  assert.ok(v.snapshot);
});

test("getAllViews: object body missing state is malformed → degraded (contract enforced)", async () => {
  const nodes = [node("a")];
  const { fn, set } = fakeFetch({ [urlFor(nodes[0])]: okRes(body()) });
  const proxy = createUpdatesProxy({ nodes, fetch: fn });
  await proxy.getAllViews();
  set(urlFor(nodes[0]), okRes({ snapshot: { probedAt: 999 } })); // no state — out of contract
  const [v] = await proxy.getAllViews();
  assert.equal(v.reachable, false, "out-of-contract body is NOT accommodated");
  assert.equal(v.display, "stale");
  assert.ok(v.snapshot, "previous good view kept");
});

test("knob timeoutMs is wired: hang aborts within budget, AbortSignal reaches fetch", async () => {
  const nodes = [node("a")];
  const { fn, calls } = fakeFetch({ [urlFor(nodes[0])]: "hang" });
  const proxy = createUpdatesProxy({ nodes, fetch: fn, timeoutMs: 50 });
  const t0 = Date.now();
  const [v] = await proxy.getAllViews();
  const dt = Date.now() - t0;
  assert.ok(dt < 1000, `timeout bounded the fan-out (${dt}ms < 1000ms)`);
  assert.equal(v.reachable, false);
  assert.equal(v.display, "stale");
  assert.ok(calls[0].init?.signal instanceof AbortSignal, "AbortSignal passed to fetch");
});

test("node with no endpoint/lanIp → zero fetches for it, stale view", async () => {
  const nodes = [node("a"), node("ghost", { endpoint: "", lanIp: "" })];
  const { fn, calls } = fakeFetch({ [urlFor(nodes[0])]: okRes(body()) });
  const views = await createUpdatesProxy({ nodes, fetch: fn }).getAllViews();
  assert.equal(calls.length, 1, "no fetch attempted for the unresolvable node");
  assert.equal(views[1].reachable, false);
  assert.equal(views[1].display, "stale");
});

test("degraded view carries a fresh waveIndex from the factory plan", async () => {
  const nodes = [node("a")];
  const { fn, set } = fakeFetch({ [urlFor(nodes[0])]: okRes(body()) });
  const plan = {
    groups: [{ nodeIds: ["a"], reason: "tp-pair" }],
    createdAt: 0,
    startedAt: 0,
    waveStates: ["running"],
  };
  const proxy = createUpdatesProxy({ nodes, fetch: fn, plan });
  await proxy.getAllViews();
  set(urlFor(nodes[0]), "throw");
  const [v] = await proxy.getAllViews();
  assert.equal(v.reachable, false);
  assert.equal(v.waveIndex, 0);
});

// ─── Plan store (createPlanStore) ───────────────────────────────────────────

function tmpPlanPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-plan-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "fleet-update-plan.json");
}

const PLAN_FIXTURE = {
  groups: [{ nodeIds: ["gx10-1c2c"], reason: "standalone" }],
  createdAt: 111,
  startedAt: null,
  waveStates: ["pending"],
};

test("planStore: missing file → null (no plan, never an error)", (t) => {
  const store = createPlanStore({ path: tmpPlanPath(t) + "/nope.json" });
  assert.equal(store.read(), null);
});

test("planStore: write→read round trip; run twice → byte-identical file", (t) => {
  const p = tmpPlanPath(t);
  const store = createPlanStore({ path: p });
  store.write(PLAN_FIXTURE);
  assert.deepEqual(store.read(), PLAN_FIXTURE);
  const bytes1 = fs.readFileSync(p, "utf-8");
  store.write(PLAN_FIXTURE);
  assert.equal(fs.readFileSync(p, "utf-8"), bytes1, "deterministic serialization");
  assert.deepEqual(fs.readdirSync(path.dirname(p)), ["fleet-update-plan.json"], "no .tmp residue");
});

test("planStore: corrupt JSON → null with warn, never a crash", (t) => {
  const p = tmpPlanPath(t);
  fs.writeFileSync(p, "{ not json");
  const store = createPlanStore({ path: p });
  assert.equal(store.read(), null);
});

test("planStore: out-of-shape JSON (array / no groups) → null, never accommodated", (t) => {
  const p = tmpPlanPath(t);
  const store = createPlanStore({ path: p });
  fs.writeFileSync(p, JSON.stringify([1, 2]));
  assert.equal(store.read(), null);
  fs.writeFileSync(p, JSON.stringify({ hello: "world" }));
  assert.equal(store.read(), null);
});

test("planStore: write(null) removes the file; null-when-absent is a no-op", (t) => {
  const p = tmpPlanPath(t);
  const store = createPlanStore({ path: p });
  store.write(null); // absent → no-op, must not throw
  store.write(PLAN_FIXTURE);
  store.write(null);
  assert.equal(fs.existsSync(p), false);
  assert.equal(store.read(), null);
});

test("planStore: normalization on write (reason default, waveStates coerce, strict rejects)", (t) => {
  const store = createPlanStore({ path: tmpPlanPath(t) });
  store.write({
    groups: [{ nodeIds: [" a "], reason: "chaos" }],
    createdAt: 5,
    startedAt: -1,
    waveStates: ["bogus"],
  });
  const plan = store.read();
  assert.deepEqual(plan.groups[0], { nodeIds: ["a"], reason: "manual" });
  assert.equal(plan.startedAt, null);
  assert.deepEqual(plan.waveStates, ["pending"]);
  assert.throws(() => store.write({ groups: [], createdAt: 1 }), /non-empty/);
  assert.throws(() => store.write({ groups: [{ nodeIds: [7] }], createdAt: 1 }), /non-string/);
  assert.throws(() => store.write({ groups: [{ nodeIds: ["a"] }] }), /createdAt/);
});
