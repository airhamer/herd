import { describe, expect, it, vi, afterEach } from "vitest";
import { act } from "react";
import { render, cleanupRenders } from "../../testing/render";
import { NormalizedEngineGrid, NormalizedEngineInline } from "./NormalizedEngineMetrics";
import { FleetCard } from "../OverviewPage/FleetCard";
import { LlmPanel } from "../SparkPage/LlmPanel";
import type {
  NormalizedEngineField,
  NormalizedEngineRecord,
  NormalizedEngineValue,
  NormalizedEngineWindows,
} from "../../../shared/types";
import type { LlmMetrics } from "../../api/types";

vi.mock("../SparkPage/LlmTrendChart", () => ({ LlmTrendChart: () => null }));
vi.mock("../SparkPage/LlmDailyChart", () => ({ LlmDailyChart: () => null }));

afterEach(() => cleanupRenders());

const FIELDS: NormalizedEngineField[] = [
  "decode_tps", "prefill_tps", "ttft_s", "queue_s", "running", "waiting",
  "kv_pct", "cache_reuse", "acc_len", "idle_share", "throughput_tps",
];

const NULL_VALUE: NormalizedEngineValue = { value: null, valid: false, source: null, windowS: null, approximate: false, samples: 0 };

function record(spanS: number, over: Partial<Record<NormalizedEngineField, Partial<NormalizedEngineValue>>>): NormalizedEngineRecord {
  const values = Object.fromEntries(
    FIELDS.map((f) => [f, over[f] ? { ...NULL_VALUE, valid: true, windowS: spanS, samples: 3, ...over[f] } : NULL_VALUE]),
  ) as Record<NormalizedEngineField, NormalizedEngineValue>;
  return { spanS, coveredS: Math.min(spanS, 120), reads: 3, startedAt: 1, resets: 0, values };
}

const WINDOWS: NormalizedEngineWindows = {
  "60": record(60, { decode_tps: { value: 48.2, source: "counter" } }),
  "300": record(300, {
    decode_tps: { value: 51.5, source: "counter" },
    ttft_s: { value: 0.2, source: "counter" },
    kv_pct: { value: 20, source: "counter", windowS: 0, peak: 35 },
    prefill_tps: { value: 1500, source: "native", approximate: true },
  }),
};

const q = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);

describe("NormalizedEngineGrid", () => {
  it("shows the longest window by default with source, window and reads", () => {
    const { container } = render(<NormalizedEngineGrid windows={WINDOWS} />);
    const decode = q(container, "llm-normalized-decode_tps")!;
    expect(decode.textContent).toContain("51.5 tok/s");
    expect(decode.textContent).toContain("counter · 300 s · n 3");
    expect(decode.getAttribute("title")).toContain("Source: counter.");
    expect(q(container, "llm-normalized-footer")!.textContent).toBe("3 reads over 120 s");
  });

  it("marks approximate values with ≈ and unmeasured ones with — (not 0)", () => {
    const { container } = render(<NormalizedEngineGrid windows={WINDOWS} />);
    expect(q(container, "llm-normalized-prefill_tps")!.textContent).toContain("≈1500 tok/s");
    expect(q(container, "llm-normalized-prefill_tps")!.getAttribute("title")).toContain("Approximate.");
    const idle = q(container, "llm-normalized-idle_share")!;
    expect(idle.textContent).toContain("—");
    expect(idle.textContent).not.toContain("0");
    expect(idle.getAttribute("title")).toContain("Not measured.");
  });

  it("levels read as instantaneous with their window peak", () => {
    const { container } = render(<NormalizedEngineGrid windows={WINDOWS} />);
    const kv = q(container, "llm-normalized-kv_pct")!;
    expect(kv.textContent).toContain("20.0%");
    expect(kv.getAttribute("title")).toContain("Instantaneous.");
    expect(kv.getAttribute("title")).toContain("Peak: 35.0%.");
  });

  it("the window toggle switches to the 1 min record", () => {
    const { container } = render(<NormalizedEngineGrid windows={WINDOWS} />);
    const btn = [...container.querySelectorAll("button")].find((b) => b.textContent === "1 min")!;
    act(() => btn.click());
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(q(container, "llm-normalized-decode_tps")!.textContent).toContain("48.2 tok/s");
  });

  it("renders nothing without records", () => {
    expect(render(<NormalizedEngineGrid windows={null} />).container.innerHTML).toBe("");
    expect(render(<NormalizedEngineGrid windows={{}} />).container.innerHTML).toBe("");
  });
});

describe("NormalizedEngineInline", () => {
  it("shows decode · TTFT · KV with the source tier", () => {
    const { container } = render(<NormalizedEngineInline windows={WINDOWS} />);
    const t = q(container, "fleet-card-model-normalized")!.textContent ?? "";
    expect(t).toContain("Decode 51.5 tok/s (counter)");
    expect(t).toContain("TTFT 200 ms (counter)");
    expect(t).toContain("KV 20.0% (counter)");
  });

  it("renders nothing when none of the three is measured", () => {
    const { container } = render(<NormalizedEngineInline windows={{ "300": record(300, {}) }} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("Fleet node card", () => {
  it("shows the normalized line on the running model row of the matching port", () => {
    const { container } = render(
      <FleetCard
        nodeId="n1" nodeName="n1" lanIp="192.168.50.10" role="standalone" rank={null} groupId={null}
        online gpu={null} cpu={null} mem={{ usedMB: 1, totalMB: 2, availableMB: 1, percentage: 50 }} containers={[]} versions={[]} requests={null}
        topology={null} memory={null} polledAt={Date.now()}
        services={[
          { name: "llm-a", kind: "llm", engine: "vllm", port: 8000, status: "running", modelId: "m", engineVersion: null, footprintMB: 1, active: true, polledAt: 1 },
          { name: "llm-b", kind: "llm", engine: "sglang", port: 30000, status: "running", modelId: "q", engineVersion: null, footprintMB: 1, active: false, polledAt: 1 },
        ]}
        llm={[
          { port: 8000, backend: "vllm", modelId: "m", normalized: WINDOWS },
          { port: 30000, backend: "sglang", modelId: "q", normalized: null },
        ]}
      />,
    );
    const lines = container.querySelectorAll('[data-testid="fleet-card-model-normalized"]');
    expect(lines).toHaveLength(1);
    expect(lines[0].closest("li")!.textContent).toContain("vllm · :8000");
  });
});

describe("Spark LlmPanel", () => {
  it("shows the normalized engine metrics for a live engine", () => {
    const llm = {
      available: true, backend: "vllm", modelId: "m", modelPath: null, contextLength: 4096,
      gpuMemoryUtilization: null, slotsActive: 0, slotsTotal: 0, generationTps: 50, prefillTps: 0,
      totalOutputTokens: 10, normalized: WINDOWS,
    } as unknown as LlmMetrics;
    const { container } = render(<LlmPanel llm={llm} sparkId="s1" llmPort={8000} />);
    expect(q(container, "llm-normalized")).toBeTruthy();
    expect(q(container, "llm-normalized-decode_tps")!.textContent).toContain("51.5 tok/s");
  });
});
