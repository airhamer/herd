/**
 * STAT1 (#34): pure parser and formula tests for llmEngines.js.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  backendFromOwnedBy,
  clampCached,
  counterDeltas,
  hassoRates,
  parseFreeTokenStats,
  parseLocalsStats,
  parseStrataMetrics,
  parseTensorfoldHealth,
  promSum,
  promMax,
} from "../llmEngines.js";

test("backendFromOwnedBy: exact, case-insensitive, no partial match", () => {
  assert.equal(backendFromOwnedBy("FreeToken"), "freetoken");
  assert.equal(backendFromOwnedBy("tabbyAPI"), "tabbyapi");
  assert.equal(backendFromOwnedBy("locals"), "locals");
  assert.equal(backendFromOwnedBy("splashai"), null);
  assert.equal(backendFromOwnedBy("vllm"), null);
  assert.equal(backendFromOwnedBy(undefined), null);
});

test("promSum / promMax: label filters and NaN skipped", () => {
  const txt = [
    'x_total{mode="a"} 2',
    'x_total{mode="b"} 3',
    "x_total NaN",
    'y{pool="0"} 0.2',
    'y{pool="1"} 0.7',
  ].join("\n");
  assert.equal(promSum(txt, "x_total"), 5);
  assert.equal(promSum(txt, "x_total", { mode: "b" }), 3);
  assert.equal(promSum(txt, "x_total", { mode: "c" }), null);
  assert.equal(promMax(txt, "y"), 0.7);
  assert.equal(promSum(txt, "missing"), null);
});

test("counterDeltas: a decrease is a reset", () => {
  assert.deepEqual(counterDeltas({ a: 5, b: 1 }, { a: 7, b: 1 }), { deltas: { a: 2, b: 0 }, reset: false });
  const r = counterDeltas({ a: 5 }, { a: 1 });
  assert.equal(r.reset, true);
  assert.equal(r.deltas.a, null);
});

test("hassoRates: no samples in the window → null, never 0", () => {
  const c = { decoded: 10, first: 1, itlSum: 1, prefillComputed: 5, prefillSeconds: 1, queueSum: 1, queueCount: 1, specAccepted: 1, specDrafts: 1 };
  const r = hassoRates("vllm", c, { ...c });
  assert.deepEqual(r, { decodeTps: null, prefillTps: null, queueSeconds: null, acceptLength: null });
  assert.deepEqual(hassoRates("vllm", null, c), r);
});

test("hassoRates: restart between polls → null", () => {
  const prev = { decoded: 100, first: 5, itlSum: 2, prefillComputed: 50, prefillSeconds: 1, queueSum: 1, queueCount: 1 };
  const cur = { decoded: 3, first: 1, itlSum: 0.1, prefillComputed: 2, prefillSeconds: 0.01, queueSum: 0.1, queueCount: 1 };
  assert.equal(hassoRates("vllm", prev, cur).decodeTps, null);
});

test("parseTensorfoldHealth: Zig {status: ok} has no totals", () => {
  assert.equal(parseTensorfoldHealth({ status: "ok" }), null);
  const h = parseTensorfoldHealth({ status: "ok", streams: { max: 8, decoding: 1, prefilling: 2 }, pool_tokens: 100, pool_free_tokens: 25 });
  assert.equal(h.running, 3);
  assert.equal(h.slotsTotal, 8);
  assert.equal(h.kvUsage, 0.75);
});

test("parseFreeTokenStats: older builds without cached total → null", () => {
  const s = parseFreeTokenStats({ throughput: { decode_tps: 1, prefill_tps: 2 }, requests: { prompt_tokens_total: 9 } });
  assert.equal(s.cached, null);
  assert.equal(s.kvUsage, null);
  assert.equal(parseFreeTokenStats({ status: "ok" }), null);
});

test("parseStrataMetrics: work outside slots blocks the slot-sum fallback", () => {
  const s = parseStrataMetrics({
    live: { state: "generating", tok_s: null, outside_slots: 1, slots: [{ state: "decoding", tok_s: 10 }] },
  });
  assert.equal(s.decodeTps, null);
});

test("parseLocalsStats: memory and active are not engines", () => {
  const s = parseLocalsStats({ active: [], memory: { rss_mb: 1 }, locals: { completion_tokens: 3, prompt_tokens: 4 } });
  assert.deepEqual(Object.keys(s.engines), ["locals"]);
  assert.equal(s.tokensOut, 3, "falls back to completion_tokens");
  assert.equal(parseLocalsStats({ model: "x" }), null);
});

test("clampCached", () => {
  assert.equal(clampCached(12, 10), 10);
  assert.equal(clampCached(null, 10), null);
  assert.equal(clampCached(4, null), 4);
});
