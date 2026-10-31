// ─── SC8 downtime/execute flow (IMPLEMENTATION_PLAN.md SC8; docs/COMPONENTS-
//     DESIGN-PROPOSAL.md §"plans do" sequencing, §7 seam ownership) ──────────
//
// The "shutdown sequence to free, then startup (parallel per stack); preview
// + live" piece, composed ENTIRELY on the existing server/fleet foundation:
//
//   buildDowntimePreview(plan) → DowntimePreview   // pure, deterministic
//   executeDowntimeSequence(preview, opts)          // walks the preview LIVE
//
// A stack plan names what each stack wants changed: { stacks: [{ stackId,
// nodes, components: [{ nodeId, component, action }] }], targetFreeBytes }.
// Each component's components array is given in DEPENDENCY ORDER (what must
// come up first is listed first) — the preview derives the two phases:
//
//   shutdownSequence = every "stop" step, per stack in REVERSE dependency
//                      order (dependents stop before what they depend on)
//   startupSequence  = every "start"/"restart" step, per stack in dependency
//                      order
//
// "restart" lives in the startup phase only: its stop half is internal to
// the agent's restart step and frees no SUSTAINED memory, so it contributes
// nothing to freeBytesProjected (documented decision — the plan author puts a
// separate stop in the plan when the memory must stay freed).
//
// PARALLELISM IS STRUCTURAL, not implicit: each phase is an array of waves.
// Steps in the SAME wave run in parallel (they belong to different stacks —
// this is the "parallel per stack"); waves run strictly in order (within one
// stack, step i+1 lands in wave i+1, so a stack's own dependency order is
// sequential while different stacks advance together).
//
// Feasibility: freeBytesProjected sums the per-component freesBytes over the
// shutdown steps (unknown counts as 0 — honest under-promise); feasible =
// freeBytesProjected >= targetFreeBytes. The preview never invents victims:
// it frees exactly what the plan's stops name, and says whether that is
// enough. Execute fails CLOSED on an infeasible preview (nothing dispatched).
//
// executeDowntimeSequence walks the preview over the EXISTING seam: every
// step goes through buildComponentAction (server owns version/actionId/
// nodeId/actor — componentActions.js contract) and proxyComponentAction
// (POST /actions status mapping). It fails closed: a per-wave pre-flight
// check (registry record present + connection.isOnline) runs BEFORE any
// dispatch in the wave; an offline or unknown node stops the whole run with
// the wave un-dispatched, and a dispatched step whose result is not a clean
// success stops all later waves. Remaining waves are simply absent from the
// walk — the report says where it stopped (stoppedAt). Success requires
// proxy status 200 AND body.ok === true; an async "running" verdict counts
// as NOT success (this flow never polls status-by-actionId — out of seam).
//
// Failures throw TypeError exactly like the existing fleet modules
// (waveSequencer's contract guards); execution failures are REPORTED, never
// thrown. Zero dependencies beyond the sibling seam modules.

import { randomUUID } from "node:crypto";
import { buildComponentAction, proxyComponentAction } from "./componentActions.js";

/** Same id grammar the seam itself validates (componentActions.js). */
const COMPONENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** v2 verbs (shared/types.ts ComponentActionType). */
const ACTIONS = ["start", "stop", "restart"];

/**
 * Derive the downtime preview for a stack plan. Pure function — no clock, no
 * network, no state; same input, same preview.
 *
 * @param {object} plan
 * @param {Array<{stackId: string, nodes: string[], components:
 *   Array<{nodeId: string, component: string, action: string,
 *            freesBytes?: number|null}>}>} plan.stacks
 *   each stack's components array in DEPENDENCY ORDER
 * @param {number} [plan.targetFreeBytes] default 0
 * @returns {{
 *   shutdownSequence: Array<Array<{stackId, nodeId, componentId, type, freesBytes}>>,
 *   startupSequence:  Array<Array<{stackId, nodeId, componentId, type, freesBytes}>>,
 *   feasible: boolean,
 *   freeBytesProjected: number,
 *   targetFreeBytes: number,
 * }}
 */
