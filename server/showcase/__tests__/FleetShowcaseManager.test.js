import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetShowcaseManager, FLEET_SHOWCASE_LIMITS, laneSummary, normalizePrompts } from "../FleetShowcaseManager.js";
import { resolveNodeLaneTarget } from "../fleetTargets.js";
import { closeLlmStreamAgent } from "../../collectors/LlmStreaming.js";
import { fromFleetShowcaseSession } from "../../bench/results/adapters.js";
import { validateResult } from "../../bench/results/schema.js";
import { startFakeLlm } from "./fakeLlm.js";

after(() => closeLlmStreamAgent());

function tmpHistory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-showcase-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "fleet-showcase-history.json");
}

const sparkLane = (port, extra = {}) => ({
  laneId: `spark:s1:${port}`,
  kind: "spark",
  nodeId: "s1",
  nodeName: "spark-1",
  host: "127.0.0.1",
  port,
  modelId: "fake-model",
  backend: "vllm",
  serverCounters: true,
  resolveTarget: async () => ({ host: "127.0.0.1", port, via: "lan", close: () => {} }),
  ...extra,
});

/** Agent lane whose LAN probe fails, so it goes through the (simulated) SSH tunnel. */
const agentLane = (port, tunnels) => {
  const target = { laneId: `node:n1:11434`, kind: "node", nodeId: "n1", nodeName: "agent-1", host: "10.9.9.9", port: 11434, modelId: "llama3", backend: "ollama", serverCounters: false };
  return {
    ...target,
    resolveTarget: (o) =>
      resolveNodeLaneTarget(
        target,
        {
          probe: async () => false,
          nodeRecord: () => ({ id: "n1", lanIp: "10.9.9.9", protocol: "ssh", ssh: { user: "ops", auth: "key" } }),
          openTunnel: async (spark, remotePort) => {
            tunnels.push({ spark, remotePort });
            return { host: "127.0.0.1", port, via: "ssh-tunnel", close: () => tunnels.push("closed") };
          },
        },
        o
      ),
  };
};

test("normalizePrompts validates count and length", () => {
  assert.deepEqual(normalizePrompts([" a ", "b"]), ["a", "b"]);
  assert.equal(normalizePrompts([]), null);
  assert.equal(normalizePrompts(["ok", ""]), null);
  assert.equal(normalizePrompts(["x".repeat(FLEET_SHOWCASE_LIMITS.maxPromptLen + 1)]), null);
  assert.equal(normalizePrompts(Array(FLEET_SHOWCASE_LIMITS.maxPrompts + 1).fill("p")), null);
  assert.equal(normalizePrompts("nope"), null);
});

test("start validates lanes, prompts, maxTokens, temperature and the stream cap", () => {
  const m = new FleetShowcaseManager({ heartbeat: false });
  const lane = sparkLane(1);
  const code = (fn) => {
    try {
      fn();
    } catch (err) {
      return err.status;
    }
    return 0;
  };
  assert.equal(code(() => m.start({ lanes: [], prompts: ["a"] })), 400);
  assert.equal(code(() => m.start({ lanes: [lane, lane], prompts: ["a"] })), 400);
  assert.equal(code(() => m.start({ lanes: [lane], prompts: [] })), 400);
  assert.equal(code(() => m.start({ lanes: [lane], prompts: ["a"], maxTokens: 10 })), 400);
  assert.equal(code(() => m.start({ lanes: [lane], prompts: ["a"], temperature: 3 })), 400);
  assert.equal(code(() => m.start({ lanes: [{ ...lane, resolveTarget: null }], prompts: ["a"] })), 400);
  const many = Array.from({ length: 5 }, (_, i) => sparkLane(1000 + i));
  assert.equal(code(() => m.start({ lanes: many, prompts: Array(16).fill("p") })), 400);
  assert.equal(m.getActive(), null);
});

