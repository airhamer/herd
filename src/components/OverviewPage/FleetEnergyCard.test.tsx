import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetEnergyCard, formatMoney } from "./FleetEnergyCard";
import { cleanupRenders, flush, render } from "../../testing/render";
import type { FleetEnergy, FleetEnergyHost } from "../../api/types";

vi.mock("../../api/client", () => ({
  fetchFleetEnergy: vi.fn(),
}));

import { fetchFleetEnergy } from "../../api/client";

const fetchEnergy = vi.mocked(fetchFleetEnergy);

afterEach(() => cleanupRenders());

function host(id: string, overrides: Partial<FleetEnergyHost> = {}): FleetEnergyHost {
  return {
    id,
    name: id,
    kind: "spark",
    online: true,
    reporting: true,
    duplicateOf: null,
    model: "gb10",
    watts: 120,
    measuredWatts: 30,
    gpuWatts: 30,
    cpuWatts: 20,
    baselineWatts: 23,
    gpuSource: "nvidia-smi",
    cpuSource: "estimated",
    gpuCount: 1,
    ...overrides,
  };
}

function energy(overrides: Partial<FleetEnergy> = {}): FleetEnergy {
  return {
    estimated: true,
    membershipChanged: false,
    restartRequired: false,
    trackedNodeIds: ["a", "b"],
    currentNodeIds: ["a", "b"],
    freshNodeCount: 2,
    currentWatts30s: 240,
    energy24hKwh: 1.5,
    energy31dKwh: 40,
    whPerOutputToken24h: 0.0123,
    outputTokens24h: 100,
    coverage24hMs: 86_400_000 * 2,
    coverage31dMs: 0,
    nodeCoverage24hMs: {},
    nodeCoverage31dMs: {},
    hourlyWatts24h: Array.from({ length: 24 }, (_, hour) => (hour % 4 === 0 ? null : 100 + hour)),
    label: "estimated, not wall-metered",
    hosts: [
      host("spark-1"),
      host("rig", {
        kind: "node",
        model: "measured",
        watts: 1410,
        gpuSource: "nvidia-smi",
        gpuCount: 4,
        cpuSource: "rapl",
        baselineWatts: 40,
      }),
    ],
    coverage: { reportingHosts: 2, hostsInScope: 2, percent: 100, measuredSharePct: 81.2, coverage24hPct: 99.6 },
    cost: { currency: "USD", pricePerKwh: 0.17, cost24h: 0.26, cost31d: 6.8, costPerDayAtCurrent: 0.98 },
    ...overrides,
  };
}

async function show(data: FleetEnergy) {
  fetchEnergy.mockResolvedValue(data);
  const view = render(<FleetEnergyCard />);
  await flush();
  return view.container;
}

