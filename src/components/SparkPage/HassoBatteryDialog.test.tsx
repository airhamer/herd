import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HassoBatteryDialog, HASSO_FALLBACK, hassoRequests } from "./HassoBatteryDialog";
import { NodeBenchPanel } from "./NodeBenchPanel";
import { flush, render } from "../../testing/render";
import type { DecodeBenchDefaults, DecodeBenchJob, HassoBatteryRun } from "../../api/types";

vi.mock("../../api/client", () => ({
  listDecodeBench: vi.fn(),
  startDecodeBench: vi.fn(),
  getDecodeBench: vi.fn(),
  cancelDecodeBench: vi.fn(),
  clearDecodeBenchHistory: vi.fn(),
}));

import { listDecodeBench, startDecodeBench } from "../../api/client";

const list = vi.mocked(listDecodeBench);
const start = vi.mocked(startDecodeBench);

const defaults: DecodeBenchDefaults = {
  allowedConcurrencies: [1, 2, 4, 8],
  defaultMaxTokens: 400,
  minMaxTokens: 64,
  maxMaxTokens: 2048,
  promptTypes: ["structured"],
  defaultPromptType: "structured",
  protocols: ["herd", "aeon-perf-v1", "hasso-battery-v1"],
  hasso: HASSO_FALLBACK,
};

const run = (tps: number | null) => ({ tps, completionTokens: 400, ttftMs: 80, decodeMs: 8000 });

const hasso: HassoBatteryRun = {
  suite: "hasso-battery-v1",
  batteryVersion: 1,
  parts: ["bench", "matrix"],
  model: "qwen3",
  bench: {
    probes: HASSO_FALLBACK.benchProbes.map((p, i) => ({
      ...p,
      runs: [run(48.2 + i), run(i === 3 ? null : 49.4 + i)],
      median: i === 3 ? 51.2 : 48.8 + i,
    })),
    greedyMedian: 49.3,
    greedyRuns: 4,
    untimed: 0,
  },
  matrix: {
    batteryVersion: 1,
    warmup: { wallS: 0.3, tokens: 2, discarded: true },
    probes: HASSO_FALLBACK.matrixProbes.map((p) =>
      p.key === "math_en"
        ? {
            ...p,
            short: { wallS: 1.7, tokens: 80 },
            long: { wallS: 2.4, tokens: 112 },
            deltaTokens: 32,
            deltaS: 0.7,
            tps: null,
            reliable: false,
            reason: "unreliable sample (Δtok=32, Δt=0.70s: short answer, cold start or cache artifact)",
          }
        : {
            ...p,
            short: { wallS: 1.7, tokens: 80 },
            long: { wallS: 13.9, tokens: 680 },
            deltaTokens: 600,
            deltaS: 12.2,
            tps: 49.2,
            reliable: true,
            reason: null,
          }
    ),
  },
};

const job = (over: Partial<DecodeBenchJob> = {}): DecodeBenchJob => ({
  benchId: "h1",
  sparkId: "s1",
  status: "completed",
  startedAt: Date.parse("2026-10-31T09:00:00Z"),
  completedAt: Date.parse("2026-10-31T09:06:00Z"),
  config: {
    port: 8000,
    modelId: "qwen3",
    concurrencies: [1],
    maxTokens: 2048,
    protocol: "hasso-battery-v1",
    suiteVersion: "1",
    batteryVersion: 1,
    parts: ["bench", "matrix"],
    requests: 25,
  },
  progress: { currentConcurrency: null, completedLevels: 2, totalLevels: 2, message: "Done", requestsDone: 25, requestsTotal: 25 },
  results: [],
  hasso,
  error: null,
  durationMs: 360_000,
  ...over,
});

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement;

describe("HassoBatteryDialog", () => {
  beforeEach(() => {
    list.mockReset();
    start.mockReset();
  });

  it("counts requests per part (25 for the full battery)", () => {
    expect(hassoRequests(["bench", "matrix"])).toBe(25);
    expect(hassoRequests(["bench"])).toBe(8);
    expect(hassoRequests(["matrix"])).toBe(17);
  });

  it("starts the Hasso protocol with the chosen parts and never sends max tokens", async () => {
    list.mockResolvedValue({ active: null, last: null, history: [], defaults });
    start.mockResolvedValue(job({ status: "running", hasso: { ...hasso, bench: null, matrix: null } }));
    render(<HassoBatteryDialog open onClose={() => {}} targetId="n1" scope="node" port={8000} modelId="qwen3" />);
    await flush();
    expect(list).toHaveBeenCalledWith("n1", 8000, "node");
    const count = document.querySelector('[data-testid="hasso-request-count"]');
    expect(count?.textContent).toContain("25 requests");
    act(() => button("bench.sh").click());
    expect(count?.textContent).toContain("17 requests");
    // The last part cannot be switched off.
    act(() => button("bench-matrix.sh").click());
    expect(count?.textContent).toContain("17 requests");
    await act(async () => {
      button("Run battery").click();
    });
    expect(start).toHaveBeenCalledWith(
      "n1",
      { protocol: "hasso-battery-v1", port: 8000, concurrencies: [1], parts: ["matrix"], modelId: "qwen3" },
      "node"
    );
  });

  it("shows the greedy median, per-probe runs, refused matrix samples, and only Hasso runs", async () => {
    const herd = job({ benchId: "x", config: { port: 8000, modelId: "m", concurrencies: [1], maxTokens: 400 }, hasso: undefined });
    list.mockResolvedValue({ active: null, last: herd, history: [herd, job()], defaults });
    render(<HassoBatteryDialog open onClose={() => {}} targetId="s1" scope="spark" port={8000} modelId={null} />);
    await flush();
    await flush();
    expect(document.querySelector('[data-testid="hasso-greedy-median"]')?.textContent).toBe("49.3 tok/s");
    const bench = document.querySelector('[data-testid="hasso-bench-table"]')!;
    const prose = [...bench.querySelectorAll("tbody tr")].find((r) => r.textContent?.startsWith("prose"));
    expect(prose?.textContent).toContain("not timed");
    expect(prose?.textContent).toContain("excluded (worst case)");
    const matrix = document.querySelector('[data-testid="hasso-matrix-table"]')!;
    const math = [...matrix.querySelectorAll("tbody tr")].find((r) => r.textContent?.startsWith("math (EN"));
    expect(math?.textContent).toContain("refused");
    expect(math?.querySelector("[title]")?.getAttribute("title")).toContain("unreliable sample");
    expect(matrix.textContent).toContain("49.2");
    expect(document.body.textContent).toContain("1 unreliable sample(s) refused");
    for (const d of ["hasso.single_stream_greedy_median.v1", "hasso.bench_probe_median.v1", "hasso.matrix_two_call_delta.v1"]) {
      expect(document.body.textContent).toContain(d);
    }
    expect(document.querySelectorAll(".quality-run").length).toBe(1);
  });

  it("is launchable per node lane", () => {
    render(
      <NodeBenchPanel
        nodeId="n1"
        nodeName="Node"
        lanes={null}
        versions={[{ kind: "llm", port: 9000, modelId: "solo", engine: "sglang", state: "running" } as never]}
      />
    );
    expect(button("Hasso battery")).toBeTruthy();
  });
});
