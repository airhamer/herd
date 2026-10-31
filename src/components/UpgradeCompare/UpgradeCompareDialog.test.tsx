import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpgradeCompareDialog, defaultPicks, runLabel } from "./UpgradeCompareDialog";
import { NodeBenchPanel } from "../SparkPage/NodeBenchPanel";
import { flush, render } from "../../testing/render";
import type { BenchUpgradeResponse, BenchUpgradeRun } from "../../../shared/types";

vi.mock("../../api/client", () => ({
  listUpgradeRuns: vi.fn(),
  compareUpgrade: vi.fn(),
}));

import { compareUpgrade, listUpgradeRuns } from "../../api/client";

const listRuns = vi.mocked(listUpgradeRuns);
const compare = vi.mocked(compareUpgrade);

const run = (run_id: string, over: Partial<BenchUpgradeRun> = {}): BenchUpgradeRun => ({
  run_id,
  bench: "DecodeBench",
  origin: "herd",
  suite: "herd.decode",
  suite_version: "1",
  status: "completed",
  started_at: "2026-10-01T12:00:00.000Z",
  completed_at: "2026-10-01T12:05:00.000Z",
  node_id: "spark-a",
  node_name: "Spark A",
  hw_bucket: "Single DGX Spark",
  model_id: "qwen3-30b",
  engine: "vllm",
  engine_version: null,
  quant: null,
  cells: 2,
  concurrencies: [1, 4],
  has_energy: false,
  has_memory: false,
  ...over,
});

const RUNS = [
  run("decode:new", { started_at: "2026-10-03T12:00:00.000Z", engine_version: "0.11.0" }),
  run("quality:q2", { bench: "QualityBench", suite: "herd.quality", started_at: "2026-10-03T11:00:00.000Z", concurrencies: [4] }),
  run("decode:other-hw", { started_at: "2026-10-02T12:00:00.000Z", hw_bucket: "2× DGX Spark" }),
  run("decode:old", { started_at: "2026-10-01T12:00:00.000Z" }),
  run("quality:q1", { bench: "QualityBench", suite: "herd.quality", started_at: "2026-10-01T11:00:00.000Z", concurrencies: [4] }),
];

const side = (run_ids: string[]) => ({
  run_ids,
  benches: ["DecodeBench"],
  node_id: "spark-a",
  node_name: "Spark A",
  hw_bucket: "Single DGX Spark",
  suite: "herd.decode",
  suite_version: "1",
  started_at: "2026-10-01T12:00:00.000Z",
  lane: { model_id: "qwen3-30b", engine: "vllm", engine_version: null, quant: null, recipe_flags: null, spec_decode: null },
});

