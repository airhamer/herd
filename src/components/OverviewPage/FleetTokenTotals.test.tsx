import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetTokenTotals } from "./FleetTokenTotals";
import { cleanupRenders, flush, render } from "../../testing/render";
import type { LlmTokenHistory, LlmTokenRange, LlmTokenTotals } from "../../api/types";

vi.mock("../../api/client", () => ({
  fetchLlmTokenTotals: vi.fn(),
  fetchLlmTokenHistory: vi.fn(),
}));

import { fetchLlmTokenHistory, fetchLlmTokenTotals } from "../../api/client";

const fetchTotals = vi.mocked(fetchLlmTokenTotals);
const fetchHistory = vi.mocked(fetchLlmTokenHistory);

afterEach(() => {
  cleanupRenders();
  vi.clearAllMocks();
});

function totals(range: LlmTokenRange = "24h", overrides: Partial<LlmTokenTotals> = {}): LlmTokenTotals {
  return {
    range,
    resolution: range === "24h" ? "hour" : range === "all" ? "all" : "day",
    fromMs: Date.UTC(2026, 9, 30, 12),
    toMs: Date.UTC(2026, 9, 31, 12),
    trackedSinceMs: Date.UTC(2026, 9, 3, 12),
    generated: 2_210_000,
    cached: 1_900_000,
    prefill: 1_300_000,
    total: 5_410_000,
    endpointCount: 3,
    models: [
      { model: "qwen3-30b", generated: 1_800_000, cached: 1_500_000, prefill: 900_000, total: 4_200_000, endpoints: ["spark-a:8000", "node-b:8000"], sources: ["counter"] },
      { model: "llama3.2", generated: 410_000, cached: 400_000, prefill: 400_000, total: 1_210_000, endpoints: ["node-b:11434"], sources: ["proxy"] },
    ],
    endpoints: [
      { seriesId: "spark-a:8000", nodeId: "spark-a", nodeName: "Spark A", port: 8000, backend: "vllm", models: ["qwen3-30b"], sources: ["counter"], lastSeenMs: Date.UTC(2026, 9, 31, 12), generated: 1_200_000, cached: 1_000_000, prefill: 600_000, total: 2_800_000 },
      { seriesId: "node-b:8000", nodeId: "node-b", nodeName: "box-b", port: 8000, backend: "ds4", models: ["qwen3-30b"], sources: ["counter"], lastSeenMs: Date.UTC(2026, 9, 31, 12), generated: 600_000, cached: 500_000, prefill: 300_000, total: 1_400_000 },
      { seriesId: "node-b:11434", nodeId: "node-b", nodeName: "box-b", port: 11434, backend: "ollama", models: ["llama3.2"], sources: ["proxy"], lastSeenMs: Date.UTC(2026, 9, 31, 12), generated: 410_000, cached: 400_000, prefill: 400_000, total: 1_210_000 },
    ],
    ...overrides,
  };
}

function history(range: LlmTokenRange): LlmTokenHistory {
  const count = range === "24h" ? 24 : range === "7d" ? 7 : 30;
  const stepMs = range === "24h" ? 3_600_000 : 86_400_000;
  return {
    range,
    resolution: range === "24h" ? "hour" : "day",
    stepMs,
    trackedSinceMs: 0,
    points: Array.from({ length: count }, (_, i) => ({ startMs: i * stepMs, generated: i * 1000, cached: 0, prefill: 0 })),
  };
}

async function show() {
  fetchTotals.mockImplementation((range) => Promise.resolve(totals(range)));
  fetchHistory.mockImplementation((range) => Promise.resolve(history(range ?? "24h")));
  const view = render(<FleetTokenTotals />);
  await flush();
  return view.container;
}

const text = (root: Element, id: string) => root.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

function click(el: Element | null | undefined) {
  act(() => { (el as HTMLElement).click(); });
}

describe("FleetTokenTotals", () => {
  it("shows the generated headline, endpoint count and the generated/cached/prefill split", async () => {
    const c = await show();
    expect(fetchTotals).toHaveBeenCalledWith("24h");
    expect(text(c, "fleet-tokens-generated")).toBe("2.21M");
    expect(text(c, "fleet-tokens-subtitle")).toBe("3 endpoints");
    const segs = c.querySelectorAll("[data-testid=fleet-tokens-split] span");
    expect(segs).toHaveLength(3);
    expect((segs[0] as HTMLElement).style.width).toMatch(/^40\.8/);
    expect(c.textContent).toContain("Cached1.90M35%");
  });

  it("lists models with cached / prefill / gen and a total row; proxy models are marked", async () => {
    const c = await show();
    expect(text(c, "fleet-tokens-model-qwen3-30b")).toBe("qwen3-30b1.50M900K1.80M");
    expect(text(c, "fleet-tokens-model-llama3.2")).toBe("llama3.2(proxy)400K400K410K");
    expect(text(c, "fleet-tokens-total-row")).toBe("Total1.90M1.30M2.21M");
  });

  it("range chips refetch the range; All shows since when counting started", async () => {
    const c = await show();
    const chip = (label: string) => [...c.querySelectorAll("[aria-label='Token range'] button")].find((b) => b.textContent === label);
    expect(chip("24h")?.getAttribute("aria-pressed")).toBe("true");
    click(chip("All"));
    await flush();
    expect(fetchTotals).toHaveBeenLastCalledWith("all");
    expect(chip("All")?.getAttribute("aria-pressed")).toBe("true");
    expect(text(c, "fleet-tokens-subtitle")).toBe("3 endpoints · since Oct 3, 2026");
  });

  it("details view shows per-endpoint rows with source and the bucket history", async () => {
    const c = await show();
    expect(c.querySelector("[data-testid=fleet-tokens-details]")).toBeNull();
    click([...c.querySelectorAll("button")].find((b) => b.textContent === "Details"));
    await flush();
    expect(fetchHistory).toHaveBeenCalledWith("24h");
    expect(text(c, "fleet-tokens-endpoint-node-b:11434")).toContain("box-b:11434");
    expect(text(c, "fleet-tokens-endpoint-node-b:11434")).toContain("proxy");
    expect(text(c, "fleet-tokens-endpoint-spark-a:8000")).toContain("engine counters");
    expect(c.querySelectorAll("[data-testid=fleet-tokens-history] span")).toHaveLength(24);
  });

  it("explains an empty range and shows fetch errors", async () => {
    fetchTotals.mockResolvedValue(totals("24h", { generated: 0, cached: 0, prefill: 0, total: 0, endpointCount: 0, models: [], endpoints: [] }));
    const view = render(<FleetTokenTotals />);
    await flush();
    expect(view.container.textContent).toContain("No tokens counted in this range yet");
    expect(view.container.querySelector("[data-testid=fleet-tokens-split]")).toBeNull();
    cleanupRenders();
    fetchTotals.mockRejectedValue(new Error("HTTP 500"));
    const failed = render(<FleetTokenTotals />);
    await flush();
    expect(failed.container.textContent).toContain("Token totals unavailable: HTTP 500");
  });
});
