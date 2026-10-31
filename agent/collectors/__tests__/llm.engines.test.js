// STAT3 (#36): every engine the STAT1 probe knows ships raw cumulative
// counters with a monotonic read stamp. Fixtures are hand-written from each
// engine's documented series / JSON fields.
import test from "node:test";
import assert from "node:assert/strict";
import {
  collectLlm,
  backendFromOwnedBy,
  countersFromJson,
  countersFromPrometheus,
  engineFromPrometheus,
  ENGINE_COUNTER_KEYS,
  ENGINE_COUNTERS_SCHEMA,
} from "../llm.js";
import { counterMeta, counterRecord, counterStamp } from "../llmCounters.js";
import { AGENT_VERSION } from "../../telemetry.js";

const CLOCK = { monoNow: () => 1234.5678, wallNow: () => 1_700_000_000_000, bootId: "boot-a" };

/** Mock fetch from a path → body table; objects are JSON, strings text. 404 otherwise. */
function routes(table) {
  const calls = [];
  const fetchFn = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (!(path in table)) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    const v = table[path];
    const body = typeof v === "string" ? v : JSON.stringify(v);
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  };
  return { fetchFn, calls };
}

async function probe(table, port = 8000) {
  const { fetchFn, calls } = routes(table);
  const [e] = await collectLlm([port], { fetch: fetchFn, clock: CLOCK });
  return { e, calls };
}

const models = (id, ownedBy) => ({ data: [{ id, owned_by: ownedBy, max_model_len: 32768 }] });

/** Expected record: every key, the given ones set. */
const rec = (o) => ({ ...Object.fromEntries(ENGINE_COUNTER_KEYS.map((k) => [k, null])), ...o });

const DS4 = [
  "# TYPE ds4_tokens_decoded_total counter",
  "ds4_tokens_decoded_total 5000",
  'ds4_tokens_prefilled_total{kind="computed"} 3000',
  'ds4_tokens_prefilled_total{kind="cached"} 9000',
  "ds4_requests_inflight 2",
].join("\n");

const Q27 = [
  "q27_decode_tokens_processed_total 4100",
  "q27_decode_tokens_total 4000",
  "q27_prefill_computed_tokens_processed_total 700",
  "q27_prefill_cached_tokens_processed_total 300",
  "q27_prefill_computed_tokens_total 650",
  "q27_itl_seconds_count 3900",
  "q27_itl_seconds_sum 39",
  "q27_ttft_seconds_sum 5",
  "q27_ttft_seconds_count 10",
  "q27_e2e_seconds_sum 80",
  "q27_e2e_seconds_count 10",
  "q27_requests_total 11",
  "q27_preemptions_total 1",
  "q27_requests_inflight 1",
  "q27_kv_usage_perc 0.4",
].join("\n");

const TF = [
  "tensorfold:generation_tokens_total 900",
  "tensorfold:prompt_tokens_total 2000",
  "tensorfold:prompt_tokens_cached_total 500",
  "tensorfold:request_prefill_seconds_sum 3",
  "tensorfold:time_to_first_token_seconds_sum 2",
  "tensorfold:time_to_first_token_seconds_count 8",
  "tensorfold:requests_running 1",
  "tensorfold:requests_waiting 0",
].join("\n");

const SPLASH = [
  "splash_decode_output_tokens_total 700",
  "splash_prefill_input_tokens_total 1200",
  "splash_cache_reused_tokens_total 800",
  "splash_accepted_draft_tokens_total 300",
  "splash_drafted_tokens_total 400",
  "splash_decode_tokens_per_second 42",
  "splash_scheduler_prefilling 1",
  "splash_scheduler_decoding 2",
  "splash_scheduler_queued 3",
].join("\n");

const LLAMA = [
  "llamacpp:prompt_tokens_total 1500",
  "llamacpp:prompt_seconds_total 1.5",
  "llamacpp:tokens_predicted_total 600",
  "llamacpp:tokens_predicted_seconds_total 12",
  "llamacpp:requests_processing 1",
  "llamacpp:requests_deferred 2",
].join("\n");

