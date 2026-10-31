// FLEET3 (#38): token ledger — diffing, restart re-seed, model switch,
// bucket roll-over, ranges, persistence and bounds.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LlmTokenLedger,
  HOUR_MS,
  DAY_MS,
  MAX_KEYS,
  MAX_RESUME_GAP_MS,
  OTHER_MODEL,
  OVERFLOW_SERIES,
} from "../LlmTokenLedger.js";

const T0 = Date.UTC(2026, 9, 30, 10, 0, 0); // 30 Oct 2026 10:00 UTC

function obs({ id = "spark-a:8000", model = "qwen", gen, prompt = null, cached = null, epoch = "engine:vllm", source = "counter" }) {
  const f = (value) => (value == null ? null : { value, epoch, source });
  const [nodeId, port] = id.split(":");
  return { seriesId: id, nodeId, nodeName: nodeId, port: Number(port), backend: "vllm", model, fields: { generated: f(gen), prompt: f(prompt), cached: f(cached) } };
}

function ledgerAt(t = T0) {
  let now = t;
  const ledger = new LlmTokenLedger({ now: () => now });
  return { ledger, set: (ms) => { now = ms; }, get now() { return now; } };
}

test("first sample seeds; later samples credit deltas (generated, cached, prefill = Δprompt − Δcached)", () => {
  const { ledger } = ledgerAt();
  assert.deepEqual(ledger.observe([obs({ gen: 1000, prompt: 5000, cached: 2000 })], T0), { generated: 0, cached: 0, prefill: 0 });
  const credited = ledger.observe([obs({ gen: 1300, prompt: 6000, cached: 2600 })], T0 + 15_000);
  assert.deepEqual(credited, { generated: 300, cached: 600, prefill: 400 });
  const t = ledger.totals("24h", T0 + 15_000);
  assert.equal(t.generated, 300);
  assert.equal(t.cached, 600);
  assert.equal(t.prefill, 400);
  assert.equal(t.total, 1300);
  assert.equal(t.endpointCount, 1);
  assert.equal(t.models[0].model, "qwen");
  assert.deepEqual(t.models[0].sources, ["counter"]);
  assert.equal(t.endpoints[0].seriesId, "spark-a:8000");
});

test("a backwards counter is a restart: re-seed without credit, then diff from the new base", () => {
  const { ledger } = ledgerAt();
  ledger.observe([obs({ gen: 5000 })], T0);
  ledger.observe([obs({ gen: 5200 })], T0 + 15_000);
  assert.equal(ledger.observe([obs({ gen: 40 })], T0 + 30_000).generated, 0);
  assert.equal(ledger.observe([obs({ gen: 100 })], T0 + 45_000).generated, 60);
  assert.equal(ledger.totals("all", T0 + 45_000).generated, 260);
});

test("a changed epoch (other engine, relay restart) re-seeds even if the value grew", () => {
  const { ledger } = ledgerAt();
  ledger.observe([obs({ gen: 100, epoch: "proxy:boot1", source: "proxy" })], T0);
  assert.equal(ledger.observe([obs({ gen: 900, epoch: "proxy:boot2", source: "proxy" })], T0 + 15_000).generated, 0);
  assert.equal(ledger.observe([obs({ gen: 950, epoch: "proxy:boot2", source: "proxy" })], T0 + 30_000).generated, 50);
  assert.deepEqual(ledger.totals("24h", T0 + 30_000).models[0].sources, ["proxy"]);
});

test("model switch mid-series credits each delta to the model running at that moment", () => {
  const { ledger } = ledgerAt();
  ledger.observe([obs({ gen: 0, model: "llama" })], T0);
  ledger.observe([obs({ gen: 700, model: "llama" })], T0 + 15_000);
  ledger.observe([obs({ gen: 1000, model: "qwen" })], T0 + 30_000);
  const t = ledger.totals("24h", T0 + 30_000);
  assert.deepEqual(t.models.map((m) => [m.model, m.generated]), [["llama", 700], ["qwen", 300]]);
  assert.equal(t.endpointCount, 1);
  assert.deepEqual(t.endpoints[0].models, ["llama", "qwen"]);
});

