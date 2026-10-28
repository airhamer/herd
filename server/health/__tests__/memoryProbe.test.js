/**
 * S5.1a memoryProbe tests (node --test). All fetch goes through fake
 * fetchImpls — no real network in this file, ever.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMemoryStatus,
  probeMemoryService,
  probeAllMemoryServices,
} from "../memoryProbe.js";

const QDRANT = { id: "q1", label: "Qdrant", kind: "qdrant", baseUrl: "http://qdrant:6333" };
const EMBEDDER = { id: "e1", label: "Embedder", kind: "embedder", baseUrl: "http://embed:11434" };

/** fake fetch: url → canned outcome; unmocked urls throw (ECONN-REFUSED class). */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const entry = routes[url];
    if (!entry) throw new Error(`ECONNREFUSED ${url}`);
    if (entry.throw) throw new Error("connection refused");
    if (entry.badJson) return { ok: entry.ok ?? true, status: entry.status ?? 200, json: async () => { throw new Error("bad json"); } };
    return { ok: entry.ok ?? true, status: entry.status ?? 200, json: async () => entry.data };
  };
  return { fetchImpl, calls };
}

const FIXED_NOW = () => Date.parse("2026-10-28T12:00:00.000Z");

test("qdrant: /health happy path → present, status ok", async () => {
  const { fetchImpl, calls } = fakeFetch({ "http://qdrant:6333/health": { data: { status: "ok" } } });
  const r = await probeMemoryService(QDRANT, { fetchImpl, now: FIXED_NOW });
  assert.equal(r.present, true);
  assert.equal(r.status, "ok");
  assert.equal(r.reason, null);
  assert.equal(r.version, null);
  assert.equal(r.modelCount, null);
  assert.equal(r.id, "q1");
  assert.equal(r.label, "Qdrant");
  assert.equal(r.kind, "qdrant");
  assert.equal(r.checkedAt, "2026-10-28T12:00:00.000Z");
  assert.deepEqual(calls, ["http://qdrant:6333/health"]); // first success wins
});

test("qdrant: root fallback sets version when /health 404s", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "http://qdrant:6333/health": { ok: false, status: 404 },
    "http://qdrant:6333/": { data: { version: "1.11.0" } },
  });
  const r = await probeMemoryService(QDRANT, { fetchImpl, now: FIXED_NOW });
  assert.equal(r.present, true);
  assert.equal(r.version, "1.11.0");
  assert.equal(r.status, "ok"); // no status field on root JSON → ok
  assert.deepEqual(calls, ["http://qdrant:6333/health", "http://qdrant:6333/"]);
});

test("embedder: /v1/models happy path sets modelCount", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "http://embed:11434/v1/models": { data: { data: [{ id: "m1" }, { id: "m2" }] } },
  });
  const r = await probeMemoryService(EMBEDDER, { fetchImpl, now: FIXED_NOW });
  assert.equal(r.present, true);
  assert.equal(r.modelCount, 2);
  assert.equal(r.status, "ok");
  assert.equal(r.reason, null);
  assert.deepEqual(calls, ["http://embed:11434/v1/models"]);
});

test("embedder: /api/version fallback when /v1/models unreachable", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "http://embed:11434/v1/models": { throw: true },
    "http://embed:11434/api/version": { data: { version: "v0.12.3" } },
  });
  const r = await probeMemoryService(EMBEDDER, { fetchImpl, now: FIXED_NOW });
  assert.equal(r.present, true);
  assert.equal(r.version, "v0.12.3");
  assert.equal(r.modelCount, null); // count only from a successful /v1/models
  assert.deepEqual(calls, ["http://embed:11434/v1/models", "http://embed:11434/api/version"]);
});

test("unknown kind uses the qdrant probe order", async () => {
  const weird = { id: "u1", label: "Weird", kind: "influx", baseUrl: "http://x:1" };
  const { fetchImpl, calls } = fakeFetch({ "http://x:1/health": { data: { status: "ok" } } });
  const r = await probeMemoryService(weird, { fetchImpl, now: FIXED_NOW });
  assert.equal(r.present, true);
  assert.deepEqual(calls, ["http://x:1/health"]);
});

test("missing kind also uses the qdrant probe order", async () => {
  const noKind = { id: "n1", label: "NoKind", baseUrl: "http://nk:1" };
  const { fetchImpl, calls } = fakeFetch({ "http://nk:1/health": { data: { status: "ok" } } });
  const r = await probeMemoryService(noKind, { fetchImpl, now: FIXED_NOW });
  assert.equal(r.present, true);
  assert.deepEqual(calls, ["http://nk:1/health"]);
});

