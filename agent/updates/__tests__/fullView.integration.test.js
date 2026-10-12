/**
 * agent/updates/__tests__/fullView.integration.test.js — Batch 5b durable
 * rule: wire the REAL scheduler + REAL dgx (exactly as agent/main.js does),
 * with ONLY fetch stubbed. A fake dgx is what hid the missing fullView
 * export; this file cannot pass if either module's wiring regresses.
 * End-to-end shape proven: GET /updates body { snapshot, state, schedules }
 * (agent/http.js contract).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDgxUpdates } from "../dgx.js";
import { createUpdateScheduler } from "../scheduler.js";

const CRED = { host: "127.0.0.1", port: 11000, username: "u", password: "p" };

const AVAILABLE_BODY = {
  ota: { version: "7.6.0", date: "2026-09-30", priority: "critical" },
  packages: [{ name: "linux-nvidia", current_version: "570.12", candidate: "570.17", size: 123 }],
};

const EXPECTED_OTA = { version: "7.6.0", date: "2026-09-30", priority: "Critical", releaseNotesUrl: null };
const EXPECTED_PKG = { name: "linux-nvidia", currentVersion: "570.12", availableVersion: "570.17", sizeBytes: 123 };

function makeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });
    const r = handler(url, init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: () => "application/json" },
      json: async () => r.json,
      text: async () => r.text ?? "",
    };
  };
  fn.calls = calls;
  return fn;
}

function happyBackend() {
  return makeFetch((url) => {
    if (url.endsWith("/api/login")) return { status: 200, json: { token: "jwt-int" } };
    if (url.includes("/api/v1/updates/available")) return { status: 200, json: AVAILABLE_BODY };
    if (url.includes("/api/v1/updates/enabled")) return { status: 200, json: { updatesEnabled: true } };
    return { status: 302, text: "SPA fallback" };
  });
}
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-int-"));
}

test("GET /updates end-to-end: real scheduler + real dgx serve {snapshot,state,schedules}", async () => {
  const cfgDir = tmpDir();
  const schedDir = tmpDir();
  fs.writeFileSync(path.join(cfgDir, "dgx.json"), JSON.stringify(CRED));
  const fetchStub = happyBackend();
  const dgx = createDgxUpdates({ configDir: cfgDir, fetch: fetchStub, now: () => 1_000 });
  const sched = createUpdateScheduler({ dgx, configDir: schedDir, now: () => 1_000 });
  // the hourly prober (or fire path) warms the cache; fullView itself must never poll
  await dgx.probeForce();
  const { schedule } = await sched.scheduleUpdate({ kind: "at", at: 5_000_000_000 });
  const view = await sched.fullView();

  // consumer contract (agent/http.js: GET /updates body)
  assert.deepEqual(Object.keys(view).sort(), ["schedules", "snapshot", "state"]);
  // known-answer snapshot shape through the REAL dgx mapping
  assert.equal(view.snapshot.dgxConfigured, true);
  assert.deepEqual(view.snapshot.otaAvailable, EXPECTED_OTA);
  assert.deepEqual(view.snapshot.packages, [EXPECTED_PKG]);
  assert.deepEqual(view.snapshot.raw, AVAILABLE_BODY); // unverified upstream kept verbatim
  // state block
  assert.equal(view.state.inProgress, false);
  assert.deepEqual(view.state.events, []);
  // schedules come from the scheduler, merged by spread
  assert.equal(view.schedules.length, 1);
  assert.equal(view.schedules[0].id, schedule.id);
  assert.equal(view.schedules[0].status, "pending");
  // fullView is cache-only: one login (from probeForce), none from the view
  assert.equal(fetchStub.calls.filter((c) => c.url.endsWith("/api/login")).length, 1);
});

test("degraded end-to-end: no creds → dgxConfigured:false, schedules still served, zero HTTP", async () => {
  const cfgDir = tmpDir(); // intentionally NO dgx.json
  const schedDir = tmpDir();
  const fetchStub = makeFetch(() => {
    throw new Error("degraded mode must not touch the backend");
  });
  const dgx = createDgxUpdates({ configDir: cfgDir, fetch: fetchStub, now: () => 1_000 });
  const sched = createUpdateScheduler({ dgx, configDir: schedDir, now: () => 1_000 });
  const { schedule } = await sched.scheduleUpdate({ kind: "at", at: 5_000_000_000 });
  const view = await sched.fullView();

  assert.equal(view.snapshot.dgxConfigured, false);
  assert.equal(view.snapshot.agentReachable, true); // the agent answers; DGX is simply unconfigured
  assert.equal(view.state.inProgress, false);
  assert.equal(view.schedules.length, 1);
  assert.equal(view.schedules[0].id, schedule.id);
  assert.equal(fetchStub.calls.length, 0);
});
