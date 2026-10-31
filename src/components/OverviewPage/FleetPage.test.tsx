import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { FleetPage, type FleetPageProps } from "./FleetPage";
import type { MemoryBudget, NodeAgentSnapshot, RequestStat, RoceLink, TopologyInfo } from "../../../shared/types";

function budget(nodeId: string, overrides: Partial<MemoryBudget> = {}): MemoryBudget {
  return {
    nodeId,
    totalMB: 128000,
    usedMB: 96000,
    freeMB: 32000,
    servicesUsedMB: 90000,
    otherUsedMB: 6000,
    services: [],
    makeRoom: [],
    needMakeRoom: false,
    polledAt: Date.now(),
    ...overrides,
  };
}

function node(nodeId: string, overrides: Partial<NodeAgentSnapshot> = {}): NodeAgentSnapshot {
  const online = overrides.online ?? true;
  return {
    nodeId,
    nodeName: nodeId,
    lanIp: "192.168.50.226",
    agentVersion: "0.1.0",
    online,
    uptimeSeconds: online ? 100000 : null,
    gpu: online
      ? {
          temperature: 55,
          usage: 10,
          powerDraw: 30,
          powerLimit: 90,
          vramUsedMB: 8000,
          vramTotalMB: 128000,
          vramPercentage: 6,
          vramAvailableMB: 120000,
          processes: [],
        }
      : null,
    cpu: online ? { usage: 5, temperature: 40, draw: 10, tdp: 60 } : null,
    mem: online ? { usedMB: 20000, totalMB: 128000, availableMB: 108000, percentage: 16 } : null,
    disk: [],
    net: [],
    containers: [],
    versions: [],
    services: [],
    memory: online ? budget(nodeId) : null,
    requests: null,
    topology: null,
    tailscale: null,
    polledAt: Date.now() - 1000,
    ...overrides,
  };
}

const topologyNodes: TopologyInfo[] = [
  { nodeId: "head", role: "head", rank: 0, groupId: "tp2", headId: null, links: [] },
  { nodeId: "w0", role: "worker", rank: 1, groupId: "tp2", headId: "head", links: [] },
  { nodeId: "solo", role: "standalone", rank: null, groupId: null, headId: null, links: [] },
];

const links: RoceLink[] = [{ from: "head", to: "w0", speedMbps: 200000, transport: "roce", up: true }];

const stat = (nodeId: string): RequestStat => ({
  modelId: "qwen3.8-27b",
  engine: "sglang",
  nodeId,
  port: 8080,
  queued: 1,
  running: 2,
  finished: 10,
  polledAt: Date.now(),
});

function makeProps(overrides: Partial<FleetPageProps> = {}): FleetPageProps {
  const nodes = [node("head"), node("w0"), node("solo", { online: false })];
  return {
    nodes,
    topology: { nodes: topologyNodes, links },
    requests: {
      byModel: { "qwen3.8-27b": [stat("head"), stat("w0")] },
      byEngine: { sglang: [stat("head"), stat("w0")] },
      byMachine: { head: [stat("head")], w0: [stat("w0")] },
    },
    memory: {
      totalMB: 384000,
      usedMB: 212000,
      freeMB: 172000,
      byNode: { head: budget("head"), w0: budget("w0"), solo: budget("solo") },
    },
    ...overrides,
  };
}

