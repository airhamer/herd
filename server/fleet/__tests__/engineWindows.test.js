// STAT2 (#35): fleet engine windows over node-agent engine counters.
import test from "node:test";
import assert from "node:assert/strict";
import { createFleetEngineWindows } from "../engineWindows.js";
import { createFleetConnection } from "../connection.js";

const T0 = 1_000_000;

/** vLLM counters after `i` polls of steady load (100 tok / 2 s, 2 first tokens). */
function vllmCounters(i, base = 0) {
  return {
    generated: base + 1000 + 100 * i, prompt: base + 8000 + 400 * i, cached: base + 6000 + 300 * i,
    decoded: base + 1000 + 100 * i, first: base + 20 + 2 * i, itlSum: base + 50 + 1.96 * i,
    prefillComputed: base + 2000 + 100 * i, prefillSeconds: base + 1 + 0.05 * i,
    queueSum: base + 1 + 0.1 * i, queueCount: base + 20 + 2 * i,
    ttftSum: base + 4 + 0.4 * i, ttftCount: base + 20 + 2 * i,
    specAccepted: base + 600 + 60 * i, specDrafts: base + 300 + 30 * i, specVerify: null, idleSeconds: null,
  };
}

function snap(i, llm) {
  return { nodeId: "n1", polledAt: T0 + i * 2000, llm };
}

const vllmEntry = (i, over = {}) => ({
  port: 8000, backend: "vllm", modelId: "m", kvCacheUsage: 0.2, requestsRunning: 1, requestsWaiting: 0,
  engineCounters: vllmCounters(i), ...over,
});

test("annotate: vLLM counters become a normalized 60 s / 300 s record", () => {
  const fw = createFleetEngineWindows();
  let out;
  for (let i = 0; i < 4; i++) out = fw.annotate("n1", snap(i, [vllmEntry(i)]));
  const rec = out.llm[0].normalized["300"];
  assert.equal(rec.values.decode_tps.value, 50);
  assert.equal(rec.values.decode_tps.source, "counter");
  assert.equal(rec.values.prefill_tps.value, 2000);
  assert.equal(rec.values.ttft_s.value, 0.2);
  assert.equal(rec.values.queue_s.value, 0.05);
  assert.equal(rec.values.acc_len.value, 3);
  assert.equal(rec.values.cache_reuse.value, 0.75);
  assert.equal(rec.values.kv_pct.value, 20);
  assert.equal(rec.values.running.value, 1);
  assert.deepEqual(Object.keys(out.llm[0].normalized), ["60", "300"]);
});

test("annotate: counter reset on the agent's engine starts the window again", () => {
  const fw = createFleetEngineWindows();
  for (let i = 0; i < 3; i++) fw.annotate("n1", snap(i, [vllmEntry(i)]));
  let out;
  for (let i = 0; i < 2; i++) {
    out = fw.annotate("n1", snap(10 + i, [vllmEntry(i, { engineCounters: vllmCounters(i, -1000) })]));
  }
  const rec = out.llm[0].normalized["300"];
  assert.equal(rec.resets, 1);
  assert.equal(rec.reads, 2);
  assert.equal(rec.values.decode_tps.value, 50);
});

test("annotate: no counters (Ollama, SGLang without metrics) → rates null, levels kept", () => {
  const fw = createFleetEngineWindows();
  let out;
  for (let i = 0; i < 3; i++) {
    out = fw.annotate("n1", snap(i, [
      { port: 11434, backend: "ollama", modelId: "llama3", engineCounters: null },
      { port: 30000, backend: "sglang", modelId: "q", requestsRunning: 2, requestsWaiting: 1, engineCounters: null },
    ]));
  }
  const [ollama, sglang] = out.llm.map((e) => e.normalized["300"].values);
  for (const f of ["decode_tps", "prefill_tps", "ttft_s", "throughput_tps"]) {
    assert.equal(ollama[f].value, null);
    assert.equal(ollama[f].valid, false);
    assert.equal(sglang[f].value, null);
  }
  assert.equal(sglang.running.value, 2);
  assert.equal(sglang.running.source, "native");
  assert.equal(sglang.waiting.value, 1);
});

test("annotate: unreachable port is null; snapshots without llm pass through untouched", () => {
  const fw = createFleetEngineWindows();
  const s = { nodeId: "n1", polledAt: T0 };
  assert.equal(fw.annotate("n1", s), s);
  const out = fw.annotate("n1", snap(0, [{ port: 8000, backend: null, engineCounters: null }]));
  assert.equal(out.llm[0].normalized, null);
  assert.equal(fw.size(), 0);
});

test("annotate: a re-served (same polledAt) snapshot is not counted twice", () => {
  const fw = createFleetEngineWindows();
  fw.annotate("n1", snap(0, [vllmEntry(0)]));
  const a = fw.annotate("n1", snap(1, [vllmEntry(1)]));
  const b = fw.annotate("n1", snap(1, [vllmEntry(1)]));
  assert.deepEqual(a.llm[0].normalized, b.llm[0].normalized);
  assert.equal(b.llm[0].normalized["300"].reads, 2);
});

test("annotate: windows are per node and port; dropped ports are forgotten", () => {
  const fw = createFleetEngineWindows();
  fw.annotate("n1", snap(0, [vllmEntry(0), vllmEntry(0, { port: 8001 })]));
  fw.annotate("n2", snap(0, [vllmEntry(0)]));
  assert.equal(fw.size(), 3);
  fw.annotate("n1", snap(1, [vllmEntry(1)]));
  assert.equal(fw.size(), 2);
  fw.forget("n2");
  assert.equal(fw.size(), 1);
});

test("FleetConnection: polled snapshots carry normalized llm records", async () => {
  const payload = { nodeId: "a", nodeName: "a", polledAt: T0, llm: [vllmEntry(0)] };
  const fetch = async () => ({ ok: true, status: 200, json: async () => payload });
  const conn = createFleetConnection([{ id: "a", endpoint: "192.168.50.10:30091" }], { fetch, pollIntervalMs: 60_000 });
  await conn.start();
  const s = conn.getSnapshot("a");
  await conn.stop();
  assert.deepEqual(Object.keys(s.llm[0].normalized), ["60", "300"]);
  assert.equal(s.llm[0].normalized["300"].reads, 1);
  assert.equal(s.llm[0].normalized["300"].values.decode_tps.valid, false, "one read: nothing to difference");
  assert.equal(s.llm[0].normalized["300"].values.kv_pct.value, 20);
});
