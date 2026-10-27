import { describe, expect, it, vi } from "vitest";
import { MonthlyEnergy } from "./MonthlyEnergy";
import { flush, render } from "../../testing/render";
import type { MonthlyEnergy as MonthlyEnergyData, MonthlyEnergyMonth } from "../../api/types";

vi.mock("../../api/client", () => ({
  fetchMonthlyEnergy: vi.fn(),
}));

import { fetchMonthlyEnergy } from "../../api/client";

const fetchMonthly = vi.mocked(fetchMonthlyEnergy);

function month(overrides: Partial<MonthlyEnergyMonth> = {}): MonthlyEnergyMonth {
  return {
    month: "2026-08",
    startMs: Date.UTC(2026, 7, 1),
    endMs: Date.UTC(2026, 8, 1),
    closed: true,
    nodeIds: ["a", "b"],
    nodes: { a: { wh: 60_000, coverageMs: 1 }, b: { wh: 40_000, coverageMs: 1 } },
    totalWh: 100_000,
    fleetWh: 100_000,
    fleetCoverageMs: 2,
    outputTokens: 500,
    coveredOutputTokens: 500,
    whPerOutputToken: 200,
    ...overrides,
  };
}

function data(months: MonthlyEnergyMonth[]): MonthlyEnergyData {
  return { estimated: true, generatedAt: 1, foldedThroughMs: 1, months };
}

describe("MonthlyEnergy", () => {
  it("renders one row per month with 1-decimal kWh and totals", async () => {
    fetchMonthly.mockResolvedValue(
      data([
        month(),
        month({ month: "2026-09", startMs: Date.UTC(2026, 8, 1), endMs: Date.UTC(2026, 9, 1), fleetWh: 25_500, totalWh: 25_500 }),
        month({
          month: "2026-10",
          startMs: Date.UTC(2026, 9, 1),
          endMs: Date.UTC(2026, 10, 1),
          closed: false,
          fleetWh: 500,
          totalWh: 500,
        }),
      ]),
    );
    const { container } = render(<MonthlyEnergy />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Aug 2026");
    expect(text).toContain("Sep 2026");
    expect(text).toContain("Oct 2026");
    expect(text).toContain("100.0");
    expect(text).toContain("25.5");
    expect(text).toContain("current");
    expect(text).toContain("total 126.0 kWh");
    expect(text).toContain("estimated, not wall-metered");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
  });

  it("shows an empty state when no months exist", async () => {
    fetchMonthly.mockResolvedValue(data([]));
    const { container } = render(<MonthlyEnergy />);
    await flush();
    expect(container.textContent).toContain("No closed months yet");
  });

  it("reports fetch failures", async () => {
    fetchMonthly.mockRejectedValue(new Error("history file missing"));
    const { container } = render(<MonthlyEnergy />);
    await flush();
    expect(container.textContent).toContain("Energy history unavailable: history file missing");
  });
});
