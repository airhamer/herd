import { describe, expect, it } from "vitest";
import type { CatalogComponent } from "../api/client";
import { groupSingles, type GroupMemberInput } from "./groupSingles";

const GiB = 1024;
const comp = (id: string, tp: number, memGiB: number | null, nodes: CatalogComponent["nodes"] = [], kind = "llm"): CatalogComponent => ({
  id, name: id, purpose: "chat", kind, tp, machineClass: null, engine: "vllm", image: null, servedModelName: id,
  memoryPerSparkMB: memGiB == null ? null : memGiB * GiB, description: "", nodes,
});
const member = (nodeId: string, availGiB: number): GroupMemberInput => ({
  nodeId, nodeName: nodeId,
  mem: { usedMB: (120 - availGiB) * GiB, totalMB: 120 * GiB, availableMB: availGiB * GiB, percentage: 0 },
  gpu: null,
});
// floor 3 GiB → remaining = avail − 3.
const CATALOG = [
  comp("glm-tp2", 2, 90),
  comp("other-tp2", 2, 60),
  comp("embed", 1, 18),
  comp("small", 1, 8),
  comp("big", 1, 100),
  comp("mystery", 1, null),
  comp("comfy", 1, 10, [], "image"),
  comp("tp4", 4, 30),
];

const fitOf = (v: ReturnType<typeof groupSingles>, node: string) =>
  Object.fromEntries(v.members.find((m) => m.nodeId === node)!.singles.map((s) => [s.component.id, s.fit]));

describe("groupSingles (SC5e)", () => {
  it("no TP component yet: fit against current headroom, placement none, TP2 candidates only", () => {
    const v = groupSingles([member("a", 110), member("b", 110)], CATALOG);
    expect(v.placement).toBe("none");
    expect(v.tpComponent).toBeNull();
    expect(v.tpCandidates.map((c) => c.id)).toEqual(["glm-tp2", "other-tp2"]);
    expect(v.members[0].remainingMB).toBe(107 * GiB);
    expect(fitOf(v, "a")).toEqual({ embed: "fits", small: "fits", big: "tight", mystery: "unknown" }); // big leaves 7 GiB < 9
  });

  it("TP2 component running on the group: its memory is already used, so the remaining figure is headroom; per-member differences matter", () => {
    const cat = [comp("glm-tp2", 2, 90, [{ nodeId: "a", nodeName: "a", state: "running" }]), ...CATALOG.slice(1)];
    // a: 28 GiB available → 25 left; b: 15 available → 12 left.
    const v = groupSingles([member("a", 28), member("b", 15)], cat, "other-tp2");
    expect(v.placement).toBe("running");
    expect(v.tpComponent?.id).toBe("glm-tp2");
    expect(fitOf(v, "a")).toEqual({ embed: "tight", small: "fits", big: "no_fit", mystery: "unknown" });
    expect(fitOf(v, "b")).toEqual({ embed: "no_fit", small: "tight", big: "no_fit", mystery: "unknown" });
    const big = v.members[1].singles.find((s) => s.component.id === "big")!;
    expect(big.leftMB).toBe((12 - 100) * GiB);
  });

  it("TP2 component selected but not running: its per-spark memory is subtracted from every member", () => {
    const v = groupSingles([member("a", 110), member("b", 100)], CATALOG, "glm-tp2");
    expect(v.placement).toBe("planned");
    expect(v.members.map((m) => m.remainingMB)).toEqual([17 * GiB, 7 * GiB]);
    expect(fitOf(v, "a")).toEqual({ small: "fits", embed: "no_fit", big: "no_fit", mystery: "unknown" });
    expect(fitOf(v, "b")).toEqual({ small: "no_fit", embed: "no_fit", big: "no_fit", mystery: "unknown" });
  });

  it("a single already running on a member reads running; order is running, fits, tight, unknown, no_fit", () => {
    const cat = CATALOG.map((c) => (c.id === "embed" ? { ...c, nodes: [{ nodeId: "b", nodeName: "b", state: "running" }] } : c));
    const v = groupSingles([member("a", 28), member("b", 28)], cat);
    expect(v.members[1].singles.map((s) => s.fit)).toEqual(["running", "fits", "unknown", "no_fit"]);
    expect(fitOf(v, "a").embed).toBe("tight");
  });

  it("a stopped TP component is not 'running'; a member without a memory reading reads unknown", () => {
    const cat = [comp("glm-tp2", 2, 90, [{ nodeId: "a", nodeName: "a", state: "stopped" }]), comp("small", 1, 8)];
    const v = groupSingles([member("a", 110), { nodeId: "x", nodeName: "x", mem: null, gpu: null }], cat);
    expect(v.placement).toBe("none");
    expect(v.members[1].remainingMB).toBeNull();
    expect(fitOf(v, "x")).toEqual({ small: "unknown" });
  });
});
