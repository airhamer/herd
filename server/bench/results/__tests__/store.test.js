import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BenchResultsStore,
  BenchResultValidationError,
  migrateDocument,
  documentVersion,
  FILE_FORMAT,
} from "../store.js";
import { makeResult, SCHEMA_VERSION } from "../schema.js";
import { fromDecodeJob, fromPrefillJob } from "../adapters.js";
import { decodeJob, decodeWave, prefillJob, showcaseRecord, provenance, referenceRecord } from "./fixtures.js";

function tmpFile(t, name = "bench-results.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-results-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

const quiet = () => {};
const open = (file, opts = {}) => new BenchResultsStore({ path: file, log: quiet, ...opts });

function seed(store) {
  store.upsertMany([
    ...fromDecodeJob(decodeJob(), { provenance: provenance() }),
    ...fromDecodeJob(
      decodeJob({ benchId: "bench-2", sparkId: "spark-b", startedAt: Date.UTC(2026, 9, 5), results: [decodeWave(4, { model: "llama-70b" })] }),
      { provenance: provenance({ host: { ...provenance().host, node_id: "spark-b", hw_bucket: "2× DGX Spark" }, lane: { ...provenance().lane, engine: "sglang", model_id: "llama-70b" } }) }
    ),
    ...fromPrefillJob(prefillJob(), { provenance: provenance() }),
    makeResult(referenceRecord()),
  ]);
}

test("persists a versioned file and reloads it", (t) => {
  const file = tmpFile(t);
  const a = open(file);
  seed(a);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(doc.format, FILE_FORMAT);
  assert.equal(doc.schema_version, SCHEMA_VERSION);
  assert.equal(doc.results.length, 6);
  const b = open(file);
  assert.equal(b.size, 6);
  assert.deepEqual(b.get("decode:bench-1:c4"), a.get("decode:bench-1:c4"));
});

test("upsert validates, is idempotent by id and keeps the first recorded_at", (t) => {
  const store = open(tmpFile(t));
  const [rec] = fromDecodeJob(decodeJob());
  assert.deepEqual(store.upsert(rec), { id: rec.id, created: true });
  const again = { ...rec, recorded_at: "2030-01-01T00:00:00.000Z" };
  assert.deepEqual(store.upsert(again), { id: rec.id, created: false });
  assert.equal(store.size, 1);
  assert.equal(store.get(rec.id).recorded_at, rec.recorded_at);
  assert.throws(() => store.upsert({ ...rec, metrics: [] }), (err) => err instanceof BenchResultValidationError && err.status === 400);
});

test("upsertMany reports rejects without throwing and skips existing on request", (t) => {
  const store = open(tmpFile(t));
  const recs = fromDecodeJob(decodeJob());
  const out = store.upsertMany([...recs, { id: "junk" }]);
  assert.equal(out.added, 2);
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].id, "junk");
  const again = store.upsertMany(recs, { skipExisting: true });
  assert.deepEqual({ ...again, rejected: again.rejected.length }, { added: 0, updated: 0, skipped: 2, rejected: 0 });
});

