// Notifier (docs/specs/alerts.md §5): payloads per channel type, and delivery
// that re-checks the outbound policy, pins the socket, refuses redirects and
// keeps no response body. LIC1 clean-room rewrite.
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { Notifier, TEST_TITLE, buildRequest, describeGroup, filterGroupForChannel, formatAge } from "../notifier.js";
import { POLICY_BLOCKED, POLICY_UNRESOLVED } from "../outbound.js";
import { SECRET_MARKER, fakeDns, localServer, recordingFetch, silentLog } from "./helpers.js";

const T = 1_850_000_000_000;
const MIN = 60_000;

function sample(patch = {}) {
  return {
    key: "box-a:disk",
    ruleId: "disk",
    ruleName: "Storage",
    unitId: "box-a",
    unitName: "box-a",
    severity: "warning",
    peakSeverity: "warning",
    label: "Storage nearly full",
    summary: "/data at 93%",
    startsAt: T - 12 * MIN,
    endsAt: null,
    ...patch,
  };
}
const fired = (patch) => ({ firing: [sample(patch)], resolved: [], reminder: false });
const channel = (patch = {}) => ({ id: "ch1", name: "Ops", type: "webhook", url: "http://hooks.lan/in", enabled: true, minSeverity: "warning", ...patch });

describe("message text", () => {
  test("formatAge", () => {
    const cases = [[0, "0s"], [59_999, "59s"], [MIN, "1m"], [61 * MIN, "1h 1m"], [25 * 60 * MIN, "1d 1h"], [-1, "0s"]];
    for (const [ms, text] of cases) assert.equal(formatAge(ms), text, String(ms));
  });

  test("one alert: the title names it; lines say how long", () => {
    const d = describeGroup(fired(), T);
    assert.equal(d.title, "[WARNING] box-a: Storage nearly full");
    assert.equal(d.tone, "warning");
    assert.deepEqual(d.lines, ["WARNING box-a · Storage: /data at 93% (for 12m)"]);
    const gone = describeGroup({ firing: [], resolved: [sample({ endsAt: T - 2 * MIN })] }, T);
    assert.equal(gone.title, "[RESOLVED] box-a: Storage nearly full");
    assert.equal(gone.lines[0], "RESOLVED box-a · Storage: /data at 93% (lasted 10m)");
    assert.equal(describeGroup({ ...fired(), reminder: true }, T).title, "[Still firing] box-a: Storage nearly full");
  });

  test("several alerts: counted title, critical wins the tone, long lists are cut", () => {
    const group = { firing: [sample(), sample({ unitName: "box-b", severity: "critical" })], resolved: [sample({ endsAt: T })] };
    const d = describeGroup(group, T);
    assert.equal(d.title, "sparkDash: 2 firing, 1 resolved");
    assert.equal(d.tone, "critical");
    assert.equal(describeGroup({ ...group, reminder: true }, T).title, "sparkDash: 2 still firing, 1 resolved");
    const crowd = { firing: Array.from({ length: 25 }, (_, i) => sample({ unitName: `n${i}` })), resolved: [] };
    const cut = describeGroup(crowd, T);
    assert.equal(cut.lines.length, 21);
    assert.equal(cut.lines[20], "+5 more");
  });
});

describe("requests per channel type", () => {
  test("ntfy: plain text with title, priority and tag headers", () => {
    const { url, init } = buildRequest(channel({ type: "ntfy", url: "https://ntfy.example.org/topic" }), fired({ severity: "critical" }), T);
    assert.equal(url, "https://ntfy.example.org/topic");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Priority, "5");
    assert.equal(init.headers.Tags, "rotating_light");
    assert.match(init.body, /^CRITICAL box-a · Storage/);
  });

  test("discord: an embed per alert and no mentions", () => {
    const body = JSON.parse(buildRequest(channel({ type: "discord" }), fired(), T).init.body);
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.equal(body.embeds.length, 1);
    assert.equal(body.embeds[0].title, "Warning · box-a: Storage nearly full");
    assert.equal(body.embeds[0].timestamp, new Date(T - 12 * MIN).toISOString());
  });

  test("slack: bold title then bullets", () => {
    const body = JSON.parse(buildRequest(channel({ type: "slack" }), fired(), T).init.body);
    assert.equal(body.text, "*[WARNING] box-a: Storage nearly full*\n• WARNING box-a · Storage: /data at 93% (for 12m)");
  });

  test("webhook: structured alerts", () => {
    const body = JSON.parse(buildRequest(channel(), fired(), T).init.body);
    assert.equal(body.status, "firing");
    assert.equal(body.sentAt, new Date(T).toISOString());
    assert.deepEqual(
      { rule: body.alerts[0].rule, unit: body.alerts[0].unit, endsAt: body.alerts[0].endsAt },
      { rule: "disk", unit: "box-a", endsAt: null }
    );
  });

  test("a test group gets the fixed test text", () => {
    const { init } = buildRequest(channel({ type: "ntfy" }), { test: true, firing: [], resolved: [] }, T);
    assert.equal(init.headers.Title, TEST_TITLE);
    assert.equal(init.headers.Tags, "test_tube");
    assert.equal(JSON.parse(buildRequest(channel(), { test: true }, T).init.body).status, "test");
  });
});

describe("per-channel filtering", () => {
  test("firing by current severity, resolved by peak; empty → null", () => {
    const strict = { minSeverity: "critical" };
    assert.equal(filterGroupForChannel(strict, fired()), null);
    const part = filterGroupForChannel(strict, { firing: [], resolved: [sample({ peakSeverity: "critical" })] });
    assert.equal(part.resolved.length, 1);
    assert.equal(filterGroupForChannel({ minSeverity: "warning" }, fired()).firing.length, 1);
  });
});

