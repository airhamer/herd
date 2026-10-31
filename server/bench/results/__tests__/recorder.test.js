import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BenchResultsStore } from "../store.js";
import { createResultsRecorder } from "../recorder.js";
import { describeProvenance, hwBucket, memClass } from "../provenance.js";
import { DecodeBenchManager } from "../../../collectors/DecodeBench.js";
import { PrefillBenchManager } from "../../../collectors/PrefillBench.js";
import { ShowcaseManager } from "../../../collectors/ShowcaseManager.js";
import { decodeJob, prefillJob, showcaseRecord, provenance } from "./fixtures.js";

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-results-rec-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sparkSnap = (over = {}) => ({
  id: "spark-a",
  name: "Spark A",
  kind: "spark",
  isLocal: true,
  hardware: { device: "DGX Spark", gpuChip: "NVIDIA GB10", totalMemoryGB: 119.7 },
  metrics: {
    gpu: { power: { draw: 30, limit: 140 }, throttle: { clockCapMHz: 2400 } },
    llm: [
      { backend: "vllm", modelId: "qwen3-30b", contextLength: 32768 },
      { backend: "llama.cpp", modelId: "gemma", contextLength: 8192 },
    ],
  },
  ...over,
});

test("hwBucket and memClass", () => {
  assert.equal(hwBucket({ kind: "spark" }), "Single DGX Spark");
  assert.equal(hwBucket({ kind: "spark" }, 2), "2× DGX Spark");
  assert.equal(hwBucket({ kind: "host", hardware: { gpuChip: "RTX 5090" } }), "Single RTX 5090");
  assert.equal(hwBucket({ kind: "host", hardware: {} }), null);
  assert.equal(memClass({ kind: "spark", hardware: { totalMemoryGB: 119.7 } }), "120GB unified");
  assert.equal(memClass({ kind: "host", hardware: { totalMemoryGB: 64 } }), "64GB");
  assert.equal(memClass({ hardware: {} }), null);
});

test("describeProvenance reads host and lane from the snapshot for the port under test", () => {
  const p = describeProvenance({
    snapshot: sparkSnap(),
    allSnapshots: [sparkSnap(), { id: "spark-w", workerHeadId: "spark-a" }],
    nodeId: "spark-a",
    port: 8001,
    ports: [8000, 8001],
  });
  assert.deepEqual(p.host, {
    node_id: "spark-a",
    node_name: "Spark A",
    hw_bucket: "2× DGX Spark",
    gpu: "NVIDIA GB10",
    gpu_count: 2,
    mem_class: "120GB unified",
    clock_cap_mhz: 2400,
    power_cap_w: 140,
  });
  assert.equal(p.lane.engine, "llama.cpp");
  assert.equal(p.lane.model_id, "gemma");
  assert.equal(p.lane.ctx_len, 8192);
  assert.deepEqual(p.lane.parallel, { nodes: 2 });
  assert.equal(p.lane.engine_version, null, "not reported → null, not guessed");
  assert.equal(p.client_location, "local");
});

test("describeProvenance: custom target hosts and missing snapshots know nothing about hardware", () => {
  const custom = describeProvenance({ snapshot: sparkSnap(), nodeId: "spark-a", port: 9000, ports: [8000], customHost: true });
  assert.equal(custom.host.node_id, "spark-a");
  assert.equal(custom.host.hw_bucket, null);
  assert.equal(custom.host.gpu, null);
  assert.equal(custom.lane.engine, null);
  assert.equal(custom.client_location, "network");
  const none = describeProvenance({ snapshot: null, nodeId: "spark-a" });
  assert.equal(none.host.hw_bucket, null);
  assert.equal(none.client_location, null);
});

test("recorder writes finished runs with the provenance captured at start", (t) => {
  const store = new BenchResultsStore({ path: path.join(tmpDir(t), "r.json"), log: () => {} });
  const rec = createResultsRecorder({ store });
  rec.noteStart("DecodeBench", "bench-1", provenance());
  rec.sinkFor("DecodeBench")(decodeJob());
  assert.equal(rec.pendingCount(), 0);
  assert.equal(store.get("decode:bench-1:c4").host.hw_bucket, "Single DGX Spark");
  rec.sinkFor("PrefillBench")(prefillJob());
  assert.equal(store.get("prefill:pf-1:t1024").host.hw_bucket, null, "no provenance noted → null");
  rec.sinkFor("Showcase")(showcaseRecord());
  assert.ok(store.get("showcase:sess-1"));
  assert.equal(rec.record("Nope", {}), null);
  assert.equal(rec.sinkFor("DecodeBench")(decodeJob({ benchId: "empty", results: [] })), null);
});

test("recorder bounds pending provenance", (t) => {
  const store = new BenchResultsStore({ path: path.join(tmpDir(t), "r.json"), log: () => {} });
  const rec = createResultsRecorder({ store });
  for (let i = 0; i < 250; i++) rec.noteStart("DecodeBench", `b${i}`, null);
  assert.equal(rec.pendingCount(), 200);
});

test("bench managers hand finished runs to resultSink; a failing sink never breaks history", (t) => {
  const dir = tmpDir(t);
  const managers = [
    [new DecodeBenchManager(path.join(dir, "d.json"), path.join(dir, "da.json")), decodeJob(), (m, o) => m._pushHistory(o)],
    [new PrefillBenchManager(path.join(dir, "p.json"), path.join(dir, "pa.json")), prefillJob(), (m, o) => m._pushHistory(o)],
    [new ShowcaseManager(path.join(dir, "s.json")), showcaseRecord(), (m, o) => m._archiveSession(o)],
  ];
  for (const [manager, obj, finish] of managers) {
    const seen = [];
    manager.resultSink = (r) => seen.push(r);
    finish(manager, obj);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].benchId ?? seen[0].sessionId, obj.benchId ?? obj.sessionId);

    manager.resultSink = () => {
      throw new Error("boom");
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.doesNotThrow(() => finish(manager, obj));
    } finally {
      console.warn = warn;
    }
    if (manager._heartbeatTimer) clearInterval(manager._heartbeatTimer);
  }
  assert.ok(fs.existsSync(path.join(dir, "d.json")));
  assert.ok(fs.existsSync(path.join(dir, "s.json")));
});
