// Activity diffs, watcher and event builders (issue #32).
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { Settler, activity, createActivityWatcher, diffNode, diffSpark, withUnitNames } from "../activity.js";

const spark = (over = {}) => ({
  id: "s1",
  name: "spark-one",
  online: true,
  health: [],
  metrics: { gpu: { throttle: { active: false, reason: "ok", detail: "" } } },
  ...over,
});
const throttled = (reason = "thermal", extra = {}) =>
  spark({ metrics: { gpu: { throttle: { active: true, reason, detail: "84 °C", ...extra } } } });
const capped = (mhz) => spark({ metrics: { gpu: { throttle: { active: false, reason: "ok", clockCapMHz: mhz } } } });
const finding = (id, severity = "warn", title = `Finding ${id}`) => ({ id, severity, title, detail: "", hint: "" });

const node = (over = {}) => ({
  nodeId: "n1",
  nodeName: "node-one",
  online: true,
  enrollment: "claimed",
  containers: [{ name: "vllm", image: "vllm:latest", status: "running" }],
  services: [{ name: "vllm", kind: "llm", engine: "vllm", port: 8000, status: "running", modelId: "qwen" }],
  ...over,
});
const types = (events) => events.map((e) => e.type);

describe("Settler", () => {
  test("first sight is a baseline; a change needs `need` consecutive observations", () => {
    const s = new Settler(2);
    assert.equal(s.observe("k", "a"), null);
    assert.equal(s.observe("k", "b"), null);
    assert.equal(s.observe("k", "a"), null, "back to settled resets");
    assert.equal(s.observe("k", "b"), null);
    assert.deepEqual(s.observe("k", "b"), { from: "a", to: "b" });
    assert.equal(s.observe("k", "b"), null);
  });

  test("forget drops keys by prefix", () => {
    const s = new Settler(1);
    s.observe("x\u0000a", 1);
    s.observe("y\u0000a", 1);
    s.forget("x\u0000");
    assert.deepEqual(s.keys(""), ["y\u0000a"]);
  });
});

describe("diffSpark", () => {
  test("online and offline transitions", () => {
    const down = diffSpark(spark(), spark({ online: false }));
    assert.deepEqual(types(down), ["spark.offline"]);
    assert.equal(down[0].severity, "warn");
    assert.equal(down[0].sparkId, "s1");
    assert.equal(down[0].sparkName, "spark-one");
    assert.equal(down[0].message, "spark-one went offline");
    const up = diffSpark(spark({ online: false }), spark());
    assert.deepEqual(types(up), ["spark.online"]);
    assert.equal(up[0].severity, "success");
  });

  test("an offline unit reports nothing about its stale metrics", () => {
    assert.deepEqual(diffSpark(spark({ online: false }), { ...throttled(), online: false }), []);
  });

  test("throttle start (with reason) and end", () => {
    const settler = new Settler(1);
    diffSpark(spark(), spark(), settler); // baseline
    const start = diffSpark(spark(), throttled("power"), settler);
    assert.deepEqual(types(start), ["gpu.throttle.start"]);
    assert.match(start[0].message, /power/);
    assert.deepEqual(start[0].data, { reason: "power" });
    const end = diffSpark(throttled("power"), spark(), settler);
    assert.deepEqual(types(end), ["gpu.throttle.end"]);
  });

  test("throttle flapping for a single tick is ignored with SETTLE_TICKS=2", () => {
    const settler = new Settler(2);
    diffSpark(spark(), spark(), settler);
    assert.deepEqual(diffSpark(spark(), throttled(), settler), []);
    assert.deepEqual(diffSpark(throttled(), spark(), settler), []);
    assert.deepEqual(diffSpark(spark(), throttled(), settler), []);
    assert.deepEqual(types(diffSpark(throttled(), throttled(), settler)), ["gpu.throttle.start"]);
  });

  test("clock cap set, changed and released", () => {
    assert.deepEqual(types(diffSpark(capped(null), capped(1500))), ["gpu.clock.capped"]);
    const changed = diffSpark(capped(1500), capped(1200));
    assert.equal(changed[0].message, "GPU clock cap changed from 1500 to 1200 MHz");
    assert.deepEqual(types(diffSpark(capped(1200), capped(null))), ["gpu.clock.released"]);
    assert.deepEqual(diffSpark(spark(), capped(1200)), [], "unreported → reported is not a change");
  });

  test("health findings raised (critical → error) and cleared", () => {
    const settler = new Settler(1);
    const raised = diffSpark(spark(), spark({ health: [finding("disk", "critical", "Disk nearly full")] }), settler);
    assert.deepEqual(types(raised), ["health.raised"]);
    assert.equal(raised[0].severity, "error");
    assert.equal(raised[0].message, "Disk nearly full");
    const cleared = diffSpark(spark({ health: [finding("disk", "critical", "Disk nearly full")] }), spark(), settler);
    assert.deepEqual(types(cleared), ["health.cleared"]);
    assert.equal(cleared[0].message, "Disk nearly full cleared");
  });

  test("a finding gone for two ticks clears even after it left both snapshots", () => {
    const settler = new Settler(2);
    const sick = spark({ health: [finding("mem")] });
    diffSpark(spark(), sick, settler);
    assert.deepEqual(types(diffSpark(sick, sick, settler)), ["health.raised"]);
    assert.deepEqual(diffSpark(sick, spark(), settler), []);
    assert.deepEqual(types(diffSpark(spark(), spark(), settler)), ["health.cleared"]);
  });
});

