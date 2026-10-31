// STAT4 (#37): relay-metered usage as the "proxy" source tier, under the
// engine counters.
import test from "node:test";
import assert from "node:assert/strict";
import { createFleetEngineWindows, mergeProxyWindows } from "../engineWindows.js";

const T0 = 2_000_000;
const pmeta = (monoMs, bootId = "b1") => ({ schema: 2, source: "proxy", monoMs, wallMs: T0 + monoMs, bootId });

/** Relay totals after `i` polls (5 s apart): 1 request of 100 tokens per poll. */
function proxyCounters(i) {
  return {
    generated: 100 * i, prompt: 400 * i, cached: null,
    decoded: 100 * i, first: i, itlSum: 2.475 * i,
    prefillComputed: 400 * i, prefillSeconds: 0.2 * i,
    ttftSum: 0.3 * i, ttftCount: i, e2eSum: 3 * i, e2eCount: i, requestsFinished: i,
  };
}

const ollama = (i, over = {}) => ({
  port: 11434, backend: "ollama", modelId: "llama3",
  proxyCounters: proxyCounters(i), proxyCountersMeta: pmeta(5000 * i), proxyInFlight: 1, ...over,
});

test("Ollama behind the relay: tokens and latency tagged source proxy", () => {
  const fw = createFleetEngineWindows();
  let out;
  for (let i = 1; i <= 4; i++) out = fw.annotate("n1", { polledAt: T0 + 5000 * i, llm: [ollama(i)] });
  const v = out.llm[0].normalized["300"].values;
  assert.equal(v.decode_tps.value, 40);
  assert.equal(v.decode_tps.source, "proxy");
  assert.equal(v.decode_tps.approximate, false);
  assert.equal(v.prefill_tps.value, 2000);
  assert.equal(v.ttft_s.value, 0.3);
  assert.equal(v.ttft_s.source, "proxy");
  assert.equal(v.throughput_tps.value, 20);
  assert.equal(v.throughput_tps.source, "proxy");
  assert.equal(v.running.value, 1);
  assert.equal(v.running.source, "proxy");
  assert.equal(v.cache_reuse.value, null);
  assert.equal(v.kv_pct.value, null);
});

test("engine counters take precedence per field; the relay fills the gaps", () => {
  const fw = createFleetEngineWindows();
  let out;
  for (let i = 1; i <= 4; i++) {
    out = fw.annotate("n1", {
      polledAt: T0 + 5000 * i,
      llm: [{
        port: 8000, backend: "ds4", modelId: "deepseek", requestsRunning: 3,
        // ds4: token counters but no TTFT histogram and no decode stopwatch
        engineCounters: { generated: 1000 + 300 * i, prompt: 5000 + 1000 * i, cached: 4000 + 800 * i, prefillComputed: 1000 + 200 * i },
        engineCountersMeta: { schema: 2, source: "prometheus", monoMs: 5000 * i, wallMs: T0 + 5000 * i, bootId: "b1" },
        proxyCounters: proxyCounters(i), proxyCountersMeta: pmeta(5000 * i), proxyInFlight: 2,
      }],
    });
  }
  const v = out.llm[0].normalized["300"].values;
  assert.equal(v.throughput_tps.value, 60);
  assert.equal(v.throughput_tps.source, "counter");
  assert.equal(v.cache_reuse.value, 0.8);
  assert.equal(v.cache_reuse.source, "counter");
  // Engine has a (per-poll, approximate) decode value: it still wins.
  assert.equal(v.decode_tps.source, "counter");
  assert.equal(v.decode_tps.approximate, true);
  // TTFT only the relay measures.
  assert.equal(v.ttft_s.value, 0.3);
  assert.equal(v.ttft_s.source, "proxy");
  assert.equal(v.running.value, 3);
  assert.equal(v.running.source, "counter");
});

test("relay in flight only (no request finished yet): running from the proxy, rates null", () => {
  const fw = createFleetEngineWindows();
  const out = fw.annotate("n1", { polledAt: T0, llm: [ollama(0, { proxyCounters: null, proxyCountersMeta: null, proxyInFlight: 2 })] });
  const v = out.llm[0].normalized["60"].values;
  assert.equal(v.running.value, 2);
  assert.equal(v.running.source, "proxy");
  assert.equal(v.decode_tps.value, null);
});

test("a relay that stops reporting drops its lane; older agents are unchanged", () => {
  const fw = createFleetEngineWindows();
  for (let i = 1; i <= 3; i++) fw.annotate("n1", { polledAt: T0 + 5000 * i, llm: [ollama(i)] });
  let out = fw.annotate("n1", { polledAt: T0 + 20_000, llm: [{ port: 11434, backend: "ollama", modelId: "llama3", requestsRunning: null }] });
  const v = out.llm[0].normalized["300"].values;
  assert.equal(v.decode_tps.value, null);
  assert.equal(v.running.value, null);
  // Relay back: a fresh lane, one read so far.
  out = fw.annotate("n1", { polledAt: T0 + 25_000, llm: [ollama(5)] });
  assert.equal(out.llm[0].normalized["300"].values.decode_tps.value, null);
  assert.equal(out.llm[0].normalized["300"].values.running.source, "proxy");
});

test("relay counters reset (agent restart) start the proxy window again", () => {
  const fw = createFleetEngineWindows();
  for (let i = 1; i <= 3; i++) fw.annotate("n1", { polledAt: T0 + 5000 * i, llm: [ollama(i)] });
  let out;
  for (let i = 1; i <= 3; i++) {
    out = fw.annotate("n1", { polledAt: T0 + 20_000 + 5000 * i, llm: [ollama(i, { proxyCountersMeta: pmeta(5000 * i, "b2") })] });
  }
  const v = out.llm[0].normalized["300"].values;
  assert.equal(v.decode_tps.value, 40);
  assert.equal(v.decode_tps.samples, 3);
});

test("mergeProxyWindows: null proxy returns the engine record as is", () => {
  const eng = { 60: { values: { decode_tps: { value: 1 } } } };
  assert.equal(mergeProxyWindows(eng, null), eng);
  const merged = mergeProxyWindows(
    { 60: { reads: 2, values: { decode_tps: { value: null, source: null }, ttft_s: { value: 0.1, source: "counter" } } } },
    { 60: { reads: 3, values: { decode_tps: { value: 5, source: "proxy" }, ttft_s: { value: 0.2, source: "proxy" } } } },
  );
  assert.deepEqual(merged, { 60: { reads: 2, values: { decode_tps: { value: 5, source: "proxy" }, ttft_s: { value: 0.1, source: "counter" } } } });
});
