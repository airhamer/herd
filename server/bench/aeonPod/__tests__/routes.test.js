import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { BenchResultsStore } from "../../results/store.js";
import { registerAeonPodRoutes } from "../routes.js";
import { upgradeCompare } from "../../upgrade/compare.js";
import { provenance } from "../../results/__tests__/fixtures.js";
import { decodeRun } from "../../upgrade/__tests__/helpers.js";

const load = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const URL_ = "/api/bench-results/import/aeon-pod";

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aeon-pod-routes-"));
  const store = new BenchResultsStore({ path: path.join(dir, "bench-results.json"), log: () => {} });
  const app = express();
  app.use(express.json());
  const asked = [];
  registerAeonPodRoutes(app, {
    store,
    provenanceFor(nodeId, port) {
      asked.push([nodeId, port]);
      if (nodeId !== "spark-a") throw Object.assign(new Error(`Node ${nodeId} not found`), { status: 404 });
      return provenance({ lane: { ...provenance().lane, model_id: "Qwen3-30B-A3B-FP8" } });
    },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body) => {
    const res = await fetch(base + URL_, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { post, store, asked };
}

test("imports a pod run against a node lane; re-import replaces", async (t) => {
  const { post, store, asked } = await start(t);
  const run = load("suite-v4-run.json");
  // The slimmed suite run fits Herd's default 100 kB JSON body limit.
  assert.ok(JSON.stringify({ run }).length < 100_000);
  const first = await post({ run, node_id: "spark-a", port: 8888 });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual(asked, [["spark-a", 8888]]);
  assert.equal(first.body.added, 6);
  assert.equal(first.body.board_status, "not_submitted");
  assert.equal(first.body.pod_trust_tier, "self_reported");
  const rec = store.get("aeon-pod:c74769be8b:overall");
  assert.equal(rec.host.node_id, "spark-a");
  assert.equal(rec.conditions.client_location, "network");

  // A narrower re-import of the same pod run drops the categories it no longer has.
  const narrower = { ...run, results: run.results.filter((x) => x.category === "Math") };
  const again = await post({ run: narrower, node_id: "spark-a", board_status: "self_reported", board_url: "https://aeon-bench.com/r/1" });
  assert.equal(again.status, 200);
  assert.equal(again.body.removed, 4);
  assert.equal(store.list({ run_id: "aeon-pod:c74769be8b" }).total, 2);
  assert.equal(store.get("aeon-pod:c74769be8b:math").settings.aeon_pod.board_status, "self_reported");
});

test("dry run, bad node, bad port, bad body", async (t) => {
  const { post, store } = await start(t);
  const dry = await post({ run: load("perf-v1-run.json"), dry_run: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.records.length, 12);
  assert.equal(store.byId.size, 0);
  assert.equal((await post({ run: load("perf-v1-run.json"), node_id: "nope" })).status, 404);
  assert.equal((await post({ run: load("perf-v1-run.json"), port: 0 })).status, 400);
  assert.equal((await post({ run: load("perf-v1-run.json"), client_location: "moon" })).status, 400);
  assert.equal((await post({ run: load("perf-v1-run.json"), board_status: "attested" })).status, 400);
  assert.equal((await post([])).status, 400);
  assert.equal((await post({ run: { id: "x", suite_id: "aeon-suite-v4", results: "no" } })).status, 400);
});

test("two pod text runs compare as quality in Upgrade worth it?", async (t) => {
  const { post, store } = await start(t);
  const base = load("suite-v4-run.json");
  const cand = { ...base, id: "c74769be8c", started_at: base.started_at + 86400, finished_at: base.finished_at + 86400 };
  cand.results = base.results.map((x, i) => (x.category === "Math" && i % 2 === 0 ? { ...x, score: 1 } : x));
  assert.equal((await post({ run: base, node_id: "spark-a" })).status, 201);
  assert.equal((await post({ run: cand, node_id: "spark-a" })).status, 201);
  const out = upgradeCompare(store, { baseline: "aeon-pod:c74769be8b", candidate: "aeon-pod:c74769be8c" });
  const math = out.quality.find((q) => q.cell === "math");
  assert.ok(math, JSON.stringify(out.quality.map((q) => q.cell)));
  assert.equal(math.baseline_pct, 0);
  assert.ok(math.candidate_pct > 0);
  assert.equal(out.throughput.length, 0);
});

test("pod perf runs pair with DecodeBench runs; suites must match", async (t) => {
  const { post, store } = await start(t);
  const base = load("perf-v1-run.json");
  const cand = {
    ...base,
    id: "85994d5f24",
    started_at: base.started_at + 86400,
    finished_at: base.finished_at + 86400,
    results: base.results.map((x) => ({ ...x, evidence: { ...x.evidence, agg_decode_tps: x.evidence.agg_decode_tps * 1.3 } })),
  };
  assert.equal((await post({ run: base, node_id: "spark-a" })).status, 201);
  assert.equal((await post({ run: cand, node_id: "spark-a" })).status, 201);
  const out = upgradeCompare(store, { baseline: "aeon-pod:85994d5f23", candidate: "aeon-pod:85994d5f24" });
  const overall = out.throughput.find((r) => r.cell === "perf.direct.overall.c4");
  assert.equal(overall.metric, "agg_window_tps");
  assert.equal(overall.delta_pct, 30);

  store.upsertMany(decodeRun("plain", { day: 3 }));
  const mixed = upgradeCompare(store, { baseline: "aeon-pod:85994d5f23", candidate: "decode:plain" });
  assert.equal(mixed.verdict.code, "refused");
  assert.ok(mixed.verdict.reasons.some((r) => /^DecodeBench: .*suite/.test(r)), JSON.stringify(mixed.verdict.reasons));
});
