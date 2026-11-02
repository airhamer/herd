import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGuardStatus, probeGuard, probeAll, probeKeepaliveProxy, findEngineBehindProxy } from "../guardProbe.js";

const NOW = () => Date.parse("2026-10-28T12:00:00.000Z");
const ISO_NOW = "2026-10-28T12:00:00.000Z";

/**
 * fetchImpl stand-in: routes maps URL → descriptor.
 * {json}, {json, status}, {badJson, status}, {status} (non-2xx),
 * {throw: Error}, {abort: true} (rejects when the signal fires).
 * URLs missing from routes throw ECONNREFUSED. No real fetch anywhere.
 */
function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    if (route.throw) throw route.throw;
    if (route.abort) {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))
        );
      });
    }
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (route.badJson) throw new SyntaxError("Unexpected token 'o' at position 0");
        return route.json;
      },
    };
  };
  return { calls, fetchImpl };
}

const EP = { id: "guard-a", label: "Guard A", baseUrl: "http://guard.test", extra: "ignored" };
const STATUS_URL = "http://guard.test/guard/status";
const HEALTH_URL = "http://guard.test/health";

test("happy path: /guard/status 2xx JSON yields the full normalized result", async () => {
  const { calls, fetchImpl } = mockFetch({
    [STATUS_URL]: {
      json: {
        status: "running",
        heldRequests: 3,
        crashTimeline: [{ at: "2026-10-28T10:00:00.000Z", kind: "crash", detail: "OOM kill" }],
      },
    },
  });
  const r = await probeGuard(EP, { fetchImpl, now: NOW });
  assert.equal(r.id, "guard-a");
  assert.equal(r.label, "Guard A");
  assert.equal(r.present, true);
  assert.equal(r.status, "running");
  assert.equal(r.heldRequests, 3);
  assert.deepEqual(r.crashTimeline, [{ at: "2026-10-28T10:00:00.000Z", kind: "crash", detail: "OOM kill" }]);
  assert.equal(r.checkedAt, ISO_NOW);
  assert.equal(r.reason, null);
  // health fallback must NOT be called when the guard endpoint answers
  assert.deepEqual(calls, [STATUS_URL]);
});

test("health fallback: /guard/status 404 falls back to /health, using status only", async () => {
  const { calls, fetchImpl } = mockFetch({
    [STATUS_URL]: { status: 404 },
    [HEALTH_URL]: { json: { status: "degraded", uptimeSeconds: 99999, noise: {} } },
  });
  const r = await probeGuard(EP, { fetchImpl, now: NOW });
  assert.equal(r.present, true);
  assert.equal(r.status, "degraded");
  assert.equal(r.heldRequests, null);
  assert.deepEqual(r.crashTimeline, []);
  assert.equal(r.reason, null);
  assert.deepEqual(calls, [STATUS_URL, HEALTH_URL]);
});

test("heldRequests: count kept, negative / non-number / NaN clamped to null", () => {
  assert.equal(normalizeGuardStatus(EP, { status: "running", heldRequests: 0 }, { now: NOW }).heldRequests, 0);
  assert.equal(normalizeGuardStatus(EP, { status: "running", heldRequests: 12 }, { now: NOW }).heldRequests, 12);
  assert.equal(normalizeGuardStatus(EP, { status: "running", heldRequests: -2 }, { now: NOW }).heldRequests, null);
  assert.equal(normalizeGuardStatus(EP, { status: "running", heldRequests: "4" }, { now: NOW }).heldRequests, null);
  assert.equal(normalizeGuardStatus(EP, { status: "running", heldRequests: NaN }, { now: NOW }).heldRequests, null);
});

