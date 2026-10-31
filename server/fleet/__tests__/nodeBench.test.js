/** Agent-node decode bench targets (#43). */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  describeNodeProvenance,
  nodeBenchKey,
  nodeLlmEndpoints,
  resolveNodeBenchTarget,
} from "../nodeBench.js";

const snapshot = {
  nodeId: "n1",
  nodeName: "Node One",
  lanes: {
    pools: [
      {
        id: "gpu0",
        lanes: [
          { recipe: "llm-tp1", modelId: "lane-model", port: 8000, running: true },
          { recipe: "llm-off", modelId: "off", port: 8001, running: false },
        ],
      },
    ],
  },
  versions: [
    { kind: "llm", port: 8000, modelId: "qwen3", engine: "vllm", engineVersion: "0.11.0", quantization: "fp8", contextLength: 32768, state: "running" },
    { kind: "llm", port: 9000, modelId: "solo", engine: "sglang", engineVersion: null, quantization: null, contextLength: null, state: "running" },
    { kind: "image", port: 8188, engine: "comfyui", state: "running" },
    { kind: "llm", port: 9100, modelId: "stopped", engine: "vllm", state: "stopped" },
  ],
};

test("endpoints: running lanes plus live LLM services, one per port", () => {
  const eps = nodeLlmEndpoints(snapshot);
  assert.deepEqual(eps.map((e) => e.port), [8000, 9000]);
  assert.equal(eps[0].modelId, "qwen3");
  assert.equal(eps[0].lane, "llm-tp1");
  assert.equal(eps[0].pool, "gpu0");
  assert.equal(eps[1].lane, null);
  assert.deepEqual(nodeLlmEndpoints(null), []);
});

test("target: only ports the node reports", () => {
  const rec = { id: "n1", name: "n1", lanIp: "10.0.0.5", isLocal: false };
  assert.equal(resolveNodeBenchTarget(rec, snapshot, { port: 9000 }).modelId, "solo");
  assert.equal(resolveNodeBenchTarget(rec, snapshot, { port: "8000" }).host, "10.0.0.5");
  assert.throws(() => resolveNodeBenchTarget(rec, snapshot, { port: 8001 }), /not a running LLM lane/);
  assert.throws(() => resolveNodeBenchTarget(rec, snapshot, {}), /pass port/);
  assert.throws(() => resolveNodeBenchTarget(rec, null, {}), /not reported telemetry/);
  assert.throws(() => resolveNodeBenchTarget({ ...rec, lanIp: "" }, snapshot, {}), /LAN IP/);
  const one = { versions: [snapshot.versions[1]] };
  assert.equal(resolveNodeBenchTarget(rec, one, {}).port, 9000);
});

test("provenance: node + lane facts, unknown hardware left null", () => {
  const rec = { id: "n1", name: "fallback", lanIp: "10.0.0.5", isLocal: true };
  const target = resolveNodeBenchTarget(rec, snapshot, { port: 8000 });
  const p = describeNodeProvenance(rec, snapshot, target);
  assert.equal(p.host.node_id, "n1");
  assert.equal(p.host.node_name, "Node One");
  assert.equal(p.host.hw_bucket, null);
  assert.equal(p.lane.engine, "vllm");
  assert.equal(p.lane.engine_version, "0.11.0");
  assert.equal(p.lane.quant, "fp8");
  assert.equal(p.lane.ctx_len, 32768);
  assert.equal(p.client_location, "local");
  assert.equal(nodeBenchKey("n1"), "node:n1");
});
