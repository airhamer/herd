import test from "node:test";
import assert from "node:assert/strict";
import { requireRecordingAccess, proxyAgentJson } from "../recordingProxy.js";

test("content access is denied when a dashboard token is configured but missing", () => {
  const prev = process.env.SPARKDASH_TOKEN;
  process.env.SPARKDASH_TOKEN = "test-token";
  try {
    const denied = requireRecordingAccess({ method: "GET", headers: {} }, { content: true });
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 401);
    const ok = requireRecordingAccess(
      { method: "GET", headers: { authorization: "Bearer test-token" } },
      { content: true }
    );
    assert.equal(ok.ok, true);
  } finally {
    if (prev == null) delete process.env.SPARKDASH_TOKEN;
    else process.env.SPARKDASH_TOKEN = prev;
  }
});

test("proxyAgentJson forwards GET/DELETE to the node agent", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    return { ok: true, status: 200, json: async () => ({ recordings: [] }) };
  };
  const out = await proxyAgentJson({ lanIp: "10.0.0.1", agentPort: 30091 }, "/recordings", { fetchImpl });
  assert.equal(out.status, 200);
  assert.equal(calls[0].url, "http://10.0.0.1:30091/recordings");
});