describe("FleetEnergyCard", () => {
  it("labels values as estimated with coverage and keeps hourly gaps empty", async () => {
    const container = await show(energy());
    const label = container.querySelector("[data-testid=fleet-energy-label]")?.textContent ?? "";
    expect(label).toContain("Estimated, not wall-metered");
    expect(label).toContain("coverage 100% (2/2 hosts)");
    expect(label).toContain("81% from sensors");
    expect(container.textContent).toContain("240 W");
    expect(container.textContent).toContain("40.00 kWh");
    const bars = [...container.querySelectorAll("[aria-label^=Hourly] span")];
    expect(bars).toHaveLength(24);
    expect(bars.filter((bar) => (bar as HTMLElement).style.height === "0px" || (bar as HTMLElement).style.height === "0")).toHaveLength(6);
  });

  it("lists Sparks and agent nodes in one table with their power sources", async () => {
    const container = await show(energy());
    const spark = container.querySelector("[data-testid=energy-host-spark-1]")?.textContent ?? "";
    expect(spark).toContain("Spark");
    expect(spark).toContain("GB10 model");
    const rig = container.querySelector("[data-testid=energy-host-rig]")?.textContent ?? "";
    expect(rig).toContain("Agent node");
    expect(rig).toContain("1410");
    expect(rig).toContain("nvidia-smi ×4");
    expect(rig).toContain("rapl");
    expect(rig).toContain("+40 W idle");
  });

  it("marks duplicates, offline and non-reporting hosts without a wattage", async () => {
    const container = await show(
      energy({
        hosts: [
          host("spark-1"),
          host("dup", { kind: "node", duplicateOf: "spark-1" }),
          host("mac", { kind: "node", reporting: false, watts: null, model: null, gpuSource: null, cpuSource: null, baselineWatts: null }),
          host("down", { online: false, reporting: false, watts: null }),
        ],
        coverage: { reportingHosts: 1, hostsInScope: 3, percent: 33.3, measuredSharePct: 25, coverage24hPct: 33 },
      })
    );
    expect(container.querySelector("[data-testid=energy-host-dup]")?.textContent).toContain("same machine as spark-1");
    expect(container.querySelector("[data-testid=energy-host-dup]")?.textContent).toContain("counted under spark-1");
    expect(container.querySelector("[data-testid=energy-host-dup]")?.textContent).not.toContain("GB10 model");
    expect(container.querySelector("[data-testid=energy-host-mac]")?.textContent).toContain("no power telemetry");
    expect(container.querySelector("[data-testid=energy-host-down]")?.textContent).toContain("offline");
    expect(container.textContent).toContain("Partial coverage: 1/3 hosts reporting power.");
  });

  it("shows cost only when a price is set", async () => {
    const priced = await show(energy());
    expect(priced.querySelector("[data-testid=fleet-energy-cost]")?.textContent).toContain("$6.80");
    expect(priced.textContent).toContain("$0.98/day now");
    expect(priced.textContent).toContain("$0.17/kWh");
    cleanupRenders();
    const free = await show(energy({ cost: null }));
    expect(free.querySelector("[data-testid=fleet-energy-cost]")).toBeNull();
    expect(free.textContent).not.toContain("/kWh");
  });

  it("hides the Wh/token line when no tokens were counted", async () => {
    const withTokens = await show(energy());
    expect(withTokens.querySelector("[data-testid=fleet-energy-efficiency]")?.textContent).toContain("0.0123 Wh/token");
    cleanupRenders();
    const none = await show(energy({ whPerOutputToken24h: null, outputTokens24h: 0 }));
    expect(none.querySelector("[data-testid=fleet-energy-efficiency]")).toBeNull();
    expect(none.textContent).not.toContain("Wh/token");
  });

  it("explains warming-up, no-reporting and fetch-error states, and never asks for a restart", async () => {
    const warming = await show(energy({ energy24hKwh: null, currentWatts30s: null }));
    expect(warming.textContent).toContain("Warming up");
    cleanupRenders();
    const silent = await show(energy({ coverage: { reportingHosts: 0, hostsInScope: 2, percent: 0, measuredSharePct: null, coverage24hPct: 0 } }));
    expect(silent.textContent).toContain("No host is reporting power right now.");
    cleanupRenders();
    const changed = await show(energy({ membershipChanged: true, restartRequired: true }));
    expect(changed.textContent).not.toContain("Restart");
    cleanupRenders();
    fetchEnergy.mockRejectedValue(new Error("disk write failed"));
    const failed = render(<FleetEnergyCard />);
    await flush();
    expect(failed.container.textContent).toContain("Energy telemetry unavailable: disk write failed");
  });

  it("renders children (the monthly table) inside the card", async () => {
    fetchEnergy.mockResolvedValue(energy());
    const view = render(<FleetEnergyCard><p data-testid="child">monthly</p></FleetEnergyCard>);
    await flush();
    expect(view.container.querySelector("[data-testid=fleet-energy-card] [data-testid=child]")).not.toBeNull();
  });
});

describe("formatMoney", () => {
  it("formats known currencies and falls back for unknown codes", () => {
    expect(formatMoney(1.234, "USD")).toBe("$1.23");
    expect(formatMoney(1234.5, "EUR")).toBe("€1,235");
    expect(formatMoney(2, "XYZ")).toMatch(/2\.00|XYZ/);
    expect(formatMoney(null, "USD")).toBe("—");
  });
});
