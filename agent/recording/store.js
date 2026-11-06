/**
 * Persistent bounded recording store (COMP2 / #118).
 *
 * JSON file under the agent config dir. Retention (age) and quota (bytes +
 * entry count) are enforced on every write. Auth is the caller's job; this
 * module only stores sanitized metadata + optional prompt/response text.
 */
import fs from "node:fs";
import path from "node:path";
import {
  containsCapturedSecrets,
  captureIds,
  extractPromptText,
  extractResponseText,
  shouldStorePrompt,
  shouldStoreResponse,
  assembleStream,
} from "../../shared/recordingCapture.js";

export const DEFAULT_MAX_STORE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 200;
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_ITEM_BYTES = 64 * 1024;

export function emptyRecordingStore() {
  return { version: 1, records: [], totalBytes: 0 };
}

export function defaultRecordingPath(configDir) {
  return path.join(configDir, "recordings.json");
}

export function loadRecordingStore(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.records)) return emptyRecordingStore();
    return { version: 1, records: raw.records, totalBytes: raw.records.reduce((n, r) => n + (r.bytes || 0), 0) };
  } catch {
    return emptyRecordingStore();
  }
}

export function saveRecordingStore(filePath, store) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  const payload = { version: 1, records: store.records };
  fs.writeFileSync(tmp, JSON.stringify(payload) + "\n");
  fs.renameSync(tmp, filePath);
}

export function vacuumStore(store, opts = {}) {
  const now = typeof opts.now === "function" ? opts.now() : Date.now();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : DEFAULT_MAX_AGE_MS;
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : DEFAULT_MAX_STORE_BYTES;
  const maxEntries = Number.isFinite(opts.maxEntries) ? opts.maxEntries : DEFAULT_MAX_ENTRIES;
  let records = store.records.filter((r) => {
    if (r.expiresAt != null && r.expiresAt <= now) return false;
    if (maxAgeMs != null && r.capturedAt && now - r.capturedAt > maxAgeMs) return false;
    return true;
  });
  let total = records.reduce((n, r) => n + (r.bytes || 0), 0);
  while (records.length > maxEntries || total > maxBytes) {
    const dropped = records.shift();
    total -= dropped?.bytes || 0;
  }
  return { version: 1, records, totalBytes: total };
}

/**
 * Build a persistable capture record. Never stores headers or secrets.
 */
export function buildCaptureRecord(input, policy) {
  const content = policy?.content || "metadata";
  const ids = captureIds({
    componentId: input.componentId,
    variantId: input.variantId,
    requestId: input.requestId,
    attempt: input.attempt,
  });
  const itemLimit = Math.min(
    DEFAULT_ITEM_BYTES,
    Number.isFinite(policy?.maxBytes) && policy.maxBytes > 0 ? policy.maxBytes : DEFAULT_ITEM_BYTES
  );
  const stream = input.streamChunks
    ? assembleStream(input.streamChunks, { maxBytes: itemLimit, aborted: input.aborted })
    : { text: "", aborted: Boolean(input.aborted), truncated: false, incomplete: Boolean(input.aborted), keepaliveExcluded: true, bytes: 0 };

  let prompt = null;
  let response = null;
  let truncated = stream.truncated;
  if (shouldStorePrompt(content)) {
    const p = extractPromptText(input.requestBody, itemLimit);
    prompt = p.text;
    truncated = truncated || p.truncated;
  }
  if (shouldStoreResponse(content)) {
    if (input.streamChunks) {
      response = stream.text || null;
    } else {
      const r = extractResponseText(input.responseBody, itemLimit);
      response = r.text;
      truncated = truncated || r.truncated;
    }
  }

  const record = {
    id: ids.attemptId,
    requestId: ids.requestId,
    attemptId: ids.attemptId,
    segment: ids.segment,
    componentId: input.componentId,
    variantId: input.variantId || "default",
    nodeId: input.nodeId || null,
    capturedAt: input.capturedAt || Date.now(),
    expiresAt:
      Number.isFinite(policy?.retentionHours) && policy.retentionHours > 0
        ? (input.capturedAt || Date.now()) + policy.retentionHours * 3600 * 1000
        : null,
    policy: { content, observer: policy?.observer ?? null },
    metadata: {
      path: typeof input.path === "string" ? input.path : null,
      status: Number.isFinite(input.status) ? input.status : null,
      method: input.method || "POST",
    },
    prompt,
    response,
    stream: {
      aborted: stream.aborted,
      truncated,
      incomplete: stream.aborted || truncated,
      keepaliveExcluded: true,
    },
  };
  record.bytes = Buffer.byteLength(JSON.stringify({ prompt: record.prompt, response: record.response }), "utf8");
  const leak = containsCapturedSecrets({ ...record, headers: undefined });
  if (leak) {
    throw new Error(`refusing to persist captured secret at ${leak}`);
  }
  if (record.headers) throw new Error("headers must never be stored");
  return record;
}

export function appendCapture(store, record, opts = {}) {
  const next = { version: 1, records: [...store.records, record], totalBytes: (store.totalBytes || 0) + (record.bytes || 0) };
  return vacuumStore(next, opts);
}

export function listCaptures(store, filter = {}) {
  return store.records
    .filter((r) => {
      if (filter.componentId && r.componentId !== filter.componentId) return false;
      if (filter.nodeId && r.nodeId !== filter.nodeId) return false;
      if (filter.variantId && r.variantId !== filter.variantId) return false;
      return true;
    })
    .map((r) => ({
      id: r.id,
      requestId: r.requestId,
      attemptId: r.attemptId,
      segment: r.segment,
      componentId: r.componentId,
      variantId: r.variantId,
      nodeId: r.nodeId,
      capturedAt: r.capturedAt,
      expiresAt: r.expiresAt,
      policy: r.policy,
      metadata: r.metadata,
      stream: r.stream,
      bytes: r.bytes,
      hasPrompt: r.prompt != null,
      hasResponse: r.response != null,
    }));
}

export function getCapture(store, id) {
  return store.records.find((r) => r.id === id || r.attemptId === id || r.requestId === id) ?? null;
}

export function deleteCapture(store, id) {
  const records = store.records.filter((r) => r.id !== id && r.attemptId !== id);
  if (records.length === store.records.length) return { ok: false, store };
  return { ok: true, store: vacuumStore({ version: 1, records }, { maxAgeMs: Number.MAX_SAFE_INTEGER }) };
}