test("hourly and daily buckets roll over; 24h, 7d, 30d and all-time ranges", () => {
  const { ledger } = ledgerAt();
  let gen = 0;
  const step = (at, add) => { gen += add; ledger.observe([obs({ gen })], at); };
  step(T0, 0);
  step(T0 + 10 * 60_000, 100); // 10:10 today
  step(T0 + HOUR_MS, 200); // 11:00 today
  // Yesterday-equivalents: walk forward 3 days in 6 h steps (within the resume gap).
  let at = T0 + HOUR_MS;
  for (let i = 0; i < 12; i += 1) { at += 6 * HOUR_MS; step(at, 10); }
  // `at` is now 3 days + 1 h after T0.
  const h = ledger.history("24h", at);
  assert.equal(h.points.length, 24);
  assert.equal(h.resolution, "hour");
  assert.equal(h.points.at(-1).startMs, Math.floor(at / HOUR_MS) * HOUR_MS);
  assert.equal(h.points.reduce((s, p) => s + p.generated, 0), ledger.totals("24h", at).generated);
  assert.equal(ledger.totals("24h", at).generated, 40); // the last four 6 h steps
  assert.equal(ledger.totals("7d", at).generated, 420);
  assert.equal(ledger.totals("30d", at).generated, 420);
  assert.equal(ledger.totals("all", at).generated, 420);
  const d = ledger.history("7d", at);
  assert.equal(d.points.length, 7);
  assert.equal(d.points.reduce((s, p) => s + p.generated, 0), 420);
  assert.equal(d.points[3].generated, 300 + 10 * 2); // 30 Oct: 100 + 200 + 16:00 + 22:00 (10 each)
});

test("buckets are bounded: hourly 72 h, daily 35 d; all-time keeps everything", () => {
  const { ledger } = ledgerAt();
  let gen = 0;
  let at = T0;
  ledger.observe([obs({ gen })], at);
  for (let i = 0; i < 40 * 4; i += 1) {
    at += 6 * HOUR_MS;
    gen += 1;
    ledger.observe([obs({ gen })], at);
  }
  const json = ledger.toJSON();
  assert.ok(Object.keys(json.hourly).length <= 72);
  assert.ok(Object.keys(json.daily).length <= 35);
  assert.equal(ledger.totals("all", at).generated, 160);
  assert.equal(ledger.totals("30d", at).generated, 4 * 29 + 2); // 29 full days + today's 04:00 and 10:00 steps
});

test("a gap longer than the resume limit re-seeds instead of crediting a lump", () => {
  const { ledger } = ledgerAt();
  ledger.observe([obs({ gen: 100 })], T0);
  assert.equal(ledger.observe([obs({ gen: 5000 })], T0 + MAX_RESUME_GAP_MS + 1).generated, 0);
  assert.equal(ledger.observe([obs({ gen: 5010 })], T0 + MAX_RESUME_GAP_MS + 15_001).generated, 10);
});

test("a field that disappears re-seeds when it comes back; prefill never goes negative", () => {
  const { ledger } = ledgerAt();
  ledger.observe([obs({ gen: 10, prompt: 100, cached: 50 })], T0);
  ledger.observe([obs({ gen: 20, prompt: null, cached: 80 })], T0 + 15_000); // prompt gone
  const c = ledger.observe([obs({ gen: 30, prompt: 400, cached: 90 })], T0 + 30_000);
  assert.deepEqual(c, { generated: 10, cached: 10, prefill: 0 });
});