test("crashTimeline: coerces good entries, drops junk, numeric at becomes ISO", () => {
  const epoch = 1_761_650_000_000;
  const raw = {
    status: "running",
    crashTimeline: [
      { at: "2026-10-28T10:00:00.000Z", kind: "crash", detail: "segv" },
      "junk string",
      null,
      42,
      [{ nested: "array entry" }],
      { at: epoch, kind: "boot" },
      { detail: "neither at nor kind" },
      { at: "T2", kind: "signal", detail: 99 },
    ],
  };
  const r = normalizeGuardStatus(EP, raw, { now: NOW });
  assert.deepEqual(r.crashTimeline, [
    { at: "2026-10-28T10:00:00.000Z", kind: "crash", detail: "segv" },
    { at: new Date(epoch).toISOString(), kind: "boot", detail: null },
    { at: "T2", kind: "signal", detail: null },
  ]);
});

test("ECONNREFUSED on both endpoints settles as present:false reason unreachable", async () => {
  const { calls, fetchImpl } = mockFetch({});
  const r = await probeGuard(EP, { fetchImpl, now: NOW });
  assert.equal(r.present, false);
  assert.equal(r.reason, "unreachable");
  assert.equal(r.status, "unknown");
  assert.equal(r.checkedAt, ISO_NOW);
  assert.deepEqual(calls, [STATUS_URL, HEALTH_URL]);
});

test("timeout: fetchImpl that dies on abort reports reason timeout", async () => {
  const { fetchImpl } = mockFetch({
    [STATUS_URL]: { abort: true },
    [HEALTH_URL]: { abort: true },
  });
  const r = await probeGuard(EP, { fetchImpl, timeoutMs: 5, now: NOW });
  assert.equal(r.present, false);
  assert.equal(r.reason, "timeout");
});

test("malformed JSON bodies on both endpoints report reason malformed", async () => {
  const { fetchImpl } = mockFetch({
    [STATUS_URL]: { badJson: true, json: null },
    [HEALTH_URL]: { badJson: true, json: null },
  });
  const r = await probeGuard(EP, { fetchImpl, now: NOW });
  assert.equal(r.present, false);
  assert.equal(r.reason, "malformed");
});

test("non-2xx responses surface as http-<code> from the final attempt", async () => {
  const { fetchImpl } = mockFetch({
    [STATUS_URL]: { status: 503 },
    [HEALTH_URL]: { status: 503 },
  });
  const r = await probeGuard(EP, { fetchImpl, now: NOW });
  assert.equal(r.present, false);
  assert.equal(r.reason, "http-503");
});

test("non-object JSON (array) is malformed, on the fallback too", async () => {
  const { fetchImpl } = mockFetch({
    [STATUS_URL]: { json: [1, 2, 3] },
    [HEALTH_URL]: { json: [] },
  });
  const r = await probeGuard(EP, { fetchImpl, now: NOW });
  assert.equal(r.present, false);
  assert.equal(r.reason, "malformed");
});

test("probeAll settles without rejects, preserves order and ids, per-entry reasons", async () => {
  const eps = [
    { id: "a", label: "A", baseUrl: "http://g1.test" },
    { id: "b", label: "B", baseUrl: "http://g2.test" },
    { id: "c", label: "C", baseUrl: "http://g3.test" },
  ];
  const { fetchImpl } = mockFetch({
    "http://g1.test/guard/status": { json: { status: "running", heldRequests: 1 } },
    // g2 missing from routes: both attempts ECONNREFUSED
    "http://g3.test/guard/status": { status: 500 },
    "http://g3.test/health": { status: 500 },
  });
  const results = await probeAll(eps, { fetchImpl, now: NOW });
  assert.deepEqual(results.map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual(results.map((r) => r.present), [true, false, false]);
  assert.equal(results[0].heldRequests, 1);
  assert.equal(results[1].reason, "unreachable");
  assert.equal(results[2].reason, "http-500");
});

test("probeAll never rejects even when a probe itself throws (broken now)", async () => {
  const bomb = () => {
    throw new Error("now exploded");
  };
  const { fetchImpl } = mockFetch({ [STATUS_URL]: { json: { status: "running" } } });
  const results = await probeAll([EP], { fetchImpl, now: bomb });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "guard-a");
  assert.equal(results[0].present, false);
  assert.equal(results[0].reason, "unreachable");
  assert.equal(typeof results[0].checkedAt, "string");
});

