/**
 * componentActions.test.js — server half of the v2 component-action seam.
 * buildComponentAction is pure; proxyComponentAction takes fetchImpl
 * (zero real endpoints, zero servers — same discipline as the fleet suite).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildComponentAction, proxyComponentAction } from "../componentActions.js";

const OK_BODY = {
  componentId: "qwen38-27b-stock-sglang-tp1-gx10",
  type: "start",
};

test("buildComponentAction: server owns version/actionId/nodeId/actor", () => {
  const built = buildComponentAction(
    { ...OK_BODY, nodeId: "EVIL-other-node", actionId: "browser-minted", version: 2, actor: "spoof" },
    { nodeId: "gx10-1c2c", actor: "dashboard:steve", actionId: () => "srv-uuid-1" }
  );
  assert.equal(built.ok, true, built.error);
  assert.equal(built.request.version, 2);
  assert.equal(built.request.actionId, "srv-uuid-1", "server mints actionId");
  assert.equal(built.request.nodeId, "gx10-1c2c", "route wins over body");
  assert.equal(built.request.actor, "dashboard:steve", "session wins over body");
});

test("buildComponentAction: absent optional fields default to null/false", () => {
  const { request } = buildComponentAction(OK_BODY, { nodeId: "n" });
  assert.equal(request.groupRef, null);
  assert.equal(request.exclusiveWith, null);
  assert.equal(request.confirmationToken, null);
  assert.equal(request.dryRun, false, "dryRun defaults false; a real change needs the explicit flag");
  assert.equal(request.recipeName, null);
  assert.equal(request.timeoutMs, null);
});

test("buildComponentAction: 400 on bad payloads (each field class)", () => {
  const bad = [
    null,
    "string",
    [],
    { type: "start", dryRun: true }, // no componentId
    { componentId: "UPPER", type: "stop", dryRun: false },
    { ...OK_BODY, type: "switch" }, // v1 verb is gone
    { ...OK_BODY, dryRun: "yes" },
    { ...OK_BODY, timeoutMs: 0 },
    { ...OK_BODY, groupRef: 42 },
    { ...OK_BODY, exclusiveWith: OK_BODY.componentId }, // self-displace
    { componentId: "c", type: "start", dryRun: "yes", exclusiveWith: "d" },
    { ...OK_BODY, confirmationToken: 7 },
  ];
  for (const b of bad) {
    const r = buildComponentAction(b, { nodeId: "n" });
    assert.equal(r.ok, false, JSON.stringify(b));
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.ok(r.error.length > 0);
  }
});

test("buildComponentAction: valid start with stated handoff passes through", () => {
  const r = buildComponentAction(
    { ...OK_BODY, exclusiveWith: "qwen38-flash-next-sglang-tp1-gx10", confirmationToken: "10.tok" },
    { nodeId: "n" }
  );
  assert.equal(r.ok, true, r.error);
  assert.equal(r.request.exclusiveWith, "qwen38-flash-next-sglang-tp1-gx10");
  assert.equal(r.request.confirmationToken, "10.tok");
});

function fakeFetch(capture) {
  return async (url, init) => {
    capture.url = url;
    capture.init = init;
    return {
      status: capture.status ?? 200,
      ok: (capture.status ?? 200) >= 200 && (capture.status ?? 200) < 300,
      json: async () => capture.body ?? { ok: true },
    };
  };
}

test("proxyComponentAction: posts v2 body to the agent endpoint verbatim", async () => {
  const cap = { status: 200, body: { version: 2, actionId: "a", status: "success", ok: true } };
  const req = { version: 2, actionId: "a", componentId: "c", type: "start", nodeId: "n" };
  const out = await proxyComponentAction(
    { lanIp: "10.0.0.5", agentPort: 8123 },
    req,
    { fetchImpl: fakeFetch(cap) }
  );
  assert.equal(cap.url, "http://10.0.0.5:8123/actions");
  assert.equal(cap.init.method, "POST");
  assert.deepEqual(JSON.parse(cap.init.body), req, "request is forwarded verbatim (no silent rewrite)");
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
});

test("proxyComponentAction: endpoint field overrides lanIp:agentPort", async () => {
  const cap = {};
  await proxyComponentAction(
    { endpoint: "127.0.0.1:9999/", lanIp: "ignored", agentPort: 1 },
    { version: 2 },
    { fetchImpl: fakeFetch(cap) }
  );
  assert.equal(cap.url, "http://127.0.0.1:9999/actions");
});

test("proxyComponentAction: 405 upstream maps to 501 telemetry-only", async () => {
  const out = await proxyComponentAction({ endpoint: "http://h:1" }, {}, {
    fetchImpl: fakeFetch({ status: 405, body: { error: "method not allowed" } }),
  });
  assert.equal(out.status, 501);
  assert.match(out.body.error, /telemetry-only build/);
});

test("proxyComponentAction: upstream 4xx/5xx maps to 502 with upstream error", async () => {
  const out = await proxyComponentAction({ endpoint: "http://h:1" }, {}, {
    fetchImpl: fakeFetch({ status: 409, body: { error: "confirmation token expired" } }),
  });
  assert.equal(out.status, 502);
  assert.equal(out.body.error, "confirmation token expired");
});

test("proxyComponentAction: transport failure maps to 502 unreachable", async () => {
  const out = await proxyComponentAction({ endpoint: "http://h:1" }, {}, {
    fetchImpl: async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), {});
    },
  });
  assert.equal(out.status, 502);
  assert.match(out.body.error, /Node agent unreachable/);
});
