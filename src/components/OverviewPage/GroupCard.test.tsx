import { describe, expect, it } from "vitest";
import { render } from "../../testing/render";
import { GroupCard } from "./GroupCard";
import { aggregateMemoryPool } from "../../lib/groupMemory";
import type { GpuMetrics, MemMetrics } from "../../../shared/types";

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

const q = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);

describe("GroupCard (SC9)", () => {
  it("shows group-level facts and the aggregated Hasso pool, no member rows", () => {
    const pool = aggregateMemoryPool([member(122_880, 20_000, 100_000), member(122_880, 24_000, 96_000)]);
    const { container } = render(
      <GroupCard groupId="tp2-aeon" memberCount={2} onlineCount={2} pool={pool} holder="aeon-176b" />
    );

    expect(q(container, "group-card")).not.toBeNull();
    expect(container.textContent).toContain("tp2-aeon");
    expect(container.textContent).toContain("TP2 group");
    expect(q(container, "group-card-online")?.textContent).toBe("2/2 online");

    // One summed pool: 240.0 GiB total, 44000 MB available → 197.0 in use.
    expect(q(container, "memory-pool")).not.toBeNull();
    expect(q(container, "memory-pool-used")?.textContent).toBe("197.0");
    const legend = q(container, "memory-pool-legend")?.textContent ?? "";
    expect(legend).toContain("aeon-176b"); // GPU holder label spans the group
    expect(q(container, "group-card-total")?.textContent).toBe(
      "240.0 GiB total · 197.0 in use · 43.0 available"
    );

    // The card is presentational: it never lists individual members.
    expect(container.textContent).not.toContain("gx10-");
    expect(container.querySelectorAll("li")).toHaveLength(container.querySelectorAll('[data-testid="memory-pool-legend"] li').length);
  });

  it("shows the waiting state when no member reported memory", () => {
    const { container } = render(
      <GroupCard groupId="tp2-off" memberCount={2} onlineCount={1} pool={null} holder="GPU allocations" />
    );
    expect(q(container, "memory-pool")).toBeNull();
    expect(container.textContent).toContain("Waiting for metrics…");
    expect(container.textContent).toContain("1/2 online");
  });
});
