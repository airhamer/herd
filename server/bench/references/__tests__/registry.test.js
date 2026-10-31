import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import {
  readRegistry,
  validateRegistry,
  registryRecords,
  syncRegistryIntoStore,
  seedReferenceRegistry,
  isRegistryId,
  referenceRecordId,
  REGISTRY_ID_PREFIX,
} from "../loader.js";
import { nearestReferences } from "../nearest.js";
import { BenchResultsStore } from "../../results/store.js";
import { registerBenchResultsRoutes } from "../../results/routes.js";
import { validateResult, compareResults } from "../../results/schema.js";
import { getDefinition, definitionsComparable } from "../../results/definitions.js";
import { fromDecodeJob, fromPrefillJob } from "../../results/adapters.js";
import { decodeJob, prefillJob, provenance } from "../../results/__tests__/fixtures.js";

const AT = "2026-10-31T12:00:00.000Z";
const doc = () => readRegistry();
const records = () => registryRecords(doc(), { recordedAt: AT });
const byId = (id) => records().find((r) => r.id === id);
const clone = (v) => JSON.parse(JSON.stringify(v));

function tmpStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-refs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "bench-results.json");
  return { file, open: () => new BenchResultsStore({ path: file, log: () => {} }) };
}

function herdRecords() {
  return [
    ...fromDecodeJob(decodeJob(), { provenance: provenance() }),
    ...fromPrefillJob(prefillJob(), { provenance: provenance() }),
  ];
}

/** value lookup: figure id -> { definition: value } */
function figures() {
  const out = {};
  for (const r of records()) {
    out[r.id.slice(REGISTRY_ID_PREFIX.length)] = Object.fromEntries(r.metrics.map((m) => [m.definition, m.value]));
  }
  return out;
}

test("the shipped registry validates and yields the 23 seed figures", () => {
  assert.deepEqual(validateRegistry(doc()), []);
  const recs = records();
  assert.equal(recs.length, 23);
  assert.equal(new Set(recs.map((r) => r.id)).size, 23, "ids are unique");
  for (const r of recs) assert.deepEqual(validateResult(r).errors, [], r.id);
});

