/**
 * componentActions.js — dashboard-server side of the v2 component-action
 * seam (docs/COMPONENTS-DESIGN-PROPOSAL.md §7; shared/types.ts
 * ComponentActionRequest / ComponentActionResult).
 *
 * The dashboard (Components/Library tab) speaks ONLY to this server; the
 * node agent is never contacted directly from the browser. This module owns
 * the server half of the seam:
 *
 *   buildComponentAction(body, { nodeId, actor })
 *     → ComponentActionRequest: validates the browser payload, generates the
 *       actionId (the browser never mints idempotency keys), stamps nodeId
 *       from the ROUTE (a body nodeId can never target another spark), and
 *       stamps actor from the authenticated session.
 *
 *   proxyComponentAction(rec, request, fetchImpl)
 *     → {status, body}: POSTs the v2 request to that node's agent
 *       POST /actions. Fetch semantics mirror the existing updates proxy
 *       (proxyUpdatesAction in index.js) byte-for-byte in spirit:
 *       405 → 501 (telemetry-only deployed build), non-ok → 502 with the
 *       upstream error, transport failure → 502. The agent is the validator
 *       of last resort — the server does not duplicate its schema check, it
 *       only guarantees the envelope fields it owns.
 *
 * Group (tp=x) fan-out, sequencing and downtime preview (SC8) compose
 * multiple single-target calls of this module; one call here always names
 * ONE component on ONE spark.
 */
import { randomUUID } from "node:crypto";

/** v2 verbs (shared/types.ts ComponentActionType). */
const TYPES = ["start", "stop", "restart"];

/**
 * Build a v2 ComponentActionRequest from a browser payload.
 *
 * @param {Record<string, unknown>} body parsed JSON body from the dashboard
 * @param {{nodeId: string, actor?: string|null, actionId?: () => string}} ctx
 *   nodeId comes from the ROUTE (/api/fleet/nodes/:id/component-actions);
 *   actor from the authenticated session (audit-only).
 * @returns {{ok: true, request: object} | {ok: false, status: number, error: string}}
 */
export function buildComponentAction(body, ctx) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "body must be a JSON object" };
  }
  const issues = [];
  const pick = (k, def = null) => (body[k] === undefined ? def : body[k]);

  const componentId = pick("componentId");
  if (typeof componentId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(componentId))
    issues.push("componentId must match ^[a-z0-9][a-z0-9-]{0,63}$");
  const type = pick("type");
  if (!TYPES.includes(type)) issues.push(`type must be one of ${TYPES.join("|")}`);
  const groupRef = pick("groupRef");
  if (groupRef !== null && typeof groupRef !== "string") issues.push("groupRef must be string or null");
  const exclusiveWith = pick("exclusiveWith");
  if (exclusiveWith !== null && typeof exclusiveWith !== "string")
    issues.push("exclusiveWith must be string or null");
  if (exclusiveWith != null && exclusiveWith === componentId)
    issues.push("exclusiveWith must name a different component");
  if (type !== "start" && exclusiveWith != null)
    issues.push("exclusiveWith is only valid with type start");
  const confirmationToken = pick("confirmationToken");
  if (confirmationToken !== null && typeof confirmationToken !== "string")
    issues.push("confirmationToken must be string or null");
  const dryRun = pick("dryRun", false);
  if (typeof dryRun !== "boolean") issues.push("dryRun must be a boolean");
  const recipeName = pick("recipeName");
  if (recipeName !== null && typeof recipeName !== "string") issues.push("recipeName must be string or null");
  const timeoutMs = pick("timeoutMs");
  if (timeoutMs !== null && !(typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0))
    issues.push("timeoutMs must be positive number or null");

  if (issues.length > 0) return { ok: false, status: 400, error: issues.join("; ") };

  const makeId = typeof ctx?.actionId === "function" ? ctx.actionId : randomUUID;
  return {
    ok: true,
    request: {
      version: 2,
      actionId: makeId(),
      componentId,
      type,
      nodeId: String(ctx.nodeId), // route wins; body cannot retarget
      groupRef,
      exclusiveWith,
      confirmationToken,
      dryRun,
      recipeName,
      timeoutMs,
      actor: typeof ctx?.actor === "string" ? ctx.actor : null,
    },
  };
}

/**
 * Proxy one ComponentActionRequest to the node agent POST /actions.
 * Mirrors proxyUpdatesAction's status mapping (that route stays the
 * precedent; this one exists so component actions keep their own timeout
 * budget — a 12-minute boot must not share the updates 60 s window).
 *
 * @param {{endpoint?: string, lanIp?: string, agentPort?: number}} rec registry record
 * @param {object} request validated ComponentActionRequest
 * @param {{fetchImpl?: (url: string, init: object) => Promise<any>, timeoutMs?: number}} [opts]
 * @returns {{status: number, body: object}}
 */
export async function proxyComponentAction(rec, request, opts = {}) {
  const doFetch = typeof opts.fetchImpl === "function" ? opts.fetchImpl : fetch;
  const timeoutMs = opts.timeoutMs ?? request?.timeoutMs ?? 20 * 60_000; // boot-class budget
  const endpoint = (rec.endpoint || `${rec.lanIp}:${rec.agentPort}`).replace(/\/+$/, "");
  try {
    const upstream = await doFetch(`http://${endpoint}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await upstream.json().catch(() => null);
    if (upstream.status === 405) {
      return {
        status: 501,
        body: {
          error:
            "The node agent on this node is a telemetry-only build (no /actions endpoint yet). Component actions are available once an agent build that ships the actions endpoint is deployed.",
        },
      };
    }
    if (!upstream.ok) {
      return { status: 502, body: { error: body?.error || `Node agent responded ${upstream.status}` } };
    }
    return { status: 200, body: body ?? { ok: true } };
  } catch (err) {
    return { status: 502, body: { error: `Node agent unreachable: ${err.message}` } };
  }
}
