import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AeonLadderDialog, AEON_FALLBACK, aeonRequests } from "./AeonLadderDialog";
import { NodeBenchPanel, nodeBenchEndpoints } from "./NodeBenchPanel";
import { flush, render } from "../../testing/render";
import type { AeonCell, AeonLevel, DecodeBenchDefaults, DecodeBenchJob } from "../../api/types";

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
  protocols: ["herd", "aeon-perf-v1"],
  aeon: AEON_FALLBACK,
};

const cell = (conc: number, agg: number, sum: number, cat = "overall"): AeonCell => ({
  n: 20,
  n_errors: 0,
  ttft_ms_mean: 120,
  ttft_ms_p50: 110,
  ttft_ms_p95: 200,
  decode_tps_mean: sum / conc,
  prefill_tps_mean: 3000,
  e2e_ms_mean: 5000,
  tpot_ms_mean: 20,
  tpot_ms_p50: 20,
  tpot_ms_p95: 22,
  output_tokens_total: 5120,
  input_tokens_total: 9000,
  agg_decode_tps: agg,
  agg_source: cat === "overall" ? "peak_category_cell" : "wave_peak_concurrent_window",
  concurrent_window_s: 5,
  agg_saturated_est: sum,
  conc,
  wave_count: 1,
  tokens_per_wall_s: 100,
  tokens_source: "client",
  case_id: `perf.direct.${cat.toLowerCase()}.c${conc}`,
});

const level = (conc: number, agg: number, sum: number): AeonLevel => ({
  conc,
  wallClockS: 30,
  overall: cell(conc, agg, sum),
  categories: Object.fromEntries(AEON_FALLBACK.categories.map((c) => [c, cell(conc, agg - 1, sum, c)])),
});

const job = (over: Partial<DecodeBenchJob> = {}): DecodeBenchJob => ({
  benchId: "a1",
  sparkId: "node:n1",
  status: "completed",
  startedAt: Date.parse("2026-10-31T09:00:00Z"),
  completedAt: Date.parse("2026-10-31T09:05:00Z"),
  config: {
    port: 8000,
    modelId: "qwen3",
    concurrencies: [1, 8],
    maxTokens: 256,
    protocol: "aeon-perf-v1",
    categories: AEON_FALLBACK.categories,
    requests: 60,
  },
  progress: { currentConcurrency: null, completedLevels: 2, totalLevels: 2, message: "Done", requestsDone: 60, requestsTotal: 60 },
  results: [],
  aeon: { suite: "aeon-perf-v1", nonce: "abc", levels: [level(1, 52.3, 51.1), level(8, 301.7, 344.2)] },
  nodeId: "n1",
  error: null,
  durationMs: 300_000,
  ...over,
});

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement;

describe("AeonLadderDialog", () => {
  beforeEach(() => {
    list.mockReset();
    start.mockReset();
  });

  it("counts AEON requests (320 for the full ladder)", () => {
    expect(aeonRequests([1, 4, 8, 16, 32])).toBe(320);
    expect(aeonRequests([1])).toBe(20);
    expect(aeonRequests([32])).toBe(160);
  });

  it("starts the AEON protocol for a node lane with the chosen ladder", async () => {
    list.mockResolvedValue({ active: null, last: null, history: [], defaults });
    start.mockResolvedValue(job({ status: "running", aeon: { suite: "aeon-perf-v1", nonce: "x", levels: [] } }));
    render(<AeonLadderDialog open onClose={() => {}} targetId="n1" scope="node" port={8000} modelId="qwen3" />);
    await flush();
    expect(list).toHaveBeenCalledWith("n1", 8000, "node");
    const count = document.querySelector('[data-testid="aeon-request-count"]');
    expect(count?.textContent).toContain("320 requests");
    expect(count?.textContent).toContain("full AEON ladder");
    act(() => button("c32").click());
    act(() => button("c16").click());
    expect(count?.textContent).toContain("80 requests");
    await act(async () => {
      button("Run ladder").click();
    });
    expect(start).toHaveBeenCalledWith(
      "n1",
      { protocol: "aeon-perf-v1", port: 8000, concurrencies: [1, 4, 8], modelId: "qwen3" },
      "node"
    );
  });

  it("shows both aggregates in separate columns and ignores herd runs", async () => {
    const herd = job({ benchId: "h", config: { port: 8000, modelId: "m", concurrencies: [1], maxTokens: 400 }, aeon: undefined });
    list.mockResolvedValue({ active: null, last: herd, history: [herd, job()], defaults });
    render(<AeonLadderDialog open onClose={() => {}} targetId="s1" scope="spark" port={8000} modelId={null} />);
    await flush();
    await flush();
    const table = document.querySelector('[data-testid="aeon-level-table"]');
    expect(table).not.toBeNull();
    const head = [...table!.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(head).toContain("Agg peak window");
    expect(head).toContain("Agg Σ (decode×c)");
    const c8 = [...table!.querySelectorAll("tbody tr")].find((r) => r.textContent?.startsWith("c8"));
    expect(c8?.textContent).toContain("301.7");
    expect(c8?.textContent).toContain("344.2");
    expect(document.querySelector('[data-testid="aeon-category-table"]')?.textContent).toContain("Instruction");
    expect(document.body.textContent).toContain("aeon.wave_peak_concurrent_window.v1");
    expect(document.body.textContent).toContain("aeon.agg_saturated_est.v1");
    // One AEON run in the list; the herd run is not shown.
    expect(document.querySelectorAll(".quality-run").length).toBe(1);
  });
});

describe("NodeBenchPanel", () => {
  it("lists running lanes and live LLM services once per port", () => {
    const eps = nodeBenchEndpoints(
      {
        pools: [
          {
            id: "p",
            lanes: [
              { recipe: "llm-a", modelId: "a", port: 8000, order: 0, running: true, containerName: null, state: "running" },
              { recipe: "llm-b", modelId: "b", port: 8001, order: 1, running: false, containerName: null, state: "stopped" },
            ],
          },
        ],
        candidates: [],
      } as never,
      [
        { kind: "llm", port: 8000, modelId: "a-live", engine: "vllm", state: "running" },
        { kind: "llm", port: 9000, modelId: "solo", engine: "sglang", state: "running" },
        { kind: "image", port: 8188, modelId: null, engine: "comfyui", state: "running" },
      ] as never
    );
    expect(eps.map((e) => e.port)).toEqual([8000, 9000]);
    expect(eps[0].modelId).toBe("a-live");
  });

  it("renders launchers per lane, and a hint without lanes", () => {
    render(<NodeBenchPanel nodeId="n1" nodeName="Node" lanes={null} versions={[]} />);
    expect(document.body.textContent).toContain("No running LLM lane");
    render(
      <NodeBenchPanel
        nodeId="n1"
        nodeName="Node"
        lanes={null}
        versions={[{ kind: "llm", port: 9000, modelId: "solo", engine: "sglang", state: "running" } as never]}
      />
    );
    expect(document.body.textContent).toContain(":9000 · solo · sglang");
    expect(button("AEON ladder")).toBeTruthy();
    expect(button("Decode bench")).toBeTruthy();
  });
});
