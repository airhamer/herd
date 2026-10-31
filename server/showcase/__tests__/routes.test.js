import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { FleetShowcaseManager } from "../FleetShowcaseManager.js";
import { registerFleetShowcaseRoutes } from "../routes.js";
import { closeLlmStreamAgent } from "../../collectors/LlmStreaming.js";
import { startFakeLlm } from "./fakeLlm.js";

after(() => closeLlmStreamAgent());

async function start(t, llmPort) {
  const manager = new FleetShowcaseManager({ heartbeat: false, readCounter: async () => null });
  const targets = [
    { laneId: `spark:s1:${llmPort}`, kind: "spark", nodeId: "s1", nodeName: "spark-1", host: "127.0.0.1", port: llmPort, modelId: "m", backend: "vllm", available: true, serverCounters: true, access: "lan-or-ssh" },
    { laneId: `node:n1:${llmPort}`, kind: "node", nodeId: "n1", nodeName: "agent-1", host: "127.0.0.1", port: llmPort, modelId: "m", backend: "ollama", available: true, serverCounters: false, access: "lan" },
    { laneId: "spark:busy:1", kind: "spark", nodeId: "busy", nodeName: "busy", host: "127.0.0.1", port: 1, modelId: null, backend: null, available: true, serverCounters: true, access: "lan" },
  ];
  const noted = [];
  const app = express();
  app.use(express.json());
  registerFleetShowcaseRoutes(app, {
    manager,
    listTargets: () => targets,
    buildLane: (tg) => ({
      lane: { ...tg, resolveTarget: async () => ({ host: tg.host, port: tg.port, via: "direct", close: () => {} }) },
      provenance: { host: { node_id: tg.nodeId } },
    }),
    laneBusy: (tg) => (tg.nodeId === "busy" ? "a decode benchmark is running on this Spark" : null),
    noteStart: (id, prov) => noted.push({ id, prov }),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { call, manager, targets, noted };
}

test("fleet showcase routes: targets, start, poll, history, cancel, clear", async (t) => {
  const llm = await startFakeLlm({ chunks: 12, delayMs: 3 });
  t.after(() => llm.close());
  const { call, manager, targets, noted } = await start(t, llm.port);

  const tg = await call("GET", "/api/fleet/showcase/targets");
  assert.equal(tg.status, 200);
  assert.equal(tg.body.targets.length, 3);
  assert.equal(tg.body.limits.maxLanes, 16);

  assert.equal((await call("POST", "/api/fleet/showcase", {})).status, 400);
  assert.equal((await call("POST", "/api/fleet/showcase", { laneIds: ["spark:nope:1"], prompts: ["a"] })).status, 400);
  const busy = await call("POST", "/api/fleet/showcase", { laneIds: ["spark:busy:1"], prompts: ["a"] });
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /decode benchmark/);
  assert.equal((await call("POST", "/api/fleet/showcase", { laneIds: [targets[0].laneId], prompts: [] })).status, 400);

  const started = await call("POST", "/api/fleet/showcase", {
    laneIds: [targets[0].laneId, targets[1].laneId],
    prompts: ["one", "two"],
    maxTokens: 64,
    promptType: "text",
  });
  assert.equal(started.status, 202);
  const sid = started.body.sessionId;
  assert.deepEqual(Object.keys(noted[0].prov.lanes).sort(), [targets[0].laneId, targets[1].laneId].sort());

  const list = await call("GET", "/api/fleet/showcase");
  assert.equal(list.body.active?.sessionId, sid);
  assert.equal((await call("DELETE", "/api/fleet/showcase")).status, 409);
  const live = await call("GET", `/api/fleet/showcase/${sid}?since=0`);
  assert.equal(live.status, 200);
  assert.equal(live.body.lanes.length, 2);
  assert.equal(live.body.promptType, "text");

  await manager.settled(sid);
  const done = await call("GET", `/api/fleet/showcase/${sid}`);
  assert.equal(done.body.status, "completed");
  assert.equal(done.body.fromHistory, true);
  const hist = await call("GET", "/api/fleet/showcase");
  assert.equal(hist.body.active, null);
  assert.equal(hist.body.history[0].sessionId, sid);
  assert.equal(hist.body.history[0].laneCount, 2);

  assert.equal((await call("GET", "/api/fleet/showcase/nope")).status, 404);
  assert.equal((await call("DELETE", "/api/fleet/showcase/nope")).status, 404);
  assert.equal((await call("DELETE", "/api/fleet/showcase")).status, 200);
  assert.equal((await call("GET", "/api/fleet/showcase")).body.history.length, 0);
});

test("DELETE :sessionId cancels a running session", async (t) => {
  const llm = await startFakeLlm({ hang: true });
  t.after(() => llm.close());
  const { call, manager, targets } = await start(t, llm.port);
  const started = await call("POST", "/api/fleet/showcase", { laneIds: [targets[0].laneId], prompts: ["x"] });
  const sid = started.body.sessionId;
  const cancelled = await call("DELETE", `/api/fleet/showcase/${sid}`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "cancelled");
  await manager.settled(sid);
});