const WIN: BenchUpgradeResponse = {
  comparable: true,
  baseline: side(["decode:old", "quality:q1"]),
  candidate: side(["decode:new", "quality:q2"]),
  verdict: {
    code: "worth_it",
    worth_it: true,
    throughput: "gain",
    quality: "ok",
    reasons: ["throughput c4 +22.22% is outside the ±15% noise band", "no quality category regresses significantly"],
  },
  throughput: [
    { cell: "c1", bench: "DecodeBench", concurrency: 1, metric: "agg_window_tps", unit: "tok/s", definition: "herd.decode.agg_window.v1", baseline: 50, candidate: 53, delta_pct: 6, noise_pct: 15, noise_source: "default", measured_noise_pct: null, headline: true, status: "noise", baseline_id: "decode:old:c1", candidate_id: "decode:new:c1" },
    { cell: "c4", bench: "DecodeBench", concurrency: 4, metric: "agg_window_tps", unit: "tok/s", definition: "herd.decode.agg_window.v1", baseline: 180, candidate: 220, delta_pct: 22.22, noise_pct: 10.53, noise_source: "repeats", measured_noise_pct: 10.53, headline: true, status: "gain", baseline_id: "decode:old:c4", candidate_id: "decode:new:c4" },
  ],
  quality: [
    { cell: "gsm8k", category: "gsm8k", baseline_pct: 75, candidate_pct: 77.5, delta_pp: 2.5, mcnemar: { paired: 40, both_pass: 30, both_fail: 9, baseline_only: 0, candidate_only: 1, p: 1, within_noise: true }, status: "noise" },
  ],
  unpaired: { baseline: [], candidate: ["DecodeBench:c8"] },
  cost: {
    energy: {
      definition: "herd.energy.node_tracker_run.v1",
      baseline: { wh: 10, window_s: 300, coverage: 1, output_tokens: 2000, wh_per_1k_tokens: 5, source: "fleet-energy-tracker", run_id: "decode:old", from: "recorded" },
      candidate: { wh: 8, window_s: 300, coverage: 1, output_tokens: 2000, wh_per_1k_tokens: 4, source: "fleet-energy-tracker", run_id: "decode:new", from: "tracker_now" },
      delta_pct: -20,
    },
    memory: {
      baseline: { total_mb: 122880, available_start_mb: 40960, available_end_mb: 38912, headroom_mb: 38912, run_id: "decode:old" },
      candidate: { total_mb: 122880, available_start_mb: 30720, available_end_mb: 31744, headroom_mb: 30720, run_id: "decode:new" },
      delta_mb: -8192,
    },
  },
  reference: {
    cell: "c4",
    metric: "agg_window_tps",
    unit: "tok/s",
    candidate: 220,
    reference: { id: "reference:registry:aeon", origin: "reference", url: "https://example.org/aeon", title: "AEON Spark perf", source: "aeon", value: 188.4, unit: "tok/s", n: null, definition: "aeon.wave_peak_concurrent_window.v1", score: 16, differences: ["lane.engine differs (vllm vs sglang)"] },
  },
  rules: { default_noise_pct: 15, quality_alpha: 0.05, worth_it: "…" },
};