test("list filters", (t) => {
  const store = open(tmpFile(t));
  seed(store);
  const ids = (f) => store.list(f).results.map((r) => r.id);
  assert.equal(store.list().total, 6);
  assert.equal(ids()[0], "decode:bench-2:c4", "newest first");
  assert.deepEqual(ids({ node_id: "spark-b" }), ["decode:bench-2:c4"]);
  assert.deepEqual(ids({ engine: "sglang" }), ["decode:bench-2:c4"]);
  assert.deepEqual(ids({ model_id: "llama-70b" }), ["decode:bench-2:c4"]);
  assert.deepEqual(ids({ hw_bucket: "2× DGX Spark" }), ["decode:bench-2:c4"]);
  assert.deepEqual(ids({ bench: "PrefillBench" }), ["prefill:pf-1:t1024", "prefill:pf-1:t8192"]);
  assert.deepEqual(ids({ context_tokens: "8192" }), ["prefill:pf-1:t8192"]);
  assert.deepEqual(ids({ origin: "reference" }), ["reference:aeon-188"]);
  assert.deepEqual(ids({ run_id: "decode:bench-1" }).sort(), ["decode:bench-1:c1", "decode:bench-1:c4"]);
  assert.deepEqual(ids({ definition: "aeon.agg_saturated_est.v1" }), ["reference:aeon-188"]);
  assert.equal(store.list({ metric: "agg_window_tps" }).total, 4);
  assert.equal(store.list({ concurrency: 4 }).total, 3);
  assert.deepEqual(ids({ since: "2026-10-04T00:00:00Z" }), ["decode:bench-2:c4"]);
  assert.deepEqual(ids({ until: String(Date.UTC(2026, 8, 30)) }), ["reference:aeon-188"]);
  assert.equal(store.list({ limit: 2 }).results.length, 2);
  assert.equal(store.list({ limit: 2 }).total, 6);
  assert.deepEqual(ids({ limit: 1, offset: 1 }), [ids()[1]]);
});

test("list like=<id> returns only like-with-like results", (t) => {
  const store = open(tmpFile(t));
  seed(store);
  const ids = store.list({ like: "decode:bench-1:c4" }).results.map((r) => r.id).sort();
  // Same bucket, suite and conditions: the herd run and the AEON reference; not the 2× Spark run.
  assert.deepEqual(ids, ["decode:bench-1:c4", "reference:aeon-188"]);
});

test("list rejects bad filters", (t) => {
  const store = open(tmpFile(t));
  for (const f of [{ since: "soon" }, { concurrency: "x" }, { limit: "0" }, { offset: "-1" }, { like: "missing" }]) {
    const out = store.list(f);
    assert.ok(out.errors?.length, JSON.stringify(f));
  }
});

test("compare by id, 404 for unknown ids", (t) => {
  const store = open(tmpFile(t));
  seed(store);
  const out = store.compare("reference:aeon-188", "decode:bench-1:c4");
  assert.equal(out.comparable, true);
  assert.ok(out.rows.some((r) => r.metric === "agg_window_tps"));
  const refused = store.compare("decode:bench-1:c4", "decode:bench-2:c4");
  assert.equal(refused.comparable, false);
  assert.match(refused.reasons.join(), /hw_bucket differs/);
  assert.throws(() => store.compare("nope", "decode:bench-1:c4"), (e) => e.status === 404);
});

test("remove by id and by run", (t) => {
  const store = open(tmpFile(t));
  seed(store);
  assert.equal(store.remove({ id: "prefill:pf-1:t1024" }), 1);
  assert.equal(store.remove({ runId: "decode:bench-1" }), 2);
  assert.equal(store.remove({ id: "nope" }), 0);
  assert.equal(open(store.path).size, 3);
});

test("cap drops the oldest runs first", (t) => {
  const store = open(tmpFile(t), { maxResults: 3 });
  seed(store);
  assert.equal(store.size, 3);
  assert.ok(store.get("decode:bench-2:c4"));
  assert.equal(store.get("reference:aeon-188"), null);
});

test("migration v0 (bare array) → v1 keeps every record and leaves a backup", (t) => {
  const file = tmpFile(t);
  const v1 = fromDecodeJob(decodeJob(), { provenance: provenance() });
  const v0 = v1.map(({ schema_version: _s, ...r }) => ({
    ...r,
    metrics: r.metrics.map(({ tier: _t, valid: _v, approximate: _a, window_s: _w, ...m }) => m),
  }));
  fs.writeFileSync(file, JSON.stringify(v0));
  assert.equal(documentVersion(v0), 0);
  const store = open(file);
  assert.deepEqual(store.loadInfo, { from: 0, migrated: true });
  assert.equal(store.size, 2);
  for (const r of v1) {
    const got = store.get(r.id);
    assert.deepEqual(got.metrics.map((m) => [m.metric, m.value, m.tier, m.valid]), r.metrics.map((m) => [m.metric, m.value, m.tier, m.valid]));
  }
  assert.ok(fs.existsSync(`${file}.v0.bak`));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).schema_version, 1);
  assert.deepEqual(open(file).loadInfo, { from: 1, migrated: false });
});

