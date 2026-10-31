import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { FleetShowcaseGrid } from "./FleetShowcaseGrid";
import { fleetLane } from "./fleetShowcaseFixtures";

describe("FleetShowcaseGrid (SHOW1)", () => {
  it("shows client tok/s, server tok/s and TTFT per lane", () => {
    const { container } = render(<FleetShowcaseGrid lanes={[fleetLane()]} />);
    const tile = container.querySelector('[data-testid="fleet-showcase-tile-spark:s1:8000"]')!;
    expect(tile).toBeTruthy();
    expect(tile.querySelector('[data-testid="tile-client-tps"]')!.textContent).toBe("80.2");
    expect(tile.querySelector('[data-testid="tile-server-tps"]')!.textContent).toBe("88.4 tok/s");
    expect(tile.querySelector('[data-testid="tile-ttft"]')!.textContent).toBe("120 ms");
    expect(tile.textContent).toContain("SSH tunnel");
    expect(tile.textContent).toContain("Spark");
    expect(tile.textContent).toContain("usage");
  });

  it("marks client-only engines and estimated tokens", () => {
    const lane = fleetLane({
      laneId: "node:n1:11434",
      kind: "node",
      nodeName: "mac-mini",
      backend: "ollama",
      serverEngine: null,
      serverCounters: false,
      serverTps: null,
      via: "lan",
      tokenSource: "estimate",
      ttftP50Ms: 1500,
    });
    const { container } = render(<FleetShowcaseGrid lanes={[lane]} />);
    const tile = container.querySelector('[data-testid="fleet-showcase-tile-node:n1:11434"]')!;
    expect(tile.querySelector('[data-testid="tile-server-tps"]')!.textContent).toBe("client only");
    expect(tile.querySelector('[data-testid="tile-ttft"]')!.textContent).toBe("1.50 s");
    expect(tile.textContent).toContain("≈ est.");
    expect(tile.textContent).toContain("agent");
  });

  it("reports lane clicks and renders nothing without lanes", () => {
    const onSelect = vi.fn();
    const { container } = render(<FleetShowcaseGrid lanes={[fleetLane({ error: "connect ECONNREFUSED", status: "error" })]} onSelectLane={onSelect} />);
    const tile = container.querySelector<HTMLButtonElement>(".fleet-showcase-tile")!;
    expect(tile.textContent).toContain("ECONNREFUSED");
    tile.click();
    expect(onSelect).toHaveBeenCalledWith("spark:s1:8000");
    const empty = render(<FleetShowcaseGrid lanes={[]} />);
    expect(empty.container.innerHTML).toBe("");
  });
});