describe("delivery", () => {
  test("goes over a real socket to the address that was checked, resolving once", async (t) => {
    const srv = await localServer();
    t.after(srv.stop);
    const dns = fakeDns(["127.0.0.1"]);
    const result = await new Notifier({ lookup: dns, log: silentLog }).send(channel({ url: `http://alerts.example.test:${srv.port}/in` }), fired());
    assert.deepEqual(result, { ok: true, status: 200 });
    assert.equal(srv.seen.length, 1);
    assert.equal(srv.seen[0].path, "/in");
    assert.equal(JSON.parse(srv.seen[0].body).alerts[0].unitId, "box-a");
    assert.deepEqual(dns.names, ["alerts.example.test"]);
  });

  test("refuses hosts that resolve somewhere forbidden, and literal forbidden IPs", async (t) => {
    const srv = await localServer();
    t.after(srv.stop);
    for (const address of ["169.254.169.254", "0.0.0.0", "::ffff:169.254.169.254", "fe80::1", "224.0.0.1"]) {
      const notifier = new Notifier({ lookup: fakeDns([address]), log: silentLog });
      const r = await notifier.send(channel({ url: `http://alerts.example.test:${srv.port}/in` }), fired());
      assert.deepEqual(r, { ok: false, error: POLICY_BLOCKED }, address);
      assert.equal(notifier.status.get("ch1").lastError, POLICY_BLOCKED);
    }
    const literal = await new Notifier({ log: silentLog }).send(channel({ url: "http://169.254.169.254/latest/meta-data" }), fired());
    assert.equal(literal.error, POLICY_BLOCKED);
    assert.equal(srv.seen.length, 0);
    assert.equal(/\d+\.\d+\.\d+\.\d+/.test(POLICY_BLOCKED), false);
  });

  test("a name that does not resolve fails with a fixed reason", async () => {
    const lookup = async () => {
      throw Object.assign(new Error("ENOTFOUND hidden.example.test"), { code: "ENOTFOUND" });
    };
    const r = await new Notifier({ lookup, log: silentLog }).send(channel({ url: "https://hidden.example.test/x" }), fired());
    assert.deepEqual(r, { ok: false, error: POLICY_UNRESOLVED });
  });

  test("redirects are reported, not followed", async (t) => {
    const elsewhere = await localServer();
    t.after(elsewhere.stop);
    const bouncer = await localServer((_req, res) => {
      res.writeHead(307, { Location: `http://127.0.0.1:${elsewhere.port}/` });
      res.end(SECRET_MARKER);
    });
    t.after(bouncer.stop);
    const r = await new Notifier({ log: silentLog }).send(channel({ url: `http://127.0.0.1:${bouncer.port}/x` }), fired());
    assert.deepEqual(r, { ok: false, error: "redirect not followed (HTTP 307)" });
    assert.equal(elsewhere.seen.length, 0);
    for (const code of [301, 302, 308]) {
      const stub = recordingFetch(code, { headers: { Location: "http://x/" } });
      const r2 = await new Notifier({ fetchImpl: stub, lookup: fakeDns(["10.1.1.1"]), log: silentLog }).send(channel(), fired());
      assert.equal(r2.error, `redirect not followed (HTTP ${code})`);
      assert.equal(stub.calls[0].init.redirect, "manual");
    }
  });

  test("response bodies and error text never come back", async (t) => {
    const srv = await localServer((_req, res) => {
      res.writeHead(502);
      res.end(`upstream said ${SECRET_MARKER}`);
    });
    t.after(srv.stop);
    const warnings = [];
    const results = [];
    const notifier = new Notifier({ log: { warn: (line) => warnings.push(line) }, onResult: (x) => results.push(x) });
    const r = await notifier.send(channel({ url: `http://127.0.0.1:${srv.port}/x` }), fired());
    assert.deepEqual(r, { ok: false, error: "HTTP 502" });
    const seen = JSON.stringify({ r, status: [...notifier.status.values()], warnings, results: results.map(({ ok, status, reason }) => ({ ok, status, reason })) });
    assert.equal(seen.includes(SECRET_MARKER), false);

    const thrown = async (error) =>
      (await new Notifier({ fetchImpl: recordingFetch(0, { error }), lookup: fakeDns(["10.1.1.1"]), log: silentLog }).send(channel(), fired())).error;
    assert.equal(await thrown(Object.assign(new TypeError(SECRET_MARKER), { cause: { code: "ECONNRESET" } })), "connection failed (ECONNRESET)");
    assert.equal(await thrown(Object.assign(new Error(SECRET_MARKER), { name: "TimeoutError" })), "timed out after 10s");
    assert.equal(await thrown(new Error(SECRET_MARKER)), "request failed");
  });

  test("dispatch sends only to enabled channels whose minimum is met", async () => {
    const stub = recordingFetch(202);
    const notifier = new Notifier({ fetchImpl: stub, lookup: fakeDns(["192.168.7.7"]), log: silentLog });
    const results = await notifier.dispatch(
      [channel({ id: "on" }), channel({ id: "off", enabled: false }), channel({ id: "picky", minSeverity: "critical" })],
      fired()
    );
    assert.deepEqual(results, [{ channelId: "on", ok: true, status: 202 }]);
    assert.equal(stub.calls.length, 1);
    assert.equal(notifier.status.get("on").lastError, null);
  });
});