describe("FleetPage", () => {
  it("renders one card per group plus one FleetCard per individual node, and the summary (SC5d)", () => {
    const { container } = render(<FleetPage {...makeProps()} />);
    const text = container.textContent ?? "";

    expect(text).toContain("Fleet Overview");

    // head + w0 are in tp2 → one group card; solo keeps its own card.
    const cards = container.querySelectorAll("[aria-label^='Fleet node']");
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute("aria-label")).toBe("Fleet node solo");
    expect(container.querySelectorAll('[data-testid="group-card"]')).toHaveLength(1);
    for (const name of ["head", "w0", "solo"]) {
      expect(text).toContain(name);
    }

    // Summary
    expect(container.querySelector('[data-testid="fleet-summary-nodes"]')?.textContent).toBe(
      "3 total · 2 online · 1 offline"
    );
    // SC9: fleet-level memory renders Hasso-style (issue #26 display), not
    // plain numbers. The pool is summed across the two online nodes:
    // total 256000 MB, available 216000 MB → 39.1 / 250.0 GiB in use.
    const memory = container.querySelector('[data-testid="fleet-summary-memory"]');
    expect(memory?.querySelector('[data-testid="memory-pool"]')).not.toBeNull();
    expect(memory?.querySelector('[data-testid="memory-pool-used"]')?.textContent).toBe("39.1");
    expect(memory?.textContent).toContain("210.9"); // GiB available
    // q1+1 · r2+2 · f10+10
    expect(container.querySelector('[data-testid="fleet-summary-requests"]')?.textContent).toBe(
      "q2 · r4 · f20"
    );
    expect(text).toContain("2/3 online");
  });

  it("renders a group card per group with aggregated bars and its member list (SC9, SC5d)", () => {
    const onSelectGroup = vi.fn();
    const { container } = render(<FleetPage {...makeProps()} onSelectGroup={onSelectGroup} />);
    const groupCards = container.querySelectorAll('[data-testid="group-card"]');
    expect(groupCards).toHaveLength(1); // only "tp2" — solo is standalone
    const card = groupCards[0] as HTMLElement;

    expect(card.getAttribute("data-group-id")).toBe("tp2");
    expect(card.textContent).toContain("TP2 group");
    expect(card.querySelector('[data-testid="group-card-online"]')?.textContent).toBe("2/2 online");

    // One memory bar for the group: 128000×2 total, 216000 available.
    expect(card.querySelectorAll('[data-testid="memory-pool"]')).toHaveLength(1);
    expect(card.querySelector('[data-testid="memory-pool-used"]')?.textContent).toBe("39.1");
    expect(card.querySelector('[data-testid="group-card-total"]')?.textContent).toBe(
      "250.0 GiB total · 39.1 in use · 210.9 available"
    );
    // GPU power summed: 30+30 W of 90+90 W.
    expect(card.querySelector('[data-testid="group-card-power"]')?.textContent).toBe("GPU power 60W / 180W");

    // Members are listed, head first, with their ranks.
    const members = [...card.querySelectorAll('[data-testid="group-card-members"] li')].map((li) => li.textContent);
    expect(members).toEqual(["headhead", "w0rank 1"]);

    // Members no longer get their own cards.
    expect(container.querySelector("[aria-label='Fleet node head']")).toBeNull();
    expect(container.querySelector("[aria-label='Fleet node w0']")).toBeNull();

    // Drilling in opens the group detail view.
    card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelectGroup).toHaveBeenCalledWith("tp2");
  });

  it("orders group members by rank and uses the persisted group name", () => {
    const { container } = render(
      <FleetPage
        {...makeProps({
          topology: {
            nodes: [
              { nodeId: "w0", role: "worker", rank: 1, groupId: "tp2", groupName: "Pair A", headId: "head", links: [] },
              { nodeId: "head", role: "head", rank: 0, groupId: "tp2", groupName: "Pair A", headId: null, links: [] },
              { nodeId: "solo", role: "standalone", rank: null, groupId: null, headId: null, links: [] },
            ],
            links: [],
          },
          nodes: [node("w0"), node("head"), node("solo", { online: false })],
        })}
      />
    );
    const card = container.querySelector('[data-testid="group-card"]') as HTMLElement;
    expect(card.textContent).toContain("Pair A");
    const ids = [...card.querySelectorAll('[data-testid="group-card-members"] li')].map((li) => li.textContent);
    expect(ids[0]).toBe("headhead");
  });

  it("renders 0 cards and an empty summary for no nodes", () => {
    const { container } = render(
      <FleetPage {...makeProps({ nodes: [], memory: { totalMB: 0, usedMB: 0, freeMB: 0, byNode: {} } })} />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Fleet Overview");
    expect(container.querySelectorAll("[aria-label^='Fleet node']")).toHaveLength(0);
    expect(container.querySelector('[data-testid="fleet-summary-nodes"]')?.textContent).toBe(
      "0 total · 0 online · 0 offline"
    );
    // No pool data at all (SSH-only fleet) → the strip keeps its totals
    // fallback and no group cards render.
    expect(container.querySelector('[data-testid="fleet-summary-memory"]')?.textContent).toContain("used");
    expect(container.querySelector('[data-testid="fleet-group-cards"]')).toBeNull();
    expect(text).toContain("No nodes registered");
  });

  it("renders the activity slot under the cards, with or without nodes", () => {
    const slot = <section data-testid="activity-slot">Recent activity</section>;
    const withNodes = render(<FleetPage {...makeProps()} activity={slot} />);
    const cards = withNodes.container.querySelector(".overview-page");
    const activity = withNodes.container.querySelector('[data-testid="activity-slot"]');
    expect(activity).not.toBeNull();
    expect(cards!.compareDocumentPosition(activity!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const empty = render(<FleetPage {...makeProps({ nodes: [] })} activity={slot} />);
    expect(empty.container.querySelector('[data-testid="activity-slot"]')).not.toBeNull();
  });

  it("renders the energy slot (issue #33) after the cards and before activity, even with no agent nodes", () => {
    const energy = <section data-testid="energy-slot">Fleet energy</section>;
    const activity = <section data-testid="activity-slot">Recent activity</section>;
    const withNodes = render(<FleetPage {...makeProps()} energy={energy} activity={activity} />);
    const cards = withNodes.container.querySelector(".overview-page");
    const energyEl = withNodes.container.querySelector('[data-testid="energy-slot"]');
    const activityEl = withNodes.container.querySelector('[data-testid="activity-slot"]');
    expect(energyEl).not.toBeNull();
    expect(cards!.compareDocumentPosition(energyEl!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(energyEl!.compareDocumentPosition(activityEl!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // SSH-Spark-only fleets have no agent nodes but still get the card.
    const empty = render(<FleetPage {...makeProps({ nodes: [] })} energy={energy} />);
    expect(empty.container.querySelector('[data-testid="energy-slot"]')).not.toBeNull();
    const off = render(<FleetPage {...makeProps()} energy={null} />);
    expect(off.container.querySelector('[data-testid="energy-slot"]')).toBeNull();
  });

  it("renders the token totals slot (issue #38) beside energy, or alone when energy is off", () => {
    const tokens = <section data-testid="tokens-slot">LLM token totals</section>;
    const energy = <section data-testid="energy-slot">Fleet energy</section>;
    const activity = <section data-testid="activity-slot">Recent activity</section>;
    const both = render(<FleetPage {...makeProps()} tokens={tokens} energy={energy} activity={activity} />);
    const row = both.container.querySelector('[data-testid="fleet-usage-row"]');
    expect(row).not.toBeNull();
    const kids = [...row!.children].map((el) => el.getAttribute("data-testid"));
    expect(kids).toEqual(["tokens-slot", "energy-slot"]);
    const activityEl = both.container.querySelector('[data-testid="activity-slot"]');
    expect(row!.compareDocumentPosition(activityEl!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const alone = render(<FleetPage {...makeProps()} tokens={tokens} energy={null} />);
    expect(alone.container.querySelector('[data-testid="fleet-usage-row"]')).toBeNull();
    expect(alone.container.querySelector('[data-testid="tokens-slot"]')).not.toBeNull();
  });
});
