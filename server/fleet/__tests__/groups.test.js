// SC5d (#75): spark groups — eligibility, seeding, validation, store, overlay.
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyGroupsToNodes,
  createGroupStore,
  MAX_GROUP_SIZE,
  seedGroupsFromNodes,
  sparkEligibility,
  TOO_MANY_MESSAGE,
  validateGroups,
} from "../groups.js";
import { buildTopology } from "../topology.js";

/** The live fleet today: tp2 = gx10-102c head + gx10-25ed (rank 2), plus 1c2c and narthex. */
const LIVE = [
  { id: "gx10-1c2c", name: "GX10 1c2c", lanIp: "10.0.0.1", role: "head", rank: 0, groupId: null, headId: null, links: [] },
  { id: "gx10-102c", name: "GX10 102c", lanIp: "10.0.0.2", role: "head", rank: 0, groupId: "tp2", headId: null, links: [] },
  { id: "gx10-25ed", name: "GX10 25ed", lanIp: "10.0.0.3", role: "worker", rank: 2, groupId: "tp2", headId: "gx10-102c", links: [] },
  { id: "narthex", name: "Narthex", lanIp: "10.0.0.9", role: "standalone", rank: null, groupId: null, headId: null, links: [] },
];
const sparkOnly = (id) => (id === "narthex" ? { spark: false, reason: "discrete GPU host" } : { spark: true, reason: "GB10" });

function tmpPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "herd-groups-")), "groups.json");
}

describe("sparkEligibility", () => {
  test("telemetry wins, then the Spark registry, then naming", () => {
    assert.equal(sparkEligibility({ id: "box" }, { gpu: { unifiedMemory: true } }).spark, true);
    assert.equal(sparkEligibility({ id: "gx10-1" }, { gpu: { unifiedMemory: false } }).spark, false);
    assert.equal(sparkEligibility({ id: "box", lanIp: "1.2.3.4" }, null, new Set(["1.2.3.4"])).spark, true);
    assert.equal(sparkEligibility({ id: "gx10-25ed" }).spark, true);
    assert.equal(sparkEligibility({ id: "n1", name: "DGX Spark 2" }).spark, true);
    assert.equal(sparkEligibility({ id: "narthex", name: "Narthex" }).spark, false);
    assert.equal(sparkEligibility({ id: "sparkdash-dev" }).spark, false);
  });
});

describe("seedGroupsFromNodes", () => {
  test("the existing tp2 pair carries over with the head first", () => {
    const seed = seedGroupsFromNodes(LIVE);
    assert.deepEqual(seed, {
      version: 1,
      switchPresent: false,
      groups: [{ id: "tp2", name: "tp2", members: ["gx10-102c", "gx10-25ed"] }],
    });
  });
  test("single-member designations and empty input seed nothing", () => {
    assert.deepEqual(seedGroupsFromNodes([{ id: "a", groupId: "g" }]).groups, []);
    assert.deepEqual(seedGroupsFromNodes(null).groups, []);
  });
});

describe("validateGroups", () => {
  const ctx = { nodes: LIVE, isSpark: sparkOnly };
  test("accepts empty pages, pairs and triples", () => {
    const v = validateGroups(
      { groups: [{ id: "tp3", members: ["gx10-1c2c", "gx10-102c", "gx10-25ed"] }, { id: "new-1", members: [] }] },
      ctx,
    );
    assert.equal(v.ok, true);
    assert.equal(v.value.groups[0].name, "tp3");
    assert.equal(v.value.switchPresent, false);
  });
  test("refuses a 4th spark with the switch message, even with switchPresent", () => {
    const four = [...LIVE.slice(0, 3).map((n) => n.id), "gx10-4444"];
    const v = validateGroups(
      { switchPresent: true, groups: [{ id: "big", members: four }] },
      { nodes: [...LIVE, { id: "gx10-4444" }], isSpark: () => ({ spark: true, reason: "" }) },
    );
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes(TOO_MANY_MESSAGE)));
    assert.equal(MAX_GROUP_SIZE, 3);
  });
  test("refuses non-Sparks, unknown nodes, duplicates and double membership", () => {
    const bad = (groups) => validateGroups({ groups }, ctx);
    assert.match(bad([{ id: "g", members: ["narthex"] }]).errors[0], /only GB10 Spark nodes can be grouped/);
    assert.match(bad([{ id: "g", members: ["ghost"] }]).errors[0], /unknown node ghost/);
    assert.match(bad([{ id: "g", members: ["gx10-1c2c", "gx10-1c2c"] }]).errors[0], /listed twice/);
    assert.match(
      bad([{ id: "a", members: ["gx10-1c2c"] }, { id: "b", members: ["gx10-1c2c"] }]).errors[0],
      /only one group/,
    );
    assert.match(bad([{ id: "a", members: [] }, { id: "a", members: [] }]).errors[0], /used twice/);
    assert.match(bad([{ id: "Bad Id", members: [] }]).errors[0], /id must be/);
    assert.equal(validateGroups({ groups: [], switchPresent: "yes" }).ok, false);
    assert.equal(validateGroups([]).ok, false);
  });
});

