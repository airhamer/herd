/**
 * DecodeBench `protocol: "hasso-battery-v1"` (#44): the battery runs on the
 * decode manager (Spark and node routes), refuses unreliable two-call
 * samples, and lands in the bench results store with suite_version 1.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { DecodeBenchManager, DECODE_BENCH_DEFAULTS, decodeBudgetArgs } from "../DecodeBench.js";
import { startSseFixture } from "./sseFixture.js";
import { BenchResultsStore } from "../../bench/results/store.js";
import { createResultsRecorder } from "../../bench/results/recorder.js";
import { fromDecodeJob } from "../../bench/results/adapters.js";
import { validateResult } from "../../bench/results/schema.js";
import { getDefinition } from "../../bench/results/definitions.js";
import { provenance } from "../../bench/results/__tests__/fixtures.js";
import { validateDecodeBudget } from "../../validate.js";

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decode-hasso-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitDone(m, benchId) {
  for (let i = 0; i < 3000 && m.getJob(benchId)?.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return m.getJob(benchId);
}

/** Deterministic engine: 50 tok/s streamed; two-call delta 50 tok/s except a short math answer. */
function fakeEngine() {
  let clock = 0;
  return {
    streamImpl: async () => {
      clock += 60_000;
      return { completionTokens: 201, tFirst: clock, tLast: clock + 4000, ttftMs: 40, error: null };
    },
    callImpl: async (url, body) => {
      if (body.max_tokens === 24) return { wallS: 0.2, tokens: 2 };
      if (body.max_tokens === 80) return { wallS: 2, tokens: 80 };
      return body.messages[0].content.startsWith("Natalia") ? { wallS: 2.6, tokens: 120 } : { wallS: 14, tokens: 680 };
    },
    modelsImpl: async () => "served",
  };
}

test("start validates the Hasso protocol options; defaults describe battery v1", (t) => {
  const dir = tmpDir(t);
  const m = new DecodeBenchManager(path.join(dir, "h.json"), path.join(dir, "a.json"));
  const base = { sparkId: "s", lanIp: "127.0.0.1", port: 1, protocol: "hasso-battery-v1" };
  assert.throws(() => m.start({ ...base, parts: ["nope"] }), /at least one Hasso battery part/);
  assert.throws(() => m.start({ ...base, maxTokens: 400 }), /own max tokens/);
  assert.equal(m.activeCount(), 0);
  assert.ok(DECODE_BENCH_DEFAULTS.protocols.includes("hasso-battery-v1"));
  assert.equal(DECODE_BENCH_DEFAULTS.hasso.batteryVersion, 1);
  assert.equal(DECODE_BENCH_DEFAULTS.hasso.requests, 25);
  assert.deepEqual(DECODE_BENCH_DEFAULTS.hasso.matrixMaxTokens, [80, 680]);
});

test("budget: the battery counts every request's max_tokens as one stream", () => {
  const [units, mt] = decodeBudgetArgs({ protocol: "hasso-battery-v1" });
  assert.deepEqual(units, [10496 + 6104]);
  assert.equal(mt, 1);
  assert.equal(validateDecodeBudget(units, mt), 16600);
  assert.deepEqual(decodeBudgetArgs({ protocol: "hasso-battery-v1", parts: ["matrix"] }), [[6104], 1]);
});

