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
    expect(tile.querySelector('[data-testid="tile-peak"]')!.textContent).toBe("peak 84.6 tok/s");
    expect(tile.querySelector(".fleet-showcase-tile__badge--est")).toBeNull();
  });

  it("flags live (character-estimated) lanes and mixed lanes (SHOW2)", () => {
    const live = fleetLane({
      status: "running", tokenSource: null, estimated: true, clientTpsPeak: 91,
      aggregate: { tps: 80.2, peakTps: 91, peakEstimated: true, estimated: true, decodeTokens: 400, windowMs: 5000, streams: 2 },
    });
    const mixed = fleetLane({ laneId: "spark:s1:8001", port: 8001, tokenSource: "mixed", estimated: true });
    const { container } = render(<FleetShowcaseGrid lanes={[live, mixed]} />);
    const [a, b] = [...container.querySelectorAll(".fleet-showcase-tile")];
    const badgeA = a.querySelector('[data-testid="tile-token-badge"]')!;
    expect(badgeA.textContent).toBe("≈ est.");
    expect(badgeA.className).toContain("fleet-showcase-tile__badge--est");
    expect(badgeA.getAttribute("title")).toMatch(/until the engine reports usage/);
    expect(a.querySelector('[data-testid="tile-peak"]')!.textContent).toBe("peak ≈91.0 tok/s");
    expect(b.querySelector('[data-testid="tile-token-badge"]')!.textContent).toBe("≈ mixed");
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
