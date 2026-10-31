import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { BenchResultsStore } from "../../results/store.js";
import { registerBenchResultsRoutes } from "../../results/routes.js";
import { decodeRun, passes, qualityRun } from "./helpers.js";

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-upgrade-routes-"));
  const store = new BenchResultsStore({ path: path.join(dir, "bench-results.json"), log: () => {} });
  store.upsertMany(decodeRun("b1", { c1: 50, c4: 180 }));
  store.upsertMany(decodeRun("b2", { c1: 61, c4: 222, day: 2 }));
  store.upsertMany(decodeRun("hw", { hw: "2× DGX Spark", day: 3 }));
  store.upsertMany(qualityRun("q1", { gsm8k: passes(20, 10) }));
  const app = express();
  registerBenchResultsRoutes(app, { store, energyWindow: () => null });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (url) => {
    const res = await fetch(base + url);
    return { status: res.status, body: await res.json() };
  };
}

test("GET /api/bench-results/upgrade/runs groups records by run", async (t) => {
  const get = await start(t);
  const res = await get("/api/bench-results/upgrade/runs");
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 4);
  assert.deepEqual(res.body.runs.map((r) => r.run_id), ["decode:hw", "decode:b2", "quality:q1", "decode:b1"]);
  const b1 = res.body.runs.find((r) => r.run_id === "decode:b1");
  assert.deepEqual([b1.bench, b1.cells, b1.concurrencies, b1.hw_bucket], ["DecodeBench", 2, [1, 4], "Single DGX Spark"]);
  const filtered = await get("/api/bench-results/upgrade/runs?bench=QualityBench");
  assert.deepEqual(filtered.body.runs.map((r) => r.run_id), ["quality:q1"]);
  assert.equal((await get("/api/bench-results/upgrade/runs?limit=0")).status, 400);
});

test("GET /api/bench-results/upgrade returns a verdict, a refusal, or an error", async (t) => {
  const get = await start(t);
  const win = await get("/api/bench-results/upgrade?baseline=decode:b1&candidate=decode:b2");
  assert.equal(win.status, 200);
  assert.equal(win.body.verdict.code, "worth_it");
  assert.deepEqual(win.body.throughput.map((c) => c.delta_pct), [22, 23.33]);

  const refused = await get("/api/bench-results/upgrade?baseline=decode:b1&candidate=decode:hw");
  assert.equal(refused.status, 200);
  assert.equal(refused.body.comparable, false);
  assert.match(refused.body.verdict.reasons[0], /hw_bucket differs/);

  assert.equal((await get("/api/bench-results/upgrade?baseline=decode:b1")).status, 400);
  const missing = await get("/api/bench-results/upgrade?baseline=decode:b1&candidate=decode:zz");
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /unknown run decode:zz/);
});

test("/upgrade is not read as a result id", async (t) => {
  const get = await start(t);
  const res = await get("/api/bench-results/upgrade");
  assert.equal(res.status, 400);
  assert.match(res.body.error, /baseline and candidate run ids are required/);
});