test("battery end to end: 13 store rows, suite_version 1, refused sample stored as invalid", async (t) => {
  const dir = tmpDir(t);
  const store = new BenchResultsStore({ path: path.join(dir, "r.json"), log: () => {} });
  const recorder = createResultsRecorder({ store });
  const m = new DecodeBenchManager(path.join(dir, "h.json"), path.join(dir, "a.json"));
  m.resultSink = recorder.sinkFor("DecodeBench");
  m.hassoImpl = fakeEngine();
  const job = m.start({ sparkId: "node:n1", nodeId: "n1", lanIp: "127.0.0.1", port: 8000, protocol: "hasso-battery-v1" });
  assert.deepEqual(job.config.concurrencies, [1]);
  assert.deepEqual(job.config.parts, ["bench", "matrix"]);
  assert.equal(job.progress.requestsTotal, 25);
  recorder.noteStart("DecodeBench", job.benchId, provenance({ host: { ...provenance().host, node_id: "n1" } }));
  const done = await waitDone(m, job.benchId);
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.config.modelId, "served");
  assert.equal(done.progress.requestsDone, 25);
  assert.equal(done.progress.completedLevels, 2);
  assert.equal(done.hasso.bench.greedyMedian, 50);

  const records = store.list({ run_id: `decode:${job.benchId}`, limit: 100 }).results;
  assert.equal(records.length, 1 + 4 + 8);
  for (const r of records) {
    assert.deepEqual(validateResult(r), { ok: true, errors: [] });
    assert.equal(r.run.suite, "hasso-battery-v1");
    assert.equal(r.run.suite_version, "1");
    assert.equal(r.settings.battery_version, 1);
    assert.equal(r.conditions.concurrency, 1);
    assert.equal(r.host.node_id, "n1");
    assert.equal(r.lane.model_id, "served");
  }
  const byCase = Object.fromEntries(records.map((r) => [r.settings.case_id, r]));
  const head = byCase["hasso.bench.greedy_median"];
  assert.equal(head.metrics[0].definition, "hasso.single_stream_greedy_median.v1");
  assert.equal(head.metrics[0].value, 50);
  assert.equal(head.metrics[0].n, 4);
  assert.equal(byCase["hasso.bench.math_peak"].conditions.temperature, 0.6);
  assert.equal(byCase["hasso.bench.prose"].settings.in_greedy_median, false);
  const code = byCase["hasso.matrix.code_en"];
  assert.equal(code.metrics[0].definition, "hasso.matrix_two_call_delta.v1");
  assert.equal(code.metrics[0].value, 50);
  assert.equal(code.conditions.max_tokens, 680);
  assert.equal(code.conditions.prompt_set, "hasso-battery-v1/matrix/code_en");
  const math = byCase["hasso.matrix.math_en"];
  assert.equal(math.metrics[0].value, null);
  assert.equal(math.metrics[0].valid, false);
  assert.equal(math.settings.reliable, false);
  assert.match(math.settings.refused_reason, /unreliable sample/);
  // Three definitions, three comparable groups: never diffed against each other.
  const groups = new Set(
    ["hasso.single_stream_greedy_median.v1", "hasso.bench_probe_median.v1", "hasso.matrix_two_call_delta.v1"].map(
      (d) => getDefinition(d).comparable
    )
  );
  assert.equal(groups.size, 3);
  assert.deepEqual(
    fromDecodeJob(done, { recordedAt: "2026-01-01T00:00:00Z" }),
    fromDecodeJob(done, { recordedAt: "2026-01-01T00:00:00Z" })
  );
});

test("over real HTTP: streamed probes are timed; a fast engine's matrix samples are all refused", async (t) => {
  const dir = tmpDir(t);
  const fx = await startSseFixture({ tokens: 30, tokenMs: 1 });
  t.after(() => fx.close());
  const m = new DecodeBenchManager(path.join(dir, "h.json"), path.join(dir, "a.json"));
  const job = m.start({ sparkId: "s", lanIp: "127.0.0.1", port: fx.port, protocol: "hasso-battery-v1" });
  const done = await waitDone(m, job.benchId);
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.config.modelId, "fixture-model");
  assert.equal(fx.requests.length, 25);
  assert.ok(fx.requests.slice(0, 8).every((b) => b.stream === true && b.stream_options?.include_usage === true));
  assert.ok(fx.requests.slice(8).every((b) => !("stream" in b) && b.temperature === 0));
  assert.ok(fx.requests.every((b) => !("chat_template_kwargs" in b) && !("top_p" in b)));
  assert.ok(done.hasso.bench.greedyMedian > 0);
  // Δtok = 0 (the fixture stops at 30 tokens) and Δt ≪ 2 s: every sample refused, none printed.
  assert.equal(done.hasso.matrix.probes.length, 8);
  assert.ok(done.hasso.matrix.probes.every((p) => p.reliable === false && p.tps === null));
  const recs = fromDecodeJob(done, { provenance: provenance() });
  assert.ok(recs.filter((r) => r.settings.case_id.startsWith("hasso.matrix.")).every((r) => r.metrics[0].valid === false));
});

test("cancel keeps what was measured and records a cancelled run", async (t) => {
  const dir = tmpDir(t);
  const m = new DecodeBenchManager(path.join(dir, "h.json"), path.join(dir, "a.json"));
  const engine = fakeEngine();
  let calls = 0;
  let jobRef = null;
  m.hassoImpl = {
    ...engine,
    streamImpl: async (...a) => {
      calls++;
      if (calls === 3) m.cancel("s", jobRef.benchId);
      return engine.streamImpl(...a);
    },
  };
  jobRef = m.start({ sparkId: "s", lanIp: "127.0.0.1", port: 8000, protocol: "hasso-battery-v1", parts: ["bench"] });
  const done = await waitDone(m, jobRef.benchId);
  assert.equal(done.status, "cancelled");
  assert.equal(done.hasso.bench.probes[0].runs.length, 2);
  assert.equal(done.hasso.matrix, null);
  const recs = fromDecodeJob(done, {});
  assert.ok(recs.every((r) => r.run.status === "cancelled"));
  assert.ok(recs.some((r) => r.settings.case_id === "hasso.bench.code"));
});
