/**
 * DecodeBench `protocol: "aeon-perf-v1"` end to end against a streaming
 * fixture (#43): AEON's exact requests, the ladder, and both aggregates
 * landing in the bench results store under distinct metrics/definitions.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { DecodeBenchManager, DECODE_BENCH_DEFAULTS, decodeBudgetArgs, runAeonLevel } from "../DecodeBench.js";
import { AEON_CATEGORIES, AEON_PROMPTS } from "../aeonPerf.js";
import { startSseFixture } from "./sseFixture.js";
import { BenchResultsStore } from "../../bench/results/store.js";
import { createResultsRecorder } from "../../bench/results/recorder.js";
import { fromDecodeJob } from "../../bench/results/adapters.js";
import { validateResult } from "../../bench/results/schema.js";
import { getDefinition } from "../../bench/results/definitions.js";
import { provenance } from "../../bench/results/__tests__/fixtures.js";
import { validateDecodeBudget } from "../../validate.js";

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decode-aeon-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(t, opts) {
  const fx = await startSseFixture(opts);
  t.after(() => fx.close());
  return fx;
}

async function waitDone(m, benchId) {
  for (let i = 0; i < 3000 && m.getJob(benchId)?.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return m.getJob(benchId);
}

test("start validates the AEON protocol options", (t) => {
  const dir = tmpDir(t);
  const m = new DecodeBenchManager(path.join(dir, "h.json"), path.join(dir, "a.json"));
  assert.throws(() => m.start({ sparkId: "s", lanIp: "127.0.0.1", port: 1, protocol: "nope" }), /protocol must be/);
  assert.throws(
    () => m.start({ sparkId: "s", lanIp: "127.0.0.1", port: 1, protocol: "aeon-perf-v1", concurrencies: [2] }),
    /AEON ladder level/
  );
  assert.throws(
    () => m.start({ sparkId: "s", lanIp: "127.0.0.1", port: 1, protocol: "aeon-perf-v1", maxTokens: 400 }),
    /256 max tokens/
  );
  assert.equal(m.activeCount(), 0);
  assert.deepEqual(DECODE_BENCH_DEFAULTS.aeon.ladder, [1, 4, 8, 16, 32]);
  assert.equal(DECODE_BENCH_DEFAULTS.aeon.requests, 320);
});

test("budget: the full AEON ladder fits; herd budget unchanged", () => {
  const [units, maxTokens] = decodeBudgetArgs({ protocol: "aeon-perf-v1" });
  assert.deepEqual(units, [20, 20, 40, 80, 160]);
  assert.equal(maxTokens, 256);
  assert.equal(validateDecodeBudget(units, maxTokens), 320 * 256);
  assert.deepEqual(decodeBudgetArgs({ concurrencies: [1, 2], maxTokens: 100 }), [[1, 2], 100]);
});

test("runAeonLevel sends AEON's exact requests in waves of conc", async () => {
  const calls = [];
  let inFlight = 0;
  let peak = 0;
  const requestImpl = async (url, body) => {
    calls.push({ url, body });
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    const t0 = calls.length * 1000;
    return { ttftMs: 100, decodeTps: 50, prefillTokens: 300, completionTokens: 256, totalMs: 5200, t0, tFirst: t0 + 100, tLast: t0 + 5200, model: "m" };
  };
  const seen = [];
  const { level, wave } = await runAeonLevel({
    baseUrl: "http://127.0.0.1:9",
    modelId: "m",
    conc: 8,
    nonce: "n0nce1",
    requestImpl,
    onCategory: (c) => seen.push(c),
  });
  assert.deepEqual(seen, [...AEON_CATEGORIES]);
  assert.equal(calls.length, 5 * 8);
  assert.equal(peak, 8);
  assert.ok(calls.every((c) => c.url === "http://127.0.0.1:9/v1/chat/completions"));
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["max_tokens", "messages", "model", "stream", "stream_options", "temperature"]);
  assert.equal(calls[0].body.max_tokens, 256);
  assert.equal(calls[0].body.temperature, 0);
  assert.equal(calls[3].body.messages[0].content, `[measurement n0nce1-c8-Mat-0003] ${AEON_PROMPTS.Math[3]}`);
  assert.equal(level.conc, 8);
  assert.equal(Object.keys(level.categories).length, 5);
  assert.equal(level.categories.Math.case_id, "perf.direct.math.c8");
  assert.equal(level.overall.case_id, "perf.direct.overall.c8");
  assert.equal(level.overall.agg_source, "peak_category_cell");
  assert.equal(level.overall.agg_saturated_est, 400);
  assert.equal(wave.aggregateDecodeTps, level.overall.agg_decode_tps);
  assert.equal(wave.aggSumDecodeTps, 400);
  assert.equal(wave.streamsOk, 40);
});

test("AEON ladder end to end: results store gets both aggregates per cell", async (t) => {
  const dir = tmpDir(t);
  const fx = await fixture(t, { tokens: 12, tokenMs: 1 });
  const store = new BenchResultsStore({ path: path.join(dir, "r.json"), log: () => {} });
  const recorder = createResultsRecorder({ store });
  const m = new DecodeBenchManager(path.join(dir, "h.json"), path.join(dir, "a.json"));
  m.resultSink = recorder.sinkFor("DecodeBench");

  const job = m.start({
    sparkId: "node:n1",
    nodeId: "n1",
    lanIp: "127.0.0.1",
    port: fx.port,
    modelId: "fixture-model",
    protocol: "aeon-perf-v1",
    concurrencies: [4, 1],
    nonce: "abc123",
  });
  assert.deepEqual(job.config.concurrencies, [1, 4]);
  assert.equal(job.config.maxTokens, 256);
  assert.equal(job.config.protocol, "aeon-perf-v1");
  recorder.noteStart("DecodeBench", job.benchId, provenance({ host: { ...provenance().host, node_id: "n1" } }));
  const done = await waitDone(m, job.benchId);
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.nodeId, "n1");

  // No warmup: exactly 5 × 4 (c1) + 5 × 4 (c4) requests, all AEON-shaped.
  assert.equal(fx.requests.length, 40);
  assert.ok(fx.requests.every((b) => b.max_tokens === 256 && b.temperature === 0 && b.stream === true));
  assert.ok(fx.requests.every((b) => b.stream_options?.include_usage === true && !("top_p" in b) && !("ignore_eos" in b)));
  assert.equal(done.progress.requestsDone, 40);
  assert.equal(done.aeon.levels.length, 2);
  assert.equal(done.results.length, 2);

  const records = store.list({ run_id: `decode:${job.benchId}`, limit: 500 }).results;
  assert.equal(records.length, 2 * 6);
  const ids = records.map((r) => r.id.split(":").pop()).sort();
  assert.ok(ids.includes("perf.direct.coding.c4"));
  assert.ok(ids.includes("perf.direct.overall.c1"));
  for (const r of records) {
    assert.deepEqual(validateResult(r), { ok: true, errors: [] });
    assert.equal(r.run.suite, "aeon-perf-v1");
    assert.equal(r.host.node_id, "n1");
    assert.equal(r.conditions.max_tokens, 256);
    assert.equal(r.conditions.temperature, 0);
    const win = r.metrics.find((x) => x.metric === "agg_window_tps");
    const sum = r.metrics.find((x) => x.metric === "agg_sum_tps");
    assert.equal(win.definition, "aeon.wave_peak_concurrent_window.v1");
    assert.equal(sum.definition, "aeon.agg_saturated_est.v1");
    assert.notEqual(getDefinition(win.definition).comparable, getDefinition(sum.definition).comparable);
    assert.ok(win.value > 0 && sum.value > 0);
  }
  const c4 = records.find((r) => r.id.endsWith("perf.direct.overall.c4"));
  assert.equal(c4.settings.agg_source, "peak_category_cell");
  assert.equal(c4.conditions.prompt_set, "aeon-perf-v1/overall");

  // Deterministic conversion: same job → same records.
  assert.deepEqual(
    fromDecodeJob(done, { provenance: provenance(), recordedAt: "2026-01-01T00:00:00Z" }),
    fromDecodeJob(done, { provenance: provenance(), recordedAt: "2026-01-01T00:00:00Z" })
  );
});

test("AEON errors make the run partial and are counted per cell", async (t) => {
  const dir = tmpDir(t);
  const fx = await fixture(t, { tokens: 6, tokenMs: 1, failEvery: 5 });
  const m = new DecodeBenchManager(path.join(dir, "h.json"), path.join(dir, "a.json"));
  const job = m.start({ sparkId: "s", lanIp: "127.0.0.1", port: fx.port, protocol: "aeon-perf-v1", concurrencies: [1] });
  const done = await waitDone(m, job.benchId);
  assert.equal(done.status, "completed");
  const overall = done.aeon.levels[0].overall;
  assert.equal(overall.n_errors, 4);
  assert.equal(overall.n, 16);
  const recs = fromDecodeJob(done, { provenance: provenance() });
  assert.ok(recs.every((r) => r.run.status === "partial"));
});