test("every seed row has its URL and a registered, non-Herd definition with a formula", () => {
  for (const r of records()) {
    assert.match(r.run.reference_url, /^https:\/\/github\.com\//, r.id);
    assert.equal(r.settings.reference.url, r.run.reference_url);
    for (const m of r.metrics) {
      const def = getDefinition(m.definition);
      assert.ok(def, `${r.id}: ${m.definition}`);
      assert.notEqual(def.owner, "herd", `${r.id}: ${m.definition}`);
      assert.ok(def.formula.length > 20);
      assert.equal(def.metric, m.metric);
    }
  }
  // Each source's definition, as the issue states it.
  const defs = (prefix) => new Set(records().filter((r) => r.id.includes(prefix)).flatMap((r) => r.metrics.map((m) => m.definition)));
  assert.ok(defs(":mia-glm").has("mia.agg_sum_per_request.v1"));
  assert.ok(defs(":mia-qwen").has("mia.agg_sum_per_request.v1"));
  assert.ok(defs(":hasso-qwen3.8-27b").has("hasso.single_stream_greedy_median.v1"));
  assert.equal(getDefinition("aeon.agg_tokens_per_cell_wall.v1").comparable, "tokens_per_cell_wall");
  assert.equal(
    byId(referenceRecordId("aeon-peak16-c8-definition-gap", "c8")).settings.locked_definition,
    "aeon.wave_peak_concurrent_window.v1"
  );
});

test("the seed figures are the plan's exact numbers", () => {
  const f = figures();
  const mia = "mia.agg_sum_per_request.v1";
  const glm = "mia-glm-5.3-flash-exl3-2x-spark";
  assert.deepEqual(
    [f[`${glm}:decode.prose.c1`][mia], f[`${glm}:decode.prose.c4`][mia], f[`${glm}:decode.structured.c1`][mia], f[`${glm}:decode.structured.c4`][mia]],
    [60.4, 108.8, 114.7, 227.9]
  );
  assert.equal(f[`${glm}:prefill.8219`]["mia.sparkdash_prefill.v1"], 1952.2);
  assert.equal(byId(referenceRecordId(glm, "prefill.8219")).conditions.context_tokens, 8219);
  assert.equal(f[`${glm}:quality.gsm8k`]["reference.accuracy_published.v1"], 98.8);
  assert.equal(byId(referenceRecordId(glm, "quality.gsm8k")).metrics[0].n, 250);
  assert.equal(f[`${glm}:quality.humaneval`]["reference.accuracy_published.v1"], 95.7);
  const qw = "mia-qwen3.8-flash-next-fp4-1x-spark";
  assert.deepEqual(
    [f[`${qw}:decode.prose.c1`][mia], f[`${qw}:decode.prose.c5`][mia], f[`${qw}:decode.code.c1`][mia], f[`${qw}:decode.code.c5`][mia]],
    [55.6, 156.1, 110.5, 217.6]
  );
  assert.equal(f[`${qw}:prefill.4134`]["mia.sparkdash_prefill.v1"], 3050);
  assert.equal(byId(referenceRecordId(qw, "prefill.4134")).lane.engine_version, "v1.1.4");
  const h = "hasso-qwen3.8-27b-nvfp4-dflash2-gx10";
  assert.equal(f[`${h}:bench.greedy_median`]["hasso.single_stream_greedy_median.v1"], 71.4);
  assert.equal(byId(referenceRecordId(h, "bench.greedy_median")).run.suite_version, "v1.14.0");
  assert.equal(f[`${h}:quality.gsm8k`]["reference.accuracy_published.v1"], 94.0);
  assert.equal(byId(referenceRecordId(h, "quality.gsm8k")).metrics[0].n, 200);
  const k = "hasso-kolibri-1-fp8-vllm-gx10";
  assert.deepEqual(
    [1, 4, 8, 16].map((c) => f[`${k}:decode.c${c}`]["hasso.vllm_bench_serve_output.v1"]),
    [48.0, 121.9, 165.8, 202.0]
  );
  const o = "hasso-ornith-1.5-122b-nvfp4-vllm-gx10";
  assert.deepEqual([1, 4, 8].map((c) => f[`${o}:decode.c${c}`]["hasso.real_jobs_in_all.v1"]), [41.2, 68.1, 90.0]);
  assert.equal(f[`${o}:quality.gsm8k`]["reference.accuracy_published.v1"], 98.8);
  assert.equal(byId(referenceRecordId(o, "quality.gsm8k")).metrics[0].n, 250);
  assert.deepEqual(f["aeon-peak16-c8-definition-gap:c8"], {
    "aeon.decode_tps_mean.v1": 23.55,
    "aeon.agg_saturated_est.v1": 188.4,
    "aeon.agg_tokens_per_cell_wall.v1": 66.66,
  });
  assert.equal(Math.round(23.55 * 8 * 10) / 10, 188.4, "decode mean × 8");
});

test("no reference row is, or can become, a Herd result", () => {
  for (const r of records()) {
    assert.equal(r.run.origin, "reference", r.id);
    assert.ok(isRegistryId(r.id));
    assert.equal(r.host.node_id, null, r.id);
    assert.equal(r.run.bench, "Reference");
    for (const m of r.metrics) {
      assert.equal(m.source, "reference");
      assert.equal(m.tier, null);
    }
    // Relabelled as herd, the schema refuses it.
    const flipped = clone(r);
    flipped.run.origin = "herd";
    const v = validateResult(flipped);
    assert.equal(v.ok, false, r.id);
    assert.ok(v.errors.some((e) => /source "reference" is not allowed on herd results/.test(e)), r.id);
    // And with its rows relabelled too, it still has no Herd node.
    for (const m of flipped.metrics) {
      m.source = "client";
      m.tier = 4;
    }
    assert.ok(validateResult(flipped).errors.includes("host.node_id is required for herd results"), r.id);
  }
});

test("bad registries are refused whole", () => {
  const noUrl = doc();
  delete noUrl.entries[0].url;
  assert.ok(validateRegistry(noUrl).some((e) => /entries\[0\]\.url/.test(e)));
  assert.throws(() => registryRecords(noUrl), /invalid reference registry/);

  const herdDef = doc();
  herdDef.entries[0].figures[0].metrics[0].definition = "herd.decode.agg_sum.v1";
  assert.ok(validateRegistry(herdDef).some((e) => /is a Herd definition/.test(e)));

  const unknownDef = doc();
  unknownDef.entries[1].figures[0].metrics[0].definition = "mia.made_up.v1";
  assert.ok(validateRegistry(unknownDef).some((e) => /registered definition/.test(e)));

  const node = doc();
  node.entries[2].host.node_id = "spark-a";
  assert.ok(validateRegistry(node).some((e) => /node_id is not allowed/.test(e)));

  const dup = doc();
  dup.entries[3].figures[1].key = dup.entries[3].figures[0].key;
  assert.ok(validateRegistry(dup).some((e) => /duplicated/.test(e)));

  const noValue = doc();
  noValue.entries[4].figures[0].metrics[0].value = null;
  assert.ok(validateRegistry(noValue).some((e) => /value must be a number/.test(e)));
});

test("seeding is idempotent, applies edits, drops stale figures and leaves everything else alone", (t) => {
  const { file, open } = tmpStore(t);
  const store = open();
  store.upsertMany(herdRecords());
  store.upsert(
    registryRecords(doc(), { recordedAt: AT }).map((r) => ({ ...clone(r), id: "reference:user-posted" }))[0]
  );
  const before = store.size;

  const first = syncRegistryIntoStore(store, records());
  assert.deepEqual(first, { added: 23, updated: 0, unchanged: 0, removed: 0 });
  assert.equal(store.size, before + 23);
  const mtime = fs.statSync(file).mtimeMs;

  const again = syncRegistryIntoStore(open(), records());
  assert.deepEqual(again, { added: 0, updated: 0, unchanged: 23, removed: 0 });
  assert.equal(fs.statSync(file).mtimeMs, mtime, "no write when nothing changed");

  const edited = doc();
  edited.entries[0].figures[0].metrics[0].value = 61;
  edited.entries[5].figures = edited.entries[5].figures.slice(0); // AEON unchanged
  edited.entries.splice(3, 1); // Kolibri gone (4 figures)
  const s3 = open();
  const res = syncRegistryIntoStore(s3, registryRecords(edited, { recordedAt: "2026-11-01T00:00:00.000Z" }));
  assert.deepEqual(res, { added: 0, updated: 1, unchanged: 18, removed: 4 });
  const glm = s3.get(referenceRecordId("mia-glm-5.3-flash-exl3-2x-spark", "decode.prose.c1"));
  assert.equal(glm.metrics[0].value, 61);
  assert.equal(glm.recorded_at, AT, "first-seen time kept");
  assert.equal(s3.get("reference:user-posted").run.origin, "reference", "user references untouched");
  assert.equal(s3.list({ origin: "herd" }).total, herdRecords().length, "herd results untouched");
});

test("seedReferenceRegistry reads the shipped file", (t) => {
  const { open } = tmpStore(t);
  const out = seedReferenceRegistry(open());
  assert.equal(out.added, 23);
  assert.equal(out.registry.registry_version, 1);
  assert.ok(Array.isArray(out.registry.not_seeded));
});

test("store listings keep reference rows out of Herd results", (t) => {
  const { open } = tmpStore(t);
  const store = open();
  store.upsertMany(herdRecords());
  syncRegistryIntoStore(store, records());
  const herd = store.list({ origin: "herd", limit: 1000 }).results;
  assert.equal(herd.length, herdRecords().length);
  assert.ok(herd.every((r) => !isRegistryId(r.id) && r.run.origin === "herd" && r.metrics.every((m) => m.source !== "reference")));
  for (const bench of ["DecodeBench", "PrefillBench", "Showcase", "QualityBench"]) {
    assert.ok(store.list({ bench, limit: 1000 }).results.every((r) => r.run.origin === "herd"), bench);
  }
  const refs = store.list({ origin: "reference", limit: 1000 }).results;
  assert.equal(refs.length, 23);
  // A Herd result's like-with-like listing never pulls in a registry row
  // (registry suites are the publishers' harnesses, not Herd's).
  for (const r of herd) {
    assert.ok(store.list({ like: r.id, limit: 1000 }).results.every((x) => !isRegistryId(x.id)), r.id);
  }
});

test("definitions published under different names never compare with Herd's own", () => {
  assert.equal(definitionsComparable("herd.decode.agg_window.v1", "hasso.vllm_bench_serve_output.v1"), false);
  assert.equal(definitionsComparable("herd.decode.agg_window.v1", "hasso.real_jobs_in_all.v1"), false);
  assert.equal(definitionsComparable("herd.decode.agg_window.v1", "aeon.agg_tokens_per_cell_wall.v1"), false);
  assert.equal(definitionsComparable("aeon.wave_peak_concurrent_window.v1", "aeon.agg_tokens_per_cell_wall.v1"), false);
  assert.equal(definitionsComparable("herd.prefill.single_request.v1", "mia.sparkdash_prefill.v1"), false);
  assert.equal(definitionsComparable("hasso.vllm_bench_serve_output.v1", "hasso.real_jobs_in_all.v1"), false);
  // The ones that do share a group, as their formulas say.
  assert.equal(definitionsComparable("herd.decode.agg_sum.v1", "mia.agg_sum_per_request.v1"), true);
  assert.equal(definitionsComparable("herd.decode.stream_mean.v1", "aeon.decode_tps_mean.v1"), true);
});

test("nearest references: same definition group only, ranked, with what differs", () => {
  const herd = fromDecodeJob(decodeJob(), { provenance: provenance() });
  const c4 = herd.find((r) => r.conditions.concurrency === 4);
  const out = nearestReferences(c4, [...herd, ...records()], { limit: 50 });
  assert.equal(out.id, c4.id);
  const all = out.metrics.flatMap((m) => m.references.map((ref) => ({ m, ref })));
  assert.ok(all.length > 0);
  for (const { m, ref } of all) {
    assert.equal(ref.origin, "reference");
    assert.ok(definitionsComparable(m.definition, ref.definition), `${m.definition} vs ${ref.definition}`);
    assert.ok(ref.url.startsWith("https://"));
    assert.ok(ref.differences.length > 0, "a published figure is never like-with-like with a Herd run");
  }
  // Kolibri's vllm-bench-serve and Ornith's real-jobs figures sit in groups of their own.
  assert.ok(all.every(({ ref }) => !/kolibri|ornith/.test(ref.id)));
  const sum = out.metrics.find((m) => m.metric === "agg_sum_tps");
  assert.ok(sum.references.some((r) => r.definition === "mia.agg_sum_per_request.v1"));
  assert.ok(sum.references.some((r) => r.definition === "aeon.agg_saturated_est.v1"));
  const scores = sum.references.map((r) => r.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "ranked closest first");
  // Herd numbers are never diffed against a reference by the store either.
  const aeon = byId(referenceRecordId("aeon-peak16-c8-definition-gap", "c8"));
  assert.equal(compareResults(c4, aeon).comparable, false);
  // Default limit is 3 per metric.
  assert.ok(nearestReferences(c4, records()).metrics.every((m) => m.references.length <= 3));
});

async function startApp(t) {
  const { open } = tmpStore(t);
  const store = open();
  store.upsertMany(herdRecords());
  const seeded = seedReferenceRegistry(store);
  const app = express();
  app.use(express.json());
  registerBenchResultsRoutes(app, { store, registry: seeded.registry });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => server.close());
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

test("GET /api/bench-results/references lists the registry", async (t) => {
  const { call } = await startApp(t);
  const res = await call("GET", "/api/bench-results/references");
  assert.equal(res.status, 200);
  assert.equal(res.body.loaded, true);
  assert.equal(res.body.registry_version, 1);
  assert.equal(res.body.entries.length, 6);
  assert.equal(res.body.entries.reduce((n, e) => n + e.figures, 0), 23);
  assert.equal(res.body.total, 23);
  assert.ok(res.body.results.every((r) => r.run.origin === "reference" && r.run.reference_url));
  assert.ok(res.body.not_seeded.length >= 2);
  const herd = await call("GET", "/api/bench-results?origin=herd&limit=1000");
  assert.ok(herd.body.results.every((r) => !isRegistryId(r.id)));
});

test("GET /api/bench-results/:id/references and registry ids are read-only", async (t) => {
  const { call } = await startApp(t);
  const near = await call("GET", `/api/bench-results/${encodeURIComponent("decode:bench-1:c4")}/references?limit=2`);
  assert.equal(near.status, 200);
  assert.ok(near.body.metrics.every((m) => m.references.length <= 2));
  assert.ok(near.body.metrics.some((m) => m.references.length > 0));
  assert.equal((await call("GET", "/api/bench-results/nope/references")).status, 404);
  assert.equal((await call("GET", `/api/bench-results/${encodeURIComponent("decode:bench-1:c4")}/references?limit=0`)).status, 400);

  const id = referenceRecordId("aeon-peak16-c8-definition-gap", "c8");
  assert.equal((await call("DELETE", `/api/bench-results/${encodeURIComponent(id)}`)).status, 409);
  const got = await call("GET", `/api/bench-results/${encodeURIComponent(id)}`);
  assert.equal(got.status, 200);
  const { recorded_at: _r, ...body } = got.body;
  const post = await call("POST", "/api/bench-results", { ...body, metrics: body.metrics.map((m) => ({ ...m, value: 1 })) });
  assert.equal(post.status, 409);
  const unchanged = await call("GET", `/api/bench-results/${encodeURIComponent(id)}`);
  assert.equal(unchanged.body.metrics[1].value, 188.4);
});
