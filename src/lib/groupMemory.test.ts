import { describe, expect, it } from "vitest";
import type { GpuMetrics, MemMetrics } from "../../shared/types";
import { aggregateMemoryPool, type MemberMemory } from "./groupMemory";

function mem(over: Partial<MemMetrics> = {}): MemMetrics {
  return { usedMB: 20_000, totalMB: 122_880, availableMB: 102_880, percentage: 16, ...over };
}

/** A GB10-style unified GPU: vramTotal mirrors MemTotal, allocations in gpuAllocMB. */
function unifiedGpu(gpuAllocMB: number): GpuMetrics {
  return {
    temperature: null,
    usage: 10,
    powerDraw: 30,
    powerLimit: 90,
    vramUsedMB: gpuAllocMB,
    vramTotalMB: 122_880,
    vramPercentage: 0,
    vramAvailableMB: 0,
    processes: [{ pid: 1, name: "sglang", vramMB: gpuAllocMB }],
    gpuAllocMB,
    unifiedMemory: true,
  };
}

const m = (mem: MemMetrics | null, gpu: GpuMetrics | null = null): MemberMemory => ({ mem, gpu });

describe("aggregateMemoryPool (SC9)", () => {
  it("sums totals, available, cache and swap across members", () => {
    const pool = aggregateMemoryPool([
      m(mem({ cachedMB: 8_000, swapTotalMB: 16_384, swapFreeMB: 8_384 })),
      m(mem({ availableMB: 40_000, usedMB: 82_880, cachedMB: 4_000, swapTotalMB: 16_384, swapFreeMB: 16_384 })),
    ]);
    expect(pool).not.toBeNull();
    expect(pool!.totalMB).toBe(245_760);
    // in-use = Σtotal − Σavailable
    expect(pool!.inUseMB).toBe(245_760 - (102_880 + 40_000));
    expect(pool!.availableMB).toBe(142_880);
    expect(pool!.cacheMB).toBe(12_000);
    expect(pool!.freeMB).toBe(142_880 - 12_000);
    expect(pool!.swapUsedMB).toBe(8_000); // only the first member is swapping
    // The parts still add up to the summed total.
    expect(pool!.gpuMB + pool!.otherMB + pool!.cacheMB + pool!.freeMB).toBe(pool!.totalMB);
  });

  it("adds the GPU share only from unified members", () => {
    const discreteGpu: GpuMetrics = { ...unifiedGpu(50_000), unifiedMemory: false };
    const pool = aggregateMemoryPool([
      m(mem({ availableMB: 20_000 }), unifiedGpu(100_000)),
      m(mem(), discreteGpu),
    ]);
    expect(pool!.unified).toBe(true);
    expect(pool!.gpuMB).toBe(100_000); // the discrete 50 GB stays out of the pool
    expect(pool!.gpuMB + pool!.otherMB + pool!.cacheMB + pool!.freeMB).toBe(pool!.totalMB);
  });

  it("skips members without a usable reading (offline spark, no mem)", () => {
    const pool = aggregateMemoryPool([m(null), m(mem()), { mem: undefined, gpu: undefined }]);
    expect(pool!.totalMB).toBe(122_880);
  });

  it("returns null when no member reports memory", () => {
    expect(aggregateMemoryPool([])).toBeNull();
    expect(aggregateMemoryPool([m(null, unifiedGpu(10_000))])).toBeNull();
  });

  it("clamps a member's available to its own total before summing", () => {
    const pool = aggregateMemoryPool([
      m(mem({ availableMB: 999_999 })), // bad reading from an older agent
      m(mem()),
    ]);
    expect(pool!.availableMB).toBe(122_880 + 102_880);
    expect(pool!.inUseMB).toBe(122_880 - 122_880 + 20_000);
  });
});
