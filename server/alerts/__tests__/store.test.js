// Alert settings validation and alerts.json (docs/specs/alerts.md §6).
// LIC1 clean-room rewrite.
import { after, describe, test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_CHANNELS,
  ValidationError,
  defaultConfig,
  loadAlertsFile,
  maskUrl,
  publicConfig,
  saveAlertsFile,
  validateChannelUrl,
  validateConfig,
} from "../store.js";
import { silentLog } from "./helpers.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "herd-alert-store-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const phone = (patch = {}) => ({ name: "Pager", type: "ntfy", url: "https://push.example.net/herd-private-topic", ...patch });

describe("channel URLs", () => {
  test("hosts follow the unit/LLM outbound policy", () => {
    const allowed = ["https://push.example.net/t", "http://10.20.30.40/x", "http://192.168.0.9:9000/", "http://100.64.0.3/h", "http://localhost:8080/h", "https://[2606:4700::1]/x"];
    for (const url of allowed) assert.equal(validateChannelUrl(url), url, url);
    const refused = ["http://169.254.169.254/", "http://0.0.0.0/", "http://239.1.1.1/", "http://[fe80::2]/", "http://[::ffff:a9fe:a9fe]/", "http://[::]/"];
    for (const url of refused) assert.throws(() => validateChannelUrl(url), /not allowed/, url);
  });

  test("shape errors", () => {
    assert.throws(() => validateChannelUrl("   "), /required/);
    assert.throws(() => validateChannelUrl("::nonsense"), /not a valid URL/);
    assert.throws(() => validateChannelUrl("gopher://h/x"), /http:\/\/ or https:\/\//);
    assert.throws(() => validateChannelUrl("file:///etc/hosts"), (err) => err instanceof ValidationError && err.status === 400);
  });

  test("maskUrl keeps scheme, host and the last four characters only", () => {
    assert.equal(maskUrl("https://push.example.net/herd-private-topic"), "https://push.example.net…opic");
    assert.equal(maskUrl("https://who:pw@hooks.example.net:8443/a?k=zz99"), "https://hooks.example.net:8443…zz99");
    assert.equal(maskUrl(""), "");
  });
});

describe("validateConfig", () => {
  test("only the sections sent change", () => {
    const first = validateConfig({ repeatIntervalMin: 15, rules: { disk: { forSec: 30 } }, channels: [phone()] });
    const second = validateConfig({ repeatIntervalMin: 60 }, first);
    assert.deepEqual(second.rules, { disk: { forSec: 30 } });
    assert.equal(second.channels[0].id, first.channels[0].id);
    assert.equal(validateConfig({ somethingElse: true }, first).repeatIntervalMin, 15);
  });

  test("repeat interval: 0 or 5…10080 minutes", () => {
    for (const ok of [0, 5, 240, 10_080]) assert.equal(validateConfig({ repeatIntervalMin: ok }).repeatIntervalMin, ok);
    assert.throws(() => validateConfig({ repeatIntervalMin: 2 }), /0 \(off\) or at least 5 minutes/);
    assert.throws(() => validateConfig({ repeatIntervalMin: null }), /must be a number/);
    assert.throws(() => validateConfig({ repeatIntervalMin: 20_000 }), /between 0 and 10080/);
  });

  test("rules: only enabled and forSec, for known rules", () => {
    assert.deepEqual(validateConfig({ rules: { llm: { enabled: false, forSec: 45 } } }).rules, { llm: { enabled: false, forSec: 45 } });
    assert.deepEqual(validateConfig({ rules: { llm: {} } }).rules, {});
    assert.throws(() => validateConfig({ rules: { llm: { threshold: 3 } } }), /unknown setting threshold/);
    assert.throws(() => validateConfig({ rules: { gpu_throttle: {} } }), /Unknown alert rule/);
    assert.throws(() => validateConfig({ rules: { llm: { forSec: 90_000 } } }), /between 0 and 86400/);
    assert.throws(() => validateConfig({ rules: { llm: { enabled: 1 } } }), /enabled must be true or false/);
    assert.throws(() => validateConfig({ rules: [] }), /rules must be an object/);
  });

  test("channels: defaults, ids and errors", () => {
    const [c] = validateConfig({ channels: [phone({ name: "  Pager  " })] }).channels;
    assert.match(c.id, /^ch_[0-9a-f]{12}$/);
    assert.deepEqual({ ...c, id: "x" }, { id: "x", name: "Pager", type: "ntfy", url: phone().url, enabled: true, minSeverity: "warning" });
    assert.throws(() => validateConfig({ channels: [phone({ name: "" })] }), /Channel name is required/);
    assert.throws(() => validateConfig({ channels: [phone({ type: "sms" })] }), /one of ntfy, discord, slack, webhook/);
    assert.throws(() => validateConfig({ channels: [phone({ minSeverity: "info" })] }), /warning or critical/);
    assert.throws(() => validateConfig({ channels: "x" }), /channels must be an array/);
    assert.throws(() => validateConfig({ channels: Array.from({ length: MAX_CHANNELS + 1 }, (_, i) => phone({ name: `p${i}` })) }), /At most/);
  });

  test("a masked URL keeps the stored one; on a new channel it is refused", () => {
    const saved = validateConfig({ channels: [phone()] });
    const shown = publicConfig(saved).channels[0];
    assert.equal(validateConfig({ channels: [shown] }, saved).channels[0].url, phone().url);
    assert.throws(() => validateConfig({ channels: [{ ...shown, id: undefined }] }, saved), /masked/);
  });
});

describe("publicConfig", () => {
  test("rules come with defaults and overrides; channels are masked with status", () => {
    const cfg = validateConfig({ rules: { offline: { forSec: 5 } }, channels: [phone()] });
    const pub = publicConfig(cfg, new Map([[cfg.channels[0].id, { lastSentAt: 1, lastError: null, lastErrorAt: null }]]));
    const offline = pub.rules.find((r) => r.id === "offline");
    assert.deepEqual(offline.overrides, { forSec: 5 });
    assert.equal(offline.source, "strip");
    assert.equal(pub.channels[0].hasUrl, true);
    assert.equal(pub.channels[0].status.lastSentAt, 1);
    assert.equal(JSON.stringify(pub).includes("private-topic"), false);
  });
});

describe("alerts.json", () => {
  test("is written 0600 without any URL and reads back", () => {
    const file = path.join(tmp, "alerts.json");
    const cfg = validateConfig({ repeatIntervalMin: 30, channels: [phone()] });
    saveAlertsFile(file, cfg, { savedAt: 1, firing: [] });
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.includes("private-topic"), false);
    assert.equal(text.includes('"url"'), false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const back = loadAlertsFile(file, silentLog);
    assert.equal(back.config.repeatIntervalMin, 30);
    assert.equal(back.config.channels[0].url, "");
    assert.deepEqual(back.state, { savedAt: 1, firing: [] });
    assert.equal(back.legacyUrls.size, 0);
  });

  test("an older file hands back its plaintext URLs (if allowed) and drops unknown rules", () => {
    const file = path.join(tmp, "v1.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        repeatIntervalMin: 120,
        rules: { disk_usage: { enabled: true }, llm: { forSec: 10 } },
        channels: [
          { id: "ch_keep", name: "Keep", type: "slack", url: "https://hooks.example.net/svc/abc", enabled: true, minSeverity: "critical" },
          { id: "ch_meta", name: "Meta", type: "webhook", url: "http://169.254.169.254/", enabled: true, minSeverity: "warning" },
        ],
      })
    );
    const { config, legacyUrls } = loadAlertsFile(file, silentLog);
    assert.equal(config.repeatIntervalMin, 120);
    assert.deepEqual(config.rules, { llm: { forSec: 10 } });
    assert.deepEqual(config.channels.map((c) => c.id), ["ch_keep", "ch_meta"]);
    assert.deepEqual([...legacyUrls], [["ch_keep", "https://hooks.example.net/svc/abc"]]);
  });

  test("missing or broken files give defaults", () => {
    assert.deepEqual(loadAlertsFile(path.join(tmp, "nope.json"), silentLog).config, defaultConfig());
    const broken = path.join(tmp, "broken.json");
    fs.writeFileSync(broken, "[1,");
    assert.deepEqual(loadAlertsFile(broken, silentLog).config, defaultConfig());
  });
});
