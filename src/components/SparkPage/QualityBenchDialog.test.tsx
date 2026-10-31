import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QualityBenchDialog, formatP, mcnemarVerdict } from "./QualityBenchDialog";
import { flush, render } from "../../testing/render";
import type { QualityCategoryScore, QualityCompareResponse, QualityRunSummary } from "../../api/types";

vi.mock("../../api/client", () => ({
  listQualityBench: vi.fn(),
  startQualityBench: vi.fn(),
  getQualityBench: vi.fn(),
  cancelQualityBench: vi.fn(),
  compareQualityBench: vi.fn(),
}));

import { compareQualityBench, listQualityBench, startQualityBench } from "../../api/client";

const list = vi.mocked(listQualityBench);
const start = vi.mocked(startQualityBench);
const compare = vi.mocked(compareQualityBench);

const cat = (key: QualityCategoryScore["key"], label: string, passed: number, scored: number): QualityCategoryScore => ({
  key,
  label,
  total: scored,
  attempted: scored,
  scored,
  passed,
  errored: 0,
  accuracy: Math.round((10000 * passed) / scored) / 100,
  maxTokens: 48,
});

const run = (benchId: string, startedAt: string, qa: number): QualityRunSummary => ({
  benchId,
  runId: `quality:${benchId}`,
  status: "completed",
  startedAt,
  completedAt: startedAt,
  modelId: "fixture-model",
  engine: "vllm",
  hwBucket: "Single DGX Spark",
  concurrency: 4,
  categories: [cat("qa", "QA", qa, 150)],
  overall: Math.round((10000 * qa) / 150) / 100,
  itemsScored: 150,
  itemsErrored: 0,
  passed: qa,
  durationMs: 61_000,
  suiteVersion: "1",
});

const mc = { paired: 150, both_pass: 100, both_fail: 20, baseline_only: 2, candidate_only: 28, p: 0.000001, within_noise: false };

const cmp = (): QualityCompareResponse => ({
  baseline: run("a", "2026-10-30T10:00:00Z", 102),
  candidate: run("b", "2026-10-31T10:00:00Z", 128),
  warnings: [],
  overall: { baseline: 68, candidate: 85.33, delta: 17.33, mcnemar: mc },
  categories: [{ key: "qa", label: "QA", baseline: 68, candidate: 85.33, delta: 17.33, mcnemar: mc }],
  regressed: ["qa-007", "qa-019"],
  improved: [],
  noiseP: 0.05,
});

const defaults = {
  categories: [],
  defaultCategories: [],
  concurrencyOptions: [1, 2, 4, 8],
  defaultConcurrency: 4,
  seed: 4242,
  suiteVersion: "1",
  noiseP: 0.05,
  historyLimit: 30,
};

describe("QualityBenchDialog", () => {
  beforeEach(() => {
    list.mockReset();
    start.mockReset();
    compare.mockReset();
  });

  it("formats p and verdicts", () => {
    expect(formatP(0.5)).toBe("0.50");
    expect(formatP(0.0041)).toBe("0.004");
    expect(formatP(0.0000001)).toBe("<0.001");
    expect(mcnemarVerdict(mc)).toBe("better");
    expect(mcnemarVerdict({ ...mc, baseline_only: 28, candidate_only: 2 })).toBe("worse");
    expect(mcnemarVerdict({ ...mc, within_noise: true })).toBe("noise");
    expect(mcnemarVerdict({ ...mc, paired: 0 })).toBeNull();
  });

  it("shows the configurator with 755 default requests and starts a run", async () => {
    list.mockResolvedValue({ active: null, runs: [], defaults });
    start.mockResolvedValue({
      benchId: "new",
      sparkId: "s1",
      status: "running",
      startedAt: 1,
      completedAt: null,
      config: { port: 8000, modelId: null, categories: ["qa"], concurrency: 8, seed: 4242, suiteVersion: "1", requests: 150 },
      progress: { done: 0, total: 150, errored: 0, currentCategory: null, message: "Starting…" },
      summary: { categories: [], overall: null, itemsTotal: 150, itemsScored: 0, itemsErrored: 0, passed: 0 },
      error: null,
      durationMs: 0,
    });
    render(<QualityBenchDialog open onClose={() => {}} sparkId="s1" llmPort={8000} modelId={null} />);
    await flush();
    const count = document.querySelector('[data-testid="quality-request-count"]');
    expect(count?.textContent).toBe("755 requests");
    const button = (label: string) =>
      [...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith(label)) as HTMLButtonElement;
    // Opt-in categories add to the count; defaults can be turned off.
    act(() => button("Instruction following").click());
    expect(count?.textContent).toBe("795 requests");
    for (const label of ["Instruction following", "Reasoning", "Arithmetic chain", "State tracking", "GSM8K", "MMLU"]) {
      act(() => button(label).click());
    }
    expect(count?.textContent).toBe("150 requests");
    act(() => button("8").click());
    await act(async () => {
      button("Run benchmark").click();
    });
    expect(start).toHaveBeenCalledWith("s1", { port: 8000, categories: ["qa"], concurrency: 8, modelId: undefined });
  });

  it("shows the latest run against the previous one with McNemar badges", async () => {
    list.mockResolvedValue({
      active: null,
      runs: [run("b", "2026-10-31T10:00:00Z", 128), run("a", "2026-10-30T10:00:00Z", 102)],
      defaults,
    });
    compare.mockResolvedValue(cmp());
    render(<QualityBenchDialog open onClose={() => {}} sparkId="s1" llmPort={8000} modelId="fixture-model" />);
    await flush();
    await flush();
    expect(compare).toHaveBeenCalledWith("s1", "a", "b");
    const text = document.body.textContent || "";
    expect(text).toContain("85.3%");
    expect(text).toContain("significant ↑");
    expect(text).toContain("+17.3");
    expect(text).toContain("2 newly failed");
    const select = document.getElementById("quality-baseline-select") as HTMLSelectElement;
    expect(select.value).toBe("a");
  });
});
