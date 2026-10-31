// Tests for the History panel and its chart helpers, written from
// docs/specs/unit-history.md §10 (LIC2 clean-room rewrite).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import type { HistoryStat, MetricsHistoryData, MetricsHistoryResponse } from "../../api/types";
import { nearestIndex, segmentRuns, yDomain, type HistoryChartSeries } from "./HistoryChart";
import { buildTimeline, formatMb, HISTORY_POLL_MS, HISTORY_RANGE_KEY, HistoryPanel, readHistoryRange } from "./HistoryPanel";

vi.mock("../../api/client", () => ({ getUnitHistory: vi.fn() }));
import { getUnitHistory } from "../../api/client";
const api = vi.mocked(getUnitHistory);

const MIN = 60_000;
const START = Date.UTC(2026, 3, 14, 9, 0, 0);
const s = (avg: number, max = avg, min?: number): HistoryStat => (min == null ? { avg, max } : { avg, max, min });

/** Ten one-minute buckets; minutes 4–6 are missing (the unit was away). */
function sample(extra: Partial<MetricsHistoryData> = {}): MetricsHistoryData {
  const minutes = [0, 1, 2, 3, 7, 8, 9];
  return {
    enabled: true,
    range: "1h",
    stepMs: MIN,
    from: START,
    to: START + 10 * MIN,
    points: minutes.map((m) => ({
      t: START + m * MIN,
      gpuUtil: s(20 + m, 30 + m),
      gpuTemp: s(40, 45),
      gpuPower: s(5),
      memFreeMB: s(20_000, 21_000, 12_000),
      cpuUtil: s(3),
      netRx: s(3 * 1024 * 1024),
      netTx: s(512),
    })),
    llm: [{ port: 30000, points: [8, 9].map((m) => ({ t: START + m * MIN, genTps: s(12.5, 14), prefillTps: s(2500, 2600) })) }],
    ...extra,
  };
}

async function show(reply: MetricsHistoryResponse | Error = sample(), kind = "spark", unit: "celsius" | "fahrenheit" = "celsius") {
  if (reply instanceof Error) api.mockRejectedValue(reply);
  else api.mockResolvedValue(reply);
  const view = render(<HistoryPanel sparkId="node-a" kind={kind} temperatureUnit={unit} />);
  await flush();
  return view.container;
}

