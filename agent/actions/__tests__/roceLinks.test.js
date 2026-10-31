import test from "node:test";
import assert from "node:assert/strict";
import {
  applyLinkPlan,
  validateLinkPlan,
  planCommands,
  ROCE_APPLY_IMPLEMENTED,
  NOT_IMPLEMENTED_MESSAGE,
} from "../roceLinks.js";

const PLAN = [
  { ifName: "enp1s0f1np1", action: "enable", speedMbps: 200000 },
  { ifName: "enp1s0f0np0", action: "disable", speedMbps: null },
];

test("validateLinkPlan accepts enable@200G/100G and disable@null", () => {
  const v = validateLinkPlan([...PLAN, { ifName: "enp2s0", action: "enable", speedMbps: 100000 }]);
  assert.equal(v.ok, true);
  assert.equal(v.entries.length, 3);
});

test("validateLinkPlan rejects bad names, speeds, actions and duplicates", () => {
  assert.equal(validateLinkPlan("x").ok, false);
  const v = validateLinkPlan([
    { ifName: "eth0; rm -rf /", action: "enable", speedMbps: 200000 },
    { ifName: "a", action: "enable", speedMbps: 400000 },
    { ifName: "b", action: "toggle", speedMbps: null },
    { ifName: "c", action: "disable", speedMbps: 100000 },
    { ifName: "a", action: "disable", speedMbps: null },
  ]);
  assert.equal(v.ok, false);
  assert.equal(v.errors.length, 5);
});

test("no command path is known, so the planned command list is empty", () => {
  assert.equal(ROCE_APPLY_IMPLEMENTED, false);
  assert.deepEqual(planCommands(PLAN), []);
});

test("applyLinkPlan defaults to a dry run that shows the (empty) commands", () => {
  const r = applyLinkPlan({ interfaces: PLAN });
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun, true);
  assert.equal(r.body.implemented, false);
  assert.deepEqual(r.body.commands, []);
  assert.match(r.body.message, /not implemented/);
});

test("a real apply (dryRun:false) is a 501 'not implemented' stub", () => {
  const r = applyLinkPlan({ interfaces: PLAN, dryRun: false });
  assert.equal(r.status, 501);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.error, NOT_IMPLEMENTED_MESSAGE);
});

test("an invalid plan is a 400 even on a dry run", () => {
  const r = applyLinkPlan({ interfaces: [{ ifName: "", action: "enable", speedMbps: 1 }] });
  assert.equal(r.status, 400);
});