test("connection refused on both endpoints → unreachable", async () => {
  const { fetchImpl } = fakeFetch({}); // everything throws ECONNREFUSED
  const r = await probeMemoryService(QDRANT, { fetchImpl, now: FIXED_NOW });
  assert.equal(r.present, false);
  assert.equal(r.status, "unknown");
  assert.equal(r.reason, "unreachable");
  assert.equal(r.version, null);
});

test("timeout: fake aborting fetchImpl → reason timeout", async () => {
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const r = await probeMemoryService(EMBEDDER, { fetchImpl, timeoutMs: 5, now: FIXED_NOW });
  assert.equal(r.present, false);
  assert.equal(r.reason, "timeout");
});

test("malformed JSON on both endpoints → reason malformed", async () => {
  const { fetchImpl } = fakeFetch({
    "http://qdrant:6333/health": { badJson: true },
    "http://qdrant:6333/": { badJson: true },
  });
  const r = await probeMemoryService(QDRANT, { fetchImpl, now: FIXED_NOW });
  assert.equal(r.present, false);
  assert.equal(r.reason, "malformed");
});

test("non-2xx settles with an http-<code> reason", async () => {
  const { fetchImpl } = fakeFetch({
    "http://qdrant:6333/health": { ok: false, status: 503 },
    "http://qdrant:6333/": { ok: false, status: 503 },
  });
  const r = await probeMemoryService(QDRANT, { fetchImpl, now: FIXED_NOW });
  assert.equal(r.present, false);
  assert.equal(r.reason, "http-503");
});

test("modelCount clamp: junk data field falls through and counts null", async () => {
  const { fetchImpl } = fakeFetch({
    "http://embed:11434/v1/models": { data: { data: "junk" } }, // not an array → unusable
    "http://embed:11434/api/version": { data: { version: "2.0" } },
  });
  const r = await probeMemoryService(EMBEDDER, { fetchImpl, now: FIXED_NOW });
  assert.equal(r.present, true);
  assert.equal(r.version, "2.0");
  assert.equal(r.modelCount, null);
});

test("successful probe with no status field still reports ok", () => {
  const r = normalizeMemoryStatus(EMBEDDER, { data: [] }, { now: FIXED_NOW });
  assert.equal(r.present, true);
  assert.equal(r.status, "ok");
  assert.equal(r.modelCount, 0);
});

test("status vocabulary: degraded passes through, foreign strings → unknown", () => {
  assert.equal(normalizeMemoryStatus(QDRANT, { status: "degraded" }, { now: FIXED_NOW }).status, "degraded");
  assert.equal(normalizeMemoryStatus(QDRANT, { status: "crashed" }, { now: FIXED_NOW }).status, "unknown");
});

test("normalizeMemoryStatus(null) → present:false malformed", () => {
  const r = normalizeMemoryStatus(null);
  assert.equal(r.present, false);
  assert.equal(r.status, "unknown");
  assert.equal(r.reason, "malformed");
  assert.equal(r.id, null);
  assert.equal(r.kind, null);
  assert.equal(typeof r.checkedAt, "string");
});

test("missing fetchImpl or baseUrl settles malformed without throwing", async () => {
  const noFetch = await probeMemoryService(QDRANT, { now: FIXED_NOW });
  assert.equal(noFetch.present, false);
  assert.equal(noFetch.reason, "malformed");
  const noUrl = await probeMemoryService({ id: "z", label: "Z" }, { fetchImpl: fakeFetch({}).fetchImpl, now: FIXED_NOW });
  assert.equal(noUrl.present, false);
  assert.equal(noUrl.reason, "malformed");
});

test("probeAllMemoryServices settles and preserves order", async () => {
  const { fetchImpl } = fakeFetch({
    "http://qdrant:6333/health": { data: { status: "ok" } },
    "http://embed:11434/v1/models": { ok: false, status: 500 },
    "http://embed:11434/api/version": { badJson: true },
  });
  const results = await probeAllMemoryServices([QDRANT, EMBEDDER], { fetchImpl, now: FIXED_NOW });
  assert.equal(results.length, 2);
  assert.equal(results[0].id, "q1");
  assert.equal(results[0].present, true);
  assert.equal(results[1].id, "e1");
  assert.equal(results[1].present, false);
  assert.equal(results[1].reason, "malformed");
});

test("probeAllMemoryServices: non-array input → []", async () => {
  assert.deepEqual(await probeAllMemoryServices(undefined, { fetchImpl: fakeFetch({}).fetchImpl }), []);
  assert.deepEqual(await probeAllMemoryServices("nope", { fetchImpl: fakeFetch({}).fetchImpl }), []);
});
