// Alerts runtime (docs/specs/alerts.md §8): the on/off gate, save-time policy,
// URLs in the secrets store, test sends and Activity events.
// LIC1 clean-room rewrite.
import { after, describe, test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventLog } from "../../events/EventLog.js";
import { ALERTS_OFF_MESSAGE, createAlertsRuntime, notificationEvent } from "../runtime.js";
import { POLICY_BLOCKED } from "../outbound.js";
import { SECRET_MARKER, fakeDns, localServer, manualClock, offlineUnit, recordingFetch, silentLog, unitAt } from "./helpers.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "herd-alert-runtime-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let fileNo = 0;

/** Secrets store stand-in kept in memory. */
function inMemorySecrets(seed = []) {
  const box = { urls: new Map(seed) };
  box.load = () => new Map(box.urls);
  box.save = (urls) => void (box.urls = new Map(urls));
  return box;
}

function build({ on = true, fetchImpl = recordingFetch(200), lookup = fakeDns(["192.168.4.4"]), secrets = inMemorySecrets(), filePath } = {}) {
  const gate = { on };
  const now = manualClock(1_850_000_000_000);
  const log = new EventLog({ now });
  const file = filePath ?? path.join(tmp, `alerts-${++fileNo}.json`);
  const rt = createAlertsRuntime({ filePath: file, isEnabled: () => gate.on, now, fetchImpl, lookup, log: silentLog, secrets, recordEvent: (e) => log.record(e) });
  rt.start();
  return { rt, gate, now, log, file, secrets, fetchImpl, lookup };
}

const pager = { name: "Pager", type: "ntfy", url: "http://push.lan/herd-private-topic", enabled: true, minSeverity: "warning" };
const waitFor = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("while alerts are off", () => {
  test("nothing is evaluated, sent, resolved or written; reads still work", async () => {
    const h = build({ on: false });
    h.rt.tick([offlineUnit()]);
    assert.deepEqual(h.rt.engine.pending(), []);
    assert.equal(h.rt.snapshotBlock(), null);
    await assert.rejects(h.rt.updateConfig({ channels: [pager] }), (e) => e.status === 409 && e.message === ALERTS_OFF_MESSAGE);
    await assert.rejects(h.rt.test({ channel: pager }), (e) => e.status === 409);
    assert.equal(h.fetchImpl.calls.length, 0);
    assert.deepEqual(h.lookup.names, []);
    assert.equal(fs.existsSync(h.file), false);
    assert.equal(h.rt.publicConfig().enabled, false);
    assert.equal(h.rt.status().enabled, false);
  });

  test("switching off forgets live alerts; switching on again starts over", async () => {
    const h = build();
    await h.rt.updateConfig({ rules: { offline: { forSec: 0 } }, channels: [pager] });
    h.rt.tick([offlineUnit()]);
    assert.equal(h.rt.status().active.length, 1);
    h.gate.on = false;
    h.rt.tick([offlineUnit()]);
    assert.deepEqual(h.rt.status().active, []);
    h.gate.on = true;
    h.rt.tick([offlineUnit()]);
    assert.equal(h.rt.status().recent[0].id, 2, "fired again as a new alert");
  });
});

describe("delivery and Activity", () => {
  test("a firing alert is sent and recorded without its URL", async () => {
    const h = build();
    await h.rt.updateConfig({ rules: { thermal: { forSec: 0 } }, channels: [pager] });
    h.rt.tick([unitAt(95)]);
    const notices = () => h.log.list({ types: ["alert.notify."] });
    await waitFor(() => notices().length > 0);
    assert.equal(h.fetchImpl.calls.length, 1);
    assert.equal(h.fetchImpl.calls[0].url, pager.url);
    const [event] = notices();
    assert.equal(event.type, "alert.notify.sent");
    assert.equal(event.sparkId, "spark-1");
    assert.equal(event.message, 'Alert notification sent to "Pager" (ntfy): critical · spark-1 GPU is close to its shutdown temperature');
    assert.equal(JSON.stringify(event).includes("private-topic"), false);
    assert.deepEqual(h.rt.snapshotBlock().active.map((a) => a.key), ["spark-1:thermal"]);
  });

  test("a rejected send shows a status code only", async (t) => {
    const srv = await localServer((_req, res) => {
      res.writeHead(401);
      res.end(`denied ${SECRET_MARKER}`);
    });
    t.after(srv.stop);
    const h = build({ fetchImpl: null, lookup: null });
    await h.rt.updateConfig({ rules: { offline: { forSec: 0 } }, channels: [{ ...pager, type: "webhook", url: `http://127.0.0.1:${srv.port}/private-path` }] });
    h.rt.tick([offlineUnit("timeout")]);
    const notices = () => h.log.list({ types: ["alert.notify."] });
    await waitFor(() => notices().length > 0);
    assert.equal(srv.seen.length, 1);
    const [event] = notices();
    assert.equal(event.type, "alert.notify.failed");
    assert.equal(event.severity, "error");
    assert.match(event.message, /failed: HTTP 401/);
    assert.equal(h.rt.publicConfig().channels[0].status.lastError, "HTTP 401");
    const all = JSON.stringify({ events: h.log.list(), cfg: h.rt.publicConfig(), status: h.rt.status() });
    assert.equal(all.includes(SECRET_MARKER), false);
    assert.equal(all.includes("private-path"), false);
  });
});

