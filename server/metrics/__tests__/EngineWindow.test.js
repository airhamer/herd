import test from "node:test";
import assert from "node:assert/strict";
import {
  ENGINE_COUNTER_NAMES,
  EngineWindow,
  EngineWindows,
  NORMALIZED_FIELDS,
  emptyNormalizedRecord,
} from "../EngineWindow.js";
import { engineWindowCounters } from "../../collectors/llmEngines.js";

const T0 = 1_000_000;
const S = 1000;

// ─── Synthetic /metrics pages, using each engine's documented names ─────────

/** vLLM page from cumulative values. */
function vllmPage(c) {
  return [
    "# HELP vllm:generation_tokens_total Number of generation tokens processed.",
    "# TYPE vllm:generation_tokens_total counter",
    `vllm:generation_tokens_total{model_name="m"} ${c.gen}`,
    `vllm:prompt_tokens_total{model_name="m"} ${c.prompt}`,
    `vllm:prompt_tokens_cached_total{model_name="m"} ${c.cached}`,
    `vllm:time_to_first_token_seconds_count{model_name="m"} ${c.ttftN}`,
    `vllm:time_to_first_token_seconds_sum{model_name="m"} ${c.ttftS}`,
    `vllm:inter_token_latency_seconds_count{model_name="m"} ${c.steps}`,
    `vllm:inter_token_latency_seconds_sum{model_name="m"} ${c.itl}`,
    `vllm:request_prefill_kv_computed_tokens_sum{model_name="m"} ${c.pc}`,
    `vllm:request_prefill_time_seconds_sum{model_name="m"} ${c.fwd}`,
    `vllm:request_queue_time_seconds_sum{model_name="m"} ${c.qS}`,
    `vllm:request_queue_time_seconds_count{model_name="m"} ${c.qN}`,
    `vllm:spec_decode_num_drafts_total{model_name="m"} ${c.drafts}`,
    `vllm:spec_decode_num_accepted_tokens_total{model_name="m"} ${c.acc}`,
    `vllm:num_requests_running{model_name="m"} 1`,
    "",
  ].join("\n");
}

/** SGLang page from cumulative values. */
function sglangPage(c, { idle = true } = {}) {
  return [
    `sglang:generation_tokens_total{model_name="m"} ${c.gen}`,
    `sglang:prompt_tokens_total{model_name="m"} ${c.prompt}`,
    `sglang:cached_tokens_total{model_name="m"} ${c.cached}`,
    `sglang:time_to_first_token_seconds_count{model_name="m"} ${c.ttftN}`,
    `sglang:time_to_first_token_seconds_sum{model_name="m"} ${c.ttftS}`,
    `sglang:inter_token_latency_seconds_count{model_name="m"} ${c.itlN}`,
    `sglang:inter_token_latency_seconds_sum{model_name="m"} ${c.itl}`,
    `sglang:realtime_tokens_total{mode="prefill_compute"} ${c.pc}`,
    `sglang:realtime_tokens_total{mode="prefill_cache"} ${c.cached}`,
    `sglang:per_stage_req_latency_seconds_sum{stage="prefill_forward"} ${c.fwd}`,
    `sglang:per_stage_req_latency_seconds_sum{stage="chunked_prefill"} ${c.fwd}`,
    `sglang:queue_time_seconds_sum{model_name="m"} ${c.qS}`,
    `sglang:queue_time_seconds_count{model_name="m"} ${c.qN}`,
    `sglang:spec_verify_calls_total{model_name="m"} ${c.ver}`,
    "# HELP sglang:scheduler_idle_seconds_total Idle seconds.",
    idle ? `sglang:scheduler_idle_seconds_total{model_name="m"} ${c.idle}` : "",
    "",
  ].join("\n");
}

/** One vLLM poll every 2 s: +100 generated (+2 first tokens), +40 ITL steps over 1.96 s. */
function vllmSeries(n, base = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      gen: (base.gen ?? 1000) + 100 * i,
      prompt: (base.prompt ?? 8000) + 400 * i,
      cached: (base.cached ?? 6000) + 300 * i,
      ttftN: (base.ttftN ?? 20) + 2 * i,
      ttftS: (base.ttftS ?? 4) + 0.4 * i,
      steps: (base.steps ?? 500) + 40 * i,
      itl: (base.itl ?? 50) + 1.96 * i,
      pc: (base.pc ?? 2000) + 100 * i,
      fwd: (base.fwd ?? 1) + 0.05 * i,
      qS: (base.qS ?? 1) + 0.1 * i,
      qN: (base.qN ?? 20) + 2 * i,
      drafts: (base.drafts ?? 300) + 30 * i,
      acc: (base.acc ?? 600) + 60 * i,
    });
  }
  return out;
}

