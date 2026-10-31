import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import type { FleetShowcaseTarget } from "../../api/types";
import { fleetLane, fleetSession, fleetStream } from "./fleetShowcaseFixtures";

const api = vi.hoisted(() => ({
  getFleetShowcaseTargets: vi.fn(),
  listFleetShowcase: vi.fn(),
  startFleetShowcase: vi.fn(),
  getFleetShowcase: vi.fn(),
  cancelFleetShowcase: vi.fn(),
  clearFleetShowcaseHistory: vi.fn(),
}));
vi.mock("../../api/client", () => api);

import { FleetShowcasePage, FLEET_POLL_MS, mergeFleetSession } from "./FleetShowcasePage";

const target = (over: Partial<FleetShowcaseTarget>): FleetShowcaseTarget => ({
  laneId: "spark:s1:8000",
  kind: "spark",
  nodeId: "s1",
  nodeName: "spark-a",
  host: "10.0.0.5",
  port: 8000,
  modelId: "Qwen3-30B",
  backend: "vllm",
  available: true,
  serverCounters: true,
  access: "lan-or-ssh",
  ...over,
});

const targets = [
  target({}),
  target({ laneId: "node:n1:11434", kind: "node", nodeId: "n1", nodeName: "mac-mini", port: 11434, backend: "ollama", serverCounters: false, access: "lan" }),
  target({ laneId: "node:n2:8080", kind: "node", nodeId: "n2", nodeName: "old-box", port: 8080, available: false }),
];

describe("mergeFleetSession (SHOW1)", () => {
  it("replaces on full text and appends on deltas", () => {
    const first = mergeFleetSession(null, fleetSession({ status: "running", lanes: [fleetLane({ streams: [fleetStream({ content: "Hel", reasoning: "" })] })] }));
    const delta = fleetSession({
      status: "running",
      lanes: [fleetLane({ streams: [fleetStream({ contentAppend: "lo", reasoningAppend: "r" })] })],
    });
    const second = mergeFleetSession(first, delta);
    expect(second.lanes[0].streams[0].content).toBe("Hello");
    expect(second.lanes[0].streams[0].reasoning).toBe("r");
    const reset = mergeFleetSession(second, fleetSession({ lanes: [fleetLane({ streams: [fleetStream({ content: "X", resetContent: true })] })] }));
    expect(reset.lanes[0].streams[0].content).toBe("X");
    // A different session never inherits text.
    const other = mergeFleetSession(second, fleetSession({ sessionId: "sid-2", lanes: [fleetLane({ streams: [fleetStream({ contentAppend: "z" })] })] }));
    expect(other.lanes[0].streams[0].content).toBe("");
  });
});

describe("FleetShowcasePage (SHOW1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const fn of Object.values(api)) fn.mockReset();
    api.getFleetShowcaseTargets.mockResolvedValue({ targets, limits: {} });
    api.listFleetShowcase.mockResolvedValue({ active: null, history: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts one session over a Spark and an agent lane and polls with since", async () => {
    const { container } = render(<FleetShowcasePage />);
    await flush();
    await flush();
    const picker = container.querySelector('[data-testid="fleet-showcase-picker"]')!;
    expect(picker.textContent).toContain("spark-a");
    expect(picker.textContent).toContain("mac-mini");
    expect(picker.textContent).toContain("client only");
    const boxes = [...picker.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((b) => b.checked)).toEqual([true, true, false]);
    expect(container.textContent).toContain("Sparks + agents");

    api.startFleetShowcase.mockResolvedValue({ sessionId: "sid-1", status: "running" });
    const running = fleetSession({
      status: "running",
      rev: 3,
      lanes: [
        fleetLane({ status: "running", streams: [fleetStream({ status: "streaming", content: "Hi", reasoning: "" })] }),
        fleetLane({ laneId: "node:n1:11434", kind: "node", nodeName: "mac-mini", serverCounters: false, serverTps: null, streams: [fleetStream({ content: "Yo", reasoning: "" })] }),
      ],
    });
    const done = fleetSession({
      status: "completed",
      rev: 4,
      lanes: [
        fleetLane({ streams: [fleetStream({ contentAppend: " there" })] }),
        fleetLane({ laneId: "node:n1:11434", kind: "node", nodeName: "mac-mini", serverCounters: false, serverTps: null, streams: [fleetStream({ contentAppend: "!" })] }),
      ],
    });
    api.getFleetShowcase.mockResolvedValueOnce(running).mockResolvedValueOnce(done);

    const run = [...container.querySelectorAll("button")].find((b) => b.textContent === "Run on fleet")!;
    await act(async () => {
      run.click();
    });
    await flush();
    const body = api.startFleetShowcase.mock.calls[0][0];
    expect(body.laneIds).toEqual(["spark:s1:8000", "node:n1:11434"]);
    expect(body.prompts).toHaveLength(2);
    expect(body.promptType).toBe("mixed");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(FLEET_POLL_MS);
    });
    expect(api.getFleetShowcase).toHaveBeenNthCalledWith(1, "sid-1", { since: undefined });
    expect(container.querySelectorAll(".fleet-showcase-tile")).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FLEET_POLL_MS);
    });
    expect(api.getFleetShowcase).toHaveBeenNthCalledWith(2, "sid-1", { since: 3 });
    const text = container.textContent || "";
    expect(text).toContain("Hi there");
    expect(text).toContain("Yo!");
    expect(text).toContain("client only");
    expect(text).toContain("TTFT 120 ms");
    // Finished: no further polls, history refreshed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FLEET_POLL_MS * 3);
    });
    expect(api.getFleetShowcase).toHaveBeenCalledTimes(2);
    expect(api.listFleetShowcase).toHaveBeenCalledTimes(2);
  });

  it("re-attaches to an active run and surfaces start errors", async () => {
    api.listFleetShowcase.mockResolvedValue({ active: { sessionId: "live", status: "running" }, history: [] });
    api.getFleetShowcase.mockResolvedValue(fleetSession({ sessionId: "live", status: "running" }));
    api.cancelFleetShowcase.mockResolvedValue(fleetSession({ sessionId: "live", status: "cancelled" }));
    const { container } = render(<FleetShowcasePage />);
    await flush();
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FLEET_POLL_MS);
    });
    expect(api.getFleetShowcase).toHaveBeenCalledWith("live", { since: undefined });
    const stop = [...container.querySelectorAll("button")].find((b) => b.textContent === "Stop")!;
    expect(stop).toBeTruthy();
    await act(async () => {
      stop.click();
    });
    await flush();
    expect(api.cancelFleetShowcase).toHaveBeenCalledWith("live");
    expect(container.textContent).toContain("cancelled");
  });

  it("shows the server's refusal", async () => {
    api.startFleetShowcase.mockRejectedValue(new Error("A fleet prompt showcase is already running"));
    const { container } = render(<FleetShowcasePage />);
    await flush();
    await flush();
    const run = [...container.querySelectorAll("button")].find((b) => b.textContent === "Run on fleet")!;
    await act(async () => {
      run.click();
    });
    await flush();
    expect(container.textContent).toContain("already running");
  });
});
