/**
 * Agent-side recording HTTP handlers. Authentication is required for
 * content GET and for any mutation; list returns metadata only.
 */
import {
  loadRecordingStore,
  saveRecordingStore,
  listCaptures,
  getCapture,
  deleteCapture,
  defaultRecordingPath,
} from "./store.js";
import { recordingAvailability } from "../../shared/recordingCapture.js";
import { resolveRecordingPolicy } from "../../shared/runtimeProfile.js";

export function observerIsPresent(opts = {}) {
  if (opts.observerPresent === true) return true;
  if (opts.observerPresent === false) return false;
  const env = opts.env || process.env;
  // Already-configured optional relay. Never treat unset LLM_PROXY as present,
  // and never write LLM_PROXY here.
  if (typeof env.LLM_PROXY === "string" && env.LLM_PROXY.trim()) return true;
  if (typeof env.LITELLM_BASE_URL === "string" && env.LITELLM_BASE_URL.trim()) return true;
  return false;
}

export function handleListRecordings(store, query, ctx) {
  if (!ctx.authorized) return { status: 401, body: { error: "unauthorized" } };
  return { status: 200, body: { recordings: listCaptures(store, query), observerPresent: observerIsPresent(ctx) } };
}

export function handleGetRecording(store, id, ctx) {
  if (!ctx.authorized) return { status: 401, body: { error: "unauthorized" } };
  if (!ctx.contentAuthorized) return { status: 401, body: { error: "unauthorized" } };
  const rec = getCapture(store, id);
  if (!rec) return { status: 404, body: { error: "not found" } };
  return { status: 200, body: { recording: rec } };
}

export function handleDeleteRecording(store, id, ctx) {
  if (!ctx.authorized) return { status: 401, body: { error: "unauthorized" } };
  const result = deleteCapture(store, id);
  if (!result.ok) return { status: 404, body: { error: "not found" }, store };
  return { status: 200, body: { ok: true }, store: result.store };
}

export function handleRecordingStatus({ policy, levels, ctx }) {
  const avail = recordingAvailability({
    policy: resolveRecordingPolicy([policy, ...(levels || [])].filter(Boolean)),
    observerPresent: observerIsPresent(ctx),
    levels: [],
  });
  // Recompute with original levels so stricter-wins still applies once.
  const shown = recordingAvailability({
    policy,
    observerPresent: observerIsPresent(ctx),
    levels: levels || [],
  });
  return { status: 200, body: shown };
}

export function persistStore(filePath, store) {
  saveRecordingStore(filePath, store);
  return store;
}

export { defaultRecordingPath, loadRecordingStore, saveRecordingStore };
