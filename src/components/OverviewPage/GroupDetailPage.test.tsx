import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { GroupDetailPage } from "./GroupDetailPage";
import type { NodeAgentSnapshot, TopologyInfo } from "../../../shared/types";

function node(nodeId: string, usedMB: number): NodeAgentSnapshot {
  return {
    nodeId,
    nodeName: nodeId,
    lanIp: "10.0.0.1",
    agentVersion: "0.1.0",
    online: true,
    uptimeSeconds: 100,
    gpu: {
      temperature: 50, usage: 40, powerDraw: 50, powerLimit: 140,
      vramUsedMB: usedMB, vramTotalMB: 122_880, vramPercentage: 0, vramAvailableMB: 0, processes: [], unifiedMemory: true,
    },
    cpu: { usage: 10, temperature: 45, draw: 10, tdp: 60 },
    mem: { usedMB, totalMB: 122_880, availableMB: 122_880 - usedMB, percentage: 0 },
    disk: [], net: [], containers: [], versions: [], services: [],
    memory: null, requests: null, topology: null, tailscale: null,
    polledAt: Date.now(),
  } as NodeAgentSnapshot;
}

const topo: TopologyInfo[] = [
  { nodeId: "gx10-102c", role: "head", rank: 0, groupId: "tp2", groupName: "tp2", headId: null, links: [] },
  { nodeId: "gx10-25ed", role: "worker", rank: 1, groupId: "tp2", groupName: "tp2", headId: "gx10-102c", links: [] },
  { nodeId: "narthex", role: "standalone", rank: null, groupId: null, headId: null, links: [] },
];

describe("GroupDetailPage (SC5d)", () => {
  it("shows the aggregated card and each member's own card", () => {
    const onSelectNode = vi.fn();
    const nodes = [node("gx10-102c", 60_000), node("gx10-25ed", 50_000), node("narthex", 1_000)];
    const { container } = render(
      <GroupDetailPage groupId="tp2" nodes={nodes} topologyNodes={topo} onSelectNode={onSelectNode} />
    );
    expect(container.querySelectorAll('[data-testid="group-card"]')).toHaveLength(1);
    const memberCards = container.querySelectorAll('[data-testid="group-detail-members"] [aria-label^="Fleet node"]');
    expect([...memberCards].map((c) => c.getAttribute("aria-label"))).toEqual([
      "Fleet node gx10-102c",
      "Fleet node gx10-25ed",
    ]);
    // Each member has its own memory bar.
    expect(container.querySelectorAll('[data-testid="group-detail-members"] [data-testid="memory-pool"]').length).toBe(2);
    (memberCards[1] as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelectNode).toHaveBeenCalledWith("gx10-25ed");
  });

  it("explains a missing group", () => {
    const onBack = vi.fn();
    const { container } = render(<GroupDetailPage groupId="nope" nodes={[]} topologyNodes={[]} onBack={onBack} />);
    expect(container.querySelector('[data-testid="group-detail-missing"]')).not.toBeNull();
    container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onBack).toHaveBeenCalled();
  });
});