export function buildDowntimePreview(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new TypeError("buildDowntimePreview: plan must be an object { stacks, targetFreeBytes }");
  }
  const { stacks } = plan;
  if (!Array.isArray(stacks)) throw new TypeError("buildDowntimePreview: plan.stacks must be an array");
  const targetFreeBytes = plan.targetFreeBytes === undefined ? 0 : plan.targetFreeBytes;
  if (!(typeof targetFreeBytes === "number" && Number.isFinite(targetFreeBytes) && targetFreeBytes >= 0)) {
    throw new TypeError("buildDowntimePreview: targetFreeBytes must be a finite non-negative number");
  }

  const seenStackIds = new Set();
  const perStackShutdown = [];
  const perStackStartup = [];

  for (const stack of stacks) {
    if (!stack || typeof stack !== "object" || Array.isArray(stack)) {
      throw new TypeError("buildDowntimePreview: each stack must be an object { stackId, nodes, components }");
    }
    const { stackId } = stack;
    if (typeof stackId !== "string" || !stackId.trim()) {
      throw new TypeError("buildDowntimePreview: stack.stackId must be a non-empty string");
    }
    if (seenStackIds.has(stackId)) {
      throw new TypeError(`buildDowntimePreview: duplicate stackId "${stackId}"`);
    }
    seenStackIds.add(stackId);

    if (!Array.isArray(stack.nodes) || stack.nodes.some((n) => typeof n !== "string" || !n.trim())) {
      throw new TypeError(`buildDowntimePreview: stack "${stackId}".nodes must be an array of node-id strings`);
    }
    const nodeSet = new Set(stack.nodes);
    if (!Array.isArray(stack.components)) {
      throw new TypeError(`buildDowntimePreview: stack "${stackId}".components must be an array`);
    }

    const shutdownSteps = [];
    const startupSteps = [];
    for (const c of stack.components) {
      if (!c || typeof c !== "object" || Array.isArray(c)) {
        throw new TypeError(`buildDowntimePreview: stack "${stackId}".components entries must be objects`);
      }
      if (typeof c.component !== "string" || !COMPONENT_ID_RE.test(c.component)) {
        throw new TypeError(
          `buildDowntimePreview: stack "${stackId}" component must match ${COMPONENT_ID_RE.source}`
        );
      }
      if (!ACTIONS.includes(c.action)) {
        throw new TypeError(`buildDowntimePreview: stack "${stackId}" action must be one of ${ACTIONS.join("|")}`);
      }
      if (typeof c.nodeId !== "string" || !nodeSet.has(c.nodeId)) {
        throw new TypeError(
          `buildDowntimePreview: stack "${stackId}" component "${c.component}" targets node "${c.nodeId}" which is not in stack.nodes`
        );
      }
      let freesBytes = null;
      if (c.freesBytes !== undefined && c.freesBytes !== null) {
        if (!(typeof c.freesBytes === "number" && Number.isFinite(c.freesBytes) && c.freesBytes >= 0)) {
          throw new TypeError(
            `buildDowntimePreview: stack "${stackId}" component "${c.component}" freesBytes must be a finite non-negative number`
          );
        }
        freesBytes = c.freesBytes;
      }
      const step = {
        stackId,
        nodeId: c.nodeId,
        componentId: c.component,
        type: c.action,
        freesBytes: c.action === "stop" ? freesBytes : null,
      };
      (c.action === "stop" ? shutdownSteps : startupSteps).push(step);
    }

    // Stop in reverse dependency order: dependents before what they depend on.
    perStackShutdown.push(shutdownSteps.reverse());
    perStackStartup.push(startupSteps); // startup keeps dependency order
  }

  const shutdownSequence = toWaves(perStackShutdown);
  const startupSequence = toWaves(perStackStartup);
  const freeBytesProjected = shutdownSequence
    .flat()
    .reduce((sum, s) => sum + (s.freesBytes ?? 0), 0);

  return {
    shutdownSequence,
    startupSequence,
    feasible: freeBytesProjected >= targetFreeBytes,
    freeBytesProjected,
    targetFreeBytes,
  };
}

