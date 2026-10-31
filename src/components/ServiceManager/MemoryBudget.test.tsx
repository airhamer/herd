import { describe, expect, it } from "vitest";
import { flush, render } from "../../testing/render";
import {
  MemoryBudget,
  type GroupPlanForNode,
  type MemoryBudgetProps,
} from "./MemoryBudget";

function budget(overrides: Partial<MemoryBudgetProps> = {}): MemoryBudgetProps {
  return {
    totalMB: 131_072,
    usedMB: 110_000,
    freeMB: 21_072,
    servicesUsedMB: 102_400,
    otherUsedMB: 7_600,
    services: [
      { name: "llm-tp1", kind: "llm", footprintMB: 102_400, running: true, needed: true },
      { name: "image-sd", kind: "image", footprintMB: 40_960, running: true, needed: false },
    ],
    makeRoom: [{ serviceName: "image-sd", freesMB: 40_960, reason: "low-priority" }],
    needMakeRoom: true,
    ...overrides,
  };
}

describe("MemoryBudget", () => {
  it("renders total, used, free, services used, other used, service rows, and make-room plan", async () => {
    const { container } = render(<MemoryBudget {...budget()} />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Memory Budget");
    expect(text).toContain("128.0 GB"); // total
    expect(text).toContain("107.4 GB / 128.0 GB"); // used bar caption
    expect(text).toContain("20.6 GB"); // free
    expect(text).toContain("100.0 GB"); // services used
    expect(text).toContain("7.4 GB"); // other used
    expect(text).toContain("llm-tp1");
    expect(text).toContain("(llm)");
    expect(text).toContain("100.0 GB · running · needed");
    expect(text).toContain("image-sd");
    expect(text).toContain("(image)");
    expect(text).toContain("40.0 GB · running");
    expect(text).toContain("Make-room plan");
    expect(text).toContain("low-priority");
    expect(text).toContain("+40.0 GB");
    expect(text).toContain("Make room needed");
  });

  it("shows the OK badge and hides the make-room / services sections when not needed", async () => {
    const { container } = render(
      <MemoryBudget {...budget({ needMakeRoom: false, makeRoom: [], services: [] })} />
    );
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("OK");
    expect(text).not.toContain("Make room needed");
    expect(text).not.toContain("Make-room plan");
    expect(text).not.toContain("(llm)"); // no service rows
    // SC3: without a group plan the multi-spark section stays hidden.
    expect(text).not.toContain("group");
    expect(text).not.toContain("Per-spark breakdown");
  });

  describe("SC3 multi-spark / TP group (unlocked)", () => {
    function group(overrides: Partial<GroupPlanForNode> = {}): GroupPlanForNode {
      return {
        groupId: "tp2-aeon",
        tp: 2,
        perSparkMB: 98_304,
        groupTotalMB: 196_608,
        groupTotalMemMB: 245_760,
        groupFreeMemMB: 120_000,
        sparks: [
          {
            nodeId: "gx10-102c",
            head: true,
            totalMB: 122_880,
            usedMB: 20_000,
            freeMB: 102_880,
            plannedMB: 98_304,
            projectedFreeMB: 4_576,
            makeRoom: [],
            feasible: true,
          },
          {
            nodeId: "gx10-25ed",
            head: false,
            totalMB: 122_880,
            usedMB: 100_000,
            freeMB: 22_880,
            plannedMB: 98_304,
            projectedFreeMB: -37_120,
            makeRoom: [{ serviceName: "image-sd", freesMB: 40_960, reason: "stoppable" }],
            feasible: false,
          },
        ],
        estimated: true,
        fits: false,
        ...overrides,
      };
    }

    it("renders the group total, shard, and per-spark breakdown with head + make-room + infeasible rows", async () => {
      const { container } = render(
        <MemoryBudget {...budget({ groupAvailableMB: 22_880, group: group() })} />
      );
      await flush();
      const text = container.textContent ?? "";
      expect(text).toContain("TP2 group · tp2-aeon");
      expect(text).toContain("does not fit");
      expect(text).toContain("estimated"); // bootstrap hardcode tag (SC10 hardcodes)
      expect(text).toContain("192.0 GB / 240.0 GB"); // group total / group mem
      expect(text).toContain("96.0 GB"); // per-spark shard
      expect(text).toContain("Per-spark breakdown");
      expect(text).toContain("gx10-102c");
      expect(text).toContain("(head)");
      expect(text).toContain("gx10-25ed");
      expect(text).toContain("make-room: image-sd");
      expect(text).toContain("4.5 GB free after"); // feasible spark
      expect(text).toContain("−36.3 GB free after"); // infeasible spark shows the shortfall
      expect(text).toContain("Available here for shard");
      expect(text).toContain("22.3 GB"); // groupAvailableMB
    });

    it("fits group without estimates renders fits badge and no estimated tag or availability bar", async () => {
      const { container } = render(
        <MemoryBudget {...budget({ group: group({ estimated: false, fits: true }) })} />
      );
      await flush();
      const text = container.textContent ?? "";
      expect(text).toContain("fits");
      expect(text).not.toContain("does not fit");
      expect(text).not.toContain("estimated");
      // No groupAvailableMB threaded → no shard-availability row.
      expect(text).not.toContain("Available here for shard");
    });

    it("formats a negative projected-free with the minus sign and absolute value", async () => {
      const { container } = render(
        <MemoryBudget {...budget({ group: group({ sparks: [group().sparks[1]] }) })} />
      );
      await flush();
      expect(container.textContent ?? "").toContain("−36.3 GB free after");
    });
  });
});
