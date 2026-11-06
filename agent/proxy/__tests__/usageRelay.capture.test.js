import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createUsageRelay } from "../usageRelay.js";
import { buildCaptureRecord, emptyRecordingStore, appendCapture } from "../../recording/store.js";

test("optional capture hook records prompt/response without headers and ignores keepalive", async () => {
  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", authorization: "Bearer should-not-leak" });
      res.write(": ping\n");
      res.write("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n");
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;
  /** @type {object|null} */
  let captured = null;
  const relay = createUsageRelay({
    listenPort: 0,
    upstreamPort: upPort,
    bind: "127.0.0.1",
    onCapture: (evt) => { captured = evt; },
  });
  const addr = await relay.start();
  const payload = JSON.stringify({
    messages: [{ role: "user", content: "hello" }],
  });
  const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-client-secret" },
    body: payload,
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(captured);
  assert.equal(captured.headers, undefined);
  assert.match(captured.requestBody, /hello/);
  const rec = buildCaptureRecord(
    {
      componentId: "comp",
      variantId: "stock",
      nodeId: "n1",
      requestBody: captured.requestBody,
      streamChunks: captured.streamChunks,
      aborted: captured.aborted,
      path: captured.path,
      status: captured.status,
    },
    { content: "prompts+responses", observer: "relay" }
  );
  assert.ok(!JSON.stringify(rec).includes("sk-client-secret"));
  assert.ok(!JSON.stringify(rec).toLowerCase().includes("authorization"));
  assert.equal(rec.prompt, "hello");
  const store = appendCapture(emptyRecordingStore(), rec);
  assert.equal(store.records.length, 1);
  await relay.stop();
  await new Promise((r) => upstream.close(r));
});