test("schema 2 payload and agent 0.4.0 or later", () => {
  assert.equal(ENGINE_COUNTERS_SCHEMA, 2);
  const [maj, min] = AGENT_VERSION.split(".").map(Number);
  assert.ok(maj > 0 || min >= 4, AGENT_VERSION);
  assert.equal(ENGINE_COUNTER_KEYS.length, new Set(ENGINE_COUNTER_KEYS).size);
});

test("counterStamp: monotonic ms, wall ms and a stable boot id", () => {
  assert.deepEqual(counterStamp(CLOCK), { monoMs: 1234.568, wallMs: 1_700_000_000_000, bootId: "boot-a" });
  const a = counterStamp();
  const b = counterStamp();
  assert.equal(a.bootId, b.bootId);
  assert.match(a.bootId, /^[0-9a-f-]{36}$/);
  assert.ok(b.monoMs >= a.monoMs);
  assert.deepEqual(counterMeta("json", CLOCK), { schema: 2, source: "json", monoMs: 1234.568, wallMs: 1_700_000_000_000, bootId: "boot-a" });
});

test("counterRecord: null when nothing but `first` is known", () => {
  assert.equal(counterRecord({ first: 0 }), null);
  assert.equal(counterRecord({}), null);
  assert.deepEqual(counterRecord({ generated: "12", bogus: 3 }), rec({ generated: 12 }));
});

test("engineFromPrometheus: series names pick the engine", () => {
  assert.equal(engineFromPrometheus(DS4), "ds4");
  assert.equal(engineFromPrometheus(Q27), "q27");
  assert.equal(engineFromPrometheus(TF), "tensorfold");
  assert.equal(engineFromPrometheus(SPLASH), "splash");
  assert.equal(engineFromPrometheus(LLAMA), "llama.cpp");
  assert.equal(engineFromPrometheus("sglang:num_running_reqs 1"), "sglang");
  assert.equal(engineFromPrometheus("vllm:num_requests_running 1"), "vllm");
  assert.equal(engineFromPrometheus("# HELP nothing\nprocess_cpu_seconds_total 1"), null);
  assert.equal(engineFromPrometheus(null), null);
});

test("backendFromOwnedBy", () => {
  assert.equal(backendFromOwnedBy("LlamaCPP"), "llama.cpp");
  assert.equal(backendFromOwnedBy("tensorfold"), "tensorfold");
  assert.equal(backendFromOwnedBy("ds4.c"), "ds4");
  assert.equal(backendFromOwnedBy("organization-owner"), null);
  assert.equal(backendFromOwnedBy(undefined), null);
});

test("ds4: owned_by unknown, /metrics names it; computed + cached prompt", async () => {
  const { e } = await probe({ "/v1/models": models("deepseek-v4", "organization"), "/metrics": DS4 });
  assert.equal(e.backend, "ds4");
  assert.equal(e.requestsRunning, 2);
  assert.deepEqual(e.engineCounters, rec({ generated: 5000, prompt: 12000, cached: 9000, prefillComputed: 3000 }));
  assert.deepEqual(e.engineCountersMeta, { schema: 2, source: "prometheus", monoMs: 1234.568, wallMs: 1_700_000_000_000, bootId: "boot-a" });
});

test("q27: live *_processed_total family only, ITL count as decoded tokens", async () => {
  const { e } = await probe({ "/v1/models": models("qwen", "q27"), "/metrics": Q27 });
  assert.equal(e.backend, "q27");
  assert.equal(e.kvCacheUsage, 0.4);
  assert.deepEqual(e.engineCounters, rec({
    generated: 4100, prompt: 1000, cached: 300, prefillComputed: 700,
    decoded: 3900, first: 0, itlSum: 39, ttftSum: 5, ttftCount: 10, e2eSum: 80, e2eCount: 10,
    requestsFinished: 11, preemptions: 1,
  }));
});

