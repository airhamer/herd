import { beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";

// The panels are covered by their own tests; only the History panel's placement is under test here.
vi.mock("./GpuPanel", () => ({ GpuPanel: () => null }));
vi.mock("./RamPanel", () => ({ RamPanel: () => null }));
vi.mock("./StoragePanel", () => ({ StoragePanel: () => null }));
vi.mock("./NetworkPanel", () => ({ NetworkPanel: () => null }));
vi.mock("./RocePanel", () => ({ RocePanel: () => null }));
vi.mock("./TailscalePanel", () => ({ TailscalePanel: () => null }));
vi.mock("./LlmPanel", () => ({ LlmPanel: () => null }));
vi.mock("./ComfyPanel", () => ({ ComfyPanel: () => null }));
vi.mock("./SparkHeader", () => ({ SparkHeader: () => null }));
vi.mock("./SparkActions", () => ({ SparkActions: () => null }));
vi.mock("../ui/HealthFindings", () => ({ HealthList: () => null }));
vi.mock("../../api/client", () => ({
  getUnitHistory: vi.fn(() => Promise.resolve({ enabled: false })),
  updateSpark: vi.fn(),
  refreshSparkMetric: vi.fn(),
  addLlmPort: vi.fn(),
  removeLlmPort: vi.fn(),
}));

import { getUnitHistory } from "../../api/client";
import { SparkPage } from "./SparkPage";

beforeEach(() => {
  localStorage.clear();
  vi.mocked(getUnitHistory).mockClear();
});

describe("SparkPage History panel", () => {
  it("sits under both columns, full width, as the page's last block", async () => {
    const { container } = render(<SparkPage spark={makeSpark()} temperatureUnit="celsius" />);
    await flush();
    const page = container.firstElementChild!;
    const panel = [...page.children].at(-1)!;
    expect(panel.previousElementSibling?.className).toContain("spark-page");
    expect(panel.querySelector(".panel-title")!.textContent).toContain("History · last hour");
    expect(getUnitHistory).toHaveBeenCalledWith("spark-1", "1h");
    expect(container.textContent).toContain("Metrics history is off on the server");
  });

  it("queries the selected spark, not the fleet", async () => {
    render(<SparkPage spark={makeSpark("unit-42")} temperatureUnit="celsius" />);
    await flush();
    expect(getUnitHistory).toHaveBeenCalledWith("unit-42", "1h");
  });
});