describe("UpgradeCompareDialog", () => {
  beforeEach(() => {
    listRuns.mockReset();
    compare.mockReset();
  });

  it("defaults to the newest throughput run vs the previous like-for-like one, quality likewise", () => {
    expect(defaultPicks(RUNS)).toEqual({ baseline: "decode:old", candidate: "decode:new", baselineQuality: "quality:q1", candidateQuality: "quality:q2" });
    expect(defaultPicks([RUNS[0]])).toEqual({ baseline: "", candidate: "decode:new", baselineQuality: "", candidateQuality: "" });
    expect(runLabel(RUNS[0])).toBe("2026-10-03 12:00 · herd.decode · qwen3-30b · vllm · 0.11.0 · c1/4");
  });

  it("treats AEON Bench Pod text runs as quality runs and pairs them by suite", () => {
    const pod = (id: string, day: string, over: Partial<BenchUpgradeRun> = {}) =>
      run(id, { bench: "AEONPodSuite", origin: "aeon-pod", suite: "aeon-suite-v4", suite_version: "7cfb", started_at: `2026-10-${day}T12:00:00.000Z`, ...over });
    const runs = [pod("aeon-pod:b", "05"), pod("aeon-pod:x", "04", { suite: "aeon-agentic-v2.5", bench: "AEONPodAgentic" }), pod("aeon-pod:a", "02"), run("decode:new"), run("decode:old")];
    expect(defaultPicks(runs)).toEqual({ baseline: "decode:old", candidate: "decode:new", baselineQuality: "aeon-pod:a", candidateQuality: "aeon-pod:b" });
    expect(runLabel(runs[0])).toBe("2026-10-05 12:00 · aeon-suite-v4 · AEON pod · qwen3-30b · vllm · c1/4");
  });

  it("shows the verdict, the nearest reference, throughput, quality and cost", async () => {
    listRuns.mockResolvedValue({ total: RUNS.length, runs: RUNS });
    compare.mockResolvedValue(WIN);
    render(<UpgradeCompareDialog open onClose={() => {}} nodeId="spark-a" title="Spark A" />);
    await flush();
    await flush();
    expect(listRuns).toHaveBeenCalledWith({ node_id: "spark-a" });
    expect(compare).toHaveBeenCalledWith(["decode:old", "quality:q1"], ["decode:new", "quality:q2"]);
    expect(document.querySelector('[data-testid="upgrade-verdict"]')?.textContent).toContain("Worth it");
    expect(document.querySelector('[data-testid="upgrade-reasons"]')?.textContent).toContain("c4 +22.22%");
    const ref = document.querySelector('[data-testid="upgrade-reference"]')!;
    expect(ref.textContent).toContain("AEON Spark perf");
    expect(ref.textContent).toContain("188.4 tok/s vs yours 220.0 (c4, agg_window_tps)");
    expect(ref.textContent).toContain("1 difference(s)");
    const rows = [...document.querySelectorAll('[data-testid="upgrade-throughput"] tbody tr')].map((r) => r.textContent);
    expect(rows[0]).toContain("+6.0%");
    expect(rows[0]).toContain("15.0%*");
    expect(rows[0]).toContain("within noise");
    expect(rows[1]).toContain("+22.2%");
    expect(rows[1]).toContain("gain");
    expect(document.querySelector('[data-testid="upgrade-quality"]')?.textContent).toContain("1.000");
    const cost = document.querySelector('[data-testid="upgrade-cost"]')!.textContent;
    expect(cost).toContain("5.000");
    expect(cost).toContain("4.000");
    expect(cost).toContain("-20.0%");
    expect(cost).toContain("38.0 GB");
    expect(cost).toContain("-8.0 GB");
    expect(document.querySelector('[data-testid="upgrade-unpaired"]')?.textContent).toContain("candidate DecodeBench:c8");
  });

  it("shows a refusal with its reasons and no tables; re-asks when a pick changes", async () => {
    listRuns.mockResolvedValue({ total: RUNS.length, runs: RUNS });
    compare.mockResolvedValue({
      ...WIN,
      comparable: false,
      verdict: { code: "refused", worth_it: false, throughput: "none", quality: "not_measured", reasons: ["DecodeBench: hw_bucket differs (2× DGX Spark vs Single DGX Spark)"] },
      throughput: [],
      quality: [],
      reference: null,
    });
    render(<UpgradeCompareDialog open onClose={() => {}} />);
    await flush();
    await flush();
    expect(listRuns).toHaveBeenCalledWith({});
    const select = document.querySelector('[data-testid="upgrade-baseline"]') as HTMLSelectElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, "decode:other-hw");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(compare).toHaveBeenLastCalledWith(["decode:other-hw", "quality:q1"], ["decode:new", "quality:q2"]);
    expect(document.querySelector('[data-testid="upgrade-verdict"]')?.textContent).toContain("Refused");
    expect(document.body.textContent).toContain("hw_bucket differs");
    expect(document.querySelector('[data-testid="upgrade-throughput"]')).toBeNull();
    expect(document.querySelector('[data-testid="upgrade-reference"]')).toBeNull();
  });

  it("shows the server's error for a bad pick", async () => {
    listRuns.mockResolvedValue({ total: RUNS.length, runs: RUNS });
    compare.mockRejectedValue(new Error("baseline: unknown run decode:gone"));
    render(<UpgradeCompareDialog open onClose={() => {}} />);
    await flush();
    await flush();
    expect(document.querySelector(".bench-sheet__error")?.textContent).toBe("baseline: unknown run decode:gone");
  });

  it("is launchable from a node's LLM benchmarks panel", async () => {
    listRuns.mockResolvedValue({ total: 0, runs: [] });
    render(<NodeBenchPanel nodeId="n1" nodeName="Node" lanes={null} versions={[]} />);
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent === "Upgrade worth it?")!;
    await act(async () => btn.click());
    await flush();
    expect(listRuns).toHaveBeenCalledWith({ node_id: "n1" });
    expect(document.body.textContent).toContain("No stored runs yet");
  });
});
