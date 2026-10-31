// STAT2 (#35): raw engine counters the dashboard windows (EngineWindow).
import test from "node:test";
import assert from "node:assert/strict";
import { collectLlm, engineCounters } from "../llm.js";

function http(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body), text: async () => body };
}

const VLLM = [
  'vllm:generation_tokens_total{model_name="m"} 1000',
  'vllm:prompt_tokens_total{model_name="m"} 8000',
  'vllm:prompt_tokens_cached_total{model_name="m"} 6000',
  'vllm:time_to_first_token_seconds_count{model_name="m"} 20',
  'vllm:time_to_first_token_seconds_sum{model_name="m"} 4',
  'vllm:inter_token_latency_seconds_count{model_name="m"} 500',
  'vllm:inter_token_latency_seconds_sum{model_name="m"} 50',
  'vllm:request_prefill_kv_computed_tokens_sum{model_name="m"} 2000',
  'vllm:request_prefill_time_seconds_sum{model_name="m"} 1',
  'vllm:request_queue_time_seconds_sum{model_name="m"} 1',
  'vllm:request_queue_time_seconds_count{model_name="m"} 20',
  'vllm:spec_decode_num_drafts_total{model_name="m"} 300',
  'vllm:spec_decode_num_accepted_tokens_total{model_name="m"} 600',
  'vllm:num_requests_running{model_name="m"} 1',
].join("\n");

const SGLANG = [
  "# HELP sglang:scheduler_idle_seconds_total Idle.",
  'sglang:generation_tokens_total{model_name="m"} 1000',
  'sglang:prompt_tokens_total{model_name="m"} 5000',
  'sglang:cached_tokens_total{cache_source="device"} 4000',
  'sglang:cached_tokens_total{cache_source="host"} 100',
  'sglang:time_to_first_token_seconds_count{model_name="m"} 10',
  'sglang:time_to_first_token_seconds_sum{model_name="m"} 3',
  'sglang:inter_token_latency_seconds_count{model_name="m"} 990',
  'sglang:inter_token_latency_seconds_sum{model_name="m"} 30',
  'sglang:realtime_tokens_total{mode="prefill_compute"} 1000',
  'sglang:realtime_tokens_total{mode="prefill_cache"} 4000',
  'sglang:per_stage_req_latency_seconds_sum{stage="prefill_forward"} 2',
  'sglang:per_stage_req_latency_seconds_sum{stage="chunked_prefill"} 2',
  'sglang:queue_time_seconds_sum{model_name="m"} 0.1',
  'sglang:queue_time_seconds_count{model_name="m"} 10',
  'sglang:spec_verify_calls_total{model_name="m"} 300',
  'sglang:token_usage{model_name="m"} 0.25',
].join("\n");

test("engineCounters: vLLM names, decoded = generated, first = TTFT count", () => {
  assert.deepEqual(engineCounters("vllm", VLLM), {
    generated: 1000, prompt: 8000, cached: 6000, decoded: 1000, first: 20, itlSum: 50,
    prefillComputed: 2000, prefillSeconds: 1, queueSum: 1, queueCount: 20, ttftSum: 4, ttftCount: 20,
    specAccepted: 600, specDrafts: 300, specVerify: null, idleSeconds: null,
  });
});

test("engineCounters: SGLang labelled series, prefill_forward only, device cache, no idle line = null", () => {
  assert.deepEqual(engineCounters("sglang", SGLANG), {
    generated: 1000, prompt: 5000, cached: 4000, decoded: 990, first: 0, itlSum: 30,
    prefillComputed: 1000, prefillSeconds: 2, queueSum: 0.1, queueCount: 10, ttftSum: 3, ttftCount: 10,
    specAccepted: null, specDrafts: null, specVerify: 300, idleSeconds: null,
  });
});

test("engineCounters: no engine page → null", () => {
  assert.equal(engineCounters("vllm", ""), null);
  assert.equal(engineCounters("vllm", "process_cpu_seconds_total 3"), null);
});

test("collectLlm: vLLM entry carries engineCounters", async () => {
  const fetch = async (url) => {
    if (url.endsWith("/get_server_info")) return http(404, "{}");
    if (url.endsWith("/api/version")) return http(404, "{}");
    if (url.endsWith("/v1/models")) return http(200, JSON.stringify({ data: [{ id: "m", owned_by: "vllm" }] }));
    if (url.endsWith("/metrics")) return http(200, VLLM);
    throw new Error(url);
  };
  const [e] = await collectLlm([8000], { fetch });
  assert.equal(e.backend, "vllm");
  assert.equal(e.engineCounters.generated, 1000);
});

test("collectLlm: SGLang reads /metrics when enabled; without it counters stay null", async () => {
  const base = (metrics) => async (url) => {
    if (url.endsWith("/get_server_info")) return http(200, JSON.stringify({ model_path: "m" }));
    if (url.endsWith("/v1/loads")) return http(200, JSON.stringify([{ num_running_reqs: 1, num_waiting_reqs: 0 }]));
    if (url.endsWith("/metrics")) return metrics ? http(200, SGLANG) : http(404, "");
    throw new Error(url);
  };
  const [on] = await collectLlm([30000], { fetch: base(true) });
  assert.equal(on.engineCounters.decoded, 990);
  assert.equal(on.kvCacheUsage, 0.25);
  const [off] = await collectLlm([30000], { fetch: base(false) });
  assert.equal(off.engineCounters, null);
  assert.equal(off.kvCacheUsage, null);
});

test("collectLlm: unreachable port has engineCounters null", async () => {
  const [e] = await collectLlm([8000], { fetch: async () => { throw new Error("down"); } });
  assert.equal(e.engineCounters, null);
});
