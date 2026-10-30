import { describe, expect, it } from "vitest";
import { gib, gpuHolderLabel, isUnifiedGpu, memoryPool, shortModel } from "./memoryPool";

// Hasso's reference screenshot (ASUS Ascent GX10): 109.9 of 121.6 GiB in use,
// 11.8 available, 8.8 above the 3 GiB floor; model 99.2, system 10.7,
// cache 11.0, free 0.8, swap 8.4.
const HASSO = {
  totalMB: 124560,
  availableMB: 12040,
  cachedMB: 11264,
  swapTotalMB: 16384,
  swapFreeMB: 16384 - 8602,
  gpuMB: 101581,
  unified: true,
};

describe("memoryPool", () => {
  it("reproduces Hasso's screenshot numbers", () => {
    const p = memoryPool(HASSO)!;
    expect(gib(p.totalMB)).toBe("121.6");
    expect(gib(p.inUseMB)).toBe("109.9");
    expect(gib(p.availableMB)).toBe("11.8");
    expect(gib(p.aboveFloorMB)).toBe("8.8");
    expect(gib(p.gpuMB)).toBe("99.2");
    expect(gib(p.otherMB)).toBe("10.7");
    expect(gib(p.cacheMB)).toBe("11.0");
    expect(gib(p.freeMB)).toBe("0.8");
    expect(gib(p.swapUsedMB)).toBe("8.4");
    expect(p.floorMB).toBe(3072);
  });

  it("parts always add up to the total", () => {
    for (const inp of [
      HASSO,
      { ...HASSO, gpuMB: 0 },
      { ...HASSO, cachedMB: 0 },
      { ...HASSO, unified: false },
      { totalMB: 64000, availableMB: 60000, cachedMB: 2000, gpuMB: 500, unified: true },
    ]) {
      const p = memoryPool(inp)!;
      expect(p.gpuMB + p.otherMB + p.cacheMB + p.freeMB).toBeCloseTo(p.totalMB, 6);
      expect(p.inUseMB + p.availableMB).toBe(p.totalMB);
    }
  });

  it("caps GPU allocations at in-use and cache at available", () => {
    const p = memoryPool({ totalMB: 100000, availableMB: 30000, cachedMB: 50000, gpuMB: 90000, unified: true })!;
    expect(p.gpuMB).toBe(70000);
    expect(p.otherMB).toBe(0);
    expect(p.cacheMB).toBe(30000);
    expect(p.freeMB).toBe(0);
  });

  it("a discrete GPU contributes nothing to the system pool", () => {
    const p = memoryPool({ ...HASSO, unified: false })!;
    expect(p.gpuMB).toBe(0);
    expect(p.otherMB).toBe(p.inUseMB);
  });

  it("tone follows Hasso's thresholds (crit < 4 GiB, low < 9 GiB)", () => {
    const at = (gibAvail: number) =>
      memoryPool({ totalMB: 124560, availableMB: gibAvail * 1024, unified: true })!.tone;
    expect(at(3.9)).toBe("crit");
    expect(at(4)).toBe("low");
    expect(at(8.9)).toBe("low");
    expect(at(9)).toBe("ok");
  });

  it("goes negative above-floor when under the floor, and honours a custom floor", () => {
    expect(memoryPool({ totalMB: 1000 * 1024, availableMB: 2048, unified: true })!.aboveFloorMB).toBe(-1024);
    expect(memoryPool({ totalMB: 1000 * 1024, availableMB: 8192, unified: true, floorMB: 6144 })!.aboveFloorMB).toBe(2048);
  });

  it("tolerates snapshots without the #26 fields (no cache, no swap)", () => {
    const p = memoryPool({ totalMB: 128000, availableMB: 40000, unified: true, gpuMB: undefined, cachedMB: null })!;
    expect(p.cacheMB).toBe(0);
    expect(p.freeMB).toBe(40000);
    expect(p.swapUsedMB).toBe(0);
    expect(p.gpuMB).toBe(0);
  });

  it("returns null without a usable total", () => {
    expect(memoryPool({ totalMB: 0, availableMB: 0, unified: true })).toBeNull();
    expect(memoryPool({ totalMB: Number.NaN, availableMB: 0, unified: true })).toBeNull();
  });
});

describe("isUnifiedGpu", () => {
  it("prefers the agent flag", () => {
    expect(isUnifiedGpu({ unifiedMemory: true, vramTotalMB: 16000 }, 128000)).toBe(true);
    expect(isUnifiedGpu({ unifiedMemory: false, vramTotalMB: 128000 }, 128000)).toBe(false);
  });
  it("falls back to VRAM total == MemTotal (the GB10 fallback) for older agents", () => {
    expect(isUnifiedGpu({ vramTotalMB: 124546 }, 124546)).toBe(true);
    expect(isUnifiedGpu({ vramTotalMB: 24576 }, 65536)).toBe(false);
    expect(isUnifiedGpu(null, 128000)).toBe(false);
  });
});

describe("gpuHolderLabel", () => {
  it("names the one running model, short", () => {
    expect(gpuHolderLabel(["Qwen/Qwen3.8-Flash-176B", null])).toBe("Qwen3.8-Flash-176B");
  });
  it("counts several distinct models", () => {
    expect(gpuHolderLabel(["a", "b", "a"])).toBe("2 models");
  });
  it("falls back to the top GPU process, then a generic label", () => {
    expect(gpuHolderLabel([], "sglang::scheduler")).toBe("sglang::scheduler");
    expect(gpuHolderLabel([], "unknown")).toBe("GPU allocations");
    expect(gpuHolderLabel([])).toBe("GPU allocations");
  });
  it("shortModel keeps ids without a slash", () => {
    expect(shortModel("qwen38-flash")).toBe("qwen38-flash");
    expect(shortModel("org/")).toBe("org/");
  });
});
