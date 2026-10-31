// SC5d (#75): RoCE plan for every grouping of three sparks on three cables.
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { computeRocePlan, interfacesByNode, linkSpeedForGroupSize } from "../rocePlan.js";

const link = (from, to, fromIf, toIf, speedMbps = 200000, up = true) => ({ from, to, fromIf, toIf, speedMbps, transport: "roce", up });
/** A, B, C fully meshed with three cables. */
const MESH = [
  link("a", "b", "p1", "p0"),
  link("a", "c", "p2", "p0"),
  link("b", "c", "p1", "p1"),
];
const plan = (groups) => computeRocePlan({ groups: { groups }, links: MESH });
const actions = (p) => Object.fromEntries(p.links.map((l) => [`${l.from}-${l.to}`, [l.action, l.targetSpeedMbps]]));

describe("computeRocePlan", () => {
  test("speed per group size", () => {
    assert.equal(linkSpeedForGroupSize(2), 200000);
    assert.equal(linkSpeedForGroupSize(3), 100000);
    assert.equal(linkSpeedForGroupSize(1), null);
  });

  test("all individuals: every link logically disabled", () => {
    assert.deepEqual(actions(plan([])), { "a-b": ["disable", null], "a-c": ["disable", null], "b-c": ["disable", null] });
  });

  test("a pair plus an individual: only the pair link, at full 200G", () => {
    const p = plan([{ id: "tp2", members: ["a", "b"] }]);
    assert.deepEqual(actions(p), { "a-b": ["enable", 200000], "a-c": ["disable", null], "b-c": ["disable", null] });
    assert.equal(p.links.find((l) => l.from === "a" && l.to === "b").change, false); // already 200G up
    assert.equal(p.changes, 2); // two links to take down
    assert.deepEqual(p.groups, [
      { groupId: "tp2", size: 2, tp: 2, linkSpeedMbps: 200000, expectedLinks: 1, missingLinks: [] },
    ]);
  });

  test("a group of three: all three links, each at half speed (100G)", () => {
    const p = plan([{ id: "tp3", members: ["a", "b", "c"] }]);
    assert.deepEqual(actions(p), { "a-b": ["enable", 100000], "a-c": ["enable", 100000], "b-c": ["enable", 100000] });
    assert.equal(p.changes, 3);
    assert.equal(p.groups[0].tp, 3);
    assert.equal(p.interfaces.length, 6);
  });

  test("an in-progress 1-member page plans nothing for it", () => {
    assert.deepEqual(actions(plan([{ id: "wip", members: ["a"] }])), actions(plan([])));
  });

  test("warns about a missing cable and an unnamed interface; skips non-Spark and tcp links", () => {
    const p = computeRocePlan({
      groups: { groups: [{ id: "tp3", members: ["a", "b", "c"] }] },
      links: [
        link("a", "b", "p1", null),
        link("b", "a", "x", "y"), // duplicate pair, other direction
        link("a", "n", "p3", "e0"),
        { ...link("b", "c", "p1", "p1"), transport: "tcp" },
      ],
      isSpark: (id) => id !== "n",
    });
    assert.equal(p.links.length, 1);
    assert.ok(p.warnings.some((w) => /no RoCE link is registered between a and c/.test(w)));
    assert.ok(p.warnings.some((w) => /no RoCE link is registered between b and c/.test(w)));
    assert.ok(p.warnings.some((w) => /interface name on b is not registered/.test(w)));
    assert.ok(p.todo.some((t) => /verification is a later feature/.test(t)));
  });

  test("interfacesByNode groups the apply payload per host", () => {
    const by = interfacesByNode(plan([{ id: "tp2", members: ["a", "b"] }]));
    assert.deepEqual(by.get("a"), [
      { ifName: "p1", action: "enable", speedMbps: 200000 },
      { ifName: "p2", action: "disable", speedMbps: null },
    ]);
    assert.equal(by.size, 3);
  });
});
