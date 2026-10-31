// Clean-room tests for the monthly energy table (docs/specs/monthly-energy.md).
import { describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import type { MonthlyEnergyMonth } from "../../api/types";

vi.mock("../../api/client", () => ({ fetchMonthlyEnergy: vi.fn() }));

import { fetchMonthlyEnergy } from "../../api/client";
import { MonthlyEnergy } from "./MonthlyEnergy";

const load = vi.mocked(fetchMonthlyEnergy);

function utcMonth(year: number, monthIndex: number, fleetWh: number, closed = true): MonthlyEnergyMonth {
  return {
    month: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
    startMs: Date.UTC(year, monthIndex, 1),
    endMs: Date.UTC(year, monthIndex + 1, 1),
    closed,
    nodeIds: ["n1", "n2"],
    nodes: { n1: { wh: fleetWh / 2, coverageMs: 1_000 }, n2: { wh: fleetWh / 2, coverageMs: 1_000 } },
    totalWh: fleetWh,
    fleetWh,
    fleetCoverageMs: 1_000,
    outputTokens: 0,
    coveredOutputTokens: 0,
    whPerOutputToken: null,
  };
}

function respond(months: MonthlyEnergyMonth[]) {
  load.mockResolvedValue({ estimated: true, generatedAt: 0, foldedThroughMs: 0, months });
}

async function mount() {
  const view = render(<MonthlyEnergy />);
  await flush();
  return view.container;
}

describe("MonthlyEnergy table", () => {

  it("lists each month in kWh with a running total and marks the current month", async () => {
    respond([utcMonth(2026, 7, 100_000), utcMonth(2026, 8, 25_500), utcMonth(2026, 9, 500, false)]);
    const root = await mount();
    const rows = [...root.querySelectorAll("tbody tr")].map((tr) => tr.textContent ?? "");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Aug 2026");
    expect(rows[0]).toContain("100.0");
    expect(rows[1]).toContain("Sep 2026");
    expect(rows[1]).toContain("25.5");
    expect(rows[2]).toContain("Oct 2026");
    expect(rows[2]).toContain("current");
    expect(rows[0]).not.toContain("current");
    expect(root.textContent).toContain("total 126.0 kWh");
    expect(root.textContent).toContain("estimated, not wall-metered");
  });

  it("says so when the history is empty", async () => {
    respond([]);
    expect((await mount()).textContent).toContain("No closed months yet");
  });

  it("shows the error message when loading fails", async () => {
    load.mockRejectedValue(new Error("disk unavailable"));
    const root = await mount();
    expect(root.textContent).toContain("Energy history unavailable: disk unavailable");
  });
});