test("q27: completion family when the build has no live counters", () => {
  const txt = ["q27_decode_tokens_total 4000", "q27_prefill_computed_tokens_total 650", "q27_prefill_cached_tokens_total 50"].join("\n");
  const c = countersFromPrometheus("q27", txt);
  assert.equal(c.generated, 4000);
  assert.equal(c.prompt, 700);
  assert.equal(c.decoded, null);
  assert.equal(c.first, null);
});

test("TensorFold native: tensorfold:* series", async () => {
  const { e } = await probe({ "/v1/models": models("m", "tensorfold"), "/metrics": TF });
  assert.equal(e.backend, "tensorfold");
  assert.equal(e.requestsRunning, 1);
  assert.equal(e.engineCountersMeta.source, "prometheus");
  assert.deepEqual(e.engineCounters, rec({
    generated: 900, prompt: 2000, cached: 500, prefillComputed: 1500, prefillSeconds: 3, ttftSum: 2, ttftCount: 8,
  }));
});

test("TensorFold CUDA: /health JSON totals win", async () => {
  const health = { status: "ok", completion_tokens_total: 50, prompt_tokens_total: 400, cached_tokens_total: 100, prefill_seconds_total: 0.5 };
  const { e } = await probe({ "/v1/models": models("m", "tensorfold"), "/health": health });
  assert.equal(e.backend, "tensorfold");
  assert.equal(e.engineCountersMeta.source, "json");
  assert.deepEqual(e.engineCounters, rec({ generated: 50, prompt: 400, cached: 100, prefillComputed: 300, prefillSeconds: 0.5 }));
});

test("Splash: computed + reused prompt, drafted / accepted tokens, gauges ignored", async () => {
  const { e } = await probe({ "/v1/models": models("m", "someone"), "/metrics": SPLASH });
  assert.equal(e.backend, "splash");
  assert.equal(e.requestsRunning, 3);
  assert.equal(e.requestsWaiting, 3);
  assert.deepEqual(e.engineCounters, rec({
    generated: 700, prompt: 2000, cached: 800, prefillComputed: 1200, specAccepted: 300, specDraftTokens: 400,
  }));
});

test("llama.cpp: predicted tokens over predicted seconds", async () => {
  const { e } = await probe({ "/v1/models": models("m", "llamacpp"), "/metrics": LLAMA });
  assert.equal(e.backend, "llama.cpp");
  assert.equal(e.requestsWaiting, 2);
  assert.deepEqual(e.engineCounters, rec({
    generated: 600, prefillComputed: 1500, prefillSeconds: 1.5, decoded: 600, first: 0, itlSum: 12,
  }));
});

test("EXL3: /health busy + totals, detected without owned_by", async () => {
  const health = { ok: true, busy: true, prompt_tokens_total: 900, completion_tokens_total: 300 };
  const { e } = await probe({ "/v1/models": models("m", "me"), "/health": health });
  assert.equal(e.backend, "exl3");
  assert.equal(e.requestsRunning, 1);
  assert.deepEqual(e.engineCounters, rec({ generated: 300, prompt: 900 }));
  assert.equal(e.engineCountersMeta.source, "json");
});

test("Strata: JSON /metrics live + totals", async () => {
  const met = { live: { running: 2, waiting: 1 }, totals: { output_tokens: 80, prompt_tokens: 600, reused: 200, drafts_accepted: 30, drafts_offered: 50 } };
  const { e, calls } = await probe({ "/v1/models": models("m", "strata"), "/metrics": met });
  assert.equal(e.backend, "strata");
  assert.equal(e.requestsRunning, 2);
  assert.equal(e.requestsWaiting, 1);
  assert.deepEqual(e.engineCounters, rec({ generated: 80, prompt: 600, cached: 200, specAccepted: 30, specDraftTokens: 50 }));
  assert.equal(calls.filter((p) => p === "/metrics").length, 1);
});

test("Strata: /health service names it when owned_by does not", async () => {
  const met = { live: {}, totals: { output_tokens: 1 } };
  const { e } = await probe({ "/v1/models": models("m", "x"), "/health": { service: "strata" }, "/metrics": "not json" });
  assert.equal(e.backend, "strata");
  assert.equal(e.engineCounters, null); // /metrics unreadable: nothing to window
  const r = await probe({ "/v1/models": models("m", "x"), "/metrics": met });
  assert.equal(r.e.backend, "strata");
  assert.equal(r.e.engineCounters.generated, 1);
});

