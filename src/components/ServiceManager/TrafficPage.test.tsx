import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmTokenTotals, TrafficLane, TrafficView } from "../../../shared/types";
import { cleanupRenders, flush, render } from "../../testing/render";
import { TrafficPage, fmtCount, type TrafficApi } from "./TrafficPage";

const tv = (value: number | null, source: "counter" | "proxy" | null = "counter") => ({ value, source: value == null ? null : source });
const win = (decode: number | null, ttft: number | null, source: "counter" | "proxy" = "counter") => ({
  coveredS: 58,
  decodeTps: tv(decode, source),
  prefillTps: tv(null),
  throughputTps: tv(decode, source),
  ttftS: tv(ttft, source),
});
const lane = (over: Partial<TrafficLane>): TrafficLane => ({
  port: 8000,
  backend: "vllm",
  modelId: "glm",
  proxied: false,
  listenPort: null,
  tokenSource: "engine",
  requests: 42,
  requestsSource: "engine",
  errors: null,
  inFlight: 0,
  promptTokens: 20000,
  cachedTokens: 15000,
  generatedTokens: 5000,
  windows: { 60: win(55.5, 0.3), 300: win(50, 0.35) },
  ...over,
});
const view = (over: Partial<TrafficView>): TrafficView => ({
  nodeId: "n1",
  polledAt: Date.now(),
  proxyEnabled: false,
  relays: [],
  lanes: [lane({})],
  recent: [],
  recentMax: 200,
  ...over,
});
const TOTALS = {
  endpoints: [
    { seriesId: "n1:8000", nodeId: "n1", nodeName: "one", port: 8000, backend: "vllm", models: ["glm"], sources: ["counter"], lastSeenMs: 1, generated: 1000, cached: 500, prefill: 300, total: 1800 },
    { seriesId: "n2:8000", nodeId: "n2", nodeName: "two", port: 8000, backend: "vllm", models: ["x"], sources: ["counter"], lastSeenMs: 1, generated: 9, cached: 9, prefill: 9, total: 999999 },
  ],
} as unknown as LlmTokenTotals;

const apiOf = (v: TrafficView | (() => TrafficView)): TrafficApi => ({
  traffic: vi.fn(async () => (typeof v === "function" ? v() : v)),
  totals: vi.fn(async () => TOTALS),
});

afterEach(() => {
  cleanupRenders();
  vi.useRealTimers();
});

