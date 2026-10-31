/**
 * component.test.js — v2 component-action seam primitives.
 * node --test, no deps, mirrors the existing actions test style.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPONENT_ACTION_TYPES,
  CONFIRM_TOKEN_TTL_MS,
  validateComponentActionRequest,
  mintConfirmationToken,
  verifyConfirmationToken,
  downgradeToV1,
  componentResultEnvelope,
} from "../component.js";

const BASE = {
  version: 2,
  actionId: "7a1f2c3e-0000-4000-8000-000000000001",
  componentId: "qwen38-27b-stock-sglang-tp1-gx10",
  type: "start",
  nodeId: "gx10-1c2c",
  groupRef: null,
  exclusiveWith: null,
  confirmationToken: null,
  dryRun: true,
  recipeName: null,
  timeoutMs: null,
  actor: "dashboard:steve",
};

test("v2 verbs are start|stop|restart (switch is gone)", () => {
  assert.deepEqual(COMPONENT_ACTION_TYPES, ["start", "stop", "restart"]);
});

test("valid dry-run start passes validation", () => {
  const r = validateComponentActionRequest(BASE);
  assert.equal(r.ok, true, r.issues.join("; "));
});

test("v1 request body is rejected with v2 issues (switch no longer accepted)", () => {
  const r = validateComponentActionRequest({
    actionId: "a",
    type: "switch",
    serviceName: "llm-tp1",
    port: 30000,
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.includes("version must be 2")));
  assert.ok(r.issues.some((i) => i.includes("type must be one of start|stop|restart")));
});

test("componentId slug regex enforced", () => {
  for (const bad of ["", "UPPER", "-lead", "spaced id", "x".repeat(65)]) {
    const r = validateComponentActionRequest({ ...BASE, componentId: bad });
    assert.equal(r.ok, false, `expected reject: ${JSON.stringify(bad)}`);
  }
});

test("exclusiveWith self-displacement rejected", () => {
  const r = validateComponentActionRequest({ ...BASE, exclusiveWith: BASE.componentId });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.includes("DIFFERENT component")));
});

test("exclusiveWith on non-start verbs rejected", () => {
  for (const type of ["stop", "restart"]) {
    const r = validateComponentActionRequest({ ...BASE, type, exclusiveWith: "other-comp" });
    assert.equal(r.ok, false, type);
    assert.ok(r.issues.some((i) => i.includes("only meaningful for start")), type);
  }
});

test("timeoutMs must be positive or null", () => {
  for (const bad of [0, -5, "3000", NaN, {}]) {
    const r = validateComponentActionRequest({ ...BASE, timeoutMs: bad });
    assert.equal(r.ok, false, `expected reject: ${String(bad)}`);
  }
  assert.equal(validateComponentActionRequest({ ...BASE, timeoutMs: 90000 }).ok, true);
});

test("confirmation token round-trips for the SAME plan", () => {
  const plan = { componentId: "c", type: "start", nodeId: "n", exclusiveWith: "d" };
  const t = mintConfirmationToken(plan, "sec", () => 1000);
  const v = verifyConfirmationToken(t, plan, "sec", { now: () => 1000 + 60_000 });
  assert.deepEqual(v, { ok: true, reason: null });
});

test("token bound to exact plan: any field change mismatches", () => {
  const plan = { componentId: "c", type: "start", nodeId: "n", exclusiveWith: null };
  const t = mintConfirmationToken(plan, "sec", () => 1000);
  const mutations = [
    { ...plan, componentId: "c2" },
    { ...plan, type: "stop" },
    { ...plan, nodeId: "n2" },
    { ...plan, exclusiveWith: "d" },
  ];
  for (const m of mutations) {
    const v = verifyConfirmationToken(t, m, "sec", { now: () => 1500 });
    assert.deepEqual(v, { ok: false, reason: "mismatch" }, JSON.stringify(m));
  }
});

test("token expiry, malformed, missing, wrong-secret all fail closed", () => {
  const plan = { componentId: "c", type: "start", nodeId: "n" };
  const t = mintConfirmationToken(plan, "sec", () => 1000);
  assert.deepEqual(
    verifyConfirmationToken(t, plan, "sec", { now: () => 1000 + CONFIRM_TOKEN_TTL_MS + 1 }),
    { ok: false, reason: "expired" }
  );
  assert.deepEqual(verifyConfirmationToken("garbage", plan, "sec"), { ok: false, reason: "malformed" });
  assert.deepEqual(verifyConfirmationToken(null, plan, "sec"), { ok: false, reason: "missing" });
  assert.deepEqual(verifyConfirmationToken(t, plan, "other", { now: () => 1500 }), {
    ok: false,
    reason: "mismatch",
  });
});

test("downgradeToV1 maps verbs 1:1 and never emits switch", () => {
  for (const type of COMPONENT_ACTION_TYPES) {
    const v1 = downgradeToV1({ actionId: "a", type, timeoutMs: 5000 }, { serviceName: "llm-tp1", port: 30000 });
    assert.equal(v1.type, type);
    assert.equal(v1.serviceName, "llm-tp1");
    assert.equal(v1.port, 30000);
    assert.equal(v1.idempotent, true);
  }
  assert.equal(downgradeToV1({ actionId: "a", type: "stop", timeoutMs: null }, { serviceName: "s", port: null }).port, null);
});

test("result envelope always carries the v2 keys, unknown type falls back", () => {
  const e = componentResultEnvelope({ actionId: "a", componentId: "c", nodeId: "n", type: "bogus" });
  assert.equal(e.version, 2);
  assert.equal(e.type, "start");
  assert.equal(e.status, "failure");
  assert.equal(e.ok, false);
  assert.deepEqual(e.steps, []);
  assert.equal(e.plan, null);
  assert.equal(e.logs, null);
  for (const k of ["actionId", "componentId", "nodeId", "canaryState", "state", "traffic", "durationMs", "at"]) {
    assert.ok(k in e, `missing key ${k}`);
  }
});