/** @param {EngineWindow|EngineWindows} w @param {string} key @param {string} engine @param {string[]} pages */
function feed(w, engine, pages, { t0 = T0, key = `${engine}|m`, step = 2 * S } = {}) {
  pages.forEach((txt, i) => {
    const counters = engineWindowCounters(engine, txt);
    w.add({ t: t0 + i * step, key, counters, counterSource: "counter" });
  });
}

test("record lists every normalized field; an empty window has none measured", () => {
  const r = new EngineWindow(60).record();
  assert.deepEqual(Object.keys(r.values), [...NORMALIZED_FIELDS]);
  for (const f of NORMALIZED_FIELDS) {
    assert.deepEqual(r.values[f], { value: null, valid: false, source: null, windowS: null, approximate: false, samples: 0 }, f);
  }
  assert.deepEqual(emptyNormalizedRecord(300).values.decode_tps.valid, false);
});

test("engineWindowCounters exposes every counter name for both engines", () => {
  for (const engine of ["vllm", "sglang"]) {
    assert.deepEqual(Object.keys(engineWindowCounters(engine, "")).sort(), [...ENGINE_COUNTER_NAMES].filter((n) => n !== "prompt" && n !== "cached").sort());
  }
});

test("vLLM window: Hasso decode / prefill / queue / TTFT / accept length / reuse / throughput", () => {
  const w = new EngineWindow(300);
  feed(w, "vllm", vllmSeries(4).map(vllmPage));
  // generated/prompt/cached come from the probe; add them as the probe does.
  const r = w.record();
  const v = r.values;
  // (Δgenerated − Δfirst) / Δitl = (300 − 6) / 5.88 = 50
  assert.equal(v.decode_tps.value, 50);
  assert.equal(v.decode_tps.source, "counter");
  assert.equal(v.decode_tps.approximate, false);
  assert.equal(v.decode_tps.windowS, 6);
  assert.equal(v.decode_tps.samples, 4);
  // Δpc / Δfwd = 300 / 0.15 = 2000
  assert.equal(v.prefill_tps.value, 2000);
  assert.equal(v.queue_s.value, 0.05);
  assert.equal(v.ttft_s.value, 0.2);
  // 1 + Δacc / Δdrafts = 1 + 180/90
  assert.equal(v.acc_len.value, 3);
  // Δgenerated / covered = 300 / 6
  assert.equal(v.throughput_tps.value, 50);
  // vLLM publishes no idle counter
  assert.equal(v.idle_share.valid, false);
  assert.equal(r.reads, 4);
  assert.equal(r.coveredS, 6);
});

test("vLLM ITL count is steps, not tokens: it never enters decode", () => {
  const series = vllmSeries(3).map((c, i) => ({ ...c, steps: 500 + 7 * i }));
  const w = new EngineWindow(300);
  feed(w, "vllm", series.map(vllmPage));
  assert.equal(w.record().values.decode_tps.value, 50);
});

test("SGLang window: ITL count is tokens, prefill_forward only, accept = generated / verify, idle share", () => {
  const pages = [0, 1, 2].map((i) =>
    sglangPage({
      gen: 1000 + 80 * i, prompt: 5000 + 500 * i, cached: 4000 + 400 * i,
      ttftN: 10 + 2 * i, ttftS: 3 + 0.6 * i, itlN: 990 + 80 * i, itl: 30 + 2 * i,
      pc: 1000 + 100 * i, fwd: 2 + 0.0667 * i, qS: 0.1 + 0.02 * i, qN: 10 + 2 * i,
      ver: 300 + 20 * i, idle: 100 + 1 * i,
    })
  );
  const w = new EngineWindow(300);
  feed(w, "sglang", pages);
  const v = w.record().values;
  assert.equal(v.decode_tps.value, 40); // 160 / 4
  assert.equal(v.prefill_tps.value, 1499.25); // 200 / 0.1334 (chunked_prefill not added)
  assert.equal(v.ttft_s.value, 0.3);
  assert.equal(v.queue_s.value, 0.01);
  assert.equal(v.acc_len.value, 4); // 160 / 40
  assert.equal(v.idle_share.value, 0.5); // 2 s idle over 4 s
  assert.equal(v.throughput_tps.value, 40);
});

