import { describe, expect, it } from "vitest";
import type { GroupsNode, SparkGroup } from "../api/client";
import { addGroup, groupLinkSummary, homeNodes, moveNode, removeGroup, renameGroup, setHead } from "./groupsModel";

const spark = (id: string): GroupsNode => ({ nodeId: id, name: id, spark: true, reason: "unified memory (GB10)" });
const nodes: GroupsNode[] = [
  spark("s1"),
  spark("s2"),
  spark("s3"),
  spark("s4"),
  { nodeId: "mac", name: "narthex", spark: false, reason: "discrete GPU" },
];

describe("groupsModel (SC5d)", () => {
  it("puts every ungrouped node on Home", () => {
    expect(homeNodes([], nodes).map((n) => n.nodeId)).toEqual(["s1", "s2", "s3", "s4", "mac"]);
    expect(homeNodes([{ id: "g", name: "G", members: ["s2"] }], nodes).map((n) => n.nodeId)).toEqual(["s1", "s3", "s4", "mac"]);
  });

  it("adds empty pages with the first free id", () => {
    const a = addGroup([]);
    expect(a.id).toBe("group-1");
    expect(a.groups).toEqual([{ id: "group-1", name: "Group 1", members: [] }]);
    const b = addGroup([{ id: "group-2", name: "x", members: [] }]);
    expect(b.id).toBe("group-1");
    expect(addGroup(a.groups).id).toBe("group-2");
  });

  it("moves sparks onto a group and back to Home", () => {
    let g: SparkGroup[] = addGroup([]).groups;
    for (const id of ["s1", "s2"]) {
      const r = moveNode(g, nodes, id, "group-1");
      expect(r.ok).toBe(true);
      if (r.ok) g = r.groups;
    }
    expect(g[0].members).toEqual(["s1", "s2"]);
    const back = moveNode(g, nodes, "s1", null);
    expect(back.ok && back.groups[0].members).toEqual(["s2"]);
  });

  it("moves a spark between groups", () => {
    const g: SparkGroup[] = [
      { id: "a", name: "A", members: ["s1", "s2"] },
      { id: "b", name: "B", members: ["s3"] },
    ];
    const r = moveNode(g, nodes, "s2", "b");
    expect(r.ok && r.groups.map((x) => x.members)).toEqual([["s1"], ["s3", "s2"]]);
  });

  it("refuses a 4th spark with a clear message", () => {
    const g: SparkGroup[] = [{ id: "a", name: "Trio", members: ["s1", "s2", "s3"] }];
    const r = moveNode(g, nodes, "s4", "a");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Trio already has 3 sparks");
      expect(r.error).toContain("RoCE switch");
    }
  });

  it("refuses non-Spark hosts", () => {
    const r = moveNode([{ id: "a", name: "A", members: [] }], nodes, "mac", "a");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/narthex is not a GB10 Spark.*Only Spark nodes/);
    // ...but Home always takes them back
    expect(moveNode([], nodes, "mac", null).ok).toBe(true);
  });

  it("rejects unknown nodes and groups", () => {
    expect(moveNode([], nodes, "nope", null).ok).toBe(false);
    expect(moveNode([], nodes, "s1", "ghost").ok).toBe(false);
  });

  it("sets the head, renames and removes groups", () => {
    const g: SparkGroup[] = [{ id: "a", name: "A", members: ["s1", "s2", "s3"] }];
    expect(setHead(g, "a", "s3")[0].members).toEqual(["s3", "s1", "s2"]);
    expect(setHead(g, "a", "zz")[0].members).toEqual(["s1", "s2", "s3"]);
    expect(renameGroup(g, "a", "  Big  ")[0].name).toBe("Big");
    expect(renameGroup(g, "a", "   ")[0].name).toBe("A");
    expect(removeGroup(g, "a")).toEqual([]);
  });

  it("summarises the RoCE layout per size", () => {
    expect(groupLinkSummary(2)).toContain("200G");
    expect(groupLinkSummary(3)).toContain("3 links @ 100G");
    expect(groupLinkSummary(0)).toContain("not active");
  });
});