const q = (root: ParentNode, sel: string) => root.querySelector<HTMLElement>(sel);
const chartOf = (root: ParentNode, id: string) => {
  const el = q(root, `[data-chart="${id}"]`);
  expect(el, `chart ${id}`).not.toBeNull();
  return el!;
};
const plotOf = (root: ParentNode, id: string) => q(chartOf(root, id), '[role="group"]')!;
const press = (el: HTMLElement, key: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

beforeEach(() => {
  api.mockReset();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chart helpers", () => {
  it("splits runs at nulls and at gaps wider than one and a half steps", () => {
    const t = [0, 10, 20, 50, 60, 70, 80];
    const v = [s(1), s(1), s(1), s(1), null, s(1), s(1)];
    expect(segmentRuns(t, v, 10)).toEqual([[0, 1, 2], [3], [5, 6]]);
    expect(segmentRuns([0, 15], [s(1), s(1)], 10)).toEqual([[0, 1]]);
    expect(segmentRuns([], [], 10)).toEqual([]);
  });

  it("picks the closest bucket, the earlier one on a tie, and -1 for an empty timeline", () => {
    const t = [100, 200, 300];
    expect(nearestIndex(t, 0)).toBe(0);
    expect(nearestIndex(t, 249)).toBe(1);
    expect(nearestIndex(t, 250)).toBe(1);
    expect(nearestIndex(t, 251)).toBe(2);
    expect(nearestIndex(t, 999)).toBe(2);
    expect(nearestIndex([], 5)).toBe(-1);
  });

  it("sizes the y range to the data, the band edge and the thresholds", () => {
    const one = (values: Array<HistoryStat | null>, band?: "max" | "min"): HistoryChartSeries[] => [
      { key: "k", label: "k", color: "red", values, band },
    ];
    expect(yDomain(one([null, null]))).toBeNull();
    // Fixed bounds stay unless the data is outside them.
    expect(yDomain(one([s(40, 70)], "max"), 0, 100)).toEqual({ lo: 0, hi: 100 });
    expect(yDomain(one([s(40, 130)], "max"), 0, 100)).toEqual({ lo: 0, hi: 130 });
    // The min band reaches below the average; thresholds get 25% headroom above the top one.
    const d = yDomain(one([s(6000, 6000, 1500)], "min"), 0, undefined, [
      { value: 8192, label: "low", color: "x" },
      { value: 4096, label: "critical", color: "x" },
    ], 1024)!;
    expect(d.lo).toBe(0);
    expect(d.hi).toBeGreaterThanOrEqual(8192 * 1.25);
    expect((d.hi / 1024) % 1).toBe(0);
    // Auto bounds snap to round numbers.
    const auto = yDomain(one([s(41), s(57)]))!;
    expect(auto.lo).toBeLessThanOrEqual(41);
    expect(auto.hi).toBeGreaterThanOrEqual(57);
    expect([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8].some((m) => [1, 10, 100].some((p) => auto.hi === m * p))).toBe(true);
  });

  it("formats memory and builds the shared timeline from unit and LLM buckets", () => {
    expect(formatMb(512.4)).toBe("512 MB");
    expect(formatMb(1536)).toBe("1.5 GB");
    expect(formatMb(3 * 1024 * 1024)).toBe("3.0 TB");
    const d = sample({ points: [{ t: 30 }, { t: 10 }], llm: [{ port: 1, points: [{ t: 20 }, { t: 10 }] }] });
    expect(buildTimeline(d)).toEqual([10, 20, 30]);
  });
});

describe("HistoryPanel", () => {
  it("starts on the hour view, and a chip switches, refetches and is remembered", async () => {
    const root = await show();
    expect(api).toHaveBeenLastCalledWith("node-a", "1h");
    expect(q(root, ".panel-title")!.textContent).toContain("History · last hour");
    const chips = [...root.querySelectorAll<HTMLButtonElement>('[aria-label="History range"] button')];
    expect(chips.map((c) => c.textContent)).toEqual(["1h", "6h", "24h", "7d", "30d"]);
    expect(chips[0].getAttribute("aria-pressed")).toBe("true");

    act(() => chips[3].click());
    await flush();
    expect(api).toHaveBeenLastCalledWith("node-a", "7d");
    expect(q(root, ".panel-title")!.textContent).toContain("last 7 days");
    expect(chips[3].getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem(HISTORY_RANGE_KEY)).toBe("7d");
    expect(readHistoryRange()).toBe("7d");
  });

  it("reads a stored range and ignores junk", async () => {
    localStorage.setItem(HISTORY_RANGE_KEY, "24h");
    await show();
    expect(api).toHaveBeenLastCalledWith("node-a", "24h");
    localStorage.setItem(HISTORY_RANGE_KEY, "2y");
    expect(readHistoryRange()).toBe("1h");
  });

  it("explains the empty states", async () => {
    expect((await show({ enabled: false })).textContent).toContain(
      "Metrics history is off on the server. Turn it on in Settings → Metrics history.",
    );
    expect((await show(sample({ points: [], llm: [] }))).textContent).toContain("No history in this range yet.");
    expect((await show(new Error("boom"))).textContent).toContain("Could not load history: boom");
  });

  it("draws the expected charts with a caption, and leaves a gap where the unit was away", async () => {
    const root = await show();
    expect(root.textContent).toContain("Average per 1 min · shaded: peak (low point for free memory)");
    const ids = [...root.querySelectorAll("[data-chart]")].map((c) => c.getAttribute("data-chart"));
    expect(ids).toEqual([
      "gpuUtil", "gpuTemp", "gpuPower", "memFree", "cpuUtil", "cpuTemp", "network", "llm-30000-gen", "llm-30000-prefill",
    ]);
    const gpu = chartOf(root, "gpuUtil");
    expect(gpu.querySelectorAll('polyline[data-series="gpuUtil"]')).toHaveLength(2);
    expect(gpu.querySelectorAll('polygon[data-band="gpuUtil"]')).toHaveLength(2);
    expect(gpu.querySelector('[data-readout="gpuUtil"]')!.textContent).toBe("29%");
    expect(chartOf(root, "gpuPower").querySelector('[data-readout="gpuPower"]')!.textContent).toBe("5.0 W");
    expect(chartOf(root, "cpuTemp").textContent).toContain("No data in this range");
    expect(chartOf(root, "llm-30000-prefill").querySelector("[data-readout]")!.textContent).toBe("2.5k");
    expect(chartOf(root, "llm-30000-gen").querySelector("[data-readout]")!.textContent).toBe("12.5");
    const net = chartOf(root, "network");
    expect(net.querySelector('[data-readout="netRx"]')!.textContent).toBe("↓ rx3.0 MB/s");
    expect(net.querySelector('[data-readout="netTx"]')!.textContent).toBe("↑ tx512 B/s");
    expect(net.querySelector("[data-band]")).toBeNull();
    for (const axis of ["ymax", "ymin", "xstart", "xend"]) expect(gpu.querySelector(`[data-axis="${axis}"]`)).not.toBeNull();
    expect(gpu.querySelector('[data-axis="ymax"]')!.textContent).toBe("100%");
  });

  it("draws a lone bucket as a short line", async () => {
    const root = await show(sample({ points: [{ t: START + 5 * MIN, gpuUtil: s(50) }], llm: [] }));
    expect(chartOf(root, "gpuUtil").querySelector('line[data-series="gpuUtil"]')).not.toBeNull();
  });

  it("marks low and critical free memory, unified versus discrete", async () => {
    const unified = chartOf(await show(), "memFree");
    expect(unified.textContent).toContain("Memory free (unified)");
    expect([...unified.querySelectorAll("[data-threshold]")].map((l) => l.getAttribute("data-threshold"))).toEqual([
      "low 8.0 GB",
      "critical 4.0 GB",
    ]);
    expect(unified.querySelector('polygon[data-band="memFreeMB"]')).not.toBeNull();

    const pts = sample().points.map((p) => ({ ...p, ramUsedMB: s(4096) }));
    const host = await show(sample({ points: pts }), "host");
    const vram = chartOf(host, "memFree");
    expect(vram.textContent).toContain("VRAM free");
    expect(vram.textContent).toContain("low 2.0 GB");
    expect(vram.textContent).toContain("critical 1.0 GB");
    expect(chartOf(host, "ramUsed").textContent).toContain("RAM used");
  });

  it("adds a KV cache chart only for endpoints that report it, as a percentage", async () => {
    const llm = [
      { port: 8001, points: [{ t: START, genTps: s(10), kvUsage: s(0.42, 0.6) }] },
      { port: 8002, points: [{ t: START, genTps: s(10) }] },
    ];
    const root = await show(sample({ llm }));
    expect(chartOf(root, "llm-8001-kv").textContent).toContain("KV cache · :8001");
    expect(chartOf(root, "llm-8001-kv").querySelector("[data-readout]")!.textContent).toBe("42%");
    expect(q(root, '[data-chart="llm-8002-kv"]')).toBeNull();
  });

  it("shows temperatures in Fahrenheit when the setting says so", async () => {
    const root = await show(sample(), "spark", "fahrenheit");
    expect(chartOf(root, "gpuTemp").querySelector("[data-readout]")!.textContent).toBe("104°F");
  });

  it("keyboard moves one crosshair across all charts; only the focused chart has a tooltip", async () => {
    const root = await show();
    const plot = plotOf(root, "gpuUtil");
    act(() => plot.focus());
    const withData = [...root.querySelectorAll("[data-chart]")].filter((c) => c.querySelector("[data-series]"));
    for (const c of withData) expect(c.querySelector("[data-crosshair]"), c.getAttribute("data-chart")!).not.toBeNull();

    const tip = () => root.querySelectorAll("[data-tooltip]");
    expect(tip()).toHaveLength(1);
    expect(tip()[0].getAttribute("role")).toBe("status");
    expect(tip()[0].textContent).toContain("29%");
    expect(tip()[0].textContent).toContain("max 39%");

    press(plot, "ArrowLeft");
    expect(q(chartOf(root, "gpuUtil"), "[data-readout]")!.textContent).toBe("28%");
    press(plot, "Home");
    expect(q(chartOf(root, "gpuUtil"), "[data-readout]")!.textContent).toBe("20%");
    press(plot, "End");
    expect(q(chartOf(root, "gpuUtil"), "[data-readout]")!.textContent).toBe("29%");
    press(plot, "Escape");
    expect(root.querySelectorAll("[data-crosshair]")).toHaveLength(0);
    expect(tip()).toHaveLength(0);
  });

  it("follows the pointer to the nearest bucket middle and clears on leave", async () => {
    const root = await show();
    const plot = plotOf(root, "cpuUtil");
    vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 1000, height: 90, right: 1000, bottom: 90, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    // 250 px of 1000 is minute 2.5, the middle of the bucket that starts at minute 2.
    act(() => {
      plot.dispatchEvent(new MouseEvent("pointermove", { clientX: 250, bubbles: true }));
    });
    expect(q(chartOf(root, "gpuUtil"), "[data-readout]")!.textContent).toBe("22%");
    expect(root.querySelectorAll("[data-tooltip]")).toHaveLength(1);
    expect(q(chartOf(root, "cpuUtil"), "[data-tooltip]")).not.toBeNull();
    act(() => {
      plot.dispatchEvent(new MouseEvent("pointerout", { bubbles: true }));
      plot.dispatchEvent(new MouseEvent("pointerleave", { bubbles: false }));
    });
    expect(root.querySelectorAll("[data-crosshair]")).toHaveLength(0);
  });

  it("refreshes every 30 s, holds while the tab is hidden and refetches when it returns", async () => {
    vi.useFakeTimers();
    let state: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
    await show();
    expect(api).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(HISTORY_POLL_MS));
    expect(api).toHaveBeenCalledTimes(2);

    state = "hidden";
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => void vi.advanceTimersByTime(HISTORY_POLL_MS * 4));
    expect(api).toHaveBeenCalledTimes(2);

    state = "visible";
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(api).toHaveBeenCalledTimes(3);
  });

  it("keeps the charts after a failed refresh with a stale notice that clears on success", async () => {
    vi.useFakeTimers();
    const root = await show();
    api.mockRejectedValueOnce(new Error("timeout"));
    await act(async () => void vi.advanceTimersByTime(HISTORY_POLL_MS));
    await flush();
    const notice = q(root, 'p[role="status"]');
    expect(notice?.textContent).toMatch(/^Stale: could not refresh \(timeout\)\. Showing data from .+\.$/);
    expect(q(root, '[data-chart="gpuUtil"]')).not.toBeNull();

    await act(async () => void vi.advanceTimersByTime(HISTORY_POLL_MS));
    await flush();
    expect(root.textContent).not.toContain("Stale:");
  });

  it("waits until the panel scrolls into view", async () => {
    const watchers: Array<(e: Array<{ isIntersecting: boolean }>) => void> = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (e: Array<{ isIntersecting: boolean }>) => void) {
          watchers.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
    await show();
    expect(api).not.toHaveBeenCalled();
    act(() => watchers.forEach((cb) => cb([{ isIntersecting: true }])));
    await flush();
    expect(api).toHaveBeenCalledTimes(1);
    act(() => watchers.forEach((cb) => cb([{ isIntersecting: false }])));
    expect(api).toHaveBeenCalledTimes(1);
  });
});
