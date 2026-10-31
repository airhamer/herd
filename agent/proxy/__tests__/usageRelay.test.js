// STAT4 (#37): opt-in usage relay — per-request usage from responses that
// pass through, as engine-neutral counters in the "proxy" source tier.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import {
  attachProxyUsage,
  createRequestMeter,
  createUsageLedger,
  createUsageRelay,
  createUsageRelays,
  isMeteredPath,
  parseRelaySpec,
} from "../usageRelay.js";
import { collectTelemetry } from "../../telemetry.js";

const enc = (s) => new TextEncoder().encode(s);
const CLOCK = { monoNow: () => 500, wallNow: () => 1_700_000_000_000, bootId: "boot-p" };

/** Feed `parts` ([text, t]) and finish at `tEnd`. */
function run(contentType, parts, { t0 = 0, tEnd = 1000, status = 200, encoding = "" } = {}) {
  const m = createRequestMeter({ t0, contentType, contentEncoding: encoding });
  for (const [txt, t] of parts) m.chunk(typeof txt === "string" ? enc(txt) : txt, t);
  return m.finish({ status, t: tEnd });
}

const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (content) => ({ model: "m", choices: [{ index: 0, delta: { content } }] });

test("parseRelaySpec: listen:upstream pairs, invalid and duplicate dropped", () => {
  assert.deepEqual(parseRelaySpec("18434:11434, 11235:1234"), [
    { listenPort: 18434, upstreamPort: 11434 },
    { listenPort: 11235, upstreamPort: 1234 },
  ]);
  assert.deepEqual(parseRelaySpec("x,0:5,70000:1,9:9,8:80,8:81"), [{ listenPort: 8, upstreamPort: 80 }]);
  assert.deepEqual(parseRelaySpec(""), []);
  assert.deepEqual(parseRelaySpec(undefined), []);
});

test("isMeteredPath: generation endpoints only", () => {
  for (const p of ["/v1/chat/completions", "/v1/completions?x=1", "/api/generate", "/api/chat/", "/completion", "/v1/messages"]) {
    assert.ok(isMeteredPath(p), p);
  }
  for (const p of ["/v1/models", "/api/tags", "/metrics", "/health", "/v1/embeddings"]) assert.ok(!isMeteredPath(p), p);
});

test("OpenAI SSE with final usage: tokens, cached, TTFT and decode from stream timing", () => {
  const r = run("text/event-stream; charset=utf-8", [
    [sse({ model: "m", choices: [{ delta: { role: "assistant" } }] }), 50],
    [sse(delta("Hel")), 200],
    // an event split across two chunks
    [sse(delta("lo")).slice(0, 10), 300],
    [sse(delta("lo")).slice(10) + sse(delta(" there")), 400],
    [sse({ model: "m", choices: [], usage: { prompt_tokens: 120, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 100 } } }) + "data: [DONE]\n\n", 600],
  ], { tEnd: 650 });
  assert.equal(r.ok, true);
  assert.equal(r.stream, true);
  assert.equal(r.model, "m");
  assert.equal(r.promptTokens, 120);
  assert.equal(r.completionTokens, 4);
  assert.equal(r.cachedTokens, 100);
  assert.equal(r.completionEstimated, false);
  assert.equal(r.ttftS, 0.2);
  assert.deepEqual(r.decode, { tokens: 4, first: 1, seconds: 0.2, from: "stream" });
  assert.equal(r.prefill, null);
  assert.equal(r.e2eS, 0.65);
});

test("SSE without usage: completion estimated from content events", () => {
  const r = run("text/event-stream", [[sse(delta("a")), 100], [sse(delta("b")), 150], [sse(delta("c")), 300]]);
  assert.equal(r.completionTokens, 3);
  assert.equal(r.completionEstimated, true);
  assert.equal(r.promptTokens, null);
  assert.deepEqual(r.decode, { tokens: 3, first: 1, seconds: 0.2, from: "stream" });
});