test("SGLang without the idle counter: idle share is null, never a fully busy 0", () => {
  const pages = [0, 1].map((i) =>
    sglangPage({ gen: 10 * i, prompt: 0, cached: 0, ttftN: 0, ttftS: 0, itlN: 10 * i, itl: 0.2 * i, pc: 0, fwd: 0, qS: 0, qN: 0, ver: 0 }, { idle: false })
  );
  const w = new EngineWindow(60);
  feed(w, "sglang", pages);
  const v = w.record().values;
  assert.equal(v.idle_share.value, null);
  assert.equal(v.idle_share.valid, false);
  assert.equal(v.decode_tps.value, 50);
});

test("idle window: speeds are null (valid false), throughput is a measured 0", () => {
  const same = vllmPage(vllmSeries(1)[0]);
  const w = new EngineWindow(60);
  feed(w, "vllm", [same, same, same]);
  const v = w.record().values;
  for (const f of ["decode_tps", "prefill_tps", "ttft_s", "queue_s", "acc_len"]) {
    assert.equal(v[f].value, null, f);
    assert.equal(v[f].valid, false, f);
    assert.equal(v[f].approximate, false, f);
    assert.equal(v[f].source, "counter", `${f} keeps its source`);
  }
  assert.equal(v.throughput_tps.value, 0);
  assert.equal(v.throughput_tps.valid, true);
});

test("one read: nothing to difference, every counter value is null", () => {
  const w = new EngineWindow(60);
  feed(w, "vllm", [vllmPage(vllmSeries(1)[0])]);
  const v = w.record().values;
  for (const f of ["decode_tps", "prefill_tps", "throughput_tps", "cache_reuse"]) assert.equal(v[f].valid, false, f);
});

test("vLLM counter reset (engine restart) starts the window again; no negative or spanning rate", () => {
  const before = vllmSeries(3).map(vllmPage);
  const after = vllmSeries(3, { gen: 0, prompt: 0, cached: 0, ttftN: 0, ttftS: 0, steps: 0, itl: 0, pc: 0, fwd: 0, qS: 0, qN: 0, drafts: 0, acc: 0 }).map(vllmPage);
  const w = new EngineWindow(300);
  feed(w, "vllm", [...before, ...after]);
  const r = w.record();
  assert.equal(r.resets, 1);
  assert.equal(r.reads, 3);
  assert.equal(r.startedAt, T0 + 3 * 2 * S);
  assert.equal(r.values.decode_tps.value, 50);
  assert.equal(r.values.throughput_tps.value, 50);
});

test("SGLang counter reset starts the window again", () => {
  const page = (i, base) =>
    sglangPage({ gen: base + 80 * i, prompt: base, cached: 0, ttftN: base + i, ttftS: base, itlN: base + 80 * i, itl: base + 2 * i, pc: base, fwd: base, qS: 0, qN: 0, ver: base + 20 * i, idle: base });
  const w = new EngineWindow(300);
  feed(w, "sglang", [page(0, 5000), page(1, 5000), page(0, 0), page(1, 0)]);
  const r = w.record();
  assert.equal(r.resets, 1);
  assert.equal(r.reads, 2);
  assert.equal(r.values.decode_tps.value, 40);
});

test("a counter that drops out and comes back lower still counts as a reset", () => {
  const w = new EngineWindow(300);
  w.add({ t: T0, key: "x", counters: { generated: 1000 } });
  w.add({ t: T0 + 2 * S, key: "x", counters: { generated: null } });
  w.add({ t: T0 + 4 * S, key: "x", counters: { generated: 10 } });
  assert.equal(w.record().resets, 1);
});

test("a counter missing at either end makes only its values null", () => {
  const w = new EngineWindow(300);
  w.add({ t: T0, key: "x", counters: { generated: 100, prompt: null, cached: 0 } });
  w.add({ t: T0 + 2 * S, key: "x", counters: { generated: 200, prompt: 500, cached: 100 } });
  const v = w.record().values;
  assert.equal(v.throughput_tps.value, 50);
  assert.equal(v.cache_reuse.value, null);
  assert.equal(v.cache_reuse.valid, false);
});

