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

import { createDgxUpdates, normalizeList } from "../dgx.js";

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
  // Batch 8 (ruling adaptation #3): raw keeps BOTH upstream bodies verbatim.
  // This stub does not serve /list (302 fall-through) → fail-soft: legacy
  // guess kept, listError recorded, raw.list null.
  assert.deepEqual(snap.raw, { available: AVAILABLE_BODY, list: null });
  assert.match(snap.listError, /302/);
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

// ─── Batch 8: /api/v1/updates/list (real gx10-1c2c captured fixtures) ───

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");
const LIST_REAL = JSON.parse(fs.readFileSync(path.join(FIXTURES, "updates-list.real.json"), "utf8"));

// Known-answer ground truth, transcribed field-for-field from the committed
// real fixture (ruling C shape: size verbatim, sizeBytes null).
const EXPECTED_LIST_PKGS = [
  { name: "apache2-bin", currentVersion: "2.4.58-1ubuntu8.15", availableVersion: "2.4.58-1ubuntu8.17",
    sizeBytes: null, size: "1.3 MB", description: "Apache HTTP Server (modules and other binary files)" },
  { name: "apparmor", currentVersion: "4.0.1really4.0.1-0ubuntu0.24.04.7", availableVersion: "4.0.1really4.0.1-0ubuntu0.24.04.9",
    sizeBytes: null, size: "601.4 kB", description: "user-space parser utility for AppArmor" },
  { name: "bind9-dnsutils", currentVersion: "1:9.18.39-0ubuntu0.24.04.7", availableVersion: "1:9.18.39-0ubuntu0.24.04.8",
    sizeBytes: null, size: "151.2 kB", description: "bind9-dnsutils" },
  { name: "xvfb", currentVersion: "2:21.1.12-1ubuntu1.6", availableVersion: "2:21.1.12-1ubuntu1.8",
    sizeBytes: null, size: "850.4 kB", description: "Virtual Framebuffer 'fake' X server" },
];
const EXPECTED_LIST_FW = [
  { component: "Embedded Controller", currentVersion: "0x02000006", availableVersion: "0x02000007" },
  { component: "UEFI Device Firmware", currentVersion: "0x03000007", availableVersion: "0x03000008" },
];

function listBackend(listHandler) {
  return makeFetch((url) => {
    if (url.endsWith("/api/login")) return { status: 200, json: { token: "***" } };
    if (url.includes("/api/v1/updates/available")) return { status: 200, json: AVAILABLE_BODY };
    if (url.includes("/api/v1/updates/enabled")) return { status: 200, json: { updatesEnabled: true } };
    if (url.includes("/api/v1/updates/list")) return listHandler(url);
    return { status: 302, text: "SPA fallback" };
  });
}

test("normalizeList (real fixture): 4 packages + 2 firmware mapped verbatim (ruling-C shape)", () => {
  const out = normalizeList(LIST_REAL);
  assert.deepEqual(out.packages, EXPECTED_LIST_PKGS); // installed/candidate/size/description verbatim
  assert.deepEqual(out.firmware, EXPECTED_LIST_FW); // hex versions verbatim
});

test("merge precedence: /list OK → real rows win over /available guess; raw keeps both bodies verbatim", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const fetchStub = listBackend(() => ({ status: 200, json: LIST_REAL }));
  const dgx = createDgxUpdates({ configDir: dir, fetch: fetchStub, now: () => 1_000 });
  const snap = await dgx.probe(true);
  assert.equal(snap.listError, undefined); // /list succeeded — no error marker
  assert.deepEqual(snap.packages, EXPECTED_LIST_PKGS); // legacy [EXPECTED_PKG] replaced
  assert.equal(snap.packages.some((p) => p.name === "linux-nvidia"), false); // guess fully superseded
  assert.deepEqual(snap.firmware, EXPECTED_LIST_FW);
  assert.deepEqual(snap.otaAvailable, EXPECTED_OTA); // summary mapping still from /available
  assert.deepEqual(snap.raw, { available: AVAILABLE_BODY, list: LIST_REAL }); // both upstream verbatim
  const urls = fetchStub.calls.map((c) => c.url);
  assert.ok(urls.findIndex((u) => u.includes("/updates/available")) < urls.findIndex((u) => u.includes("/updates/list")),
    "/list must be fetched AFTER /available succeeds");
  const listCall = fetchStub.calls.find((c) => c.url.includes("/updates/list"));
  assert.equal(listCall.headers.Authorization, "Bearer ***"); // same token/base as /available
});