test("one session runs an SSH Spark lane and an agent lane at once, with client and server timing", async (t) => {
  const spark = await startFakeLlm({ chunks: 40, delayMs: 5, usage: true, metrics: true });
  const agent = await startFakeLlm({ chunks: 30, delayMs: 5, usage: false, metrics: false, model: "llama3" });
  t.after(() => Promise.all([spark.close(), agent.close()]));
  const tunnels = [];
  const historyPath = tmpHistory(t);
  const m = new FleetShowcaseManager({ historyPath, heartbeat: false, pollIntervalMs: 20 });
  const records = [];
  const events = [];
  m.resultSink = (r) => records.push(r);
  m.eventSink = (e) => events.push(e.status);

  const { sessionId, status } = m.start({
    lanes: [sparkLane(spark.port), agentLane(agent.port, tunnels)],
    prompts: ["Write a table", "Write a poem"],
    maxTokens: 128,
    temperature: 0.5,
    promptType: "mixed",
  });
  assert.equal(status, "running");
  assert.deepEqual([...m.busySparkIds()], ["s1"]);
  assert.throws(() => m.start({ lanes: [sparkLane(spark.port)], prompts: ["a"] }), { status: 409 });
  assert.throws(() => m.clearHistory(), { status: 409 });

  // Concurrency: both lanes are streaming before either finishes.
  let sawBoth = false;
  for (let i = 0; i < 200 && m.getActive(); i += 1) {
    const live = m.getSession(sessionId, 0);
    if (live && live.lanes.every((l) => l.streams.some((s) => s.status === "streaming"))) sawBoth = true;
    await new Promise((r) => setTimeout(r, 5));
  }
  await m.settled(sessionId);
  assert.ok(sawBoth, "both lanes streamed concurrently");
  assert.equal(m.getActive(), null);
  assert.equal(m.busySparkIds().size, 0);

  const rec = m.getSession(sessionId);
  assert.equal(rec.status, "completed");
  assert.equal(rec.fromHistory, true);
  const [s, a] = rec.lanes;

  assert.equal(s.via, "lan");
  assert.equal(s.status, "completed");
  assert.equal(s.streamsOk, 2);
  assert.equal(s.tokenSource, "usage");
  assert.ok(s.clientTps > 0 && s.streamTpsMean > 0 && s.ttftP50Ms > 0);
  assert.ok(s.prefillTps > 0, "prefill = prompt_tokens / TTFT");
  assert.ok(s.serverTps > 0, "server tok/s from the vLLM counter");
  assert.equal(s.serverEngine, "vllm");
  assert.equal(s.streams[0].tokenCount, 40);
  assert.match(s.streams[0].content, /word/);

  assert.equal(a.via, "ssh-tunnel");
  assert.equal(a.serverCounters, false);
  assert.equal(a.serverTps, null, "Ollama lane is client only");
  assert.equal(a.tokenSource, "estimate");
  assert.ok(a.clientTps > 0 && a.ttftP50Ms > 0);
  assert.deepEqual(tunnels[0].remotePort, 11434);
  assert.ok(tunnels.includes("closed"), "tunnel closed after the lane");

  // Request shape: shared prompt set, usage requested, fill-to-max fields.
  const req = spark.requests[0];
  assert.equal(req.stream_options.include_usage, true);
  assert.equal(req.max_tokens, 128);
  assert.equal(req.temperature, 0.5);
  assert.equal(req.model, "fake-model");
  assert.equal(agent.requests.length, 2);

  // Bench rows: one per lane, source showcase, schema-valid.
  assert.equal(records.length, 1);
  const rows = fromFleetShowcaseSession(records[0], { provenance: { lanes: {} } });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual(validateResult(row).errors, [], JSON.stringify(validateResult(row)));
    assert.equal(row.settings.source, "showcase");
    assert.equal(row.run.bench, "Showcase");
    assert.equal(row.settings.fleet_session_id, sessionId);
  }
  const metricsOf = (row) => Object.fromEntries(row.metrics.map((x) => [x.metric, x]));
  const sm = metricsOf(rows[0]);
  assert.equal(sm.server_generation_tps.source, "counter");
  assert.equal(sm.decode_tps_stream.approximate, false);
  assert.ok(sm.ttft_p50.value > 0 && sm.prefill_tps.value > 0 && sm.agg_window_tps.value > 0);
  const am = metricsOf(rows[1]);
  assert.equal(am.server_generation_tps, undefined);
  assert.equal(am.decode_tps_stream.approximate, true);
  assert.equal(rows[1].settings.via, "ssh-tunnel");

  assert.deepEqual(events, ["running", "completed"]);

  // History persisted (0600) and reloaded; text capped.
  const st = fs.statSync(historyPath);
  assert.equal(st.mode & 0o777, 0o600);
  const m2 = new FleetShowcaseManager({ historyPath, heartbeat: false });
  const h = m2.getHistory();
  assert.equal(h.length, 1);
  assert.equal(h[0].sessionId, sessionId);
  assert.equal(h[0].laneCount, 2);
  assert.equal(h[0].streamsPerLane, 2);
  assert.ok(h[0].lanes[0].clientTps > 0);
  assert.equal(m2.getSession(sessionId).lanes[1].streams[0].content.length <= FLEET_SHOWCASE_LIMITS.historyTextChars, true);
  m2.clearHistory();
  assert.equal(m2.getHistory().length, 0);
  assert.equal(new FleetShowcaseManager({ historyPath, heartbeat: false }).getHistory().length, 0);
});

test("polling with since sends appends, not the full text", async (t) => {
  const llm = await startFakeLlm({ chunks: 60, delayMs: 4 });
  t.after(() => llm.close());
  const m = new FleetShowcaseManager({ heartbeat: false, readCounter: async () => null });
  const { sessionId } = m.start({ lanes: [sparkLane(llm.port)], prompts: ["p"], maxTokens: 64 });
  let text = "";
  let polls = 0;
  while (m.getActive()) {
    const snap = m.getSession(sessionId, polls);
    const st = snap.lanes[0].streams[0];
    if (snap.fromHistory) break;
    text = st.resetContent ? st.content : text + st.contentAppend;
    polls += 1;
    await new Promise((r) => setTimeout(r, 10));
  }
  await m.settled(sessionId);
  assert.ok(polls > 1);
  const final = m.getSession(sessionId).lanes[0].streams[0].content;
  assert.ok(final.startsWith(text), "appends rebuild the same text");
});