describe("createGroupStore", () => {
  test("seeds and persists from the registry when groups.json is missing", () => {
    const p = tmpPath();
    const store = createGroupStore({ path: p });
    assert.deepEqual(store.read(LIVE).groups[0].members, ["gx10-102c", "gx10-25ed"]);
    assert.equal(JSON.parse(fs.readFileSync(p, "utf-8")).groups[0].id, "tp2");
    // Once persisted, the file — not the registry — is the truth.
    store.write({ groups: [] });
    assert.deepEqual(store.read(LIVE).groups, []);
  });
  test("does not persist a seed from an empty registry", () => {
    const p = tmpPath();
    createGroupStore({ path: p }).read([]);
    assert.equal(fs.existsSync(p), false);
  });
  test("a corrupt file reads as the seed and is left alone", () => {
    const p = tmpPath();
    fs.writeFileSync(p, "{nope");
    assert.equal(createGroupStore({ path: p }).read(LIVE).groups[0].id, "tp2");
    assert.equal(fs.readFileSync(p, "utf-8"), "{nope");
  });
  test("write rejects an out-of-shape document", () => {
    assert.throws(() => createGroupStore({ path: tmpPath() }).write({ groups: "x" }), /groups must be an array/);
  });
});

describe("applyGroupsToNodes → buildTopology", () => {
  test("sets groupId, head and rank from the groups; everyone else is standalone", () => {
    const doc = { groups: [{ id: "tp2", members: ["gx10-102c", "gx10-25ed"] }, { id: "wip", members: ["gx10-1c2c"] }] };
    const topo = buildTopology(applyGroupsToNodes(LIVE, doc));
    const by = Object.fromEntries(topo.nodes.map((n) => [n.nodeId, n]));
    assert.deepEqual(
      { role: by["gx10-102c"].role, rank: by["gx10-102c"].rank, groupId: by["gx10-102c"].groupId, headId: by["gx10-102c"].headId },
      { role: "head", rank: 0, groupId: "tp2", headId: null },
    );
    assert.deepEqual(
      { role: by["gx10-25ed"].role, rank: by["gx10-25ed"].rank, groupId: by["gx10-25ed"].groupId, headId: by["gx10-25ed"].headId },
      { role: "worker", rank: 1, groupId: "tp2", headId: "gx10-102c" },
    );
    // A 1-member page is in progress: its node stays standalone.
    assert.equal(by["gx10-1c2c"].groupId, null);
    assert.equal(by["gx10-1c2c"].role, "standalone");
    assert.equal(by.narthex.rank, null);
    // Records are copied, not mutated.
    assert.equal(LIVE[2].rank, 2);
  });
  test("carries the group's display name into the topology (groupName)", () => {
    const doc = { groups: [{ id: "group-1", name: "Pair A", members: ["gx10-102c", "gx10-25ed"] }] };
    const topo = buildTopology(applyGroupsToNodes(LIVE, doc));
    const by = Object.fromEntries(topo.nodes.map((n) => [n.nodeId, n]));
    assert.equal(by["gx10-102c"].groupName, "Pair A");
    assert.equal(by["gx10-25ed"].groupName, "Pair A");
    assert.equal("groupName" in by.narthex, false);
  });
});
