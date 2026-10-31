import { test } from "node:test";
import assert from "node:assert/strict";
import { laneIdOf, listShowcaseTargets, parseLaneId, proxyFront, resolveNodeLaneTarget } from "../fleetTargets.js";

test("laneIdOf / parseLaneId round trip", () => {
  assert.equal(laneIdOf("spark", "s1", 8000), "spark:s1:8000");
  assert.deepEqual(parseLaneId("node:abc:def:11434"), { kind: "node", nodeId: "abc:def", port: 11434 });
  assert.equal(parseLaneId("spark:s1:70000"), null);
  assert.equal(parseLaneId("x:s1:80"), null);
  assert.equal(parseLaneId(null), null);
});

const sparks = [
  { id: "s1", name: "spark-1", lanIp: "10.0.0.1", llmPorts: [8000, 8001] },
  { id: "w1", name: "worker", lanIp: "10.0.0.2", llmPorts: [8000], workerNode: true },
  { id: "off", name: "no-llm", lanIp: "10.0.0.3", llmPorts: [8000], llmMonitoring: false },
  { id: "loc", name: "a-local", isLocal: true, lanIp: "10.0.0.4", llmPorts: [30000] },
];
const snaps = {
  s1: { online: true, metrics: { llm: [{ available: true, modelId: "qwen", backend: "vllm" }, { available: false }] } },
  loc: { online: true, metrics: { llm: [{ available: true, modelId: "m", backend: "sglang" }] } },
};
const nodes = [
  { nodeId: "n1", nodeName: "mac", lanIp: "10.0.0.9", registryLanIp: "10.0.0.9", online: true, llm: [{ port: 1234, backend: "lmstudio", modelId: "gemma" }] },
  // Same engine as Spark s1:8000 (agent on the Spark): listed once, as the Spark lane.
  { nodeId: "s1-agent", nodeName: "spark-1", lanIp: "10.0.0.1", online: true, llm: [{ port: 8000, backend: "vllm", modelId: "qwen" }] },
  { nodeId: "n2", nodeName: "box", lanIp: "10.0.0.10", online: false, llm: [{ port: 11434, backend: "ollama", modelId: "llama" }, { port: "bad" }] },
  { nodeId: "n3", nodeName: "nollm", online: true },
];
const records = { n2: { id: "n2", protocol: "ssh", ssh: { user: "ops", auth: "key" } } };

test("listShowcaseTargets: Spark lanes then agent lanes, deduped, with access + counters", () => {
  const t = listShowcaseTargets({ sparks, sparkSnapshot: (id) => snaps[id] ?? null, nodes, nodeRecord: (id) => records[id] ?? null });
  assert.deepEqual(
    t.map((x) => x.laneId),
    ["spark:loc:30000", "spark:s1:8000", "spark:s1:8001", "node:n2:11434", "node:n1:1234"]
  );
  const byId = Object.fromEntries(t.map((x) => [x.laneId, x]));
  assert.equal(byId["spark:loc:30000"].host, "127.0.0.1");
  assert.equal(byId["spark:loc:30000"].access, "local");
  assert.equal(byId["spark:s1:8000"].host, "10.0.0.1");
  assert.equal(byId["spark:s1:8000"].available, true);
  assert.equal(byId["spark:s1:8000"].serverCounters, true);
  assert.equal(byId["spark:s1:8001"].available, false);
  assert.equal(byId["spark:s1:8001"].modelId, null);
  assert.equal(byId["node:n1:1234"].serverCounters, false, "LM Studio is client only");
  assert.equal(byId["node:n1:1234"].access, "lan");
  assert.equal(byId["node:n2:11434"].access, "lan-or-ssh");
  assert.equal(byId["node:n2:11434"].available, false);
  assert.equal(byId["node:n2:11434"].serverCounters, false);
});

test("resolveNodeLaneTarget: LAN first", async () => {
  const status = [];
  const r = await resolveNodeLaneTarget(
    { nodeId: "n1", host: "10.0.0.9", port: 1234 },
    { probe: async () => true, openTunnel: async () => assert.fail("no tunnel"), nodeRecord: () => null },
    { onStatus: (m) => status.push(m) }
  );
  assert.equal(r.via, "direct");
  assert.equal(r.host, "10.0.0.9");
  assert.match(status[0], /10\.0\.0\.9:1234/);
});

