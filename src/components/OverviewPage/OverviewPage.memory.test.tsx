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

// A discrete-GPU "host" unit: 64 GiB of system RAM, one 24 GiB card. The server
// still fills unifiedMemory from /proc/meminfo (system RAM) on such hosts.
function discreteHost(): SparkSnapshot {
  const s = makeSpark("x86-4090");
  s.kind = "host";
  s.hardware = { ...s.hardware, device: "Linux GPU host", gpuChip: "NVIDIA GeForce RTX 4090", totalMemoryGB: 64 };
  s.metrics.gpu = { ...s.metrics.gpu!, vram: { used: 8192, total: 24576, available: 16384, percentage: 33 } };
  s.metrics.ram = { used: 24576, total: 65536, available: 40960, percentage: 38 } as SparkSnapshot["metrics"]["ram"];
  s.metrics.unifiedMemory = {
    total: 65536, gpuUsed: 8000, cpuUsed: 16576, used: 24576, available: 40960,
    percentage: 38, oomRisk: "low", bandwidth: { current: 0, peak: 400 },
    cached: 10240, swapTotal: 8192, swapFree: 0,
  };
  return s;
}

describe("OverviewPage cards on hosts without unified memory (#26)", () => {
  it("discrete GPU host: separate VRAM and RAM bars, VRAM Available from the card, no pool", () => {
    const { container } = render(<OverviewPage sparks={[discreteHost()]} />);
    const text = container.textContent ?? "";
    expect(q(container, "memory-pool")).toBeNull();
    expect(text).not.toContain("Unified memory");
    expect(text).not.toContain("Swap in use");
    expect(text).toMatch(/VRAM8(\.0)?\s*\/\s*24(\.0)? ?GB/);
    expect(text).toMatch(/RAM24(\.0)?\s*\/\s*64(\.0)? ?GB/);
    expect(text).toContain("Available16.0 GB"); // VRAM free, not the 40 GB of system RAM
  });

  it("CPU-only host: the server's zeroed GPU reading shows no VRAM and system RAM stays on the RAM bar", () => {
    const s = discreteHost();
    s.hardware = { ...s.hardware, gpuChip: null };
    // SystemCollector._defaultGpu() when nvidia-smi is absent.
    s.metrics.gpu = { ...s.metrics.gpu!, usage: 0, temperature: 0, vram: { used: 0, total: 0, available: 0, percentage: 0 } };
    const { container } = render(<OverviewPage sparks={[s]} />);
    const text = container.textContent ?? "";
    expect(q(container, "memory-pool")).toBeNull();
    expect(text).toContain("VRAM—");
    expect(text).toMatch(/RAM24(\.0)?\s*\/\s*64(\.0)? ?GB/);
    expect(text).not.toContain("Available");
  });

  it("CPU-only host: a GPU reading without vram never borrows the meminfo pool as VRAM", () => {
    const s = discreteHost();
    s.metrics.gpu = { ...s.metrics.gpu!, vram: undefined } as unknown as SparkSnapshot["metrics"]["gpu"];
    const { container } = render(<OverviewPage sparks={[s]} />);
    const text = container.textContent ?? "";
    expect(text).toContain("VRAM—");
    expect(text).not.toContain("Available");
  });

  it("CPU-only host with no GPU object renders the waiting placeholder without errors (as on main)", () => {
    const s = discreteHost();
    s.metrics.gpu = null;
    const { container } = render(<OverviewPage sparks={[s]} />);
    expect(container.textContent).toContain("Waiting for metrics");
    expect(q(container, "memory-pool")).toBeNull();
  });

  it("a Spark-kind unit whose hardware is not GB10 is not drawn as a unified pool", () => {
    const s = gb10Spark();
    s.hardware = { ...s.hardware, gpuChip: "NVIDIA H100 80GB HBM3" };
    const { container } = render(<OverviewPage sparks={[s]} />);
    expect(q(container, "memory-pool")).toBeNull();
    expect(container.textContent).toContain("VRAM");
  });

  it("mixed fleet: each card picks its own presentation", () => {
    const { container } = render(<OverviewPage sparks={[gb10Spark(), discreteHost()]} />);
    expect(container.querySelectorAll('[data-testid="memory-pool"]').length).toBe(1);
    expect(container.textContent).toContain("109.9");
    expect(container.textContent).toMatch(/VRAM8(\.0)?\s*\/\s*24(\.0)? ?GB/);
  });
});
