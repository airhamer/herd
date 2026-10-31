// Alert channel URLs in the encrypted secrets store, next to SSH passwords and
// LLM keys (docs/specs/alerts.md §6). LIC1 clean-room rewrite.
import { after, beforeEach, test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// config.js reads these once at import time; node --test runs each file in its own process.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "herd-alert-secrets-"));
process.env.SPARKS_SECRETS_PATH = path.join(tmp, "secrets.json");
process.env.SECRETS_KEY_PATH = path.join(tmp, "key");
const store = await import("../../secretsStore.js");
const { createAlertsRuntime } = await import("../runtime.js");
const { silentLog } = await import("./helpers.js");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(process.env.SPARKS_SECRETS_PATH, { force: true }));

const HOOK = "https://hooks.example.net/services/T000/B000/zzzz-private";
const TOPIC = "http://10.9.8.7:2586/herd-private-topic";

test("URLs are stored encrypted and come back intact", () => {
  store.saveAlertChannelUrls(new Map([["ch_1", HOOK], ["ch_2", TOPIC]]));
  const disk = fs.readFileSync(process.env.SPARKS_SECRETS_PATH, "utf8");
  assert.equal(disk.includes("private"), false);
  assert.deepEqual(Object.keys(JSON.parse(disk).alertChannels).sort(), ["ch_1", "ch_2"]);
  assert.deepEqual([...store.loadAlertChannelUrls()].sort(), [["ch_1", HOOK], ["ch_2", TOPIC]]);
});

test("password saves and URL saves leave each other's sections alone", () => {
  store.saveAlertChannelUrls(new Map([["ch_1", HOOK]]));
  store.saveSecrets(new Map([["unit-a", "hunter2"]]), new Map([["unit-a", { 8000: "sk-local" }]]));
  assert.equal(store.loadAlertChannelUrls().get("ch_1"), HOOK);

  store.saveAlertChannelUrls(new Map([["ch_2", TOPIC]]));
  const { passwords, llmApiKeys } = store.loadSecrets();
  assert.equal(passwords.get("unit-a"), "hunter2");
  assert.equal(llmApiKeys.get("unit-a")["8000"], "sk-local");
  assert.deepEqual([...store.loadAlertChannelUrls().keys()], ["ch_2"]);

  store.saveSecrets(new Map(), new Map());
  assert.equal(store.loadAlertChannelUrls().get("ch_2"), TOPIC, "file kept while URLs remain");
  store.saveAlertChannelUrls(new Map());
  assert.equal(fs.existsSync(process.env.SPARKS_SECRETS_PATH), false, "removed once every section is empty");
});

test("the runtime migrates a plaintext URL from alerts.json at startup", () => {
  const file = path.join(tmp, "alerts.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, channels: [{ id: "ch_old", name: "Old", type: "ntfy", url: TOPIC, enabled: true, minSeverity: "warning" }] }));
  const first = createAlertsRuntime({ filePath: file, isEnabled: () => false, log: silentLog });
  assert.equal(fs.readFileSync(file, "utf8").includes("private-topic"), false);
  assert.equal(fs.readFileSync(process.env.SPARKS_SECRETS_PATH, "utf8").includes("private-topic"), false);
  assert.equal(store.loadAlertChannelUrls().get("ch_old"), TOPIC);
  assert.equal(first.publicConfig().channels[0].hasUrl, true);
  const second = createAlertsRuntime({ filePath: file, isEnabled: () => false, log: silentLog });
  assert.equal(second.publicConfig().channels[0].url, `http://10.9.8.7:2586…${TOPIC.slice(-4)}`);
});
