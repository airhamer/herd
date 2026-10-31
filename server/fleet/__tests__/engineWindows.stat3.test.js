// STAT3 (#36): agent 0.4 counters with a monotonic read stamp, every
// engine's counters, and the older payloads still parsing.
import test from "node:test";
import assert from "node:assert/strict";
import { counterMetaOf, createFleetEngineWindows } from "../engineWindows.js";
import { EngineWindow } from "../../metrics/EngineWindow.js";

const T0 = 1_000_000;
const meta = (monoMs, bootId = "b1", source = "prometheus") => ({ schema: 2, source, monoMs, wallMs: T0 + monoMs, bootId });

function vllmCounters(i) {
  return {
    generated: 1000 + 100 * i, prompt: 8000 + 400 * i, cached: 6000 + 300 * i,
    decoded: 1000 + 100 * i, first: 20 + 2 * i, itlSum: 50 + 1.96 * i,
    prefillComputed: 2000 + 100 * i, prefillSeconds: 1 + 0.05 * i,
    queueSum: 1 + 0.1 * i, queueCount: 20 + 2 * i, ttftSum: 4 + 0.4 * i, ttftCount: 20 + 2 * i,
    e2eSum: 10 + i, e2eCount: 20 + 2 * i, requestsFinished: 20 + 2 * i, preemptions: 0,
    specAccepted: null, specDrafts: null, specDraftTokens: null, specVerify: null, idleSeconds: null,
  };
}

test("counterMetaOf: schema 2 meta only", () => {
  assert.deepEqual(counterMetaOf(meta(5)), { schema: 2, source: "prometheus", monoMs: 5, wallMs: T0 + 5, bootId: "b1" });
  assert.equal(counterMetaOf(null), null);
  assert.equal(counterMetaOf({ schema: 1, monoMs: 5, bootId: "b" }), null);
  assert.equal(counterMetaOf({ schema: 2, monoMs: -1, bootId: "b" }), null);
  assert.equal(counterMetaOf({ schema: 2, monoMs: 5, bootId: "" }), null);
  assert.equal(counterMetaOf({ schema: 2, monoMs: "5", bootId: "b" }), null);
});

test("monotonic stamp times the window, not the jittery poll time", () => {
  const fw = createFleetEngineWindows();
  // Counters read every 10 s of agent time (generated +100 per read); the
  // dashboard's poll times wander by seconds (and once go backwards).
  const polled = [0, 13_000, 19_000, 18_500, 44_000];
  let out;
  for (let i = 0; i < polled.length; i++) {
    out = fw.annotate("n1", {
      polledAt: T0 + polled[i],
      llm: [{ port: 8000, backend: "vllm", modelId: "m", engineCounters: vllmCounters(i), engineCountersMeta: meta(10_000 * i) }],
    });
  }
  const rec = out.llm[0].normalized["300"];
  assert.equal(rec.reads, 5);
  assert.equal(rec.coveredS, 40);
  assert.equal(rec.values.throughput_tps.value, 10);
  assert.equal(rec.values.throughput_tps.source, "counter");
  assert.equal(rec.values.decode_tps.value, 50);
});

test("agent restart (new bootId) re-anchors without dropping or resetting the window", () => {
  const fw = createFleetEngineWindows();
  let out;
  for (let i = 0; i < 3; i++) {
    out = fw.annotate("n1", { polledAt: T0 + 2000 * i, llm: [{ port: 8000, backend: "vllm", modelId: "m", engineCounters: vllmCounters(i), engineCountersMeta: meta(2000 * i, "b1") }] });
  }
  // New agent process: its monotonic clock starts near 0 again.
  for (let i = 3; i < 5; i++) {
    out = fw.annotate("n1", { polledAt: T0 + 2000 * i, llm: [{ port: 8000, backend: "vllm", modelId: "m", engineCounters: vllmCounters(i), engineCountersMeta: { ...meta(50 + 2000 * (i - 3), "b2"), wallMs: T0 + 2000 * i } }] });
  }
  const rec = out.llm[0].normalized["300"];
  assert.equal(rec.reads, 5);
  assert.equal(rec.resets, 0);
  assert.equal(rec.values.decode_tps.value, 50);
});