test("normalizeGuardStatus(null) is present:false with safe defaults", () => {
  const r = normalizeGuardStatus(EP, null, { now: NOW });
  assert.equal(r.present, false);
  assert.equal(r.status, "unknown");
  assert.equal(r.heldRequests, null);
  assert.deepEqual(r.crashTimeline, []);
  assert.equal(r.reason, "malformed");
  assert.equal(r.checkedAt, ISO_NOW);
});

test("status vocabulary and reason forcing: foreign status → unknown, reason forces absent", () => {
  assert.equal(normalizeGuardStatus(EP, { status: "exploded" }, { now: NOW }).status, "unknown");
  assert.equal(normalizeGuardStatus(EP, { status: "stopped" }, { now: NOW }).status, "stopped");
  const forced = normalizeGuardStatus(EP, { status: "running", heldRequests: 7 }, { reason: "timeout", now: NOW });
  assert.equal(forced.present, false);
  assert.equal(forced.reason, "timeout");
  assert.equal(forced.status, "unknown");
  assert.equal(forced.heldRequests, null);
});

test("baseUrl handling: trailing slash trimmed, non-string baseUrl settles malformed", async () => {
  const { calls, fetchImpl } = mockFetch({ [STATUS_URL]: { json: { status: "running" } } });
  const slashed = await probeGuard({ ...EP, baseUrl: "http://guard.test/" }, { fetchImpl, now: NOW });
  assert.equal(slashed.present, true);
  assert.deepEqual(calls, [STATUS_URL]);
  const broken = await probeGuard({ id: "x", label: "X", baseUrl: 42 }, { fetchImpl, now: NOW });
  assert.equal(broken.present, false);
  assert.equal(broken.reason, "malformed");
});

// ─── GUARD1 (#95): keepalive-proxy probe ─────────────────────────────
//
// Different contract from the S4.1a guards: /health (fallback /), 401/403
// count as ALIVE (SRV1 auth-gate convention), metrics are optional, and an
// unset baseUrl is "not-configured" — the empty state must say why.

const PX = { id: "gp", label: "Guard proxy", baseUrl: "http://guard.test:8081" };
const PX_HEALTH = "http://guard.test:8081/health";
const PX_ROOT = "http://guard.test:8081/";

test("guard proxy alive: /health JSON yields uptime + request count", async () => {
  const { calls, fetchImpl } = mockFetch({
    [PX_HEALTH]: { json: { status: "ok", uptime: 3725, requests: 41 } },
  });
  const r = await probeKeepaliveProxy(PX, { fetchImpl, now: NOW });
  assert.deepEqual(calls, [PX_HEALTH]);
  assert.equal(r.present, true);
  assert.equal(r.alive, true);
  assert.equal(r.authGate, false);
  assert.equal(r.status, "alive");
  assert.equal(r.uptimeSeconds, 3725);
  assert.equal(r.requestCount, 41);
  assert.equal(r.hasMetrics, true);
  assert.equal(r.reason, null);
  assert.equal(r.checkedAt, ISO_NOW);
});

test("guard proxy 401 and 403 are alive via the auth gate, without metrics", async () => {
  for (const status of [401, 403]) {
    const { calls, fetchImpl } = mockFetch({ [PX_HEALTH]: { status } });
    const r = await probeKeepaliveProxy(PX, { fetchImpl, now: NOW });
    assert.equal(r.alive, true, `status ${status} must be alive`);
    assert.equal(r.authGate, true);
    assert.equal(r.hasMetrics, false);
    assert.equal(r.uptimeSeconds, null);
    assert.equal(r.requestCount, null);
    assert.equal(r.reason, null);
    // The gate answered; no pointless fallback call.
    assert.deepEqual(calls, [PX_HEALTH]);
  }
});

test("guard proxy dead: both endpoints refuse → down with the fallback reason", async () => {
  const { calls, fetchImpl } = mockFetch({});
  const r = await probeKeepaliveProxy(PX, { fetchImpl, now: NOW });
  assert.deepEqual(calls, [PX_HEALTH, PX_ROOT]);
  assert.equal(r.alive, false);
  assert.equal(r.status, "down");
  assert.equal(r.reason, "unreachable");
});