test("Ollama /api/chat NDJSON stream: eval counts and durations win over stream timing", () => {
  const line = (o) => JSON.stringify(o) + "\n";
  const r = run("application/x-ndjson", [
    [line({ model: "llama3", message: { role: "assistant", content: "Hi" }, done: false }), 300],
    [line({ model: "llama3", message: { role: "assistant", content: "!" }, done: false }), 350],
    [line({
      model: "llama3", message: { role: "assistant", content: "" }, done: true,
      total_duration: 900_000_000, load_duration: 10_000_000,
      prompt_eval_count: 26, prompt_eval_duration: 130_000_000, eval_count: 42, eval_duration: 840_000_000,
    }), 900],
  ]);
  assert.equal(r.model, "llama3");
  assert.equal(r.promptTokens, 26);
  assert.equal(r.completionTokens, 42);
  assert.equal(r.cachedTokens, null);
  assert.equal(r.ttftS, 0.3);
  assert.deepEqual(r.decode, { tokens: 42, first: 0, seconds: 0.84, from: "engine" });
  assert.deepEqual(r.prefill, { tokens: 26, seconds: 0.13 });
});

test("Ollama /api/generate non-stream JSON: totals, no TTFT", () => {
  const body = JSON.stringify({ model: "qwen", response: "ok", done: true, prompt_eval_count: 10, prompt_eval_duration: 50_000_000, eval_count: 5, eval_duration: 100_000_000 });
  const r = run("application/json; charset=utf-8", [[body.slice(0, 20), 100], [body.slice(20), 200]], { tEnd: 210 });
  assert.equal(r.stream, false);
  assert.equal(r.promptTokens, 10);
  assert.equal(r.completionTokens, 5);
  assert.equal(r.ttftS, null);
  assert.deepEqual(r.decode, { tokens: 5, first: 0, seconds: 0.1, from: "engine" });
});

test("llama.cpp timings: prompt_n + cache_n, predicted over predicted_ms", () => {
  const body = JSON.stringify({ content: "x", stop: true, timings: { prompt_n: 40, prompt_ms: 20, predicted_n: 30, predicted_ms: 600, cache_n: 60 } });
  const r = run("application/json", [[body, 100]]);
  assert.equal(r.promptTokens, 100);
  assert.equal(r.cachedTokens, 60);
  assert.equal(r.completionTokens, 30);
  assert.deepEqual(r.decode, { tokens: 30, first: 0, seconds: 0.6, from: "engine" });
  assert.deepEqual(r.prefill, { tokens: 40, seconds: 0.02 });
});

test("/v1/messages stream: input and output usage merged", () => {
  const r = run("text/event-stream", [
    [`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model: "c", usage: { input_tokens: 10, cache_read_input_tokens: 5 } } })}\n\n`, 10],
    [`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "a" } })}\n\n`, 100],
    [`data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 7 } })}\n\n`, 300],
  ]);
  assert.equal(r.promptTokens, 15);
  assert.equal(r.cachedTokens, 5);
  assert.equal(r.completionTokens, 7);
});

