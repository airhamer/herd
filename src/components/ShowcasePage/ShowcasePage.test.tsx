import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import type { ShowcaseSessionState, ShowcaseStreamState } from "../../api/types";

const api = vi.hoisted(() => ({
  cancelShowcase: vi.fn(),
  clearShowcaseHistory: vi.fn(),
  fetchSparkMetrics: vi.fn(),
  fetchSparks: vi.fn(),
  getShowcase: vi.fn(),
  listShowcase: vi.fn(),
  startShowcase: vi.fn(),
}));
vi.mock("../../api/client", () => api);

import { ShowcasePage } from "./ShowcasePage";

const stream = (i: number, over: Partial<ShowcaseStreamState> = {}): ShowcaseStreamState => ({
  streamId: String(i),
  label: `Prompt ${i}`,
  prompt: `Prompt ${i}`,
  status: "completed",
  content: "hello",
  reasoning: "",
  contentLength: 5,
  tokenCount: 200,
  ttftMs: 100,
  decodeTps: 50,
  liveTokPerSec: 50,
  peakTokPerSec: 55,
  tokenSource: "usage",
  estimated: false,
  model: "m",
  error: null,
  ...over,
});

const record = (over: Partial<ShowcaseSessionState> = {}): ShowcaseSessionState => ({
  sessionId: "run-1",
  sparkId: "s1",
  status: "completed",
  rev: 9,
  port: 8888,
  modelId: "Qwen3-30B",
  maxTokens: 512,
  streams: [stream(0), stream(1)],
  fromHistory: true,
  ...over,
});

async function openRun(rec: ShowcaseSessionState, summary: Record<string, unknown> = {}) {
  api.listShowcase.mockResolvedValue({
    active: null,
    history: [
      { sessionId: rec.sessionId, sparkId: "s1", status: "completed", port: 8888, totalTokens: 400, meanDecodeTps: 50, peakStreamTps: 55, streamCount: 2, startedAt: 1, ...summary },
    ],
  });
  api.getShowcase.mockResolvedValue(rec);
  const { container } = render(<ShowcasePage sparkId="s1" />);
  await flush();
  await flush();
  const histBtn = [...container.querySelectorAll("button")].find((b) => /^History/.test(b.textContent || ""))!;
  await act(async () => {
    histBtn.click();
  });
  await flush();
  const historyText = container.querySelector(".showcase-history__list")!.textContent || "";
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".showcase-history__main")!.click();
  });
  await flush();
  return { container, historyText };
}

describe("ShowcasePage aggregate (SHOW2)", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.fetchSparks.mockResolvedValue({ sparks: [{ id: "s1", name: "spark-1", llmPort: 8888, llmMonitoring: true }] });
    api.fetchSparkMetrics.mockResolvedValue({ metrics: { llm: [] } });
  });

  it("shows the server's concurrent-window aggregate and peak, not a sum of stream rates", async () => {
    const { container, historyText } = await openRun(
      record({ aggregate: { tps: 72.4, peakTps: 88.1, estimated: false, decodeTokens: 398, windowMs: 5500, streams: 2 } }),
      { aggregateTps: 72.4, aggregatePeakTps: 88.1, aggregateEstimated: false }
    );
    expect(historyText).toContain("72 tok/s agg (peak 88)");
    expect(historyText).not.toContain("≈");
    const hero = container.querySelector('[data-testid="showcase-aggregate"]')!;
    expect(hero.textContent).toContain("72");
    expect(hero.textContent).not.toContain("100"); // Σ of stream rates would be 100
    expect(hero.getAttribute("title")).toMatch(/Concurrent window/);
    expect(container.querySelector('[data-testid="showcase-aggregate-peak"]')!.textContent).toBe("peak 88");
    expect(container.querySelector('[data-testid="showcase-aggregate-estimated"]')).toBeNull();
    expect(container.querySelectorAll(".showcase-term__badge")).toHaveLength(0);
  });

  it("flags character-estimated counts on the aggregate, history row and each terminal", async () => {
    const est = { tokenSource: "estimate" as const, estimated: true };
    const { container, historyText } = await openRun(
      record({
        streams: [stream(0, est), stream(1, est)],
        aggregate: { tps: 64, peakTps: 70, peakEstimated: true, estimated: true, decodeTokens: 398, windowMs: 6200, streams: 2 },
      }),
      { aggregateTps: 64, aggregatePeakTps: 70, aggregatePeakEstimated: true, aggregateEstimated: true }
    );
    expect(historyText).toContain("≈ 64 tok/s agg (peak ≈70)");
    expect(container.querySelector('[data-testid="showcase-aggregate-peak"]')!.textContent).toBe("peak ≈70");
    const flag = container.querySelector('[data-testid="showcase-aggregate-estimated"]')!;
    expect(flag.textContent).toBe("≈ est.");
    expect(flag.getAttribute("title")).toMatch(/~4 chars\/token/);
    const badges = [...container.querySelectorAll(".showcase-term__badge")];
    expect(badges).toHaveLength(2);
    expect(badges.every((b) => b.textContent === "est.")).toBe(true);
  });

  it("falls back to the old sum for runs archived before the aggregate existed", async () => {
    const { container, historyText } = await openRun(record({ aggregate: undefined }));
    expect(historyText).toContain("avg 50 tok/s");
    const hero = container.querySelector('[data-testid="showcase-aggregate"]')!;
    expect(hero.textContent).toContain("100");
    expect(hero.getAttribute("title")).toMatch(/before the concurrent-window aggregate/);
  });
});