test("guard proxy /health 502 falls back to / and scores the fallback", async () => {
  const { fetchImpl } = mockFetch({
    [PX_HEALTH]: { status: 502 },
    [PX_ROOT]: { status: 401 },
  });
  const r = await probeKeepaliveProxy(PX, { fetchImpl, now: NOW });
  assert.equal(r.alive, true);
  assert.equal(r.authGate, true);
});

test("guard proxy 2xx without usable metrics still proves liveness", async () => {
  const cases = [
    { json: {} }, // object, no metric fields
    { badJson: true }, // unparseable body
    { json: [1, 2, 3] }, // array body: alive, nothing to pick
  ];
  for (const route of cases) {
    const { fetchImpl } = mockFetch({ [PX_HEALTH]: route });
    const r = await probeKeepaliveProxy(PX, { fetchImpl, now: NOW });
    assert.equal(r.alive, true);
    assert.equal(r.hasMetrics, false);
    assert.equal(r.uptimeSeconds, null);
    assert.equal(r.requestCount, null);
  }
});

test("guard proxy metric key shapes: uptime_seconds / recent_requests / requests_total", async () => {
  const { fetchImpl } = mockFetch({
    [PX_HEALTH]: { json: { uptime_seconds: 60, recent_requests: 3 } },
  });
  const a = await probeKeepaliveProxy(PX, { fetchImpl, now: NOW });
  assert.equal(a.uptimeSeconds, 60);
  assert.equal(a.requestCount, 3);
  const { fetchImpl: f2 } = mockFetch({ [PX_ROOT]: { json: { requests_total: 9 } } });
  const b = await probeKeepaliveProxy(PX, { fetchImpl: f2, now: NOW });
  assert.equal(b.requestCount, 9);
  assert.equal(b.hasMetrics, true);
});

test("guard proxy not configured: empty baseUrl says so, no fetch at all", async () => {
  let fetched = 0;
  const r = await probeKeepaliveProxy({ id: "gp", baseUrl: "" }, {
    fetchImpl: async () => {
      fetched += 1;
      throw new Error("must not fetch");
    },
    now: NOW,
  });
  assert.equal(fetched, 0);
  assert.equal(r.status, "not-configured");
  assert.equal(r.reason, "not-configured");
  assert.equal(r.alive, false);
});

test("guard proxy sends the bearer key resolved from apiKeyRef", async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push(init?.headers);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const resolveApiKeyRef = (ref) => (ref === "env:GP_KEY" ? "sekret" : null);
  const r = await probeKeepaliveProxy(
    { ...PX, apiKeyRef: "env:GP_KEY" },
    { fetchImpl, resolveApiKeyRef, now: NOW }
  );
  assert.equal(r.alive, true);
  assert.equal(seen[0]?.Authorization, "Bearer sekret");
});

test("findEngineBehindProxy matches SRV1 service truth by proxyPort, host match preferred", () => {
  const snaps = [
    { id: "other", lanIp: "10.0.0.9", services: [{ name: "served", engine: "sglang", port: 9000, proxyPort: 8081, model: null }] },
    { id: "n1", lanIp: "192.168.50.226", services: [
      { name: "qwen", engine: "vllm", port: 8080, proxyPort: 8081, model: "qwen3-32b" },
      { name: "noise", engine: "vllm", port: 8090, proxyPort: 8091, model: "x" },
    ] },
  ];
  const byHost = findEngineBehindProxy(snaps, { port: 8081, host: "192.168.50.226" });
  assert.deepEqual(byHost, { sparkId: "n1", name: "qwen", engine: "vllm", model: "qwen3-32b", enginePort: 8080 });
  const byPortOnly = findEngineBehindProxy(snaps, { port: 8081 });
  assert.equal(byPortOnly.sparkId, "other"); // first port match wins without a host
  assert.equal(findEngineBehindProxy(snaps, { port: 9999 }), null);
  assert.equal(findEngineBehindProxy(snaps, { port: "8081" }), null);
  assert.equal(findEngineBehindProxy(null, { port: 8081 }), null);
});