test("persists across restarts, including baselines, so downtime tokens are credited once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet3-"));
  const filePath = path.join(dir, "llm-token-totals.json");
  let now = T0;
  const a = new LlmTokenLedger({ filePath, now: () => now });
  a.observe([obs({ gen: 100 })], T0);
  a.observe([obs({ gen: 400, model: "qwen" })], T0 + 15_000);
  assert.equal(a.save(), true);
  now = T0 + 10 * 60_000;
  const b = new LlmTokenLedger({ filePath, now: () => now });
  assert.equal(b.totals("all", now).generated, 300);
  assert.equal(b.observe([obs({ gen: 900 })], now).generated, 500); // produced while down
  assert.equal(b.totals("24h", now).generated, 800);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a corrupt file is moved aside and the ledger starts empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet3-"));
  const filePath = path.join(dir, "llm-token-totals.json");
  fs.writeFileSync(filePath, "{not json");
  const origError = console.error;
  console.error = () => {};
  try {
    const l = new LlmTokenLedger({ filePath, now: () => T0 });
    assert.equal(l.totals("all", T0).generated, 0);
  } finally {
    console.error = origError;
  }
  assert.ok(fs.readdirSync(dir).some((f) => f.includes(".corrupt-")));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("clear() wipes totals but keeps baselines: nothing is credited twice", () => {
  const { ledger } = ledgerAt();
  ledger.observe([obs({ gen: 100 })], T0);
  ledger.observe([obs({ gen: 300 })], T0 + 15_000);
  ledger.clear(T0 + 20_000);
  assert.equal(ledger.totals("all", T0 + 20_000).generated, 0);
  assert.equal(ledger.totals("all", T0 + 20_000).trackedSinceMs, T0 + 20_000);
  assert.equal(ledger.observe([obs({ gen: 350 })], T0 + 30_000).generated, 50);
});

test("per-model and per-endpoint aggregation across nodes; unknown model label", () => {
  const { ledger } = ledgerAt();
  const sample = (at, a, b, c) =>
    ledger.observe([
      obs({ id: "spark-a:8000", model: "qwen", gen: a }),
      obs({ id: "node-b:8000", model: "qwen", gen: b }),
      obs({ id: "node-b:11434", model: null, gen: c, epoch: "proxy:x", source: "proxy" }),
    ], at);
  sample(T0, 0, 0, 0);
  sample(T0 + 15_000, 1000, 500, 20);
  const t = ledger.totals("24h", T0 + 15_000);
  assert.equal(t.endpointCount, 3);
  assert.deepEqual(t.models.map((m) => [m.model, m.generated, m.endpoints.length]), [["qwen", 1500, 2], ["unknown", 20, 1]]);
  assert.deepEqual(t.endpoints.map((e) => e.seriesId), ["spark-a:8000", "node-b:8000", "node-b:11434"]);
});

test("key count is capped; overflow models fold into one bucket per endpoint", () => {
  const { ledger } = ledgerAt();
  const series = Array.from({ length: MAX_KEYS + 3 }, (_, i) => `n${i}:1`);
  ledger.observe(series.map((id) => obs({ id, gen: 0 })), T0);
  ledger.observe(series.map((id) => obs({ id, gen: 1 })), T0 + 15_000);
  const t = ledger.totals("all", T0 + 15_000);
  assert.equal(t.generated, MAX_KEYS + 3);
  assert.equal(Object.keys(ledger.toJSON().keys).length, MAX_KEYS + 1); // 512 named + one fleet-wide overflow key
  assert.equal(t.models.find((m) => m.model === OTHER_MODEL).generated, 3);
  assert.equal(t.endpoints.find((e) => e.seriesId === OVERFLOW_SERIES).generated, 3);
});

test("unknown range is rejected", () => {
  const { ledger } = ledgerAt();
  assert.throws(() => ledger.totals("1y"), RangeError);
  assert.throws(() => ledger.history("bogus"), RangeError);
  assert.equal(DAY_MS, 24 * HOUR_MS);
});