describe("TrafficPage (SC5c)", () => {
  it("engine-only lane: stats, 60/300 s tok/s, engine badge, 24 h ledger total for this node, proxy-off hint", async () => {
    const api = apiOf(view({}));
    const { container } = render(<TrafficPage nodeId="n1" nodeName="one" api={api} />);
    await flush();
    expect(api.traffic).toHaveBeenCalledWith("n1");
    const row = container.querySelector('[data-testid="traffic-lane-8000"]')!;
    expect(row.textContent).toContain("glm");
    expect(row.textContent).toContain("42");
    expect(row.textContent).toContain("15k");
    expect(row.querySelector('[data-testid="tps-60"]')!.textContent).toBe("55.5counter");
    expect(row.querySelector('[data-testid="tps-300"]')!.textContent).toBe("50.0counter");
    expect(row.textContent).toContain("300 ms");
    expect(row.textContent).toContain("1.8k"); // n1:8000, not n2's
    expect(row.querySelector('[data-testid="source-badge"]')!.textContent).toBe("engine");
    expect(container.querySelector('[data-testid="proxy-off-hint"]')!.textContent).toContain("LLM_PROXY");
    expect(container.querySelector('[data-testid="recent-empty"]')!.textContent).toContain("proxy off");
  });

  it("source badges: proxy, estimate, none; unmeasured values read — not 0", async () => {
    const api = apiOf(
      view({
        proxyEnabled: true,
        lanes: [
          lane({ port: 11434, tokenSource: "proxy", proxied: true, listenPort: 18000, errors: 2, windows: { 60: win(null, null), 300: win(null, null) } }),
          lane({ port: 1234, tokenSource: "estimate" }),
          lane({ port: 5000, tokenSource: null, requests: null, promptTokens: null, cachedTokens: null, generatedTokens: null }),
        ],
      })
    );
    const { container } = render(<TrafficPage nodeId="n1" nodeName="one" api={api} />);
    await flush();
    const badges = Array.from(container.querySelectorAll('[data-testid="source-badge"]')).map((b) => b.textContent);
    expect(badges).toEqual(["proxy", "estimate", "none"]);
    const p = container.querySelector('[data-testid="traffic-lane-11434"]')!;
    expect(p.textContent).toContain("relay :18000");
    expect(p.querySelector('[data-testid="tps-60"]')!.textContent).toBe("—");
    const none = container.querySelector('[data-testid="traffic-lane-5000"]')!;
    expect(none.textContent).not.toMatch(/\b0\b/);
    expect(container.querySelector('[data-testid="proxy-off-hint"]')).toBeNull();
    expect(container.querySelector('[data-testid="recent-empty"]')!.textContent).toContain("No requests through the relay yet");
  });

  it("recent requests table: metadata rows, estimated completions marked, errors red", async () => {
    const now = Date.now();
    const api = apiOf(
      view({
        proxyEnabled: true,
        recent: [
          { wallMs: now - 10_000, listenPort: 18000, upstreamPort: 11434, client: "10.0.0.5", path: "/v1/chat/completions", model: "llama", status: 200, aborted: false, stream: true, promptTokens: 100, completionTokens: 40, cachedTokens: 60, completionEstimated: true, ttftS: 0.25, decodeS: 1, e2eS: 1.3 },
          { wallMs: now - 20_000, listenPort: 18000, upstreamPort: 11434, client: "10.0.0.6", path: "/api/generate", model: "llama", status: 500, aborted: false, stream: false, promptTokens: null, completionTokens: null, cachedTokens: null, completionEstimated: false, ttftS: null, decodeS: null, e2eS: 0.1 },
        ],
      })
    );
    const { container } = render(<TrafficPage nodeId="n1" nodeName="one" api={api} />);
    await flush();
    const rows = Array.from(container.querySelectorAll('[data-testid="traffic-request"]'));
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("10.0.0.5");
    expect(rows[0].textContent).toContain("40~");
    expect(rows[0].textContent).toContain("250 ms");
    expect(rows[0].textContent).toContain("1.30 s");
    expect(rows[1].textContent).toContain("500");
    expect(rows[1].querySelector(".text-danger")).not.toBeNull();
    expect(container.textContent).toContain("Recent requests (2 of last 200)");
  });

  it("empty lanes state and error banner", async () => {
    const { container } = render(<TrafficPage nodeId="n1" nodeName="one" api={apiOf(view({ lanes: [] }))} />);
    await flush();
    expect(container.querySelector('[data-testid="lanes-empty"]')).not.toBeNull();
    cleanupRenders();
    const bad: TrafficApi = { traffic: vi.fn(async () => Promise.reject(new Error("HTTP 404"))), totals: vi.fn(async () => TOTALS) };
    const r2 = render(<TrafficPage nodeId="nope" nodeName="?" api={bad} />);
    await flush();
    expect(r2.container.textContent).toContain("Traffic unavailable: HTTP 404");
  });

  it("polls", async () => {
    vi.useFakeTimers();
    let n = 0;
    const api = apiOf(() => view({ lanes: [lane({ requests: ++n })] }));
    const { container } = render(<TrafficPage nodeId="n1" nodeName="one" api={api} pollMs={1000} />);
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
    expect(api.traffic).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="traffic-lane-8000"]')!.textContent).toContain("glm");
  });

  it("fmtCount", () => {
    expect(fmtCount(null)).toBe("—");
    expect(fmtCount(999)).toBe("999");
    expect(fmtCount(1234)).toBe("1.2k");
    expect(fmtCount(15000)).toBe("15k");
    expect(fmtCount(5_600_000)).toBe("5.6M");
  });
});