test("migrateDocument is a no-op at the current version and refuses newer files", () => {
  const doc = { format: FILE_FORMAT, schema_version: SCHEMA_VERSION, results: [] };
  assert.deepEqual(migrateDocument(doc), { doc, from: SCHEMA_VERSION, migrated: false });
  assert.throws(() => migrateDocument({ schema_version: SCHEMA_VERSION + 1, results: [] }), (e) => e.code === "FUTURE_VERSION");
});

test("a file from a newer Herd is read but never overwritten", (t) => {
  const file = tmpFile(t);
  const [rec] = fromDecodeJob(decodeJob());
  const future = JSON.stringify({ format: FILE_FORMAT, schema_version: 99, results: [{ ...rec, schema_version: 99 }] });
  fs.writeFileSync(file, future);
  const store = open(file);
  assert.equal(store.readOnly, true);
  assert.equal(store.size, 1);
  assert.throws(() => store.upsert(rec), (e) => e.status === 409);
  assert.throws(() => store.upsertMany([rec]), (e) => e.status === 409);
  assert.equal(fs.readFileSync(file, "utf8"), future);
});

test("an unreadable file is moved aside, not overwritten", (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, "{not json");
  const store = open(file);
  assert.equal(store.size, 0);
  const aside = fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".corrupt-"));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), aside[0]), "utf8"), "{not json");
});

test("invalid records in the file are skipped on load", (t) => {
  const file = tmpFile(t);
  const [rec] = fromDecodeJob(decodeJob());
  fs.writeFileSync(file, JSON.stringify({ format: FILE_FORMAT, schema_version: 1, results: [rec, { id: "bad" }] }));
  const logs = [];
  const store = open(file, { log: (m) => logs.push(m) });
  assert.equal(store.size, 1);
  assert.match(logs.join(), /skipped 1 invalid/);
});

test("legacy history import: all three files, idempotent, missing files reported", (t) => {
  const file = tmpFile(t);
  const dir = path.dirname(file);
  const decode = path.join(dir, "bench-history.json");
  const prefill = path.join(dir, "prefill-bench-history.json");
  const showcase = path.join(dir, "showcase-history.json");
  fs.writeFileSync(decode, JSON.stringify({ "spark-a": [decodeJob()] }));
  fs.writeFileSync(prefill, JSON.stringify({ "spark-a": [prefillJob()] }));
  fs.writeFileSync(showcase, JSON.stringify({ "spark-a": [showcaseRecord()] }));
  const before = [decode, prefill, showcase].map((f) => fs.readFileSync(f, "utf8"));

  const store = open(file);
  const first = store.importLegacyHistories({ decode, prefill, showcase });
  assert.equal(first.DecodeBench.added, 2);
  assert.equal(first.PrefillBench.added, 2);
  assert.equal(first.Showcase.added, 1);
  assert.equal(store.size, 5);

  const second = open(file).importLegacyHistories({ decode, prefill, showcase });
  assert.equal(second.DecodeBench.added, 0);
  assert.equal(second.DecodeBench.skipped, 2);
  assert.equal(open(file).size, 5);

  assert.deepEqual([decode, prefill, showcase].map((f) => fs.readFileSync(f, "utf8")), before, "legacy files untouched");

  const missing = open(tmpFile(t)).importLegacyHistories({ decode: path.join(dir, "nope.json") });
  assert.equal(missing.DecodeBench.found, false);
  assert.equal(missing.PrefillBench.found, false);
});

test("a broken legacy file is reported, not fatal", (t) => {
  const file = tmpFile(t);
  const decode = path.join(path.dirname(file), "bench-history.json");
  fs.writeFileSync(decode, "{");
  const out = open(file).importLegacyHistories({ decode });
  assert.ok(out.DecodeBench.error);
});
