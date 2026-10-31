import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { GroupCard } from "./GroupCard";
import type { GpuMetrics, MemMetrics, NodeAgentSnapshot } from "../../../shared/types";

function member(totalMB: number, availableMB: number, gpuAllocMB: number) {
  const mem: MemMetrics = {
    usedMB: totalMB - availableMB,
    totalMB,
    availableMB,
    percentage: Math.round(((totalMB - availableMB) / totalMB) * 100),
    cachedMB: 8_192,
  };
  const gpu: GpuMetrics = {
    temperature: null,
    usage: 99,
    powerDraw: 120,
    powerLimit: 140,
    vramUsedMB: gpuAllocMB,
    vramTotalMB: totalMB,
    vramPercentage: 0,
    vramAvailableMB: 0,
    processes: [{ pid: 7, name: "sglang", vramMB: gpuAllocMB }],
    gpuAllocMB,
    unifiedMemory: true,
  };
  return { mem, gpu };
}

function snap(nodeId: string, m: ReturnType<typeof member> | null, online = true, cpu = { usage: 20, temperature: 50, draw: 10, tdp: 60 }) {
  return {
    nodeId,
    nodeName: nodeId,
    online,
    mem: m?.mem ?? null,
    gpu: m?.gpu ?? null,
    cpu: m ? cpu : null,
  } as unknown as NodeAgentSnapshot;
}

const q = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);

describe("GroupCard (SC9, SC5d)", () => {
  it("shows one aggregated bar per metric and lists its members", () => {
    const members = [
      { snapshot: snap("gx10-102c", member(122_880, 20_000, 100_000), true, { usage: 10, temperature: 61, draw: 10, tdp: 60 }), rank: 0 },
      { snapshot: snap("gx10-25ed", member(122_880, 24_000, 96_000), true, { usage: 30, temperature: 55, draw: 10, tdp: 60 }), rank: 1 },
    ];
    const { container } = render(<GroupCard groupId="tp2" name="tp2" members={members} holder="aeon-176b" />);

    expect(q(container, "group-card")).not.toBeNull();
    expect(container.textContent).toContain("TP2 group");
    expect(q(container, "group-card-online")?.textContent).toBe("2/2 online");

    // One summed pool: 240.0 GiB total, 44000 MB available → 197.0 in use.
    expect(container.querySelectorAll('[data-testid="memory-pool"]')).toHaveLength(1);
    expect(q(container, "memory-pool-used")?.textContent).toBe("197.0");
    expect(q(container, "memory-pool-legend")?.textContent ?? "").toContain("aeon-176b");
    expect(q(container, "group-card-total")?.textContent).toBe("240.0 GiB total · 197.0 in use · 43.0 available");
    // Power summed (120+120 / 140+140); CPU usage averaged (10, 30 → 20%); hottest CPU 61°C.
    expect(q(container, "group-card-power")?.textContent).toBe("GPU power 240W / 280W");
    expect(container.textContent).toContain("20% · 61°C max");
    // Unified (GB10) members → no separate VRAM bar.
    expect(container.textContent).not.toContain("VRAM (group)");

    const rows = [...container.querySelectorAll('[data-testid="group-card-members"] li')].map((li) => li.textContent);
    expect(rows).toEqual(["gx10-102chead", "gx10-25edrank 1"]);
    expect(q(container, "group-card-components-empty")).not.toBeNull();
  });

  it("lists the group's components, TP=x when a model spans every member", () => {
    const svc = (modelId: string, status = "running") => ({ name: `llm-${modelId}`, kind: "llm", modelId, engine: "sglang", port: 8000, status, active: true });
    const a = snap("a", member(122_880, 20_000, 100));
    const b = snap("b", member(122_880, 20_000, 100));
    (a as unknown as { services: unknown[] }).services = [svc("glm-4.6"), svc("qwen-small")];
    (b as unknown as { services: unknown[] }).services = [svc("glm-4.6")];
    const { container } = render(
      <GroupCard groupId="tp2" members={[{ snapshot: a, rank: 0 }, { snapshot: b, rank: 1 }]} holder="glm-4.6" />
    );
    const rows = [...container.querySelectorAll('[data-testid="group-card-components"] li')].map((li) => li.textContent);
    expect(rows).toEqual(["glm-4.6sglang · TP2", "qwen-smallsglang · a"]);
  });

  it("opens the group detail on click and Enter", () => {
    const onOpen = vi.fn();
    const members = [{ snapshot: snap("a", member(122_880, 20_000, 100)), rank: 0 }, { snapshot: snap("b", member(122_880, 20_000, 100)), rank: 1 }];
    const { container } = render(<GroupCard groupId="g1" name="Pair" members={members} holder="x" onOpen={onOpen} />);
    const card = q(container, "group-card") as HTMLElement;
    expect(card.getAttribute("role")).toBe("button");
    card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledWith("g1");
    expect(container.textContent).toContain("Pair");
  });

  it("shows the waiting state when no online member reported metrics", () => {
    const members = [{ snapshot: snap("a", null), rank: 0 }, { snapshot: snap("b", null, false), rank: 1 }];
    const { container } = render(<GroupCard groupId="tp2-off" members={members} holder="GPU allocations" />);
    expect(q(container, "memory-pool")).toBeNull();
    expect(container.textContent).toContain("Waiting for metrics…");
    expect(container.textContent).toContain("1/2 online");
  });
});
