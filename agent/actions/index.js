/**
 * index.js — public API of the node-agent actions layer.
 *
 * Re-exports all action modules so the HTTP wiring (agent/http.js
 * POST /actions + GET /audit) can import one path:
 *
 *   import { startContainer, stopContainer, restartContainer,
 *            removeContainer, appendAudit, readAudit, startUnit,
 *            stopUnit, restartUnit, canaryProbe, switchLlm } from
 *            "./actions/index.js";
 *
 * Batch 2A: docker.js + audit.js. Batch 2B: systemd.js + llm-switch.js.
 * SC action seam (POC): component.js — v2 ComponentActionRequest primitives
 * (validation, confirmation tokens, v2→v1 downgrade, result envelopes).
 * Dispatch of v2 requests is SC10's wiring batch; the pure primitives are
 * here so the seam contract has a producer-side reference implementation.
 */
export * from "./docker.js";
export * from "./audit.js";
export * from "./systemd.js";
export * from "./llm-switch.js";
export * from "./component.js";
