// FLEET3 (#38): fleet observations, sampling runtime, HTTP routes and the
// energy Wh/token hook.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { collectTokenObservations } from "../observations.js";
import { LlmTokenLedger } from "../LlmTokenLedger.js";
import {
  createLlmTokenRuntime,
  registerLlmTokenRoutes,
  withLedgerTokens,
  TOKEN_SAMPLE_INTERVAL_MS,
  TOKEN_WIPE_CONFIRMATION,
} from "../LlmTokenRuntime.js";

const spark = (over = {}) => ({
  id: "spark-a",
  name: "Spark A",
  online: true,
  lanIp: "10.0.0.5",
  llmPorts: [8000, 8001],
  metrics: {
    llm: [
      { available: true, backend: "vllm", modelId: "qwen3", totalOutputTokens: 1000, totalPromptTokens: 9000, totalCachedTokens: 4000, valueSources: { totalOutputTokens: { source: "counter" } } },
      { available: false, backend: null, modelId: null, totalOutputTokens: null },
    ],
  },
  ...over,
});

const agentNode = (over = {}) => ({
  nodeId: "node-b",
  nodeName: "box-b",
  online: true,
  lanIp: "10.200.0.7",
  registryLanIp: "10.0.0.7",
  llm: [
    { port: 8000, backend: "ds4", modelId: "ds4-v3", engineCounters: { generated: 50, prompt: 300, cached: null }, proxyCounters: { generated: 40, prompt: 280, cached: 100 }, proxyCountersMeta: { bootId: "b1" } },
    { port: 11434, backend: "ollama", modelId: "llama3.2", engineCounters: null, proxyCounters: { generated: 70, prompt: 200, cached: 0 }, proxyCountersMeta: { bootId: "b1" } },
    { port: 1234, backend: "lmstudio", modelId: "phi", engineCounters: null, proxyCounters: null },
  ],
  ...over,
});

test("Spark ports and agent lanes become observations; counters win per field, the relay fills gaps", () => {
  const out = collectTokenObservations({ sparks: [spark()], nodes: [agentNode()] });
  assert.deepEqual(out.map((o) => o.seriesId), ["spark-a:8000", "node-b:8000", "node-b:11434"]);
  const [s, ds4, ollama] = out;
  assert.deepEqual(s.fields.generated, { value: 1000, epoch: "engine:vllm", source: "counter" });
  assert.equal(s.model, "qwen3");
  assert.equal(ds4.fields.generated.source, "counter");
  assert.equal(ds4.fields.prompt.value, 300);
  assert.deepEqual(ds4.fields.cached, { value: 100, epoch: "proxy:b1", source: "proxy" });
  assert.deepEqual(ollama.fields.generated, { value: 70, epoch: "proxy:b1", source: "proxy" });
});

test("offline hosts are skipped; an agent on a Spark's LAN IP and port is counted once", () => {
  assert.equal(collectTokenObservations({ sparks: [spark({ online: false })], nodes: [agentNode({ online: false })] }).length, 0);
  const dup = agentNode({ registryLanIp: "10.0.0.5" });
  const out = collectTokenObservations({ sparks: [spark()], nodes: [dup] });
  assert.deepEqual(out.map((o) => o.seriesId), ["spark-a:8000", "node-b:11434"]);
});

test("runtime samples every 15 s and saves at most once a minute; stop() saves", () => {
  let now = 1_000_000;
  let gen = 0;
  const saves = [];
  const ledger = new LlmTokenLedger({ now: () => now });
  ledger.save = () => { saves.push(now); return true; };
  let tick = null;
  const runtime = createLlmTokenRuntime({
    ledger,
    now: () => now,
    collect: () => collectTokenObservations({ sparks: [spark({ metrics: { llm: [{ available: true, backend: "vllm", modelId: "m", totalOutputTokens: gen }] } })] }),
    setIntervalFn: (fn, ms) => { assert.equal(ms, TOKEN_SAMPLE_INTERVAL_MS); tick = fn; return 1; },
    clearIntervalFn: () => {},
  });
  assert.equal(runtime.start(), true);
  assert.equal(runtime.start(), false);
  for (let i = 0; i < 4; i += 1) { now += 15_000; gen += 10; tick(); }
  assert.equal(ledger.totals("all", now).generated, 40);
  assert.deepEqual(saves, [1_060_000]);
  runtime.stop();
  assert.equal(saves.length, 2);
});

test("a throwing collector is logged and sampling continues", () => {
  const errors = [];
  const ledger = new LlmTokenLedger({ now: () => 0 });
  const runtime = createLlmTokenRuntime({ ledger, collect: () => { throw new Error("boom"); }, setIntervalFn: () => 1, clearIntervalFn: () => {}, logError: (m) => errors.push(m) });
  runtime.start();
  assert.deepEqual(errors, ["llm token sample error"]);
});

async function withServer(ledger, fn) {
  const app = express();
  registerLlmTokenRoutes(app, ledger);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("GET /api/llm-token-totals?range, /history and confirmed DELETE", async () => {
  let now = Date.UTC(2026, 9, 31, 12);
  const ledger = new LlmTokenLedger({ now: () => now });
  ledger.observe(collectTokenObservations({ sparks: [spark()] }), now);
  now += 15_000;
  const s = spark();
  s.metrics.llm[0] = { ...s.metrics.llm[0], totalOutputTokens: 1500, totalPromptTokens: 9800, totalCachedTokens: 4300 };
  ledger.observe(collectTokenObservations({ sparks: [s] }), now);
  await withServer(ledger, async (base) => {
    const totals = await (await fetch(`${base}/api/llm-token-totals?range=7d`)).json();
    assert.equal(totals.range, "7d");
    assert.equal(totals.generated, 500);
    assert.equal(totals.cached, 300);
    assert.equal(totals.prefill, 500);
    assert.equal(totals.endpointCount, 1);
    const def = await (await fetch(`${base}/api/llm-token-totals`)).json();
    assert.equal(def.range, "24h");
    const hist = await (await fetch(`${base}/api/llm-token-totals/history?range=30d`)).json();
    assert.equal(hist.points.length, 30);
    assert.equal(hist.points.at(-1).generated, 500);
    assert.equal((await fetch(`${base}/api/llm-token-totals?range=1y`)).status, 400);
    assert.equal((await fetch(`${base}/api/llm-token-totals`, { method: "DELETE" })).status, 400);
    const del = await fetch(`${base}/api/llm-token-totals?confirm=${TOKEN_WIPE_CONFIRMATION}`, { method: "DELETE" });
    assert.deepEqual(await del.json(), { cleared: true });
    assert.equal((await (await fetch(`${base}/api/llm-token-totals?range=all`)).json()).generated, 0);
  });
});

test("Fleet energy Wh/token uses the ledger's 24 h generated tokens when present", () => {
  const view = { energy24hKwh: 4.19, outputTokens24h: 10, whPerOutputToken24h: 419 };
  const out = withLedgerTokens(view, { generated: 1_000_000 });
  assert.equal(out.outputTokens24h, 1_000_000);
  assert.equal(out.whPerOutputToken24h, 0.00419);
  assert.equal(out.tokenSource, "ledger");
  assert.equal(withLedgerTokens(view, { generated: 0 }), view);
  assert.equal(withLedgerTokens({ ...view, energy24hKwh: null }, { generated: 5 }).whPerOutputToken24h, 419);
});
