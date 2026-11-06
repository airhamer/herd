import test from "node:test";
import assert from "node:assert/strict";
import { handleListRecordings, handleGetRecording, handleDeleteRecording, handleRecordingStatus } from "../handlers.js";
import { emptyRecordingStore, appendCapture, buildCaptureRecord } from "../store.js";

const policy = { content: "prompts+responses", retentionHours: 24, maxBytes: 4096, observer: "relay" };

function seed() {
  const rec = buildCaptureRecord(
    {
      componentId: "comp",
      variantId: "stock",
      nodeId: "n1",
      requestId: "r1",
      requestBody: { messages: [{ role: "user", content: "secret prompt" }] },
      responseBody: { choices: [{ message: { content: "secret reply" } }] },
    },
    policy
  );
  return appendCapture(emptyRecordingStore(), rec);
}

test("access denial without authorization", () => {
  const store = seed();
  assert.equal(handleListRecordings(store, {}, { authorized: false }).status, 401);
  assert.equal(handleGetRecording(store, "r1:1", { authorized: true, contentAuthorized: false }).status, 401);
  assert.equal(handleDeleteRecording(store, "r1:1", { authorized: false }).status, 401);
});

test("get requires content authorization and returns bodies", () => {
  const store = seed();
  const denied = handleGetRecording(store, "r1:1", { authorized: true, contentAuthorized: false });
  assert.equal(denied.status, 401);
  const ok = handleGetRecording(store, "r1:1", { authorized: true, contentAuthorized: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.recording.prompt, "secret prompt");
});

test("list never includes prompt text", () => {
  const listed = handleListRecordings(seed(), { componentId: "comp" }, { authorized: true });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.recordings[0].hasPrompt, true);
  assert.equal(JSON.stringify(listed.body.recordings).includes("secret prompt"), false);
});

test("delete + status without observer", () => {
  const store = seed();
  const del = handleDeleteRecording(store, "r1:1", { authorized: true });
  assert.equal(del.status, 200);
  assert.equal(del.store.records.length, 0);
  const status = handleRecordingStatus({
    policy,
    ctx: { observerPresent: false },
  });
  assert.match(status.body.ui, /unavailable/);
  assert.equal(status.body.recording, false);
});
