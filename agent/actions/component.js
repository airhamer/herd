/**
 * component.js — v2 component-action seam primitives (shared/types.ts §
 * Component actions; docs/COMPONENTS-DESIGN-PROPOSAL.md §7).
 *
 * Pure helpers, no execution: parsing/validation of ComponentActionRequest,
 * the confirmation-token mint/verify pair, the v2 → v1 downgrade adapter
 * (start/stop/restart 1:1; v2 never produces a v1 `switch`), and the
 * ComponentActionResult envelope builders. dispatch.js (component dispatch)
 * composes these with docker.js / systemd.js / llm-switch.js verbs; this
 * module never touches child processes or the network.
 *
 * Invariants:
 *  - A v2 request that fails validation returns an issue list, never throws.
 *  - Tokens are HMAC(componentId|type|nodeId|exclusiveWith|issuedAt, secret)
 *    bound to the exact plan; a replay against a different plan mismatches.
 *  - downgradeToV1 is total: every v2 verb maps onto an existing v1 verb so
 *    an old ActionRequest consumer (telemetry-only agent builds) can still
 *    be told the goal state (it will 405; that is the deployed-build case).
 */
import { createHmac } from "node:crypto";

/** V2 verbs (shared/types.ts ComponentActionType). */
export const COMPONENT_ACTION_TYPES = ["start", "stop", "restart"];

/** Token TTL: a dry-run plan is only valid briefly (live state drifts). */
export const CONFIRM_TOKEN_TTL_MS = 10 * 60 * 1000;

const COMPONENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Validate a raw ComponentActionRequest. Returns { ok, issues }.
 * Never throws; the HTTP layer maps issues to 400 { error }.
 *
 * @param {unknown} raw
 * @returns {{ok: boolean, issues: string[]}}
 */
export function validateComponentActionRequest(raw) {
  const issues = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: ["request must be a JSON object"] };
  }
  const r = /** @type {Record<string, unknown>} */ (raw);

  if (r.version !== 2) issues.push("version must be 2 (v2 seam)");
  if (typeof r.actionId !== "string" || r.actionId.trim() === "")
    issues.push("actionId is required (non-empty string)");
  if (typeof r.componentId !== "string" || !COMPONENT_ID_RE.test(r.componentId))
    issues.push(`componentId must match ${COMPONENT_ID_RE.source}`);
  if (!COMPONENT_ACTION_TYPES.includes(r.type))
    issues.push(`type must be one of ${COMPONENT_ACTION_TYPES.join("|")}`);
  if (typeof r.nodeId !== "string" || r.nodeId.trim() === "")
    issues.push("nodeId is required (target spark)");
  if (r.groupRef != null && typeof r.groupRef !== "string")
    issues.push("groupRef must be a string or null");
  if (r.exclusiveWith != null && typeof r.exclusiveWith !== "string")
    issues.push("exclusiveWith must be a string or null");
  if (r.type === "start" && r.exclusiveWith === r.componentId)
    issues.push("exclusiveWith must name a DIFFERENT component (nothing to displace)");
  if (r.type !== "start" && r.exclusiveWith != null)
    issues.push(`exclusiveWith is only meaningful for start (got type ${String(r.type)})`);
  if (r.confirmationToken != null && typeof r.confirmationToken !== "string")
    issues.push("confirmationToken must be a string or null");
  if (typeof r.dryRun !== "boolean") issues.push("dryRun must be a boolean");
  if (r.recipeName != null && typeof r.recipeName !== "string")
    issues.push("recipeName must be a string or null");
  if (r.timeoutMs != null && !(typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs) && r.timeoutMs > 0))
    issues.push("timeoutMs must be a positive number or null");
  if (r.actor != null && typeof r.actor !== "string")
    issues.push("actor must be a string or null");

  return { ok: issues.length === 0, issues };
}