/**
 * Per-stack step lists → waves: stack k's step i lands in wave i, so steps
 * from DIFFERENT stacks share a wave (parallel per stack) while one stack's
 * own steps walk across waves in order. Stack order is preserved inside each
 * wave (deterministic output).
 */
function toWaves(perStack) {
  const waves = [];
  for (const steps of perStack) {
    steps.forEach((step, i) => {
      if (!waves[i]) waves[i] = [];
      waves[i].push(step);
    });
  }
  return waves;
}

/** One preview step, structurally validated (throws TypeError). */
function requireStep(step, phase, wave, index) {
  const where = `${phase}[${wave}][${index}]`;
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw new TypeError(`executeDowntimeSequence: ${where} must be a step object`);
  }
  if (typeof step.stackId !== "string" || !step.stackId.trim()) {
    throw new TypeError(`executeDowntimeSequence: ${where}.stackId must be a non-empty string`);
  }
  if (typeof step.nodeId !== "string" || !step.nodeId.trim()) {
    throw new TypeError(`executeDowntimeSequence: ${where}.nodeId must be a non-empty string`);
  }
  if (typeof step.componentId !== "string" || !COMPONENT_ID_RE.test(step.componentId)) {
    throw new TypeError(`executeDowntimeSequence: ${where}.componentId must match ${COMPONENT_ID_RE.source}`);
  }
  if (!ACTIONS.includes(step.type)) {
    throw new TypeError(`executeDowntimeSequence: ${where}.type must be one of ${ACTIONS.join("|")}`);
  }
  if (
    step.freesBytes !== null &&
    step.freesBytes !== undefined &&
    !(typeof step.freesBytes === "number" && Number.isFinite(step.freesBytes))
  ) {
    throw new TypeError(`executeDowntimeSequence: ${where}.freesBytes must be null or a finite number`);
  }
}

/** Preview-shape guard for execute (mirrors waveSequencer's contract guards). */
function requirePreviewShape(preview) {
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
    throw new TypeError("executeDowntimeSequence: preview must be a buildDowntimePreview result object");
  }
  for (const phase of ["shutdownSequence", "startupSequence"]) {
    const waves = preview[phase];
    if (!Array.isArray(waves)) {
      throw new TypeError(`executeDowntimeSequence: preview.${phase} must be an array of waves`);
    }
    waves.forEach((wave, w) => {
      if (!Array.isArray(wave)) {
        throw new TypeError(`executeDowntimeSequence: preview.${phase}[${w}] must be an array of steps`);
      }
      wave.forEach((step, i) => requireStep(step, phase, w, i));
    });
  }
}

/** One per-step result record (shared/types.ts DowntimeStepResult). */
function stepResult(phase, wave, step, { ok, status, error, actionId = null }) {
  return {
    phase,
    wave,
    stackId: step.stackId,
    nodeId: step.nodeId,
    componentId: step.componentId,
    type: step.type,
    actionId,
    ok,
    status, // upstream HTTP status via proxyComponentAction; null = never dispatched
    error,
  };
}

/**
 * Walk a preview LIVE over the existing component-action seam. Fails CLOSED:
 * an infeasible preview, a pre-flight failure (unknown/offline node), or a
 * non-success step result stops the walk; later waves are not attempted.
 *
 * @param {object} preview a buildDowntimePreview result (shape-guarded)
 * @param {object} opts
 * @param {{ isOnline: (id: string) => boolean, nodes: object[] }} opts.connection
 *   the existing fleet connection surface (fleet/connection.js): isOnline +
 *   the registry records proxyComponentAction dials
 * @param {string|null} [opts.actor] audit principal for buildComponentAction's ctx
 * @param {() => string} [opts.actionId] idempotency-key mint (tests); default randomUUID
 * @param {(url: string, init: object) => Promise<any>} [opts.fetchImpl] fetch override (tests)
 * @param {number} [opts.timeoutMs] per-step proxy budget; default = the proxy's own
 * @returns {Promise<{
 *   ok: boolean,
 *   executed: number,
 *   results: object[],           // DowntimeStepResult, dispatch order
 *   stoppedAt: {phase: string, wave: number} | null,
 *   error?: string,
 * }>}
 */
