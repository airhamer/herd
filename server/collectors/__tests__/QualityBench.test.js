/**
 * QualityBench manager against a deterministic fixture model (#42).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import {
  MAX_CONSECUTIVE_ERRORS,
  QualityBenchManager,
  askChat,
  compareQualityRecords,
  summarize,
  timeoutMsForItem,
} from "../QualityBench.js";
import { startQualityFixture } from "./qualityFixture.js";
import { BenchResultsStore } from "../../bench/results/store.js";
import { createResultsRecorder } from "../../bench/results/recorder.js";
import { fromQualityJob } from "../../bench/results/adapters.js";
import { compareResults, validateResult } from "../../bench/results/schema.js";
import { provenance } from "../../bench/results/__tests__/fixtures.js";

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quality-bench-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new BenchResultsStore({ path: path.join(dir, "bench-results.json"), log: () => {} });
}

async function fixture(t, opts) {
  const fx = await startQualityFixture(opts);
  t.after(() => fx.close());
  return fx;
}

function wire(store) {
  const m = new QualityBenchManager();
  const recorder = createResultsRecorder({ store });
  m.resultSink = recorder.sinkFor("QualityBench");
  m.store = store;
  return { m, recorder };
}

async function run(m, recorder, opts) {
  const job = m.start({ sparkId: "spark-a", lanIp: "127.0.0.1", modelId: "fixture-model", ...opts });
  recorder?.noteStart("QualityBench", job.benchId, provenance());
  for (let i = 0; i < 2000 && m.getJob(job.benchId)?.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return m.getJob(job.benchId, { items: true });
}

test("start validates categories, concurrency and port", () => {
  const m = new QualityBenchManager();
  assert.throws(() => m.start({ sparkId: "s", lanIp: "x", port: 1, categories: ["nope"] }), /at least one/);
  assert.throws(() => m.start({ sparkId: "s", lanIp: "x", port: 1, concurrency: 3 }), /Concurrency/);
  assert.throws(() => m.start({ sparkId: "s", lanIp: "x", port: 0 }), /Invalid LLM port/);
  assert.equal(m.activeCount(), 0);
});

test("timeouts scale with output and prompt size, capped at 10 min", () => {
  assert.equal(timeoutMsForItem({ prompt: "", maxTokens: 48 }), 69_600);
  assert.ok(timeoutMsForItem({ prompt: "x".repeat(65536), maxTokens: 24 }) > timeoutMsForItem({ prompt: "x", maxTokens: 24 }));
  assert.equal(timeoutMsForItem({ prompt: "x".repeat(10_000_000), maxTokens: 24 }), 600_000);
});

test("requests are greedy, seeded, non-streaming, thinking off", async (t) => {
  const fx = await fixture(t, { skill: 1000 });
  const res = await askChat({
    baseUrl: `http://127.0.0.1:${fx.port}`,
    modelId: "fixture-model",
    item: { prompt: "What is the capital city of France? Reply with the answer only.", maxTokens: 48 },
    signal: new AbortController().signal,
  });
  assert.equal(res.error, null);
  assert.match(res.text, /Paris/);
  const body = fx.requests[0];
  assert.equal(body.temperature, 0);
  assert.equal(body.top_p, 1);
  assert.equal(body.seed, 4242);
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 48);
  assert.equal(body.chat_template_kwargs.enable_thinking, false);
});

test("deterministic on a fixture model: same vector, run after run", async (t) => {
  const fx = await fixture(t);
  const store = tmpStore(t);
  const { m, recorder } = wire(store);
  const a = await run(m, recorder, { port: fx.port, concurrency: 8 });
  const b = await run(m, recorder, { port: fx.port, concurrency: 2 });
  assert.equal(a.status, "completed");
  assert.equal(b.status, "completed");
  assert.equal(fx.requests.length, 2 * 755);
  assert.equal(a.items.length, 755);
  assert.deepEqual(
    a.items.map((it) => [it.id, it.pass]),
    b.items.map((it) => [it.id, it.pass])
  );
  assert.deepEqual(a.summary, b.summary);
  // Overall = mean of category %.
  const cats = a.summary.categories;
  assert.equal(cats.length, 6);
  const mean = cats.reduce((s, c) => s + c.accuracy, 0) / cats.length;
  assert.ok(Math.abs(a.summary.overall - mean) < 0.01);
  assert.ok(a.summary.overall > 50 && a.summary.overall < 90, String(a.summary.overall));

  // Stored: per-category + overall records with item vectors, history lists both.
  await recorder.flush?.();
  const recs = store.list({ bench: "QualityBench", limit: 1000 }).results;
  assert.equal(recs.length, 14);
  for (const r of recs) assert.deepEqual(validateResult(r).errors, []);
  const overall = store.get(`quality:${a.benchId}`);
  assert.equal(overall.quality.items.length, 755);
  assert.equal(overall.raw.items.length, 755);
  assert.equal(overall.conditions.prompt_set, "quality/overall:qa+reasoning+arithmetic+state+gsm8k+mmlu");
  const mmlu = store.get(`quality:${a.benchId}:mmlu`);
  assert.equal(mmlu.quality.items.length, 285);
  assert.equal(mmlu.metrics[0].definition, "herd.quality.item_pass_rate.v1");
  const history = m.history("spark-a");
  assert.deepEqual(history.map((h) => h.benchId).sort(), [a.benchId, b.benchId].sort());

  // Same vectors: McNemar finds nothing; concurrency difference is a warning.
  const cmp = m.compare("spark-a", a.benchId, b.benchId);
  assert.equal(cmp.overall.mcnemar.paired, 755);
  assert.equal(cmp.overall.mcnemar.p, 1);
  assert.equal(cmp.overall.mcnemar.within_noise, true);
  assert.deepEqual(cmp.regressed, []);
  assert.match(cmp.warnings.join(), /concurrency differs/);
  assert.throws(() => m.compare("spark-a", a.benchId, "missing"), (e) => e.status === 404);
  assert.throws(() => m.compare("spark-b", a.benchId, b.benchId), (e) => e.status === 404);

  // Generic BENCH1 compare carries McNemar for records with item vectors.
  const generic = compareResults(store.get(`quality:${a.benchId}:qa`), store.get(`quality:${a.benchId}:qa`));
  assert.equal(generic.quality.paired, 150);
});

test("a different model is flagged by McNemar", async (t) => {
  const good = await fixture(t, { skill: 900 });
  const weak = await fixture(t, { skill: 500 });
  const store = tmpStore(t);
  const { m, recorder } = wire(store);
  const a = await run(m, recorder, { port: weak.port, categories: ["qa", "mmlu"], concurrency: 8 });
  const b = await run(m, recorder, { port: good.port, categories: ["mmlu", "qa"], concurrency: 8 });
  assert.deepEqual(b.config.categories, ["qa", "mmlu"]);
  const cmp = m.compare("spark-a", a.benchId, b.benchId);
  assert.ok(cmp.overall.delta > 20);
  assert.equal(cmp.overall.mcnemar.within_noise, false);
  assert.ok(cmp.overall.mcnemar.p < 1e-6);
  assert.ok(cmp.improved.length > cmp.regressed.length);
  assert.deepEqual(cmp.categories.map((c) => c.key), ["qa", "mmlu"]);
  for (const c of cmp.categories) assert.equal(c.mcnemar.within_noise, false, c.key);
  assert.deepEqual(cmp.warnings, []);
});

test("request errors are unscored (pass: null) and mark the run partial", async (t) => {
  const fx = await fixture(t, { failIds: new Set(["qa-002", "qa-010"]) });
  const store = tmpStore(t);
  const { m, recorder } = wire(store);
  const job = await run(m, recorder, { port: fx.port, categories: ["qa"], concurrency: 1 });
  assert.equal(job.status, "completed");
  assert.equal(job.summary.itemsErrored, 2);
  assert.equal(job.summary.categories[0].scored, 148);
  const row = job.items.find((it) => it.id === "qa-002");
  assert.equal(row.pass, null);
  assert.match(row.error, /HTTP 500/);
  const rec = store.get(`quality:${job.benchId}`);
  assert.equal(rec.run.status, "partial");
  assert.equal(rec.quality.items.find((it) => it.id === "qa-010").pass, null);
});

test("an unreachable endpoint fails fast after consecutive errors", async (t) => {
  const fx = await fixture(t);
  const port = fx.port;
  await fx.close();
  const m = new QualityBenchManager();
  const records = [];
  m.resultSink = (r) => records.push(r);
  const job = await run(m, null, { port, categories: ["qa"], concurrency: 1 });
  assert.equal(job.status, "failed");
  assert.match(job.error, new RegExp(`${MAX_CONSECUTIVE_ERRORS} failed requests`));
  assert.equal(job.progress.done, MAX_CONSECUTIVE_ERRORS);
  assert.equal(records.length, 1);
  // Unattempted items are not stored.
  assert.equal(fromQualityJob(records[0]).at(-1).quality.items.length, MAX_CONSECUTIVE_ERRORS);
});

test("cancel and per-Spark mutex", async (t) => {
  const fx = await fixture(t, { delayMs: 20 });
  const m = new QualityBenchManager();
  const records = [];
  m.resultSink = (r) => records.push(r);
  const job = m.start({ sparkId: "spark-a", lanIp: "127.0.0.1", port: fx.port, concurrency: 1 });
  assert.throws(() => m.start({ sparkId: "spark-a", lanIp: "127.0.0.1", port: fx.port }), (e) => e.status === 409);
  assert.equal(m.activeCount(), 1);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(m.cancel("spark-b", job.benchId), null);
  m.cancel("spark-a", job.benchId);
  for (let i = 0; i < 200 && m.activeCount(); i++) await new Promise((r) => setTimeout(r, 10));
  const done = m.getJob(job.benchId);
  assert.equal(done.status, "cancelled");
  assert.ok(done.progress.done > 0 && done.progress.done < 755);
  assert.equal(records.length, 1);
  const recs = fromQualityJob(records[0], { provenance: provenance() });
  assert.equal(recs.at(-1).run.status, "cancelled");
  for (const r of recs) assert.deepEqual(validateResult(r).errors, []);
});

test("interruptAll finalizes running jobs once", async (t) => {
  const fx = await fixture(t, { delayMs: 50 });
  const m = new QualityBenchManager();
  const records = [];
  m.resultSink = (r) => records.push(r);
  const job = m.start({ sparkId: "spark-a", lanIp: "127.0.0.1", port: fx.port, concurrency: 1, categories: ["qa"] });
  m.interruptAll("bye");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(m.getJob(job.benchId).status, "interrupted");
  assert.equal(m.activeCount(), 0);
  assert.equal(records.length, 1);
});

test("summarize: mean of category %, errored items excluded", () => {
  const items = [
    { category: "qa", pass: true, attempted: true },
    { category: "qa", pass: false, attempted: true },
    { category: "qa", pass: null, attempted: true },
    { category: "mmlu", pass: true, attempted: true },
    { category: "mmlu", pass: null, attempted: false },
  ];
  const s = summarize(["qa", "mmlu"], items);
  assert.equal(s.categories[0].accuracy, 50);
  assert.equal(s.categories[0].errored, 1);
  assert.equal(s.categories[1].accuracy, 100);
  assert.equal(s.categories[1].errored, 0);
  assert.equal(s.overall, 75);
  assert.equal(s.itemsScored, 3);
  assert.equal(s.passed, 2);
});

test("compareQualityRecords only compares shared categories", () => {
  const job = (benchId, cats, passFn) => {
    const items = [];
    for (const c of cats) for (let i = 1; i <= 10; i++) items.push({ id: `${c}-${i}`, category: c, attempted: true, pass: passFn(c, i) });
    return { benchId, sparkId: "spark-a", status: "completed", startedAt: 1, completedAt: 2, config: { categories: cats, concurrency: 4 }, summary: summarize(cats, items), items };
  };
  const recsA = fromQualityJob(job("a", ["qa", "state"], () => true), { provenance: provenance() });
  const recsB = fromQualityJob(job("b", ["qa", "mmlu"], (c, i) => i > 3), { provenance: provenance() });
  const byId = new Map([...recsA, ...recsB].map((r) => [r.id, r]));
  const cmp = compareQualityRecords(byId.get("quality:a"), byId.get("quality:b"), (id) => byId.get(id));
  assert.deepEqual(cmp.categories.map((c) => c.key), ["qa"]);
  assert.equal(cmp.overall.mcnemar.paired, 10);
  assert.equal(cmp.overall.mcnemar.baseline_only, 3);
  assert.deepEqual(cmp.regressed, ["qa-1", "qa-2", "qa-3"]);
  assert.match(cmp.warnings.join(), /categories differ/);
});