test("engine change (key) starts the window again", () => {
  const w = new EngineWindow(300);
  feed(w, "vllm", vllmSeries(3).map(vllmPage), { key: "vllm|a" });
  feed(w, "vllm", vllmSeries(2, { gen: 99999 }).map(vllmPage), { key: "vllm|b", t0: T0 + 10 * S });
  const r = w.record();
  assert.equal(r.resets, 1);
  assert.equal(r.reads, 2);
});

test("the window keeps one read at or before its start and drops older ones", () => {
  const w = new EngineWindow(60);
  feed(w, "vllm", vllmSeries(61).map(vllmPage)); // 120 s of reads
  const r = w.record();
  assert.equal(r.coveredS, 60);
  assert.equal(r.reads, 31);
  assert.equal(r.values.decode_tps.windowS, 60);
  assert.equal(r.values.decode_tps.value, 50);
});

test("60 s and 300 s windows differ once load changes", () => {
  const ws = new EngineWindows([60, 300]);
  const pages = [];
  let gen = 0;
  for (let i = 0; i < 150; i++) {
    gen += i < 120 ? 100 : 0; // last 60 s idle
    pages.push({ generated: gen });
  }
  pages.forEach((c, i) => ws.add({ t: T0 + i * 2 * S, key: "k", counters: c, counterSource: "native" }));
  const r = ws.records();
  assert.deepEqual(Object.keys(r), ["60", "300"]);
  assert.equal(r["60"].values.throughput_tps.value, 0);
  assert.equal(r["300"].values.throughput_tps.value, 39.93); // 11900 / 298 s
  assert.equal(r["300"].values.throughput_tps.source, "native");
});

test("engines without Hasso counters: busy-time-weighted mean of per-poll rates, approximate", () => {
  const w = new EngineWindow(60);
  const rates = [null, 30, 0, 60, 0];
  rates.forEach((r, i) =>
    w.add({ t: T0 + i * 2 * S, key: "k", rates: { decodeTps: r, prefillTps: null, ttftS: null }, rateSources: { decodeTps: "native" } })
  );
  const v = w.record().values;
  assert.equal(v.decode_tps.value, 45);
  assert.equal(v.decode_tps.approximate, true);
  assert.equal(v.decode_tps.source, "native");
  assert.equal(v.decode_tps.samples, 2);
  assert.equal(v.prefill_tps.valid, false);
  assert.equal(v.prefill_tps.value, null);
});

test("an idle rate-only engine reads null, not 0", () => {
  const w = new EngineWindow(60);
  [0, 0, 0].forEach((r, i) => w.add({ t: T0 + i * 2 * S, key: "k", rates: { decodeTps: r }, rateSources: { decodeTps: "native" } }));
  const v = w.record().values.decode_tps;
  assert.equal(v.value, null);
  assert.equal(v.valid, false);
  assert.equal(v.source, "native");
});

test("levels: newest read with the window peak; null when the newest read has none", () => {
  const w = new EngineWindow(60);
  [3, 7, 2].forEach((running, i) =>
    w.add({ t: T0 + i * 2 * S, key: "k", levels: { running, waiting: null, kvPct: 12.345 * (i + 1) }, levelSources: { running: "counter", kvPct: "counter" } })
  );
  const v = w.record().values;
  assert.deepEqual(v.running, { value: 2, valid: true, source: "counter", windowS: 0, approximate: false, samples: 3, peak: 7 });
  assert.equal(v.kv_pct.value, 37);
  assert.equal(v.kv_pct.peak, 37);
  assert.equal(v.waiting.valid, false);
});

test("out-of-order and duplicate reads are ignored", () => {
  const w = new EngineWindow(60);
  w.add({ t: T0, key: "k", counters: { generated: 0 } });
  w.add({ t: T0 + 2 * S, key: "k", counters: { generated: 100 } });
  w.add({ t: T0 + 2 * S, key: "k", counters: { generated: 5 } });
  w.add({ t: T0 + S, key: "k", counters: { generated: 1 } });
  const r = w.record();
  assert.equal(r.reads, 2);
  assert.equal(r.resets, 0);
  assert.equal(r.values.throughput_tps.value, 50);
});

test("clear() forgets every read", () => {
  const ws = new EngineWindows();
  feed(ws, "vllm", vllmSeries(3).map(vllmPage));
  ws.clear();
  for (const rec of Object.values(ws.records())) assert.equal(rec.reads, 0);
});
