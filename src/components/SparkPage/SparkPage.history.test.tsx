// Where the History panel sits on the unit page (docs/specs/unit-history.md §10).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";

// Every other panel is stubbed out: only placement and the query are checked here.
const { blank, stubs } = vi.hoisted(() => ({
  blank: () => null,
  stubs: (names: string[]) => Object.fromEntries(names.map((n) => [n, vi.fn()])),
}));
vi.mock("../ui/HealthFindings", () => ({ HealthList: blank }));
vi.mock("./SparkHeader", () => ({ SparkHeader: blank }));
vi.mock("./SparkActions", () => ({ SparkActions: blank }));
vi.mock("./GpuPanel", () => ({ GpuPanel: blank }));
vi.mock("./RamPanel", () => ({ RamPanel: blank }));
vi.mock("./StoragePanel", () => ({ StoragePanel: blank }));
vi.mock("./NetworkPanel", () => ({ NetworkPanel: blank }));
vi.mock("./RocePanel", () => ({ RocePanel: blank }));
vi.mock("./TailscalePanel", () => ({ TailscalePanel: blank }));
vi.mock("./LlmPanel", () => ({ LlmPanel: blank }));
vi.mock("./ComfyPanel", () => ({ ComfyPanel: blank }));
vi.mock("../../api/client", () => ({
  ...stubs(["addLlmPort", "refreshSparkMetric", "removeLlmPort", "updateSpark"]),
  getUnitHistory: vi.fn(async () => ({ enabled: false })),
}));

import { getUnitHistory } from "../../api/client";
import { SparkPage } from "./SparkPage";

describe("unit page history placement", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(getUnitHistory).mockClear();
  });

  it("is the final full-width block, below the panel grid", async () => {
    const { container } = render(<SparkPage spark={makeSpark()} temperatureUnit="celsius" />);
    await flush();
    const blocks = [...container.firstElementChild!.children];
    const history = blocks[blocks.length - 1];
    expect(blocks[blocks.length - 2].className).toContain("spark-page");
    expect(history.querySelector(".panel-title")?.textContent).toContain("History · last hour");
    expect(history.textContent).toContain("Metrics history is off on the server");
  });

  it("asks for the history of the unit being shown", async () => {
    render(<SparkPage spark={makeSpark("gx-77")} temperatureUnit="fahrenheit" />);
    await flush();
    expect(getUnitHistory).toHaveBeenCalledWith("gx-77", "1h");
    expect(getUnitHistory).not.toHaveBeenCalledWith("spark-1", expect.anything());
  });
});
