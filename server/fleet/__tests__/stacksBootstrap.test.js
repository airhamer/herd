/**
 * stacksBootstrap.test.js — SC10 bootstrap + pre-defined stacks handling.
 * Pure functions only: fleet scopes from fleet/node records, bootstrap
 * stacks (the POC-step-1 Hasso pair) defaulted tp=1 single / tp=x multi.
 * Zero endpoints, zero servers (downtimeSequencer.test.js discipline).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  fleetScopes,
  defaultTpForScope,
  bootstrapStacksForFleet,
} from "../stacksBootstrap.js";
import { bootstrapStacks } from "../../../agent/catalog/stacks-catalog.js";

const node = (id, groupId = null) => ({ id, name: id, groupId });

// ─── fleetScopes ───────────────────────────────────────────────────────────

test("fleetScopes: no records yields one unscoped single scope", () => {
  assert.deepEqual(fleetScopes([]), [{ type: "single", groupId: null, nodeIds: [] }]);
  assert.deepEqual(fleetScopes(null), [{ type: "single", groupId: null, nodeIds: [] }]);
});

test("fleetScopes: standalone nodes are single-machine scopes", () => {
  const scopes = fleetScopes([node("gx10-a"), node("gx10-b")]);
  assert.deepEqual(scopes, [
    { type: "single", groupId: null, nodeIds: ["gx10-a"] },
    { type: "single", groupId: null, nodeIds: ["gx10-b"] },
  ]);
});

test("fleetScopes: ≥2 members sharing a groupId is a group scope", () => {
  const scopes = fleetScopes([
    node("gx10-1c2c", "tp2-glm"),
    node("gx10-27c1", "tp2-glm"),
    node("gx10-standalone"),
  ]);
  assert.deepEqual(scopes, [
    { type: "group", groupId: "tp2-glm", nodeIds: ["gx10-1c2c", "gx10-27c1"] },
    { type: "single", groupId: null, nodeIds: ["gx10-standalone"] },
  ]);
});

test("fleetScopes: a one-member group is a single machine (tp=1)", () => {
  const scopes = fleetScopes([node("lonely", "tp2-ghost")]);
  assert.deepEqual(scopes, [{ type: "single", groupId: null, nodeIds: ["lonely"] }]);
});

test("fleetScopes: malformed records and duplicate ids are dropped", () => {
  const scopes = fleetScopes([
    null,
    { name: "no-id" },
    { id: "  " },
    node("dup", "g1"),
    node("dup", "g1"),
    node("x", "g1"),
  ]);
  assert.deepEqual(scopes, [
    { type: "group", groupId: "g1", nodeIds: ["dup", "x"] },
  ]);
});

test("defaultTpForScope: 1 floor, x = machine count", () => {
  assert.equal(defaultTpForScope({ type: "single", groupId: null, nodeIds: [] }), 1);
  assert.equal(defaultTpForScope({ type: "single", groupId: null, nodeIds: ["a"] }), 1);
  assert.equal(defaultTpForScope({ type: "group", groupId: "g", nodeIds: ["a", "b"] }), 2);
  assert.equal(defaultTpForScope({ type: "group", groupId: "g", nodeIds: ["a", "b", "c", "d"] }), 4);
  assert.equal(defaultTpForScope(null), 1);
});

// ─── bootstrapStacksForFleet ───────────────────────────────────────────────

test("bootstrap stacks are available with no fleet records, tp=1", () => {
  const out = bootstrapStacksForFleet([]);
  const boot = bootstrapStacks();
  assert.equal(out.length, boot.length); // hardcoded initial stacks, unlocked
  for (const s of out) {
    assert.equal(s.tp, 1);
    assert.deepEqual(s.target, { groupId: null, nodeIds: [] });
  }
  assert.deepEqual(out.map((s) => s.id), boot.map((s) => s.id)); // POC step 1 feeds bootstrap
});

test("single-machine fleet → every bootstrap stack at tp=1 on that machine", () => {
  const out = bootstrapStacksForFleet([node("gx10-1c2c")]);
  assert.ok(out.length >= 1);
  for (const s of out) {
    assert.equal(s.tp, 1);
    assert.deepEqual(s.target, { groupId: null, nodeIds: ["gx10-1c2c"] });
  }
});

test("multi-machine group → tp=x (group size) per stack", () => {
  const out = bootstrapStacksForFleet([
    node("gx10-1c2c", "tp2-glm"),
    node("gx10-27c1", "tp2-glm"),
  ]);
  const boot = bootstrapStacks();
  assert.equal(out.length, boot.length);
  for (const s of out) {
    assert.equal(s.tp, 2);
    assert.deepEqual(s.target, { groupId: "tp2-glm", nodeIds: ["gx10-1c2c", "gx10-27c1"] });
  }
});

test("mixed fleet → one entry per stack per scope (tp1 box + tp-x group)", () => {
  const out = bootstrapStacksForFleet([
    node("gx10-box"),
    node("gx10-a", "tp4"),
    node("gx10-b", "tp4"),
    node("gx10-c", "tp4"),
    node("gx10-d", "tp4"),
  ]);
  const boot = bootstrapStacks();
  assert.equal(out.length, boot.length * 2);
  const first = out[0];
  assert.equal(first.id, boot[0].id);
  assert.equal(first.tp, 4); // group scopes come first (fleetScopes order)
  const tps = new Set(out.map((s) => s.tp));
  assert.ok(tps.has(1) && tps.has(4));
});

test("bootstrap definition fields survive scoping (name, components, category)", () => {
  const boot = bootstrapStacks();
  const out = bootstrapStacksForFleet([node("a", "g"), node("b", "g")]);
  for (const s of out) {
    const src = boot.find((b) => b.id === s.id);
    assert.ok(src);
    assert.equal(s.name, src.name);
    assert.deepEqual(s.componentNames, src.componentNames);
    assert.equal(s.category, src.category);
  }
});

test("input stacks are never mutated", () => {
  const stacks = bootstrapStacks();
  const snapshot = JSON.stringify(stacks);
  bootstrapStacksForFleet([node("a"), node("b", "g"), node("c", "g")], stacks);
  assert.equal(JSON.stringify(stacks), snapshot);
});
