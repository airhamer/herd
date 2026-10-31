import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { BenchResultsStore } from "../store.js";
import { registerBenchResultsRoutes } from "../routes.js";
import { fromDecodeJob } from "../adapters.js";
import { decodeJob, provenance, referenceRecord } from "./fixtures.js";

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-results-routes-"));
  const store = new BenchResultsStore({ path: path.join(dir, "bench-results.json"), log: () => {} });
  store.upsertMany(fromDecodeJob(decodeJob(), { provenance: provenance() }));
  const app = express();
  app.use(express.json());
  registerBenchResultsRoutes(app, { store });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { call, store };
}

test("GET list, filters and bad filters", async (t) => {
  const { call } = await start(t);
  const all = await call("GET", "/api/bench-results");
  assert.equal(all.status, 200);
  assert.equal(all.body.schema_version, 1);
  assert.equal(all.body.total, 2);
  const c4 = await call("GET", "/api/bench-results?concurrency=4&metric=agg_window_tps");
  assert.deepEqual(c4.body.results.map((r) => r.id), ["decode:bench-1:c4"]);
  const bad = await call("GET", "/api/bench-results?since=whenever");
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /since/);
});

test("GET definitions catalog", async (t) => {
  const { call } = await start(t);
  const res = await call("GET", "/api/bench-results/definitions");
  assert.equal(res.status, 200);
  assert.ok(res.body.definitions.some((d) => d.name === "mia.agg_sum_per_request.v1"));
  assert.equal(res.body.sources.counter.tier, 1);
  assert.deepEqual(res.body.origins, ["herd", "reference", "aeon-pod"]);
});

test("GET one result; 404 when unknown", async (t) => {
  const { call } = await start(t);
  const ok = await call("GET", `/api/bench-results/${encodeURIComponent("decode:bench-1:c1")}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.conditions.concurrency, 1);
  assert.equal((await call("GET", "/api/bench-results/nope")).status, 404);
});

test("POST a reference result, then update it; herd origin and invalid bodies are refused", async (t) => {
  const { call, store } = await start(t);
  const { id: _id, ...body } = referenceRecord();
  const created = await call("POST", "/api/bench-results", body);
  assert.equal(created.status, 201);
  assert.equal(created.body.id, "reference:aeon-188");
  assert.equal(created.body.lane.quant, null, "unknowns filled as null");
  assert.equal(store.size, 3);
  const updated = await call("POST", "/api/bench-results", body);
  assert.equal(updated.status, 200);

  const herdBody = { ...body, run: { ...body.run, origin: "herd" } };
  assert.equal((await call("POST", "/api/bench-results", herdBody)).status, 400);

  const noDef = { ...body, metrics: [{ metric: "agg_window_tps", value: 1, source: "reference" }] };
  const bad = await call("POST", "/api/bench-results", noDef);
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.some((e) => /registered definition/.test(e)));

  assert.equal((await call("POST", "/api/bench-results", [1, 2])).status, 400);
});

test("GET compare: like-with-like rows, refusals as comparable:false", async (t) => {
  const { call } = await start(t);
  await call("POST", "/api/bench-results", referenceRecord());
  const ok = await call("GET", "/api/bench-results/compare?baseline=reference%3Aaeon-188&candidate=decode%3Abench-1%3Ac4");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.comparable, true);
  assert.ok(ok.body.rows.find((r) => r.metric === "agg_window_tps"));
  const refused = await call("GET", "/api/bench-results/compare?baseline=decode%3Abench-1%3Ac1&candidate=decode%3Abench-1%3Ac4");
  assert.equal(refused.status, 200);
  assert.equal(refused.body.comparable, false);
  assert.match(refused.body.reasons.join(), /concurrency differs/);
  assert.equal((await call("GET", "/api/bench-results/compare?baseline=x")).status, 400);
  assert.equal((await call("GET", "/api/bench-results/compare?baseline=x&candidate=y")).status, 404);
});

test("DELETE one result", async (t) => {
  const { call, store } = await start(t);
  assert.equal((await call("DELETE", `/api/bench-results/${encodeURIComponent("decode:bench-1:c1")}`)).status, 204);
  assert.equal(store.size, 1);
  assert.equal((await call("DELETE", "/api/bench-results/nope")).status, 404);
});
