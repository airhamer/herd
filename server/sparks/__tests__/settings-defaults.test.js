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

// Issue #33: Fleet energy on by default, price/currency and idle baselines.
test("fleet energy defaults on, with a price, currency and idle baseline", () => {
  fs.writeFileSync(settingsFile, JSON.stringify({ settingsRevision: 2 }));
  const loaded = settings.loadSettings();
  assert.equal(loaded.showFleetEnergy, true);
  assert.equal(loaded.electricityPricePerKwh, 0.17);
  assert.equal(loaded.electricityCurrency, "USD");
  assert.equal(loaded.energyIdleBaselineW, 40);
  assert.deepEqual(loaded.energyHostBaselines, {});
});

test("a settings file from before #33 turns Fleet energy on once, then respects the choice", () => {
  const old = JSON.stringify({ showFleetEnergy: false, density: "compact" });
  fs.writeFileSync(settingsFile, old);
  assert.equal(settings.loadSettings().showFleetEnergy, true);
  assert.equal(fs.readFileSync(settingsFile, "utf8"), old, "loading never rewrites the file");
  settings.updateSettings({ showFleetEnergy: false });
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).settingsRevision, 2);
  assert.equal(settings.loadSettings().showFleetEnergy, false);
});

test("energy settings are clamped and sanitised", () => {
  fs.writeFileSync(settingsFile, JSON.stringify({ settingsRevision: 2 }));
  settings.loadSettings();
  const next = settings.updateSettings({
    electricityPricePerKwh: -4,
    electricityCurrency: "euro",
    energyIdleBaselineW: 9_999,
    energyHostBaselines: { big: 150, bad: "x", neg: -1, "": 5 },
  });
  assert.equal(next.electricityPricePerKwh, 0.17);
  assert.equal(next.electricityCurrency, "USD");
  assert.equal(next.energyIdleBaselineW, 2_000);
  assert.deepEqual(next.energyHostBaselines, { big: 150 });
  assert.equal(settings.updateSettings({ electricityPricePerKwh: 0, electricityCurrency: "gbp" }).electricityCurrency, "GBP");
  assert.equal(settings.getSettings().electricityPricePerKwh, 0);
});

// GUARD1 (#95): guardProxy config — validated, trimmed, never half-valid.
test("guardProxy defaults to empty and is clamped on save", () => {
  fs.writeFileSync(settingsFile, "{}");
  assert.deepEqual(settings.loadSettings().guardProxy, { baseURL: "", apiKeyRef: "" });

  const ok = settings.updateSettings({
    guardProxy: { baseURL: "http://192.168.50.226:8081///", apiKeyRef: "env:GUARD_PROXY_KEY" },
  });
  assert.equal(ok.guardProxy.baseURL, "http://192.168.50.226:8081");
  assert.equal(ok.guardProxy.apiKeyRef, "env:GUARD_PROXY_KEY");
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")).guardProxy, ok.guardProxy);

  // Non-http(s) schemes and non-URLs clear; secret-ref shapes pass, raw keys don't.
  for (const baseURL of ["ftp://x.test", "not a url", "javascript:alert(1)", "", 42]) {
    assert.equal(settings.updateSettings({ guardProxy: { baseURL } }).guardProxy.baseURL, "", String(baseURL));
  }
  assert.equal(settings.updateSettings({ guardProxy: { baseURL: "https://h.test:8443/base" } }).guardProxy.baseURL, "https://h.test:8443/base");
  for (const apiKeyRef of ["file:/etc/herd/guard.key", "GUARD_PROXY_KEY", "env:K"]) {
    assert.equal(settings.updateSettings({ guardProxy: { apiKeyRef } }).guardProxy.apiKeyRef, apiKeyRef);
  }
  for (const apiKeyRef of ["sk-abc123", "http://k.test", "has space", "env:"]) {
    assert.equal(settings.updateSettings({ guardProxy: { apiKeyRef } }).guardProxy.apiKeyRef, "", apiKeyRef);
  }

  // Junk values (array, string, missing) never throw and never stick.
  for (const junk of ["http://x.test", [], 7, null]) {
    assert.deepEqual(settings.updateSettings({ guardProxy: junk }).guardProxy, { baseURL: "", apiKeyRef: "" });
  }
});