test("fail-soft: /list 500 → probe OK, legacy rows kept, listError recorded, raw.list null", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const fetchStub = listBackend(() => ({ status: 500, text: "Internal Server Error" }));
  const dgx = createDgxUpdates({ configDir: dir, fetch: fetchStub, now: () => 1_000 });
  const snap = await dgx.probe(true);
  assert.equal(snap.dgxError, undefined); // a /list failure NEVER fails the probe
  assert.deepEqual(snap.packages, [EXPECTED_PKG]); // today's behavior preserved
  assert.deepEqual(snap.firmware, [EXPECTED_FW]);
  assert.match(snap.listError, /500/);
  assert.deepEqual(snap.raw, { available: AVAILABLE_BODY, list: null });
});

test("fail-soft: /list malformed JSON or transport timeout → same legacy outcome + listError", async () => {
  // 200 but unparseable body (stub json() rejects → mapped to null → unparseable)
  const d1 = tmpDir();
  writeCreds(d1);
  const dgx1 = createDgxUpdates({
    configDir: d1, fetch: listBackend(() => ({ status: 200 })), now: () => 1_000,
  });
  const snap1 = await dgx1.probe(true);
  assert.equal(snap1.dgxError, undefined);
  assert.match(snap1.listError, /unparseable/i);
  assert.deepEqual(snap1.packages, [EXPECTED_PKG]);
  assert.equal(snap1.raw.list, null);
  // transport failure (AbortSignal.timeout surfaces as a rejected fetch)
  const d2 = tmpDir();
  writeCreds(d2);
  const dgx2 = createDgxUpdates({
    configDir: d2,
    fetch: listBackend(() => { throw new Error("The operation was aborted due to a timeout"); }),
    now: () => 1_000,
  });
  const snap2 = await dgx2.probe(true);
  assert.equal(snap2.dgxError, undefined);
  assert.match(snap2.listError, /timeout/i);
  assert.deepEqual(snap2.packages, [EXPECTED_PKG]);
});

test("legit zero: packageUpdates [] + firmwareUpdates [] → empty rows, NO listError, guess still superseded", async () => {
  const dir = tmpDir();
  writeCreds(dir);
  const emptyList = { packageUpdates: [], firmwareUpdates: [] };
  const dgx = createDgxUpdates({
    configDir: dir, fetch: listBackend(() => ({ status: 200, json: emptyList })), now: () => 1_000,
  });
  const snap = await dgx.probe(true);
  assert.equal(snap.listError, undefined); // legitimate zero ≠ error
  assert.deepEqual(snap.packages, []); // real zero from /list beats the legacy guess
  assert.deepEqual(snap.firmware, []);
  assert.deepEqual(snap.raw.list, emptyList);
});

test("normalizeList junk tolerance: never throws, empty out, nameless items skipped", () => {
  const EMPTY = { packages: [], firmware: [] };
  for (const junk of [null, undefined, "updates", 42, [], {}]) {
    assert.deepEqual(normalizeList(junk), EMPTY);
  }
  assert.deepEqual(normalizeList({ packageUpdates: "nope", firmwareUpdates: 7 }), EMPTY);
  const out = normalizeList({
    packageUpdates: [null, "x", 5, { currentVersion: "1", availableVersion: "2" }, { name: "" }, { name: "ok" }],
    firmwareUpdates: [null, {}, { name: 42 }, { name: "EC", currentVersion: "0x1", availableVersion: "0x2" }],
  });
  assert.deepEqual(out.packages, [{ name: "ok", currentVersion: "", availableVersion: "", sizeBytes: null, size: null, description: null }]);
  assert.deepEqual(out.firmware, [{ component: "EC", currentVersion: "0x1", availableVersion: "0x2" }]);
});

