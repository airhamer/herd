import { describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";

// Only the unified-memory panel's placement is under test (#26).
vi.mock("./GpuPanel", () => ({ GpuPanel: () => <section data-testid="gpu-panel" /> }));
vi.mock("./RamPanel", () => ({ RamPanel: () => <section data-testid="ram-panel" /> }));
vi.mock("./StoragePanel", () => ({ StoragePanel: () => null }));
vi.mock("./NetworkPanel", () => ({ NetworkPanel: () => null }));
vi.mock("./RocePanel", () => ({ RocePanel: () => null }));
vi.mock("./TailscalePanel", () => ({ TailscalePanel: () => null }));
vi.mock("./LlmPanel", () => ({ LlmPanel: () => null }));
vi.mock("./ComfyPanel", () => ({ ComfyPanel: () => null }));
vi.mock("./SparkHeader", () => ({ SparkHeader: () => null }));
vi.mock("./SparkActions", () => ({ SparkActions: () => null }));
vi.mock("./HistoryPanel", () => ({ HistoryPanel: () => null }));
vi.mock("../ui/HealthFindings", () => ({ HealthList: () => null }));
vi.mock("../../api/client", () => ({
  getUnitHistory: vi.fn(() => Promise.resolve({ enabled: false })),
  updateSpark: vi.fn(),
  refreshSparkMetric: vi.fn(),
  addLlmPort: vi.fn(),
  removeLlmPort: vi.fn(),
}));

import { SparkPage } from "./SparkPage";

function withPool(kind?: "host") {
  const s = makeSpark("gx10-1c2c");
  if (kind) s.kind = kind;
  s.metrics.unifiedMemory = {
    total: 124560, gpuUsed: 101581, cpuUsed: 10939, used: 112520, available: 12040,
    percentage: 90, oomRisk: "high", bandwidth: { current: 0, peak: 400 },
    cached: 11264, swapTotal: 16384, swapFree: 16384 - 8602,
  };
  return s;
}

describe("SparkPage unified memory panel (#26)", () => {
  it("opens the Resources grid full width, ahead of the GPU panel", async () => {
    const { container } = render(<SparkPage spark={withPool()} temperatureUnit="celsius" />);
    await flush();
    const panel = container.querySelector(".panel-unified-memory")!;
    expect(panel).toBeTruthy();
    expect(panel.className).toContain("md:col-span-2");
    expect(panel.nextElementSibling?.getAttribute("data-testid")).toBe("gpu-panel");
    expect(panel.textContent).toContain("109.9");
  });

  it("is absent without a reading and on non-Spark hosts", async () => {
    const bare = render(<SparkPage spark={makeSpark()} temperatureUnit="celsius" />);
    await flush();
    expect(bare.container.querySelector(".panel-unified-memory")).toBeNull();
    const host = render(<SparkPage spark={withPool("host")} temperatureUnit="celsius" />);
    await flush();
    expect(host.container.querySelector(".panel-unified-memory")).toBeNull();
    expect(host.container.querySelector('[data-testid="ram-panel"]')).toBeTruthy();
  });
});
