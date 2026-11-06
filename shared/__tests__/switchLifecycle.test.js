import test from "node:test";
import assert from "node:assert/strict";
import { validateSwitchTarget, validateSwitchArgv, planHardwareSwitch } from "../switchLifecycle.js";

test("allowlisted targets produce the reviewed argv", () => {
  const r = validateSwitchTarget("uncensored");
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, ["./switch-model.sh", "uncensored"]);
});

test("arbitrary targets and scripts are rejected", () => {
  assert.equal(validateSwitchTarget("rm -rf /").ok, false);
  assert.equal(validateSwitchArgv(["./install.sh", "stock"]).ok, false);
  assert.equal(validateSwitchArgv(["./switch-model.sh", "stock", "--force"]).ok, false);
  assert.equal(validateSwitchArgv(["bash", "-c", "evil"]).ok, false);
});

test("plan requires confirmed downtime and reports long load", () => {
  assert.equal(planHardwareSwitch({ switchTarget: "flash" }, { confirmedDowntime: false }).ok, false);
  const p = planHardwareSwitch({ switchTarget: "flash" });
  assert.equal(p.ok, true);
  assert.equal(p.estDowntimeMs, 20 * 60 * 1000);
  assert.deepEqual(p.willDo, ["switch-model", "canary"]);
});

test("invented targets fail closed; upstream-only names are not executed", () => {
  const fake = validateSwitchTarget("turbo-flash");
  assert.equal(fake.ok, false);
  assert.equal(fake.code, "target-not-allowlisted");
  const unbound = validateSwitchTarget("fp8");
  assert.equal(unbound.ok, false);
  assert.equal(unbound.code, "target-unbound-in-herd");
});