/** Canonical plan key the token binds to. */
function planKey(r) {
  return [r.componentId, r.type, r.nodeId, r.exclusiveWith ?? "", r.recipeName ?? ""].join("|");
}

/**
 * Mint a confirmation token for a dry-run plan (agent side).
 * Format: `${issuedAt}.${base64url(hmac)}`.
 *
 * @param {{componentId: string, type: string, nodeId: string, exclusiveWith?: string|null, recipeName?: string|null}} plan
 * @param {string} secret node agent's HMAC secret
 * @param {() => number} [clock] injectable clock (tests)
 * @returns {string}
 */
export function mintConfirmationToken(plan, secret, clock = Date.now) {
  const issuedAt = clock();
  const sig = hmac(`${planKey(plan)}|${issuedAt}`, secret);
  return `${issuedAt}.${sig}`;
}

/**
 * Verify a confirmation token against the presenting request's plan.
 *
 * @param {string|null|undefined} token
 * @param {{componentId: string, type: string, nodeId: string, exclusiveWith?: string|null, recipeName?: string|null}} plan the PRESENTING request's plan (must equal the dry-run plan)
 * @param {string} secret
 * @param {{now?: () => number, ttlMs?: number}} [opts]
 * @returns {{ok: boolean, reason: string|null}}
 */
export function verifyConfirmationToken(token, plan, secret, opts = {}) {
  if (typeof token !== "string" || token === "") return { ok: false, reason: "missing" };
  const dot = token.indexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const issuedAt = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(issuedAt)) return { ok: false, reason: "malformed" };
  const now = (opts.now ?? Date.now)();
  const ttl = opts.ttlMs ?? CONFIRM_TOKEN_TTL_MS;
  if (now - issuedAt > ttl) return { ok: false, reason: "expired" };
  const expect = hmac(`${planKey(plan)}|${issuedAt}`, secret);
  if (expect !== sig) return { ok: false, reason: "mismatch" };
  return { ok: true, reason: null };
}

/** HMAC-SHA256, base64url (node:crypto only; no new deps). */
function hmac(payload, secret) {
  return createHmac("sha256", String(secret)).update(payload, "utf8").digest("base64url");
}

/**
 * Downgrade a v2 request to the legacy v1 ActionRequest so an ActionRequest
 * consumer can act on start/stop/restart goal states. v2 never produces a
 * v1 `switch` (the handoff lives in `exclusiveWith` + take-turn dispatch).
 *
 * @param {object} r a VALIDATED ComponentActionRequest
 * @param {{serviceName: string, port: number|null}} resolved materialized recipe info
 * @returns {object} ActionRequest (shared/types.ts v1)
 */
export function downgradeToV1(r, resolved) {
  return {
    actionId: r.actionId,
    type: r.type,
    serviceName: resolved.serviceName,
    port: resolved.port,
    modelId: null,
    engine: null,
    contextLength: null,
    memFraction: null,
    tpSize: null,
    idempotent: true,
    timeoutMs: r.timeoutMs ?? null,
  };
}

/**
 * Start-envelope for a ComponentActionResult (callers fill in the outcome
 * fields). Keeps the seam's required keys present on every reply, including
 * error replies from validation failures.
 *
 * @param {object} r validated/partial request
 * @returns {object} ComponentActionResult skeleton (status failure, ok false)
 */
export function componentResultEnvelope(r) {
  return {
    version: 2,
    actionId: typeof r?.actionId === "string" ? r.actionId : "",
    componentId: typeof r?.componentId === "string" ? r.componentId : "",
    nodeId: typeof r?.nodeId === "string" ? r.nodeId : "",
    type: COMPONENT_ACTION_TYPES.includes(r?.type) ? r.type : "start",
    status: "failure",
    ok: false,
    message: "",
    error: null,
    canaryState: null,
    steps: [],
    state: null,
    traffic: null,
    plan: null,
    logs: null,
    durationMs: null,
    at: Date.now(),
  };
}
