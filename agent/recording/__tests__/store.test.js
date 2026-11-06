import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  emptyRecordingStore,
  loadRecordingStore,
  saveRecordingStore,
  buildCaptureRecord,
  appendCapture,
  listCaptures,
  getCapture,
  deleteCapture,
  vacuumStore,
  defaultRecordingPath,
} from "../store.js";

const policy = { content: "prompts+responses", retentionHours: 1, maxBytes: 4096, observer: "relay" };

function rec(over = {}) {
  return buildCaptureRecord(
    {
      componentId: "qwen38-27b-stock-sglang-tp1-gx10",
      variantId: "stock",
      nodeId: "n1",
      requestId: over.requestId || "abc",
      attempt: over.attempt || 1,
      path: "/v1/chat/completions",
      status: 200,
      requestBody: { messages: [{ role: "user", content: over.prompt || "hi" }] },
      responseBody: { choices: [{ message: { content: over.response || "there" } }] },
      capturedAt: over.capturedAt ?? Date.now(),
      ...over,
    },
    over.policy || policy
  );
}

test("enabled capture persists prompt and response without headers", () => {
  const r = rec();
  assert.equal(r.prompt, "hi");
  assert.equal(r.response, "there");
  assert.equal(r.headers, undefined);
  assert.equal(r.metadata.path, "/v1/chat/completions");
});

test("disabled / metadata policy stores no bodies", () => {
  const r = rec({ policy: { content: "metadata", observer: "relay" } });
  assert.equal(r.prompt, null);
  assert.equal(r.response, null);
});

test("restart persistence round-trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-rec-"));
  const file = defaultRecordingPath(dir);
  let store = appendCapture(emptyRecordingStore(), rec());
  saveRecordingStore(file, store);
  const loaded = loadRecordingStore(file);
  assert.equal(loaded.records.length, 1);
  assert.equal(getCapture(loaded, "abc:1").prompt, "hi");
});

test("delete removes a record", () => {
  let store = appendCapture(emptyRecordingStore(), rec());
  const del = deleteCapture(store, "abc:1");
  assert.equal(del.ok, true);
  assert.equal(del.store.records.length, 0);
});

test("retention expiry drops old records", () => {
  const old = rec({ capturedAt: 1_000 });
  old.expiresAt = 2_000;
  const store = vacuumStore({ version: 1, records: [old] }, { now: () => 3_000 });
  assert.equal(store.records.length, 0);
});

test("quota evicts oldest when over maxBytes / maxEntries", () => {
  let store = emptyRecordingStore();
  for (let i = 0; i < 5; i++) {
    store = appendCapture(store, rec({ requestId: `r${i}`, prompt: "x".repeat(80) }), {
      maxEntries: 3,
      maxBytes: 10_000,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
    });
  }
  assert.equal(store.records.length, 3);
  assert.equal(store.records[0].requestId, "r2");
});

test("streaming abort is marked incomplete and keepalive text is excluded", () => {
  const r = rec({
    streamChunks: [": ping\n", "data: hello\n"],
    aborted: true,
    responseBody: null,
  });
  assert.equal(r.stream.aborted, true);
  assert.equal(r.stream.incomplete, true);
  assert.ok(!String(r.response).includes("ping"));
  assert.match(String(r.response), /hello/);
});

test("variant continuity keeps the same requestId across segments", () => {
  const a = rec({ variantId: "stock", requestId: "same", attempt: 1 });
  const b = rec({ variantId: "uncensored", requestId: "same", attempt: 2 });
  assert.equal(a.requestId, b.requestId);
  assert.equal(a.segment.endsWith(":stock"), true);
  assert.equal(b.segment.endsWith(":uncensored"), true);
});

test("list is metadata-only (no prompt/response fields)", () => {
  const store = appendCapture(emptyRecordingStore(), rec());
  const listed = listCaptures(store, { componentId: "qwen38-27b-stock-sglang-tp1-gx10" });
  assert.equal(listed[0].hasPrompt, true);
  assert.equal(listed[0].prompt, undefined);
  assert.equal(listed[0].response, undefined);
});

test("buildCaptureRecord rejects injected secret fields by never adding headers", () => {
  const r = rec({ requestBody: { messages: [{ role: "user", content: "hi" }], headers: { authorization: "Bearer x" } } });
  assert.equal(r.headers, undefined);
  assert.ok(!JSON.stringify(r).toLowerCase().includes("authorization"));
  assert.ok(!JSON.stringify(r).includes("Bearer"));
});

test("retention file is owner-only after atomic save", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-rec-"));
  const file = defaultRecordingPath(dir);
  saveRecordingStore(file, appendCapture(emptyRecordingStore(), rec()));
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("metadata list never includes prompt or response text", () => {
  const listed = listCaptures(appendCapture(emptyRecordingStore(), rec({ prompt: "secret prompt body" })));
  assert.equal(listed[0].hasPrompt, true);
  const blob = JSON.stringify(listed);
  assert.equal(blob.includes("secret prompt body"), false);
  assert.equal(blob.includes("there"), false);
  assert.equal("prompt" in listed[0], false);
  assert.equal("response" in listed[0], false);
});
