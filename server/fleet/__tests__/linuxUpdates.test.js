import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import {
  parseLinuxUpdateProbe,
  linuxUpdatesSnapshot,
  linuxUpgradePlan,
  linuxDisplay,
} from "../linuxUpdates.js";

const APT = `
===OS===
linuxmint
===TOOL===
apt
===SIM===
Inst libfoo [1] (2 Ubuntu:24.04/noble [amd64])
Inst linux-image [1] (2 Ubuntu:24.04/noble-security [amd64])
===LIST===
Listing...
libfoo/noble 2 amd64 [upgradable from: 1]
linux-image/noble-security 2 amd64 [upgradable from: 1]
===END===
`;

describe("linuxUpdates", () => {
  test("parses apt-get -s Inst lines and security list rows", () => {
    const p = parseLinuxUpdateProbe(APT);
    assert.equal(p.ok, true);
    assert.equal(p.tool, "apt");
    assert.equal(p.upgradable, 2);
    assert.equal(p.security, 1);
    const snap = linuxUpdatesSnapshot(p, 1000);
    assert.equal(snap.backend, "linux");
    assert.equal(snap.upgradableCount, 2);
    assert.equal(linuxDisplay(snap), "available");
  });

  test("empty or tool-less output is an error, not zero upgrades", () => {
    assert.equal(parseLinuxUpdateProbe("").ok, false);
    const none = parseLinuxUpdateProbe("===OS===\nalpine\n===TOOL===\nnone\n===SIM===\n===LIST===\n===END===\n");
    assert.equal(none.ok, false);
    const snap = linuxUpdatesSnapshot(none, 1);
    assert.equal(snap.upgradableCount, null);
    assert.equal(linuxDisplay(snap), "stale");
    assert.notEqual(linuxDisplay(snap), "current");
  });

  test("a successful empty upgrade list is current with count 0", () => {
    const p = parseLinuxUpdateProbe("===OS===\nubuntu\n===TOOL===\napt\n===SIM===\n===LIST===\nListing...\n===END===\n");
    assert.equal(p.ok, true);
    assert.equal(p.upgradable, 0);
    assert.equal(linuxDisplay(linuxUpdatesSnapshot(p)), "current");
  });

  test("apply plan is dry-run unless confirm is explicit", () => {
    const dry = linuxUpgradePlan();
    assert.equal(dry.dryRun, true);
    assert.match(dry.command, /apt-get -s upgrade/);
    const real = linuxUpgradePlan({ confirm: true });
    assert.equal(real.dryRun, false);
    assert.equal(real.requiresConfirm, true);
    assert.match(real.command, /apt-get -y upgrade/);
  });
});