test("FreeToken: /v1/stats totals, KV pages, decode seconds", async () => {
  const stats = {
    throughput: { decode_tps: 50 },
    requests: {
      active: 1, completed: 9, prompt_tokens_total: 1000, cached_prompt_tokens_total: 250, completion_tokens_total: 500,
      prefill_seconds_total: 2, decode_tokens_total: 480, decode_seconds_total: 10,
    },
    kv: { used_pages: 25, total_pages: 100 },
  };
  const { e } = await probe({ "/v1/models": models("m", "y"), "/v1/stats": stats });
  assert.equal(e.backend, "freetoken");
  assert.equal(e.requestsRunning, 1);
  assert.equal(e.kvCacheUsage, 0.25);
  assert.deepEqual(e.engineCounters, rec({
    generated: 500, prompt: 1000, cached: 250, prefillComputed: 750, prefillSeconds: 2,
    decoded: 480, first: 0, itlSum: 10, requestsFinished: 9,
  }));
});

test("Locals: /stats per-engine objects summed", async () => {
  const stats = {
    memory: { used: 1 },
    mlx: { completion_tokens: 100, prompt_tokens: 300, tokens_out: 100, decode_s: 2, prefill_tokens: 250, prefill_s: 0.5 },
    llama: { completion_tokens: 50, prompt_tokens: 100, tokens_out: 50, decode_s: 1, prefill_tokens: 100, prefill_s: 0.25 },
    active: [{ id: 1 }],
  };
  const { e } = await probe({ "/v1/models": models("m", "locals"), "/stats": stats });
  assert.equal(e.backend, "locals");
  assert.equal(e.requestsRunning, 1);
  assert.deepEqual(e.engineCounters, rec({
    generated: 150, prompt: 400, prefillComputed: 350, prefillSeconds: 0.75, decoded: 150, first: 0, itlSum: 3,
  }));
});

test("TabbyAPI: labelled, no counters", async () => {
  const { e } = await probe({ "/v1/models": models("m", "tabbyAPI") });
  assert.equal(e.backend, "tabbyapi");
  assert.equal(e.engineCounters, null);
  assert.equal(e.engineCountersMeta, null);
});

test("unknown OpenAI server stays vllm (legacy) with no counters", async () => {
  const { e } = await probe({ "/v1/models": models("m", "openai") });
  assert.equal(e.backend, "vllm");
  assert.equal(e.engineCounters, null);
  assert.equal(e.engineCountersMeta, null);
});

test("vLLM: counters carry meta; known engines skip the identification probes", async () => {
  const txt = 'vllm:generation_tokens_total{model_name="m"} 10\nvllm:num_requests_running{model_name="m"} 1';
  const { e, calls } = await probe({ "/v1/models": models("m", "vllm"), "/metrics": txt });
  assert.equal(e.backend, "vllm");
  assert.equal(e.engineCounters.generated, 10);
  assert.equal(e.engineCountersMeta.source, "prometheus");
  assert.ok(!calls.includes("/health") && !calls.includes("/v1/stats"));
});

test("countersFromJson: non-objects and unknown engines are null", () => {
  assert.equal(countersFromJson("exl3", null), null);
  assert.equal(countersFromJson("exl3", [1]), null);
  assert.equal(countersFromJson("nope", { a: 1 }), null);
  assert.equal(countersFromPrometheus("nope", "x 1"), null);
  assert.equal(countersFromPrometheus("vllm", ""), null);
});

test("every entry is JSON-safe and keeps the legacy fields", async () => {
  const { e } = await probe({ "/v1/models": models("m", "q27"), "/metrics": Q27 });
  const back = JSON.parse(JSON.stringify(e));
  assert.deepEqual(back, e);
  for (const k of ["port", "backend", "modelId", "requestsRunning", "kvCacheUsage", "engineCounters"]) assert.ok(k in e, k);
});