test("compressed, unknown or failed responses meter nothing but are recorded", () => {
  const gz = zlib.gzipSync(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  const a = run("application/json", [[gz, 10]], { encoding: "gzip" });
  assert.equal(a.promptTokens, null);
  const b = run("text/plain", [["hello", 10]]);
  assert.equal(b.completionTokens, null);
  const c = run("application/json", [['{"error":"x"}', 10]], { status: 500 });
  assert.equal(c.ok, false);
  const d = run("application/json", [["not json", 10]]);
  assert.equal(d.promptTokens, null);
});

test("ledger: engine-neutral counters, errors apart, proxy meta", () => {
  const l = createUsageLedger({ listenPort: 18434, upstreamPort: 11434 });
  assert.deepEqual(l.snapshot(CLOCK).counters, null);
  assert.equal(l.snapshot(CLOCK).meta, null);
  l.begin();
  l.begin();
  l.begin();
  assert.equal(l.snapshot(CLOCK).inFlight, 3);
  const ok = {
    status: 200, ok: true, aborted: false, model: "m", stream: true, promptTokens: 100, completionTokens: 11, cachedTokens: null,
    completionEstimated: false, ttftS: 0.5, e2eS: 2, decode: { tokens: 11, first: 1, seconds: 1, from: "stream" }, prefill: null,
  };
  l.record(ok, { client: "10.0.0.2", path: "/v1/chat/completions", wallMs: 1 });
  l.record({ ...ok, promptTokens: 50, completionTokens: 21, decode: { tokens: 21, first: 0, seconds: 0.5, from: "engine" }, prefill: { tokens: 50, seconds: 0.1 }, ttftS: null, cachedTokens: 10 }, { client: "10.0.0.3", wallMs: 2 });
  l.record({ ...ok, status: 500, ok: false }, { client: "10.0.0.2", wallMs: 3 });
  const s = l.snapshot(CLOCK);
  assert.equal(s.inFlight, 0);
  assert.equal(s.requests, 3);
  assert.equal(s.errors, 1);
  assert.deepEqual(s.meta, { schema: 2, source: "proxy", monoMs: 500, wallMs: 1_700_000_000_000, bootId: "boot-p" });
  assert.equal(s.counters.prompt, 150);
  assert.equal(s.counters.cached, 10);
  assert.equal(s.counters.generated, 32);
  assert.equal(s.counters.decoded, 32);
  assert.equal(s.counters.first, 1);
  assert.equal(s.counters.itlSum, 1.5);
  assert.equal(s.counters.prefillComputed, 50);
  assert.equal(s.counters.ttftSum, 0.5);
  assert.equal(s.counters.ttftCount, 1);
  assert.equal(s.counters.e2eCount, 2);
  assert.equal(s.counters.requestsFinished, 2);
  assert.equal(s.counters.queueSum, null);
  assert.deepEqual(s.clients.map((c) => [c.client, c.requests, c.errors, c.generated]), [["10.0.0.2", 2, 1, 11], ["10.0.0.3", 1, 0, 21]]);
  assert.equal(s.recent.length, 3);
  assert.equal(s.recent[0].path, "/v1/chat/completions");
});

test("ledger: clients and recent requests are capped", () => {
  const l = createUsageLedger();
  const r = { status: 200, ok: true, aborted: false, model: null, stream: false, promptTokens: 1, completionTokens: 1, cachedTokens: null, completionEstimated: false, ttftS: null, e2eS: 0.1, decode: null, prefill: null };
  for (let i = 0; i < 100; i++) l.record(r, { client: `c${i}`, wallMs: i });
  const s = l.snapshot(CLOCK);
  assert.equal(s.clients.length, 64);
  assert.equal(s.clients[0].client, "c99");
  assert.equal(s.recent.length, 20);
  assert.equal(s.counters.requestsFinished, 100);
});

test("attachProxyUsage: counters on the forwarded port only", () => {
  const relays = [
    { upstreamPort: 11434, inFlight: 1, counters: { generated: 5, prompt: null }, meta: { schema: 2, source: "proxy" } },
    { upstreamPort: 11434, inFlight: 0, counters: { generated: 7, prompt: 3 }, meta: { schema: 2, source: "proxy" } },
  ];
  const out = attachProxyUsage([{ port: 11434, backend: "ollama" }, { port: 8000, backend: "vllm" }], relays);
  assert.deepEqual(out[0].proxyCounters, { generated: 12, prompt: 3 });
  assert.equal(out[0].proxyInFlight, 1);
  assert.equal(out[0].proxyCountersMeta.source, "proxy");
  assert.equal("proxyCounters" in out[1], false);
  const same = [{ port: 1 }];
  assert.equal(attachProxyUsage(same, []), same);
});

test("createUsageRelays: off unless LLM_PROXY is set", () => {
  assert.equal(createUsageRelays({}).relays.length, 0);
  assert.deepEqual(createUsageRelays({}).snapshot(), []);
  assert.equal(createUsageRelays({ LLM_PROXY: "18434:11434" }).relays.length, 1);
});

/** Start an HTTP server on an ephemeral loopback port. */
function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

function request(port, path, body, method = "POST") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("relay end to end: bytes pass unchanged, Ollama usage metered, other paths not", async () => {
  const lines = [
    { model: "llama3", message: { role: "assistant", content: "Hi" }, done: false },
    { model: "llama3", message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 8, prompt_eval_duration: 40_000_000, eval_count: 3, eval_duration: 30_000_000 },
  ].map((o) => JSON.stringify(o) + "\n");
  let seenBody = null;
  const upstream = await listen((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seenBody = Buffer.concat(chunks).toString();
      if (req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"models":[]}');
        return;
      }
      res.writeHead(200, { "content-type": "application/x-ndjson", "x-upstream": "yes" });
      res.write(lines[0]);
      setTimeout(() => res.end(lines[1]), 20);
    });
  });
  const relay = createUsageRelay({ listenPort: 0, upstreamPort: upstream.address().port });
  const { port } = await relay.start();
  try {
    const r = await request(port, "/api/chat", '{"model":"llama3","messages":[]}');
    assert.equal(r.status, 200);
    assert.equal(r.body, lines.join(""));
    assert.equal(r.headers["x-upstream"], "yes");
    assert.equal(seenBody, '{"model":"llama3","messages":[]}');
    const tags = await request(port, "/api/tags", "", "GET");
    assert.equal(tags.body, '{"models":[]}');
    const s = relay.ledger.snapshot(CLOCK);
    assert.equal(s.requests, 1);
    assert.equal(s.inFlight, 0);
    assert.equal(s.counters.prompt, 8);
    assert.equal(s.counters.generated, 3);
    assert.equal(s.counters.itlSum, 0.03);
    assert.equal(s.counters.ttftCount, 1);
    assert.equal(s.clients[0].client, "127.0.0.1");
    assert.equal(s.recent[0].model, "llama3");
  } finally {
    await relay.stop();
    await new Promise((r) => upstream.close(r));
  }
});

