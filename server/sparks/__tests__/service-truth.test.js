/**
 * Issue #93 — probe-truth service status.
 * Fixture-driven fake fetch; no live network. Covers the gx10-1c2c shape:
 * engine bound to 127.0.0.1 only, keepalive proxy on another port behind an
 * API key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  probeServiceTruth,
  hasNonzeroRequestCounter,
  resolveServiceApiKeyRef,
  SERVICE_ACTIVE_WINDOW_MS,
} from "../SparkMonitor.js";

function fakeFetch(routes) {
  const seen = [];
  const impl = async (url, opts = {}) => {
    seen.push({ url, headers: opts.headers || {} });
    const u = new URL(url);
    const key = `${u.port}${u.pathname}`;
    const hit = routes[key];
    if (!hit) {
      const err = new Error(`connect ECONNREFUSED ${u.port}`);
      err.code = "ECONNREFUSED";
      throw err; // refused connection = fetch throws
    }
    const { status = 200, json, text, requireAuth } = hit;
    if (requireAuth && !opts.headers?.Authorization) {
      return { ok: false, status: 401, async json() { return null; }, async text() { return ""; } };
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return json ?? null;
      },
      async text() {
        return text ?? "";
      },
    };
  };
  impl.seen = seen;
  return impl;
}

test("loopback engine refused, proxy 401 answers: running via proxy", async () => {
  // sglang on 127.0.0.1:8080 (unreachable from the board), keepalive proxy on 8081.
  const fetch = fakeFetch({
    "8081/v1/models": { status: 401 },
  });
  const out = await probeServiceTruth(
    { name: "llm-tp1", engine: "sglang", kind: "llm", port: 8080, proxyPort: 8081 },
    { host: "192.168.50.226", fetch, now: () => 1000 }
  );
  assert.equal(out.status, "running");
  assert.equal(out.source, "proxy");
  assert.equal(out.port, 8081);
  assert.equal(out.model, null); // auth gate: body not readable
  assert.equal(out.error, null);
});

test("proxy 200 with key from env ref populates model and version", async () => {
  const fetch = fakeFetch({
    "8081/v1/models": {
      requireAuth: true,
      status: 200,
      json: { data: [{ id: "qwen38-flash-next" }], version: "v1.2.0" },
    },
    "8081/metrics": { requireAuth: true, status: 200, text: "vllm:num_requests_running 2\n" },
  });
  const out = await probeServiceTruth(
    {
      name: "llm-tp1",
      engine: "sglang",
      kind: "llm",
      port: 8080,
      proxyPort: 8081,
      proxyApiKeyRef: "env:TEST_PROXY_KEY",
    },
    {
      host: "10.0.0.5",
      fetch,
      now: () => 5000,
      env: { TEST_PROXY_KEY: "secret-key" },
    }
  );
  assert.equal(out.status, "running");
  assert.equal(out.source, "proxy");
  assert.equal(out.model, "qwen38-flash-next");
  assert.equal(out.engineVersion, "v1.2.0");
  assert.equal(out.active, true);
  const modelsReq = fetch.seen.find((s) => s.url.endsWith("/v1/models") && s.headers.Authorization);
  assert.equal(modelsReq.headers.Authorization, "Bearer secret-key");
});

test("engine port answering directly wins with source engine", async () => {
  const fetch = fakeFetch({
    "8000/v1/models": { status: 200, json: { data: [{ id: "qwen3.8-27b" }] } },
    "8000/version": { status: 200, json: { version: "v0.29.0" } },
    "8000/metrics": { status: 200, text: "# empty\n" },
  });
  const out = await probeServiceTruth(
    { name: "llm-tp2", engine: "vllm", kind: "llm", port: 8000, proxyPort: 8001 },
    { host: "127.0.0.1", fetch, now: () => 1000 }
  );
  assert.equal(out.status, "running");
  assert.equal(out.source, "engine");
  assert.equal(out.port, 8000);
  assert.equal(out.engineVersion, "v0.29.0");
  assert.equal(out.active, false);
});

test("comfyui probes /system_stats", async () => {
  const fetch = fakeFetch({
    "8188/system_stats": {
      status: 200,
      json: { system: { comfyui_version: "0.3.66" } },
    },
    "8188/metrics": { status: 404 },
  });
  const out = await probeServiceTruth(
    { name: "comfyui", engine: "comfyui", kind: "image", port: 8188 },
    { host: "127.0.0.1", fetch, now: () => 1000 }
  );
  assert.equal(out.status, "running");
  assert.equal(out.source, "engine");
  assert.equal(out.engineVersion, "0.3.66");
});

test("all candidates dead: stopped, activeAt carried from previous", async () => {
  const fetch = fakeFetch({}); // everything refused
  const now = 10_000;
  const out = await probeServiceTruth(
    { name: "llm-x", engine: "vllm", kind: "llm", port: 9000, proxyPort: 9001 },
    { host: "h", fetch, now: () => now, previous: { activeAt: now - 1000 } }
  );
  assert.equal(out.status, "stopped");
  assert.equal(out.source, null);
  assert.equal(out.activeAt, now - 1000);
});

test("active window: stale counters keep active only within the window", async () => {
  const fetch = fakeFetch({ "7000/v1/models": { status: 200, json: {} }, "7000/metrics": { status: 200, text: "requests_total 0\n" } });
  const now = 1_000_000;
  const recent = await probeServiceTruth(
    { name: "s", engine: "vllm", kind: "llm", port: 7000 },
    { host: "h", fetch, now: () => now, previous: { activeAt: now - SERVICE_ACTIVE_WINDOW_MS + 1 } }
  );
  assert.equal(recent.status, "running");
  assert.equal(recent.active, true);
  const stale = await probeServiceTruth(
    { name: "s", engine: "vllm", kind: "llm", port: 7000 },
    { host: "h", fetch, now: () => now, previous: { activeAt: now - SERVICE_ACTIVE_WINDOW_MS - 1 } }
  );
  assert.equal(stale.active, false);
});

test("same-spark proxy fallback covers a service without its own proxyPort", async () => {
  const fetch = fakeFetch({ "8081/v1/models": { status: 403 } });
  const out = await probeServiceTruth(
    { name: "llm-tp1", engine: "sglang", kind: "llm", port: 8080 },
    {
      host: "h",
      fetch,
      now: () => 1,
      sparkProxies: [{ port: 8081, apiKeyRef: null }],
    }
  );
  assert.equal(out.status, "running");
  assert.equal(out.source, "proxy");
  assert.equal(out.port, 8081);
});

test("hasNonzeroRequestCounter parses Prometheus request counters", () => {
  assert.equal(hasNonzeroRequestCounter("vllm:num_requests_running 3"), true);
  assert.equal(hasNonzeroRequestCounter("proxy_requests_total{code=\"200\"} 1"), true);
  assert.equal(hasNonzeroRequestCounter("vllm:num_requests_running 0"), false);
  assert.equal(hasNonzeroRequestCounter("gpu_used_bytes 999"), false);
  assert.equal(hasNonzeroRequestCounter(""), false);
});

test("resolveServiceApiKeyRef reads env:, file:, and bare names", () => {
  assert.equal(
    resolveServiceApiKeyRef("env:K", { env: { K: " abc " } }),
    "abc"
  );
  assert.equal(
    resolveServiceApiKeyRef("file:/tmp/x.key", {
      readFile: () => "diskkey\n",
    }),
    "diskkey"
  );
  assert.equal(resolveServiceApiKeyRef("K", { env: { K: "bare" } }), "bare");
  assert.equal(resolveServiceApiKeyRef(""), null);
  assert.equal(resolveServiceApiKeyRef("env:MISSING", { env: {} }), null);
  assert.equal(
    resolveServiceApiKeyRef("file:/nope", {
      readFile: () => {
        throw new Error("EACCES");
      },
    }),
    null
  );
});
