/**
 * Settings defaults for the bucketed unit history (server/settings.js). This fork
 * had no settings-defaults test file; upstream 04c7560 adds the metricsHistory
 * toggle test, which lands here (adapted: no showVramBreakdown in this fork).
 */
import { test, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-settings-"));
process.env.SETTINGS_JSON_PATH = path.join(dir, "settings.json");
const { loadSettings, updateSettings } = await import("../../settings.js");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("metricsHistory is opt-in and stored as a boolean", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ density: "compact" }));
  assert.equal(loadSettings().metricsHistory, false);
  assert.equal(updateSettings({ metricsHistory: 1 }).metricsHistory, true);
  assert.equal(loadSettings().metricsHistory, true);
  assert.equal(updateSettings({ metricsHistory: "" }).metricsHistory, false);
});