test("relay: upstream down answers 502 and counts an error", async () => {
  const dead = await listen(() => {});
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  const relay = createUsageRelay({ listenPort: 0, upstreamPort: deadPort });
  const { port } = await relay.start();
  try {
    const r = await request(port, "/v1/chat/completions", "{}");
    assert.equal(r.status, 502);
    const s = relay.ledger.snapshot(CLOCK);
    assert.equal(s.errors, 1);
    assert.equal(s.counters, null);
  } finally {
    await relay.stop();
  }
});

test("relay: a client that leaves mid-stream aborts the upstream request", async () => {
  let upstreamClosed;
  const closed = new Promise((r) => (upstreamClosed = r));
  const upstream = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse(delta("a")));
    res.on("close", () => upstreamClosed(true));
  });
  const relay = createUsageRelay({ listenPort: 0, upstreamPort: upstream.address().port });
  const { port } = await relay.start();
  try {
    await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST" }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => {});
      req.end("{}");
    });
    assert.equal(await closed, true);
    await new Promise((r) => setTimeout(r, 20));
    const s = relay.ledger.snapshot(CLOCK);
    assert.equal(s.requests, 1);
    assert.equal(s.errors, 1);
    assert.equal(s.recent[0].aborted, true);
    assert.equal(s.inFlight, 0);
  } finally {
    await relay.stop();
    upstream.closeAllConnections?.();
    await new Promise((r) => upstream.close(r));
  }
});

test("collectTelemetry: relay usage on the llm entry and snapshot.llmProxy", async () => {
  const relaySnap = [{ listenPort: 18434, upstreamPort: 11434, inFlight: 2, counters: { generated: 9 }, meta: { schema: 2, source: "proxy", monoMs: 1, wallMs: 1, bootId: "b" }, requests: 4, errors: 0, clients: [], recent: [] }];
  const none = () => null;
  const snap = await collectTelemetry("n", "n", "1.2.3.4", [11434], null, {
    now: () => 1000,
    readFile: async () => "1 1",
    usageRelay: { snapshot: () => relaySnap },
    inject: {
      gpu: none, cpu: none, mem: none, disk: () => [], net: () => [], docker: () => [], systemd: () => [], uptime: () => 1,
      llm: () => [{ port: 11434, backend: "ollama", modelId: "llama3" }], comfy: none, tailscale: none, proxy: none, library: none,
    },
  });
  assert.deepEqual(snap.llm[0].proxyCounters, { generated: 9 });
  assert.equal(snap.llm[0].proxyInFlight, 2);
  assert.deepEqual(snap.llmProxy, relaySnap);
  const plain = await collectTelemetry("n", "n", "1.2.3.4", [11434], null, {
    now: () => 1000,
    readFile: async () => "1 1",
    inject: {
      gpu: none, cpu: none, mem: none, disk: () => [], net: () => [], docker: () => [], systemd: () => [], uptime: () => 1,
      llm: () => [{ port: 11434, backend: "ollama", modelId: "llama3" }], comfy: none, tailscale: none, proxy: none, library: none,
    },
  });
  assert.equal(plain.llmProxy, null);
  assert.equal("proxyCounters" in plain.llm[0], false);
});