export async function executeDowntimeSequence(preview, opts = {}) {
  requirePreviewShape(preview);
  const connection = opts.connection;
  if (
    !connection ||
    typeof connection !== "object" ||
    typeof connection.isOnline !== "function" ||
    !Array.isArray(connection.nodes)
  ) {
    throw new TypeError(
      "executeDowntimeSequence: connection must expose isOnline + nodes (the fleet connection surface)"
    );
  }

  // Fail CLOSED on an infeasible preview: never free memory the plan cannot
  // deliver, never touch a single node.
  if (preview.feasible !== true) {
    return {
      ok: false,
      executed: 0,
      results: [],
      stoppedAt: null,
      error: `preview is not feasible (freeBytesProjected ${preview.freeBytesProjected} < target ${preview.targetFreeBytes}); nothing executed`,
    };
  }

  const recordByNode = new Map();
  for (const rec of connection.nodes) {
    if (rec && typeof rec.id === "string" && rec.id.trim()) recordByNode.set(rec.id.trim(), rec);
  }

  const proxyOpts = {};
  if (typeof opts.fetchImpl === "function") proxyOpts.fetchImpl = opts.fetchImpl;
  if (Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) proxyOpts.timeoutMs = opts.timeoutMs;
  const makeId = typeof opts.actionId === "function" ? opts.actionId : randomUUID;

  const results = [];
  let executed = 0;
  let stoppedAt = null;

  walk: for (const [phase, waves] of [
    ["shutdown", preview.shutdownSequence],
    ["startup", preview.startupSequence],
  ]) {
    for (let wave = 0; wave < waves.length; wave++) {
      const steps = waves[wave];

      // Pre-flight, before ANY dispatch in this wave: a missing registry
      // record or an offline node fails the whole wave closed.
      const ready = steps.map((step) => {
        const rec = recordByNode.get(step.nodeId);
        if (!rec) return { step, preError: `no registry record for node "${step.nodeId}"` };
        if (!connection.isOnline(step.nodeId)) return { step, preError: `node "${step.nodeId}" is offline` };
        return { step, rec };
      });
      const firstPreFailure = ready.find((r) => r.preError);
      if (firstPreFailure) {
        for (const r of ready) {
          results.push(
            stepResult(phase, wave, r.step, {
              ok: false,
              status: null,
              error: r.preError ?? "skipped: the wave failed its pre-flight check",
            })
          );
        }
        stoppedAt = { phase, wave };
        break walk;
      }

      // Whole wave in parallel (steps here belong to different stacks).
      const waveResults = await Promise.all(
        ready.map(async ({ step, rec }) => {
          // Server owns version/actionId/nodeId/actor (componentActions.js).
          const built = buildComponentAction(
            { componentId: step.componentId, type: step.type },
            { nodeId: step.nodeId, actor: opts.actor ?? null, actionId: makeId }
          );
          if (!built.ok) {
            return stepResult(phase, wave, step, { ok: false, status: built.status, error: built.error });
          }
          const res = await proxyComponentAction(rec, built.request, proxyOpts);
          const ok = res.status === 200 && res.body?.ok === true;
          return stepResult(phase, wave, step, {
            ok,
            status: res.status,
            actionId: built.request.actionId,
            error: ok ? null : res.body?.error || `node agent responded ${res.status}`,
          });
        })
      );
      results.push(...waveResults);
      executed += waveResults.length;

      if (waveResults.some((r) => !r.ok)) {
        stoppedAt = { phase, wave };
        break walk;
      }
    }
  }

  return { ok: stoppedAt === null, executed, results, stoppedAt };
}