test("one lane failing to resolve does not stop the others", async (t) => {
  const llm = await startFakeLlm({ chunks: 10, delayMs: 2 });
  t.after(() => llm.close());
  const m = new FleetShowcaseManager({ heartbeat: false, readCounter: async () => null });
  const bad = sparkLane(9, { laneId: "node:dead:9", kind: "node", nodeId: "dead", resolveTarget: async () => { throw new Error("unreachable"); } });
  const { sessionId } = m.start({ lanes: [sparkLane(llm.port), bad], prompts: ["p"], maxTokens: 64 });
  await m.settled(sessionId);
  const rec = m.getSession(sessionId);
  assert.equal(rec.status, "completed");
  assert.equal(rec.lanes[0].status, "completed");
  assert.equal(rec.lanes[1].status, "error");
  assert.match(rec.lanes[1].error, /unreachable/);
  assert.equal(rec.lanes[1].streams[0].status, "error");
  // A failed lane still records a row, with decode marked unmeasured.
  const rows = fromFleetShowcaseSession(rec);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.deepEqual(validateResult(row).errors, []);
  assert.equal(rows[1].run.status, "failed");
});

test("all lanes failing ends the session in error", async () => {
  const m = new FleetShowcaseManager({ heartbeat: false });
  const bad = sparkLane(9, { resolveTarget: async () => { throw new Error("no route"); } });
  const { sessionId } = m.start({ lanes: [bad], prompts: ["p"] });
  await m.settled(sessionId);
  const rec = m.getSession(sessionId);
  assert.equal(rec.status, "error");
  assert.match(rec.error, /no route/);
});

test("engines that reject fill-to-max fields get one retry without them", async (t) => {
  const llm = await startFakeLlm({ chunks: 8, delayMs: 2, rejectFillFields: true });
  t.after(() => llm.close());
  const m = new FleetShowcaseManager({ heartbeat: false, readCounter: async () => null });
  const { sessionId } = m.start({ lanes: [sparkLane(llm.port)], prompts: ["p"], maxTokens: 64 });
  await m.settled(sessionId);
  assert.equal(m.getSession(sessionId).lanes[0].status, "completed");
  assert.ok(llm.requests.length >= 2);
  assert.equal(llm.requests[0].ignore_eos, true);
  assert.equal(llm.requests.at(-1).ignore_eos, undefined);
});

test("cancel aborts every lane; heartbeat timeout cancels a session nobody polls", async (t) => {
  const llm = await startFakeLlm({ hang: true });
  t.after(() => llm.close());
  let clock = 1_000_000;
  const m = new FleetShowcaseManager({ heartbeat: false, readCounter: async () => null, now: () => clock });
  const { sessionId } = m.start({ lanes: [sparkLane(llm.port)], prompts: ["a", "b"] });
  await new Promise((r) => setTimeout(r, 50));
  const snap = m.cancel(sessionId);
  assert.equal(snap.status, "cancelled");
  assert.ok(snap.lanes[0].streams.every((s) => s.status === "cancelled"));
  assert.equal(m.getActive(), null);
  await m.settled(sessionId);
  assert.equal(m.getHistory()[0].status, "cancelled");
  assert.equal(m.cancel("nope"), null);

  const second = m.start({ lanes: [sparkLane(llm.port)], prompts: ["a"] });
  m.checkHeartbeats();
  assert.ok(m.getActive(), "still inside the heartbeat window");
  clock += FLEET_SHOWCASE_LIMITS.heartbeatTimeoutMs;
  m.checkHeartbeats();
  assert.equal(m.getActive(), null);
  await m.settled(second.sessionId);
  const rec = m.getSession(second.sessionId);
  assert.equal(rec.status, "cancelled");
  assert.equal(rec.error, "Heartbeat timeout");
});

test("laneSummary: window aggregate, live sum and token source", () => {
  const done = laneSummary({
    streams: [
      { status: "completed", tokenCount: 101, _tFirst: 0, _tLast: 1000, decodeTps: 100, ttftMs: 50, prefillTps: 800, tokenSource: "usage" },
      { status: "completed", tokenCount: 101, _tFirst: 0, _tLast: 2000, decodeTps: 50, ttftMs: 70, prefillTps: 600, tokenSource: "estimate" },
    ],
  });
  assert.equal(done.clientTps, 100); // 200 decode tokens / 2 s
  assert.equal(done.streamTpsMean, 75);
  assert.equal(done.ttftP50Ms, 60);
  assert.equal(done.prefillTps, 700);
  assert.equal(done.tokenSource, "mixed");
  assert.equal(done.streamsDone, 2);
  const live = laneSummary({
    streams: [
      { status: "streaming", tokenCount: 10, _tFirst: 0, _tLast: 100, liveTokPerSec: 30 },
      { status: "streaming", tokenCount: 10, _tFirst: 0, _tLast: 100, liveTokPerSec: 40 },
    ],
  });
  assert.equal(live.clientTps, 70);
  assert.equal(live.tokenSource, null);
  assert.equal(laneSummary({ streams: [] }).clientTps, null);
});