describe("diffNode", () => {
  test("online, offline and claimed", () => {
    assert.deepEqual(types(diffNode(node({ online: false }), node())), ["node.online"]);
    assert.deepEqual(types(diffNode(node(), node({ online: false }))), ["node.offline"]);
    const claimed = diffNode(node({ enrollment: "pending" }), node());
    assert.deepEqual(types(claimed), ["node.claimed"]);
    assert.equal(claimed[0].sparkId, "n1");
    assert.equal(claimed[0].sparkName, "node-one");
  });

  test("container start and stop by name", () => {
    const stopped = node({ containers: [{ name: "vllm", image: "vllm:latest", status: "exited" }] });
    const out = diffNode(node(), stopped);
    assert.deepEqual(types(out), ["container.stopped"]);
    assert.equal(out[0].message, "Container vllm exited");
    assert.deepEqual(types(diffNode(stopped, node())), ["container.started"]);
    const extra = node({ containers: [...node().containers, { name: "comfy", status: "running" }] });
    assert.deepEqual(types(diffNode(node(), extra)), ["container.started"]);
  });

  test("an empty container list (not collected) is not a mass stop", () => {
    assert.deepEqual(diffNode(node(), node({ containers: [] })), []);
    assert.deepEqual(diffNode(node({ containers: [] }), node()), []);
  });

  test("service started, stopped and wedged; loading is quiet", () => {
    const svc = (status) => node({ services: [{ ...node().services[0], status }] });
    assert.deepEqual(types(diffNode(svc("loading"), svc("running"))), ["service.started"]);
    const stop = diffNode(svc("running"), svc("stopped"));
    assert.deepEqual(types(stop), ["service.stopped"]);
    assert.equal(stop[0].message, "Service vllm (qwen) stopped");
    const wedged = diffNode(svc("running"), svc("wedged"));
    assert.deepEqual(types(wedged), ["service.wedged"]);
    assert.equal(wedged[0].severity, "error");
    assert.deepEqual(diffNode(svc("stopped"), svc("loading")), []);
  });

  test("nothing about containers or services while offline", () => {
    const off = node({ online: false, containers: [{ name: "vllm", status: "exited" }] });
    assert.deepEqual(types(diffNode(node(), off)), ["node.offline"]);
  });
});

describe("createActivityWatcher", () => {
  function harness(opts = {}) {
    let sparks = [];
    let nodes = [];
    const recorded = [];
    let clock = 1_000;
    const w = createActivityWatcher({
      getSparks: () => sparks,
      getNodes: () => nodes,
      record: (e) => recorded.push(e),
      settleTicks: 1,
      now: () => clock,
      ...opts,
    });
    return {
      w,
      recorded,
      set: (s, n = nodes) => {
        sparks = s;
        nodes = n;
      },
      advance: (ms) => {
        clock += ms;
      },
    };
  }

  test("first sight is silent; later transitions are recorded", () => {
    const h = harness();
    h.set([spark({ online: false })], [node({ online: false })]);
    h.w.tick();
    assert.deepEqual(h.recorded, []);
    h.set([spark()], [node()]);
    h.w.tick();
    assert.deepEqual(types(h.recorded), ["spark.online", "node.online"]);
  });

  test("a unit that disappears and comes back is a fresh baseline", () => {
    const h = harness();
    h.set([spark()]);
    h.w.tick();
    h.set([]);
    h.w.tick();
    h.set([spark({ online: false })]);
    h.w.tick();
    assert.deepEqual(h.recorded, []);
  });

  test("warm-up after start() absorbs boot transitions", () => {
    const h = harness({ warmupMs: 30_000, intervalMs: 60_000 });
    h.set([spark({ online: false })]);
    h.w.start();
    h.set([spark()]);
    h.w.tick();
    assert.deepEqual(h.recorded, [], "came online during warm-up");
    h.advance(30_000);
    h.set([spark({ online: false })]);
    h.w.tick();
    assert.deepEqual(types(h.recorded), ["spark.offline"]);
    h.w.stop();
  });

  test("a throwing source or sink does not break the tick", () => {
    const recorded = [];
    let n = 0;
    const w = createActivityWatcher({
      getSparks: () => {
        throw new Error("boom");
      },
      getNodes: () => [node({ online: n++ > 0 })],
      record: (e) => {
        recorded.push(e);
        throw new Error("sink down");
      },
    });
    w.tick();
    assert.deepEqual(types(w.tick()), ["node.online"]);
    assert.equal(recorded.length, 1);
  });
});

