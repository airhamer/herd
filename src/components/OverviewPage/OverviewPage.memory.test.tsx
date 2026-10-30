import { describe, expect, it } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import type { SparkSnapshot } from "../../api/types";
import { OverviewPage } from "./OverviewPage";

// Issue #26: Sparks screen cards show the Hasso-style unified-memory pool.
function gb10Spark(over: Partial<SparkSnapshot["metrics"]["unifiedMemory"] & object> = {}): SparkSnapshot {
  const s = makeSpark("gx10-1c2c");
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

const q = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);

describe("OverviewPage spark card memory (#26)", () => {
  it("replaces the VRAM bar with the unified pool, named after the served model", () => {
    const { container } = render(<OverviewPage sparks={[gb10Spark()]} />);
    expect(q(container, "memory-pool")).toBeTruthy();
    expect(q(container, "memory-pool-used")?.textContent).toBe("109.9");
    expect(q(container, "memory-pool-floor-text")?.textContent).toBe("8.8 above the 3 GiB floor");
    const legend = q(container, "memory-pool-legend")?.textContent ?? "";
    expect(legend).toContain("qwen38-flash-176B99.2");
    expect(legend).toContain("Page cache11.0");
    expect(q(container, "memory-pool-swap")?.textContent).toBe("Swap in use8.4");
    expect(container.textContent).not.toContain("VRAM");
  });

  it("renders a server without the #26 fields (no cache, no swap)", () => {
    const { container } = render(
      <OverviewPage sparks={[gb10Spark({ cached: undefined, swapTotal: undefined, swapFree: undefined })]} />
    );
    expect(q(container, "memory-pool-seg-cache")).toBeNull();
    expect(q(container, "memory-pool-swap")).toBeNull();
    expect(q(container, "memory-pool-legend")?.textContent).toContain("Free11.8");
  });

  it("keeps the VRAM bar when there is no unified-memory reading", () => {
    const { container } = render(<OverviewPage sparks={[makeSpark("s1")]} />);
    expect(q(container, "memory-pool")).toBeNull();
    expect(container.textContent).toContain("VRAM");
  });

  it("keeps VRAM and RAM bars on a non-Spark host", () => {
    const s = gb10Spark();
    s.kind = "host";
    const { container } = render(<OverviewPage sparks={[s]} />);
    expect(q(container, "memory-pool")).toBeNull();
    expect(container.textContent).toContain("VRAM");
    expect(container.textContent).toContain("RAM");
  });
});
