import { describe, expect, it } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import type { SparkSnapshot } from "../../api/types";
import { UnifiedMemoryPanel } from "./UnifiedMemoryPanel";

// The numbers in Hasso's cockpit screenshot (issue #26): 109.9 of 121.6 GiB.
function gx10(over: Partial<NonNullable<SparkSnapshot["metrics"]["unifiedMemory"]>> = {}): SparkSnapshot {
  const s = makeSpark("gx10-1c2c");
  s.hardware = { ...s.hardware, device: "ASUS Ascent GX10", totalMemoryGB: 128 };
  s.metrics.unifiedMemory = {
    total: 124560,
    gpuUsed: 101581,
    cpuUsed: 10939,
    used: 112520,
    available: 12040,
    percentage: 90,
    oomRisk: "high",
    bandwidth: { current: 0, peak: 400 },
    cached: 11264,
    swapTotal: 16384,
    swapFree: 16384 - 8602,
    ...over,
  };
  s.metrics.llm = [{ ...s.metrics.llm[0], available: true, modelId: "Qwen/qwen38-flash-176B" }];
  return s;
}

const q = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("UnifiedMemoryPanel (#26)", () => {
  it("reproduces Hasso's panel: title, big number, subline, headroom, legend", () => {
    const { container } = render(<UnifiedMemoryPanel spark={gx10()} />);
    expect(q(container, "unified-memory-title")?.textContent).toBe(
      "Unified memory of this ASUS Ascent GX10, 128 GB, shared by CPU and GPU",
    );
    expect(q(container, "unified-memory-used")?.textContent).toBe("109.9");
    expect(container.textContent).toContain("of 121.6 GiB in use");
    expect(q(container, "unified-memory-sub")?.textContent).toBe(
      "qwen38-flash-176B holds its weights and its KV pool: 99.2 GiB on the GPU side of the pool.",
    );
    expect(q(container, "unified-memory-available")?.textContent).toBe("11.8");
    expect(q(container, "unified-memory-available")?.className).toContain("text-success");
    expect(q(container, "unified-memory-floor-text")?.textContent).toBe("GiB available, 8.8 above the 3 GiB floor");
    const legend = q(container, "unified-memory-legend")?.textContent ?? "";
    expect(legend).toContain("qwen38-flash-176B, GPU allocations99.2 GiB");
    expect(legend).toContain("System and apps10.7 GiB");
    expect(legend).toContain("Page cache11.0 GiB");
    expect(legend).toContain("Free0.8 GiB");
    expect(q(container, "unified-memory-swap")?.textContent).toBe("Swap in use8.4 GiB");
  });

  it("draws the reservoir: labelled segments over 9%, floor, scale and swap strip", () => {
    const { container } = render(<UnifiedMemoryPanel spark={gx10()} />);
    expect(q(container, "memory-reservoir-label-gpu")?.textContent).toBe("qwen38-flash-176B 99 GiB");
    expect(q(container, "memory-reservoir-label-cache")?.textContent).toBe("cache 11 GiB");
    // 0.8 GiB free is under 9% of the bar: no label, the segment is still there.
    expect(q(container, "memory-reservoir-seg-free")).toBeTruthy();
    expect(q(container, "memory-reservoir-label-free")).toBeNull();
    expect(q(container, "memory-reservoir-seg-gpu")?.style.width).toBe("81.55%");
    expect(q(container, "memory-reservoir-floor")?.style.width).toBe("2.47%");
    expect(q(container, "memory-reservoir-scale")?.textContent).toBe("032 GiB64 GiB96 GiB121.6 GiB");
    expect(q(container, "memory-reservoir-swap")?.textContent).toContain("8.4 GiB");
  });

  it("colours the available number amber when low and red under the floor", () => {
    const low = render(<UnifiedMemoryPanel spark={gx10({ available: 6 * 1024 })} />);
    expect(q(low.container, "unified-memory-available")?.className).toContain("text-warning");
    const crit = render(<UnifiedMemoryPanel spark={gx10({ available: 2 * 1024, cached: 1024 })} />);
    expect(q(crit.container, "unified-memory-available")?.className).toContain("text-danger");
    expect(q(crit.container, "unified-memory-floor-text")?.textContent).toBe("GiB available: under the 3 GiB floor");
  });

  it("hides swap when none is in use and words an empty GPU side", () => {
    const s = gx10({ swapFree: 16384, gpuUsed: 0 });
    s.metrics.llm = [];
    const { container } = render(<UnifiedMemoryPanel spark={s} />);
    expect(q(container, "unified-memory-swap")).toBeNull();
    expect(q(container, "memory-reservoir-swap")).toBeNull();
    expect(q(container, "unified-memory-sub")?.textContent).toBe("Nothing holds the GPU side of the pool.");
  });

  it("names the box size from MemTotal when the hardware does not report it", () => {
    const s = gx10();
    s.hardware = { ...s.hardware, totalMemoryGB: null };
    const { container } = render(<UnifiedMemoryPanel spark={s} />);
    expect(q(container, "unified-memory-title")?.textContent).toContain("GX10, 128 GB,");
  });

  it("renders nothing without a unified-memory reading", () => {
    const s = gx10();
    s.metrics.unifiedMemory = null;
    const { container } = render(<UnifiedMemoryPanel spark={s} />);
    expect(container.textContent).toBe("");
  });

  it("renders nothing on a discrete-GPU host or non-GB10 hardware, even with a meminfo reading", () => {
    const host = gx10();
    host.kind = "host";
    expect(render(<UnifiedMemoryPanel spark={host} />).container.textContent).toBe("");
    const h100 = gx10();
    h100.hardware = { ...h100.hardware, gpuChip: "NVIDIA H100 80GB HBM3" };
    expect(render(<UnifiedMemoryPanel spark={h100} />).container.textContent).toBe("");
  });
});