describe("event builders", () => {
  test("registry events", () => {
    assert.deepEqual(activity.sparkAdded({ id: "s1", name: "alpha" }), {
      type: "spark.added",
      severity: "success",
      sparkId: "s1",
      sparkName: "alpha",
      message: "alpha added to the fleet",
    });
    assert.equal(activity.sparkRemoved({ id: "s1", name: "alpha" }).type, "spark.removed");
    assert.equal(activity.nodeAdded({ id: "n1", name: "beta" }).sparkId, "n1");
    assert.equal(activity.nodeRemoved({ id: "n1" }).message, "n1 removed from the fleet");
  });

  test("actions succeed and fail", () => {
    const rec = { id: "n1", name: "beta" };
    assert.equal(activity.serviceAction(rec, { action: "restart", service: "vllm", ok: true }).message, "Requested restart vllm");
    const failed = activity.serviceAction(rec, { action: "stop", ok: false, error: "agent unreachable" });
    assert.equal(failed.type, "service.action.failed");
    assert.equal(failed.severity, "error");
    const comp = activity.componentAction(rec, { type: "start", componentId: "sglang", ok: true, dryRun: true });
    assert.equal(comp.type, "component.start");
    assert.equal(comp.message, "Component start sglang (dry run) requested");
    assert.equal(activity.componentAction(rec, { type: "stop", componentId: "x", ok: false }).type, "component.failed");
    assert.equal(activity.updateStarted(rec).type, "update.started");
    assert.equal(activity.updateStarted(rec, { ok: false, error: "409" }).type, "update.failed");
    assert.equal(activity.updateScheduled(rec, null).message, "Update schedule cleared");
    assert.equal(activity.powerShutdown({ id: "s1", name: "a" }).type, "power.shutdown");
    assert.equal(activity.powerWake({ id: "s1", name: "a" }, { ok: false, error: "x" }).type, "power.wake.failed");
  });

  test("alerts", () => {
    const a = { key: "s1:thermal", ruleId: "thermal", ruleName: "GPU temperature", unitId: "s1", unitName: "alpha", severity: "critical", summary: "GPU at 91 °C" };
    const fired = activity.alertFired(a);
    assert.equal(fired.type, "alert.fired");
    assert.equal(fired.severity, "error");
    assert.equal(fired.message, "GPU temperature: GPU at 91 °C");
    const resolved = activity.alertResolved(a);
    assert.equal(resolved.type, "alert.resolved");
    assert.equal(resolved.severity, "success");
  });

  test("bench and showcase lifecycles", () => {
    const job = (status, extra = {}) => ({ benchId: "b1", sparkId: "s1", status, config: { port: 8000, modelId: "qwen" }, ...extra });
    assert.equal(activity.bench("decode", job("running")).type, "bench.decode.started");
    assert.equal(activity.bench("prefill", job("completed")).message, "Prefill benchmark finished (qwen)");
    assert.equal(activity.bench("decode", job("cancelled")).type, "bench.decode.cancelled");
    const failed = activity.bench("decode", job("failed", { error: "connect ECONNREFUSED" }));
    assert.equal(failed.type, "bench.decode.failed");
    assert.match(failed.message, /ECONNREFUSED/);
    const s = (status) => ({ sessionId: "x", sparkId: "s1", status, streams: [{}, {}], modelId: null });
    assert.equal(activity.showcase(s("running")).message, "Showcase started: 2 streams");
    assert.equal(activity.showcase(s("completed")).type, "showcase.completed");
    assert.equal(activity.showcase(s("cancelled")).type, "showcase.cancelled");
    assert.equal(activity.showcase(s("error")).type, "showcase.failed");
  });

  test("withUnitNames fills a missing name and never throws", () => {
    const got = [];
    const record = withUnitNames((e) => got.push(e), (id) => (id === "s1" ? "alpha" : null));
    record({ type: "x", message: "m", sparkId: "s1", sparkName: null });
    record({ type: "x", message: "m", sparkId: "s2", sparkName: null });
    record({ type: "x", message: "m", sparkId: "s1", sparkName: "kept" });
    assert.deepEqual(got.map((e) => e.sparkName), ["alpha", null, "kept"]);
    const throwing = withUnitNames(() => {
      throw new Error("x");
    }, () => null);
    assert.equal(throwing({ type: "x", message: "m" }), null);
  });
});
