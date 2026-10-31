import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetStore, getMetricHistorySamples } from "./metricsStore";
import { useSnapshot } from "./useSnapshot";
import { subscribeActivity } from "./activityBus";
import { makeSpark } from "../testing/fixtures";
import { flush, render } from "../testing/render";

class MockSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: MockSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    MockSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data: unknown) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function Probe() {
  const snapshot = useSnapshot();
  return (
    <pre data-testid="probe">
      {JSON.stringify({
        connected: snapshot.connected,
        error: snapshot.snapshotError,
        last: snapshot.lastValidSnapshotAt,
        count: snapshot.sparks.length,
      })}
    </pre>
  );
}

function readProbe() {
  return JSON.parse(document.querySelector("[data-testid=probe]")!.textContent || "{}");
}

describe("useSnapshot connection lifecycle", () => {
  beforeEach(() => {
    _resetStore();
    MockSocket.instances = [];
    vi.stubGlobal("WebSocket", MockSocket);
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { protocol: "http:", host: "localhost:5555" },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stays disconnected until a valid snapshot, then recovers after disconnect and malformed data", async () => {
    render(<Probe />);
    const socket = MockSocket.instances[0];
    act(() => socket.open());
    await flush();
    expect(readProbe().connected).toBe(false);

    act(() => socket.emit({
      type: "snapshot",
      generatedAt: 50_000,
      refreshInterval: 2000,
      sparks: [makeSpark("alpha")],
    }));
    await flush();
    expect(readProbe()).toMatchObject({ connected: true, count: 1, error: null, last: 50_000 });
    expect(getMetricHistorySamples("alpha", "gpu.usage")[0]).toEqual({ at: 50_000, value: 42 });

    act(() => socket.close());
    await flush();
    expect(readProbe().connected).toBe(false);
    expect(readProbe().count).toBe(1);

    act(() => vi.advanceTimersByTime(2000));
    const next = MockSocket.instances[1];
    act(() => next.open());
    act(() => next.emit("not-json"));
    await flush();
    expect(readProbe().error).toContain("malformed");
    expect(readProbe().connected).toBe(false);

    act(() => next.emit({ type: "snapshot", generatedAt: 51_000, refreshInterval: 2000, sparks: [makeSpark("alpha")] }));
    await flush();
    expect(readProbe()).toMatchObject({ connected: true, error: null });
    expect(readProbe().last).toBeGreaterThanOrEqual(50_000);
  });

  it("hands activity pushes to the activity bus without flagging the telemetry", async () => {
    const seen: number[] = [];
    const off = subscribeActivity((e) => seen.push(e.id));
    render(<Probe />);
    const socket = MockSocket.instances[0];
    act(() => socket.open());
    act(() => socket.emit({ type: "snapshot", generatedAt: 50_000, refreshInterval: 2000, sparks: [makeSpark("alpha")] }));
    act(() =>
      socket.emit({
        type: "event",
        event: { id: 9, ts: 50_000, type: "spark.offline", severity: "warn", sparkId: "alpha", sparkName: "alpha", message: "alpha went offline" },
      }),
    );
    act(() => socket.emit({ type: "event", event: { id: "bogus" } }));
    await flush();
    off();
    expect(seen).toEqual([9]);
    expect(readProbe()).toMatchObject({ connected: true, error: null, count: 1 });
  });
});