test("engine without decode / prefill stopwatch (ds4): per-poll counter rates, approximate", () => {
  const fw = createFleetEngineWindows();
  let out;
  for (let i = 0; i < 4; i++) {
    out = fw.annotate("n1", {
      polledAt: T0 + 2000 * i,
      llm: [{
        port: 8000, backend: "ds4", modelId: "deepseek", requestsRunning: 1,
        engineCounters: { generated: 5000 + 60 * i, prompt: 12000 + 500 * i, cached: 9000 + 400 * i, prefillComputed: 3000 + 100 * i, decoded: null, first: null, itlSum: null, prefillSeconds: null },
        engineCountersMeta: meta(2000 * i),
      }],
    });
  }
  const v = out.llm[0].normalized["300"].values;
  assert.equal(v.decode_tps.value, 30);
  assert.equal(v.decode_tps.approximate, true);
  assert.equal(v.decode_tps.source, "counter");
  assert.equal(v.prefill_tps.value, 50);
  assert.equal(v.cache_reuse.value, 0.8);
  assert.equal(v.cache_reuse.approximate, false);
  assert.equal(v.throughput_tps.value, 30);
  assert.equal(v.running.source, "counter");
  assert.equal(v.ttft_s.value, null);
});

test("JSON engines (FreeToken) window their counters; levels are native", () => {
  const fw = createFleetEngineWindows();
  let out;
  for (let i = 0; i < 3; i++) {
    out = fw.annotate("n1", {
      polledAt: T0 + 5000 * i,
      llm: [{
        port: 9000, backend: "freetoken", modelId: "m", requestsRunning: 1, kvCacheUsage: 0.25,
        engineCounters: { generated: 500 + 200 * i, prompt: 1000, cached: 250, prefillComputed: 750, prefillSeconds: 2, decoded: 480 + 200 * i, first: 0, itlSum: 10 + 4 * i, requestsFinished: 9 + i },
        engineCountersMeta: meta(5000 * i, "b1", "json"),
      }],
    });
  }
  const v = out.llm[0].normalized["60"].values;
  assert.equal(v.decode_tps.value, 50);
  assert.equal(v.decode_tps.approximate, false);
  assert.equal(v.throughput_tps.value, 40);
  assert.equal(v.running.source, "native");
  assert.equal(v.kv_pct.value, 25);
});

test("older agents still parse: 0.2 (no counters) and 0.3 (counters, no meta)", () => {
  const fw = createFleetEngineWindows();
  let out;
  for (let i = 0; i < 3; i++) {
    out = fw.annotate("n1", {
      agentVersion: "0.3.0",
      polledAt: T0 + 2000 * i,
      llm: [
        { port: 8000, backend: "vllm", modelId: "m", engineCounters: vllmCounters(i) },
        { port: 8001, backend: "ollama", modelId: "llama", requestsRunning: 2 },
        { port: 8002, backend: "vllm", modelId: "m", engineCounters: vllmCounters(i), engineCountersMeta: { schema: 1 } },
      ],
    });
  }
  const [a, b, c] = out.llm;
  assert.equal(a.normalized["300"].values.decode_tps.value, 50);
  assert.equal(a.normalized["300"].coveredS, 4);
  assert.equal(b.normalized["300"].values.decode_tps.value, null);
  assert.equal(b.normalized["300"].values.running.value, 2);
  assert.equal(c.normalized["300"].values.decode_tps.value, 50);
});

test("a counter only agent 0.4 sends (requestsFinished) going back is a reset", () => {
  const w = new EngineWindow(300);
  const c = (g, f) => ({ generated: g, requestsFinished: f });
  w.add({ t: 0, key: "k", counters: c(10, 5) });
  w.add({ t: 1000, key: "k", counters: c(20, 6) });
  const r = w.add({ t: 2000, key: "k", counters: c(30, 1) });
  assert.equal(r.reset, true);
});