describe("alert transitions in Activity (issue #32)", () => {
  test("firing and resolving are recorded as alert.fired / alert.resolved", async () => {
    const h = build();
    await h.rt.updateConfig({ rules: { offline: { forSec: 0 } }, channels: [] });
    h.rt.tick([offlineUnit()]);
    const [fired] = h.log.list({ types: ["alert.fired"] });
    assert.equal(fired.sparkId, "spark-1");
    assert.equal(fired.sparkName, "spark-1");
    assert.equal(fired.data.ruleId, "offline");
    for (let i = 0; i < 40 && h.log.list({ types: ["alert.resolved"] }).length === 0; i++) {
      h.now.tick(60_000);
      h.rt.tick([unitAt(40)]);
    }
    const [resolved] = h.log.list({ types: ["alert.resolved"] });
    assert.ok(resolved, "resolved once the unit is healthy long enough");
    assert.equal(resolved.severity, "success");
    assert.equal(resolved.data.key, fired.data.key);
  });
});

describe("test sends", () => {
  test("a draft channel gets the test message; failures give a code only", async (t) => {
    const srv = await localServer((_req, res) => {
      res.writeHead(503);
      res.end(SECRET_MARKER);
    });
    t.after(srv.stop);
    const h = build({ fetchImpl: null, lookup: null });
    const result = await h.rt.test({ channel: { ...pager, url: `http://127.0.0.1:${srv.port}/t` } });
    assert.deepEqual(result, { ok: false, error: "HTTP 503" });
    assert.match(srv.seen[0].headers.title, /test notification/);
    const [event] = h.log.list();
    assert.equal(event.message, 'Test notification to "Pager" (ntfy) failed: HTTP 503');
    assert.equal(event.data.channelId, "draft");
    assert.equal(JSON.stringify(event).includes(SECRET_MARKER), false);
  });

  test("saved channels by id, masked drafts resolve, unknown ids are 404, quick repeats wait", async () => {
    const h = build();
    const pub = await h.rt.updateConfig({ channels: [pager] });
    const saved = pub.channels[0];
    assert.deepEqual(await h.rt.test({ channelId: saved.id }), { ok: true, status: 200 });
    const again = await h.rt.test({ channelId: saved.id });
    assert.equal(again.rateLimited, true);
    h.now.tick(10_000);
    assert.equal((await h.rt.test({ channelId: saved.id, channel: { ...saved, name: "Renamed" } })).ok, true);
    assert.equal(h.fetchImpl.calls.at(-1).url, pager.url);
    await assert.rejects(h.rt.test({ channelId: "ch_000000000000" }), (e) => e.status === 404 && e.message === "Unknown channel");
    await assert.rejects(h.rt.test({ channel: { ...pager, url: "http://169.254.169.254/" } }), (e) => e.status === 400);
  });
});

describe("saving", () => {
  test("a host resolving to a forbidden address is refused; an unresolvable one is accepted", async () => {
    const meta = build({ lookup: fakeDns(["169.254.169.254"]) });
    await assert.rejects(meta.rt.updateConfig({ channels: [pager] }), (e) => e.status === 400 && e.message === `Pager: ${POLICY_BLOCKED}`);
    const nxdomain = build({
      lookup: async () => {
        throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      },
    });
    const pub = await nxdomain.rt.updateConfig({ channels: [pager] });
    assert.equal(pub.channels.length, 1);
  });

  test("URLs go to the secrets store and leave with their channel", async () => {
    const h = build();
    const pub = await h.rt.updateConfig({ channels: [pager] });
    assert.equal(h.secrets.urls.get(pub.channels[0].id), pager.url);
    assert.equal(fs.readFileSync(h.file, "utf8").includes("private-topic"), false);
    await h.rt.updateConfig({ channels: [] });
    assert.equal(h.secrets.urls.size, 0);
  });

  test("plaintext URLs from an older alerts.json move into the secrets store", () => {
    const file = path.join(tmp, "older.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, channels: [{ id: "ch_legacy", name: "Old", type: "slack", url: "https://hooks.example.net/legacy", enabled: true, minSeverity: "warning" }] }));
    const secrets = inMemorySecrets();
    const h = build({ filePath: file, secrets });
    assert.equal(secrets.urls.get("ch_legacy"), "https://hooks.example.net/legacy");
    assert.equal(fs.readFileSync(file, "utf8").includes("hooks.example.net"), false);
    assert.equal(h.rt.publicConfig().channels[0].hasUrl, true);
  });
});

describe("notificationEvent", () => {
  const ch = { id: "c9", name: "M".repeat(80), type: "slack" };
  const a = { unitId: "u1", unitName: "U1", severity: "critical", label: "Unit offline", ruleName: "Unit offline" };

  test("a single alert is named; the channel name is capped", () => {
    const e = notificationEvent({ channel: ch, group: { firing: [a], resolved: [] }, ok: true, status: 200 });
    assert.ok(e.message.endsWith(": critical · U1 Unit offline"));
    assert.ok(e.message.includes(`"${"M".repeat(59)}…"`));
    assert.deepEqual([e.sparkId, e.sparkName], ["u1", "U1"]);
  });

  test("groups are counted; reminders and failures say so", () => {
    const e = notificationEvent({ channel: ch, group: { firing: [a, { ...a, unitId: "u2" }], resolved: [a], reminder: true }, ok: false, reason: "HTTP 410" });
    assert.match(e.message, /^Alert reminder to ".*" \(slack\) failed: HTTP 410: 2 firing, 1 resolved$/);
    assert.equal(e.sparkId, null);
    assert.deepEqual(e.data, { channelId: "c9", channelType: "slack", test: false, reminder: true, firing: 2, resolved: 1, reason: "HTTP 410" });
  });
});