test("resolveNodeLaneTarget: SSH tunnel for protocol ssh nodes, password from the secret store", async () => {
  const calls = [];
  const r = await resolveNodeLaneTarget(
    { nodeId: "n2", host: "10.0.0.10", port: 11434 },
    {
      probe: async () => false,
      nodeRecord: () => ({ id: "n2", lanIp: "10.0.0.10", protocol: "ssh", ssh: { user: "ops", auth: "pass" } }),
      getPassword: (id) => `pw-${id}`,
      openTunnel: async (spark, port) => {
        calls.push({ spark, port });
        return { host: "127.0.0.1", port: 40000, via: "ssh-tunnel", close: () => {} };
      },
    }
  );
  assert.equal(r.via, "ssh-tunnel");
  assert.equal(calls[0].port, 11434);
  assert.deepEqual(calls[0].spark, { id: "n2", lanIp: "10.0.0.10", ssh: { user: "ops", auth: "pass", password: "pw-n2" } });
});

test("resolveNodeLaneTarget: unreachable agent-only node explains why", async () => {
  await assert.rejects(
    resolveNodeLaneTarget(
      { nodeId: "n1", host: "10.0.0.9", port: 1234 },
      { probe: async () => false, openTunnel: async () => assert.fail(), nodeRecord: () => ({ id: "n1", protocol: "agent" }) }
    ),
    /not reachable over the LAN.*no SSH access/
  );
});

// ─── SC11 (#20): LLM traffic only through the proxy ──────────────────────

test("proxyFront: running + valid port only", () => {
  assert.equal(proxyFront({ proxy: { running: true, port: 30001 } }), 30001);
  assert.equal(proxyFront({ proxy: { running: false, port: 30001 } }), null, "stopped proxy: direct lanes");
  assert.equal(proxyFront({ proxy: { running: true, port: "nope" } }), null, "malformed port: direct lanes");
  assert.equal(proxyFront({ proxy: { running: true, port: 70000 } }), null, "out of range: direct lanes");
  assert.equal(proxyFront({}), null, "no proxy status (old agent): direct lanes");
  assert.equal(proxyFront(null), null);
});

test("listShowcaseTargets: proxy-running node publishes at the proxy front, once", () => {
  const proxyNodes = [
    {
      nodeId: "p1", nodeName: "fronted", lanIp: "10.0.0.20", registryLanIp: "10.0.0.20", online: true,
      proxy: { running: true, port: 30001 },
      llm: [{ port: 8000, backend: "vllm", modelId: "qwen" }, { port: 8001, backend: "vllm", modelId: "aeon" }],
    },
    // Same proxy front on a second record for the same box: no duplicate lane.
    {
      nodeId: "p1b", nodeName: "fronted-b", lanIp: "10.0.0.20", online: true,
      proxy: { running: true, port: 30001 },
      llm: [{ port: 8000, backend: "vllm", modelId: "qwen" }],
    },
  ];
  const t = listShowcaseTargets({ sparks: [], sparkSnapshot: () => null, nodes: proxyNodes, nodeRecord: () => null });
  assert.deepEqual(t.map((x) => x.laneId), ["node:p1:30001"]);
  assert.equal(t[0].port, 30001, "proxy front, not the engine port");
  assert.equal(t[0].viaProxy, true);
  assert.equal(t[0].modelId, "qwen");
});

test("listShowcaseTargets: stopped proxy keeps direct lanes and no viaProxy flag", () => {
  const t = listShowcaseTargets({
    sparks: [], sparkSnapshot: () => null,
    nodes: [{ nodeId: "p2", nodeName: "unfronted", lanIp: "10.0.0.21", online: true, proxy: { running: false, port: 30001 }, llm: [{ port: 8000, backend: "vllm", modelId: "qwen" }] }],
    nodeRecord: () => null,
  });
  assert.deepEqual(t.map((x) => x.laneId), ["node:p2:8000"]);
  assert.equal(t[0].viaProxy, undefined);
});

test("listShowcaseTargets: proxy fronted engine already claimed as Spark lane stays deduped", () => {
  const t = listShowcaseTargets({
    sparks: [{ id: "s9", name: "s9", lanIp: "10.0.0.30", llmPorts: [8000] }],
    sparkSnapshot: () => ({ online: true, metrics: { llm: [{ available: true, modelId: "qwen", backend: "vllm" }] } }),
    nodes: [{ nodeId: "a9", nodeName: "s9-agent", lanIp: "10.0.0.30", online: true, proxy: { running: true, port: 30001 }, llm: [{ port: 8000, backend: "vllm", modelId: "qwen" }] }],
    nodeRecord: () => null,
  });
  assert.deepEqual(t.map((x) => x.laneId), ["spark:s9:8000"]);
});
