// SC5c (#74): traffic view, recent-request log and GET /api/fleet/nodes/:id/traffic.
import { after, before, describe, test } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import { TRAFFIC_RECENT_MAX, buildTrafficView, createTrafficLog, registerTrafficRoutes, requestRow } from "../traffic.js";

const val = (value, source) => ({ value, valid: value != null, source, windowS: 60, approximate: false, samples: 3 });
const win = (decode, ttft, source) => ({
  spanS: 60,
  coveredS: 58,
  reads: 12,
  startedAt: 0,
  resets: 0,
  values: { decode_tps: val(decode, source), prefill_tps: val(900, source), throughput_tps: val(decode, source), ttft_s: val(ttft, source) },
});
const req = (wallMs, extra = {}) => ({
  wallMs,
  client: "10.0.0.5",
  path: "/v1/chat/completions",
  model: "m",
  status: 200,
  aborted: false,
  stream: true,
  promptTokens: 100,
  completionTokens: 40,
  cachedTokens: 60,
  completionEstimated: false,
  ttftS: 0.2,
  decodeS: 1.1,
  decodeFrom: "stream",
  e2eS: 1.3,
  ...extra,
});
const relay = (recent, extra = {}) => ({
  listenPort: 18000,
  upstreamPort: 11434,
  counters: { generated: 400, prompt: 1000, cached: 600, requestsFinished: 10 },
  meta: null,
  inFlight: 1,
  requests: 11,
  errors: 1,
  estimatedRequests: 0,
  clients: [{ client: "10.0.0.5" }],
  recent,
  ...extra,
});

describe("buildTrafficView", () => {
  test("engine counters lane: engine badge, engine requests, no relay", () => {
    const v = buildTrafficView({
      nodeId: "n1",
      polledAt: 5,
      llm: [
        {
          port: 8000,
          backend: "vllm",
          modelId: "glm",
          engineCounters: { generated: 5000, prompt: 20000, cached: 15000, requestsFinished: 42 },
          normalized: { 60: win(55.5, 0.3, "counter"), 300: win(50, 0.35, "counter") },
        },
      ],
    });
    assert.equal(v.proxyEnabled, false);
    assert.equal(v.lanes.length, 1);
    const l = v.lanes[0];
    assert.equal(l.tokenSource, "engine");
    assert.equal(l.requests, 42);
    assert.equal(l.requestsSource, "engine");
    assert.equal(l.errors, null, "only the relay sees errors");
    assert.equal(l.generatedTokens, 5000);
    assert.equal(l.cachedTokens, 15000);
    assert.deepEqual(l.windows[60].decodeTps, { value: 55.5, source: "counter" });
    assert.deepEqual(l.windows[300].ttftS, { value: 0.35, source: "counter" });
    assert.equal(l.proxied, false);
  });

  test("relay-only lane: proxy badge, relay requests/errors; estimate when content was counted", () => {
    const snap = {
      nodeId: "n1",
      llm: [{ port: 11434, backend: "ollama", modelId: "llama", proxyCounters: { generated: 400, prompt: 1000, cached: 600 } }],
      llmProxy: [relay([])],
    };
    const l = buildTrafficView(snap).lanes[0];
    assert.equal(l.tokenSource, "proxy");
    assert.equal(l.requests, 11);
    assert.equal(l.requestsSource, "proxy");
    assert.equal(l.errors, 1);
    assert.equal(l.inFlight, 1);
    assert.equal(l.listenPort, 18000);
    assert.equal(l.windows[60].decodeTps.value, null, "no normalized → nulls, never 0");
    snap.llmProxy = [relay([], { estimatedRequests: 2 })];
    assert.equal(buildTrafficView(snap).lanes[0].tokenSource, "estimate");
  });

  test("no counters anywhere: no badge, nulls", () => {
    const l = buildTrafficView({ llm: [{ port: 1234, backend: "lmstudio", modelId: null }] }).lanes[0];
    assert.equal(l.tokenSource, null);
    assert.equal(l.requests, null);
    assert.equal(l.generatedTokens, null);
  });

  test("empty snapshot reads an empty view", () => {
    const v = buildTrafficView(null);
    assert.deepEqual(v.lanes, []);
    assert.equal(v.proxyEnabled, false);
    assert.equal(v.recentMax, TRAFFIC_RECENT_MAX);
  });
});

describe("createTrafficLog", () => {
  test("rows are metadata only (allow-list)", () => {
    const row = requestRow(req(1, { prompt: "secret text", messages: [{ content: "x" }], responseText: "y" }), { listenPort: 1, upstreamPort: 2 });
    assert.equal("prompt" in row, false);
    assert.equal("messages" in row, false);
    assert.equal("responseText" in row, false);
    assert.equal(JSON.stringify(row).includes("secret"), false);
    assert.equal(row.promptTokens, 100);
  });

  test("accumulates across polls without duplicates, newest first", () => {
    const log = createTrafficLog();
    assert.equal(log.ingest("n1", { llmProxy: [relay([req(1), req(2)])] }), 2);
    assert.equal(log.ingest("n1", { llmProxy: [relay([req(2), req(3)])] }), 1);
    assert.deepEqual(log.recent("n1").map((r) => r.wallMs), [3, 2, 1]);
    assert.deepEqual(log.recent("other"), []);
    assert.equal(log.ingest("n1", { llm: [] }), 0, "no relay → nothing");
  });

  test("keeps the last 200 per node", () => {
    const log = createTrafficLog();
    for (let p = 0; p < 15; p++) {
      log.ingest("n1", { llmProxy: [relay(Array.from({ length: 20 }, (_, i) => req(p * 20 + i + 1)))] });
    }
    assert.equal(log.size("n1"), 200);
    const rows = log.recent("n1");
    assert.equal(rows[0].wallMs, 300);
    assert.equal(rows[199].wallMs, 101);
    // An evicted row seen again is accepted again (keys are evicted with rows) but the cap holds.
    log.ingest("n1", { llmProxy: [relay([req(301)])] });
    assert.equal(log.size("n1"), 200);
  });

  test("forget drops a node", () => {
    const log = createTrafficLog();
    log.ingest("n1", { llmProxy: [relay([req(1)])] });
    log.forget("n1");
    assert.equal(log.size("n1"), 0);
  });
});

describe("GET /api/fleet/nodes/:id/traffic", () => {
  let server;
  let base;
  const snaps = {
    n1: {
      nodeId: "n1",
      llm: [{ port: 11434, backend: "ollama", modelId: "llama", proxyCounters: { generated: 1 } }],
      llmProxy: [relay([req(10), req(11, { status: 500 })])],
    },
  };
  before(async () => {
    const app = express();
    registerTrafficRoutes(app, {
      getNode: (id) => (id === "n1" || id === "n2" ? { id } : null),
      getSnapshot: (id) => snaps[id] ?? null,
      log: createTrafficLog(),
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test("returns lanes and recent rows", async () => {
    const r = await fetch(`${base}/api/fleet/nodes/n1/traffic`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.proxyEnabled, true);
    assert.equal(body.lanes[0].port, 11434);
    assert.deepEqual(body.recent.map((x) => x.status), [500, 200]);
  });

  test("registered node without a snapshot → empty view", async () => {
    const body = await (await fetch(`${base}/api/fleet/nodes/n2/traffic`)).json();
    assert.equal(body.nodeId, "n2");
    assert.deepEqual(body.lanes, []);
    assert.deepEqual(body.recent, []);
  });

  test("unknown node → 404", async () => {
    assert.equal((await fetch(`${base}/api/fleet/nodes/nope/traffic`)).status, 404);
  });
});
