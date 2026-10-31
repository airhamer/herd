// settings.metricsHistory: off unless asked for, always a boolean
// (docs/specs/unit-history.md §7).
import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "herd-settings-"));
const settingsFile = path.join(tmp, "settings.json");
process.env.SETTINGS_JSON_PATH = settingsFile;
const settings = await import("../../settings.js");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("metricsHistory defaults to false and is coerced to a boolean", () => {
  fs.writeFileSync(settingsFile, "{}");
  assert.equal(settings.loadSettings().metricsHistory, false);
  assert.equal(settings.updateSettings({ metricsHistory: "yes" }).metricsHistory, true);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).metricsHistory, true);
  assert.equal(settings.updateSettings({ metricsHistory: 0 }).metricsHistory, false);
});
