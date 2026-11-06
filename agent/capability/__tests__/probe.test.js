import test from "node:test";
import assert from "node:assert/strict";
import { probeRuntimeCapabilities, persistDetected, resetDetected, resolveAuthRef } from "../probe.js";

const SGLANG_METRICS = `
# HELP sglang:num_running_reqs Running requests
# TYPE sglang:num_running_reqs gauge
sglang:num_running_reqs 2
# HELP sglang:prompt_tokens_total Prompt tokens
# TYPE sglang:prompt_tokens_total counter
sglang:prompt_tokens_total 42
`;

function profile(over = {}) {
  return {
    engine: "sglang",
    protocol: "openai",
    ports: { engine: 8080, guard: 8081 },
    adapters: [{ id: "openai", support: "native", capabilities: ["chat"] }],
    credentialRef: "env:GUARD_PROXY_KEY",
    ...over,
  };
}

function http(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] || headers[k] || null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

test("mocked HTTP scrape populates detected availability separately from declarations", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization || init?.headers?.authorization || null });
    if (String(url).includes("/get_server_info")) {
      return http(200, { model: "qwen3.8-27b" });
    }
    if (String(url).endsWith("/metrics")) return http(200, SGLANG_METRICS, { "content-type": "text/plain" });
    if (String(url).includes("/v1/models")) return http(200, { data: [{ id: "qwen3.8-27b", owned_by: "sglang" }] });
    return http(404, "");
  };
  const result = await probeRuntimeCapabilities(profile(), {
    fetchImpl,
    now: () => 1234,
    env: { GUARD_PROXY_KEY: "secret-token" },
  });
  assert.equal(result.declared[0].id, "openai");
  assert.equal(result.detected.reachable, true);
  assert.equal(result.detected.freshness, "fresh");
  assert.equal(result.detected.observedAt, 1234);
  assert.equal(result.capabilities[0].status, "supported+enabled");
  assert.equal(result.capabilities[0].freshness, "fresh");
  assert.ok(calls.some((c) => c.url.includes("/metrics") || c.url.includes("/get_server_info")));
  // Auth ref used, raw catalog never stored on detected blob.
  assert.ok(JSON.stringify(result.detected).indexOf("secret-token") === -1);
});

test("auth / error / timeout become unreachable without fake zeros", async () => {
  const fetchImpl = async () => {
    throw Object.assign(new Error("timeout"), { name: "AbortError" });
  };
  const result = await probeRuntimeCapabilities(profile(), { fetchImpl, now: () => 9 });
  assert.equal(result.detected.reachable, false);
  assert.ok(result.detected.reason);
  assert.equal(result.detected.metrics, null);
  assert.equal(result.capabilities[0].value.numeric, null);
  assert.equal(result.capabilities[0].value.kind, "unavailable");
});

test("http 401 is an error, not a measured zero", async () => {
  const fetchImpl = async () => http(401, { error: "nope" });
  const result = await probeRuntimeCapabilities(profile(), { fetchImpl, now: () => 1 });
  assert.notEqual(result.capabilities[0].value.kind, "measured");
  assert.equal(result.capabilities[0].value.numeric, null);
});

test("TensorFold stays unverified even when something answers", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("/v1/models")) {
      return http(200, { data: [{ id: "m", owned_by: "tensorfold" }] });
    }
    if (String(url).endsWith("/metrics")) return http(200, "tf_tokens 99\n");
    return http(404, "");
  };
  const result = await probeRuntimeCapabilities(profile({ engine: "tensorfold" }), { fetchImpl, now: () => 2 });
  assert.equal(result.detected.tensorfoldUnverified, true);
  assert.equal(result.detected.metrics, null);
  assert.equal(result.capabilities[0].status, "unsupported");
  assert.equal(result.capabilities[0].value.numeric, null);
});

test("persist / reset freshness handling", () => {
  const stored = persistDetected({ variantId: "stock" }, { observedAt: 5, freshness: "fresh", reachable: true, backend: "sglang" });
  assert.equal(stored.detectedCapabilities.freshness, "fresh");
  assert.equal(stored.variantId, "stock");
  const cleared = resetDetected(stored);
  assert.equal(cleared.detectedCapabilities, null);
});

test("only env:/file: refs resolve; raw tokens are ignored", () => {
  assert.equal(resolveAuthRef("sk-live", { sk: "x" }), null);
  assert.equal(resolveAuthRef("env:FOO", { FOO: "abc" }), "abc");
  assert.equal(resolveAuthRef("file:/tmp/k", {}, () => "from-file"), "from-file");
});
