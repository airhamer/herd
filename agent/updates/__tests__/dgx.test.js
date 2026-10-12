/**
 * agent/updates/__tests__/dgx.test.js — REAL createDgxUpdates with ONLY fetch
 * stubbed. Batch 5b durable rule: never stub the dgx module itself — stubbing
 * it (as scheduler.test.js does for scheduler units) is exactly what hid the
 * missing fullView export. Covers the degraded (no creds), happy, and
 * fetch-failure shapes; fullView is exercised against the real return block.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDgxUpdates } from "../dgx.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-dgx-"));
}

const CRED = { host: "127.0.0.1", port: 11000, username: "u", password: "p" };

function writeCreds(dir) {
  fs.writeFileSync(path.join(dir, "dgx.json"), JSON.stringify(CRED));
}

/** Stub the transport only. All dgx HTTP goes through here; calls[] proves polling. */
function makeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", headers: init.headers || {} });
    const r = handler(url, init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: () => "application/json" },
      json: async () => {
        if (r.json === undefined) throw new Error("stub: no json body");
        return r.json;
      },
      text: async () => r.text ?? "",
    };
  };
  fn.calls = calls;
  return fn;
}

const AVAILABLE_BODY = {
  ota: { version: "7.6.0", date: "2026-09-30", priority: "critical" },
  packages: [{ name: "linux-nvidia", current_version: "570.12", candidate: "570.17", size: 123 }],
  firmware: [{ component: "SBIOS", current_version: "1.2", new_version: "1.3" }],
};

const EXPECTED_OTA = { version: "7.6.0", date: "2026-09-30", priority: "Critical", releaseNotesUrl: null };
const EXPECTED_PKG = { name: "linux-nvidia", currentVersion: "570.12", availableVersion: "570.17", sizeBytes: 123 };
const EXPECTED_FW = { component: "SBIOS", currentVersion: "1.2", availableVersion: "1.3" };

function happyBackend() {
  return makeFetch((url) => {
    if (url.endsWith("/api/login")) return { status: 200, json: { token: "jwt-test" } };
    if (url.includes("/api/v1/updates/available")) return { status: 200, json: AVAILABLE_BODY };
    if (url.includes("/api/v1/updates/enabled")) return { status: 200, json: { updatesEnabled: true } };
    return { status: 302, text: "SPA fallback" };
  });
}
test("export: createDgxUpdates returns fullView — scheduler.js awaits dgx.fullView()", () => {
  const dgx = createDgxUpdates({ configDir: tmpDir(), fetch: makeFetch(() => ({ status: 500 })) });
  assert.equal(typeof dgx.fullView, "function");
});

test("degraded (no creds): fullView answers dgxConfigured:false with ZERO backend calls", async () => {
  const fetchStub = makeFetch(() => {
    throw new Error("degraded mode must not touch the backend");
  });
  const dgx = createDgxUpdates({ configDir: tmpDir(), fetch: fetchStub });
  const view = await dgx.fullView();
  assert.equal(view.snapshot.dgxConfigured, false);
  assert.equal(view.snapshot.agentReachable, true);
  assert.deepEqual(view.snapshot.packages, []);
  assert.equal(view.state.inProgress, false);
  assert.deepEqual(view.state.events, []);
  assert.equal(fetchStub.calls.length, 0); // spec §3: nothing polls when unconfigured
});

test("happy: probe maps /updates/available to known-answer snapshot; fullView carries snapshot+state", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const fetchStub = happyBackend();
  let clock = 1_000;
  const dgx = createDgxUpdates({ configDir: dir, fetch: fetchStub, now: () => clock });
  const snap = await dgx.probe(true);
  assert.equal(snap.dgxConfigured, true);
  assert.equal(snap.probedAt, 1_000);
  assert.deepEqual(snap.otaAvailable, EXPECTED_OTA);
  assert.deepEqual(snap.packages, [EXPECTED_PKG]);
  assert.deepEqual(snap.firmware, [EXPECTED_FW]);
  assert.equal(snap.updatesDisabled, false);
  assert.deepEqual(snap.raw, AVAILABLE_BODY);
  assert.equal(snap.dgxError, undefined);
  const authed = fetchStub.calls.find((c) => c.url.includes("/updates/available"));
  assert.equal(authed.headers.Authorization, "Bearer jwt-test");
  const loginCount = () => fetchStub.calls.filter((c) => c.url.endsWith("/api/login")).length;
  assert.equal(loginCount(), 1);
  // cache window: fresh (<60 s) serves the cache; past it re-probes. The JWT
  // is cached in memory, so count available-fetches (not logins) for the window.
  const availCount = () => fetchStub.calls.filter((c) => c.url.includes("/updates/available")).length;
  assert.equal(availCount(), 1);
  clock += 30_000;
  const cached = await dgx.probe();
  assert.equal(cached.probedAt, 1_000);
  assert.equal(availCount(), 1);
  clock += 30_001;
  await dgx.probe();
  assert.equal(availCount(), 2);
  assert.equal(loginCount(), 1); // bearer token reused across re-probes
  const view = await dgx.fullView();
  assert.deepEqual(Object.keys(view).sort(), ["snapshot", "state"]); // scheduler adds schedules
  assert.deepEqual(view.snapshot.packages, [EXPECTED_PKG]);
  assert.equal(view.state.inProgress, false);
});
test("fetch failure: probe never throws; dgxError set; fullView still answers", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const fetchStub = makeFetch(() => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:11000");
  });
  const dgx = createDgxUpdates({ configDir: dir, fetch: fetchStub, now: () => 1_000 });
  const snap = await dgx.probe(true);
  assert.equal(snap.dgxConfigured, true); // credentials ARE configured; the backend is down
  assert.match(snap.dgxError, /ECONNREFUSED/);
  // Known dgx.js behavior, pre-dating Batch 5b: a failed probe is RETURNED but
  // not cached, so the cache-only getSnapshot (and fullView) keep answering
  // with the last-good shape — degraded-safe, never throws, never shows stale dgxError.
  const view = await dgx.fullView();
  assert.equal(view.snapshot.dgxError, undefined);
  assert.equal(view.snapshot.dgxConfigured, true);
  assert.equal(view.state.inProgress, false);
});

test("login 401 (bad creds, negative path): error surfaces in dgxError, never throws", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const fetchStub = makeFetch((url) =>
    url.endsWith("/api/login") ? { status: 401, text: "invalid credentials" } : { status: 200 }
  );
  const dgx = createDgxUpdates({ configDir: dir, fetch: fetchStub, now: () => 1_000 });
  const snap = await dgx.probe(true);
  assert.match(snap.dgxError, /dgx login failed \(401\)/);
  assert.equal(snap.dgxConfigured, true);
});

