import test from "node:test";
import assert from "node:assert/strict";
import {
  assembleStream,
  stripAuthHeaders,
  containsCapturedSecrets,
  extractPromptText,
  recordingAvailability,
  captureIds,
  shouldStorePrompt,
} from "../recordingCapture.js";

test("assembleStream drops keepalive pings and marks abort/truncate", () => {
  const out = assembleStream(
    [": ping\n", "data: hello\n", ": keepalive\n", "data: world\n"],
    { maxBytes: 8, aborted: true }
  );
  assert.equal(out.keepaliveExcluded, true);
  assert.equal(out.aborted, true);
  assert.equal(out.truncated, true);
  assert.equal(out.incomplete, true);
  assert.ok(!out.text.includes("ping"));
  assert.ok(out.text.startsWith("hello"));
});

test("headers and keys are never kept", () => {
  const cleaned = stripAuthHeaders({
    authorization: "Bearer sk-secret",
    "x-api-key": "abc",
    "content-type": "application/json",
  });
  assert.deepEqual(cleaned, { "content-type": "application/json" });
  assert.ok(containsCapturedSecrets({ authorization: "Bearer x" }));
  assert.equal(containsCapturedSecrets({ path: "/v1/chat/completions", status: 200 }), null);
});

test("prompt extraction from chat messages", () => {
  const { text } = extractPromptText({ messages: [{ role: "user", content: "hello" }] });
  assert.equal(text, "hello");
});

test("without observer UI is unavailable even if policy wants prompts", () => {
  const a = recordingAvailability({
    policy: { content: "prompts+responses", retentionHours: 24, maxBytes: 1000, observer: "relay" },
    observerPresent: false,
  });
  assert.equal(a.recording, false);
  assert.equal(a.available, false);
  assert.match(a.ui, /not recording \/ unavailable/);
  assert.equal(shouldStorePrompt("prompts+responses"), true);
  assert.equal(shouldStorePrompt("metadata"), false);
});

test("stricter policy wins over a looser variant-level desire", () => {
  const a = recordingAvailability({
    policy: { content: "prompts+responses", retentionHours: null, maxBytes: null, observer: "relay" },
    observerPresent: true,
    levels: [{ content: "off", retentionHours: null, maxBytes: null, observer: null }],
  });
  assert.equal(a.content, "off");
  assert.equal(a.recording, false);
});

test("ids are stable across variant segments", () => {
  const first = captureIds({ componentId: "qwen", variantId: "stock", requestId: "abc", attempt: 1 });
  const second = captureIds({ componentId: "qwen", variantId: "uncensored", requestId: "abc", attempt: 2 });
  assert.equal(first.requestId, second.requestId);
  assert.equal(first.attemptId, "abc:1");
  assert.equal(second.attemptId, "abc:2");
  assert.equal(first.segment, "qwen:stock");
  assert.equal(second.segment, "qwen:uncensored");
});
