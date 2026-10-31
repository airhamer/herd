/**
 * Hasso battery v1 (#44): the probe battery, bench.sh's per-run rate and
 * greedy median, and bench-matrix.sh's two-call delta with its
 * unreliable-sample guard, as upstream defines them.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import crypto from "crypto";
import http from "http";
import {
  HASSO_BENCH_PROBES,
  HASSO_MATRIX_PROBES,
  HASSO_WARMUP,
  hassoBenchSummary,
  hassoCallBody,
  hassoRequestCount,
  hassoStreamBody,
  hassoStreamRate,
  hassoTimedCall,
  hassoTokenBudget,
  hassoTwoCallDelta,
  normalizeHassoParts,
  pyMedian,
  runHassoBattery,
} from "../hassoBattery.js";

function sha(v) {
  return crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
}

test("battery v1 is frozen: probes, sampling and prompts as upstream", () => {
  assert.deepEqual(
    HASSO_BENCH_PROBES.map((p) => [p.key, p.temperature, p.maxTokens, p.inMedian]),
    [
      ["code", 0, 1200, true],
      ["reasoning", 0, 1200, true],
      ["math_peak", 0.6, 2048, false],
      ["prose", 0, 800, false],
    ]
  );
  assert.equal(HASSO_MATRIX_PROBES.length, 8);
  assert.deepEqual([...new Set(HASSO_MATRIX_PROBES.map((p) => p.lang))].sort(), ["DE", "EN", "FR"]);
  assert.deepEqual(
    HASSO_MATRIX_PROBES.map((p) => p.name),
    [
      "math (EN, eval-style)",
      "code (EN)",
      "code (DE)",
      "technical explain (FR)",
      "reasoning (FR)",
      "free prose (EN)",
      "free prose (FR)",
      "free prose (DE)",
    ]
  );
  // Editing a prompt in place breaks comparability: this hash must never change.
  assert.equal(
    sha([HASSO_BENCH_PROBES.map((p) => p.prompt), HASSO_MATRIX_PROBES.map((p) => p.prompt)]),
    "85b16f731b88d3ba5da79c71ab4011a5905bc981b2b72246eec7d9c79fc446b8"
  );
  assert.deepEqual(HASSO_WARMUP, { prompt: "Say OK.", maxTokens: 24 });
});

test("request bodies: bench.sh streams with usage, bench-matrix.sh is greedy and not streamed", () => {
  assert.deepEqual(hassoStreamBody("m", "p", 0.6, 2048), {
    model: "m",
    messages: [{ role: "user", content: "p" }],
    max_tokens: 2048,
    temperature: 0.6,
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.deepEqual(hassoCallBody("m", "p", 80), {
    model: "m",
    messages: [{ role: "user", content: "p" }],
    temperature: 0,
    max_tokens: 80,
  });
  assert.equal("model" in hassoCallBody(null, "p", 80), false);
});

test("bench.sh run rate: (out − 1) / (t_last − t_first); untimeable runs are null", () => {
  assert.equal(hassoStreamRate({ completionTokens: 101, tFirst: 1000, tLast: 3000 }), 50);
  assert.equal(hassoStreamRate({ completionTokens: 5, tFirst: 1000, tLast: 1000 }), null);
  assert.equal(hassoStreamRate({ completionTokens: 0, tFirst: null, tLast: null }), null);
});

test("greedy median: code + reasoning timed runs only; math and prose never enter it", () => {
  const s = hassoBenchSummary([
    { key: "code", inMedian: true, runs: [{ tps: 60 }, { tps: 64 }] },
    { key: "reasoning", inMedian: true, runs: [{ tps: 66 }, { tps: null }] },
    { key: "math_peak", inMedian: false, runs: [{ tps: 1 }, { tps: 1 }] },
    { key: "prose", inMedian: false, runs: [{ tps: 999 }, { tps: 999 }] },
  ]);
  assert.equal(s.greedyMedian, 64);
  assert.equal(s.greedyRuns, 3);
  assert.equal(s.untimed, 1);
  assert.deepEqual(
    s.perProbe.map((p) => p.median),
    [62, 66, 1, 999]
  );
  assert.equal(pyMedian([1, 2, 3, 4]), 2.5);
  assert.equal(hassoBenchSummary([{ key: "code", inMedian: true, runs: [{ tps: null }] }]).greedyMedian, null);
});

test("two-call delta: Δtok / Δt, refused below 50 tokens or 2.0 s like upstream", () => {
  const ok = hassoTwoCallDelta({ wallS: 1.5, tokens: 80 }, { wallS: 13.5, tokens: 680 });
  assert.deepEqual(ok, { deltaTokens: 600, deltaS: 12, tps: 50, reliable: true, reason: null });
  assert.equal(hassoTwoCallDelta({ wallS: 0, tokens: 80 }, { wallS: 2.0, tokens: 130 }).reliable, true);
  const fewTok = hassoTwoCallDelta({ wallS: 1, tokens: 40 }, { wallS: 9, tokens: 89 });
  assert.equal(fewTok.reliable, false);
  assert.equal(fewTok.tps, null);
  assert.match(fewTok.reason, /unreliable sample \(Δtok=49, Δt=8\.00s/);
  const fast = hassoTwoCallDelta({ wallS: 1, tokens: 80 }, { wallS: 2.99, tokens: 680 });
  assert.equal(fast.reliable, false);
  assert.match(fast.reason, /Δt=1\.99s/);
});

test("parts, request count and token budget", () => {
  assert.deepEqual(normalizeHassoParts(undefined), ["bench", "matrix"]);
  assert.deepEqual(normalizeHassoParts(["matrix", "bogus"]), ["matrix"]);
  assert.deepEqual(normalizeHassoParts([]), []);
  assert.equal(hassoRequestCount(["bench", "matrix"]), 25);
  assert.equal(hassoRequestCount(["matrix"]), 17);
  assert.equal(hassoTokenBudget(["bench"]), 2 * (1200 + 1200 + 2048 + 800));
  assert.equal(hassoTokenBudget(["matrix"]), 24 + 8 * 760);
});

test("runHassoBattery: bench.sh probes ×2 in order, then warm-up and 80/680 pairs", async () => {
  const sent = [];
  let clock = 0;
  const streamImpl = async (url, body) => {
    sent.push({ kind: "stream", body });
    clock += 10_000;
    return { completionTokens: 201, tFirst: clock, tLast: clock + 4000, ttftMs: 50, error: null };
  };
  const callImpl = async (url, body) => {
    sent.push({ kind: "call", body });
    if (body.max_tokens === 24) return { wallS: 0.3, tokens: 2 };
    const prose = body.messages[0].content.includes("autumn");
    // A short answer (math EN) stops before the long budget: refused.
    const short = body.messages[0].content.startsWith("Natalia");
    if (body.max_tokens === 80) return { wallS: 2, tokens: 80 };
    return short ? { wallS: 2.5, tokens: 110 } : { wallS: prose ? 32 : 14, tokens: 680 };
  };
  const state = {};
  await runHassoBattery({
    baseUrl: "http://x",
    parts: ["bench", "matrix"],
    state,
    streamImpl,
    callImpl,
    modelsImpl: async () => "served-model",
  });
  assert.equal(state.model, "served-model");
  assert.equal(sent.length, 25);
  assert.deepEqual(
    sent.slice(0, 8).map((s) => [s.body.temperature, s.body.max_tokens]),
    [
      [0, 1200], [0, 1200], [0, 1200], [0, 1200], [0.6, 2048], [0.6, 2048], [0, 800], [0, 800],
    ]
  );
  assert.ok(sent.every((s) => s.body.model === "served-model"));
  assert.deepEqual(sent[8].body.messages[0].content, "Say OK.");
  assert.deepEqual(
    sent.slice(9).map((s) => s.body.max_tokens),
    Array.from({ length: 8 }, () => [80, 680]).flat()
  );
  assert.ok(sent.slice(8).every((s) => s.kind === "call" && s.body.temperature === 0 && !("stream" in s.body)));
  assert.equal(state.bench.greedyMedian, 50);
  assert.equal(state.bench.greedyRuns, 4);
  const byKey = Object.fromEntries(state.matrix.probes.map((p) => [p.key, p]));
  assert.equal(byKey.math_en.reliable, false);
  assert.equal(byKey.math_en.tps, null);
  assert.equal(byKey.code_en.tps, 50);
  assert.equal(byKey.prose_en.tps, 20);
  assert.equal(byKey.prose_de.tps, 50);
  assert.equal(state.matrix.warmup.discarded, true);
});

test("request errors are fatal, as the scripts exit; partial state is kept", async () => {
  const state = {};
  await assert.rejects(
    runHassoBattery({
      baseUrl: "http://x",
      modelId: "m",
      parts: ["bench"],
      state,
      streamImpl: async () => ({ error: "HTTP 500" }),
    }),
    /bench\.sh code: HTTP 500/
  );
  assert.equal(state.bench.probes[0].runs.length, 0);
});

test("hassoTimedCall: wall clock + usage; no usage or HTTP error throws", async (t) => {
  let mode = "ok";
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (mode === "500") {
        res.writeHead(500);
        res.end("boom");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(mode === "ok" ? { model: "m", usage: { completion_tokens: 7 } } : { choices: [] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const ok = await hassoTimedCall(url, hassoCallBody("m", "p", 80));
  assert.equal(ok.tokens, 7);
  assert.ok(ok.wallS >= 0);
  mode = "nousage";
  await assert.rejects(hassoTimedCall(url, hassoCallBody("m", "p", 80)), /no usage\.completion_tokens/);
  mode = "500";
  await assert.rejects(hassoTimedCall(url, hassoCallBody("m", "p", 80)), /HTTP 500/);
});
