import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StackPreview } from "../../../shared/types";
import { cleanupRenders, flush, render } from "../../testing/render";
import { StackPreviewPanel, fmtDuration, type PreviewApi } from "./StackPreviewPanel";
import { ComponentsPage } from "./ComponentsPage";
import { comp, fakeFetch, fstack } from "./testKit";

const step = (componentId: string, type: "start" | "stop", source: "history" | "estimate", ms: number) => ({
  stackId: "s",
  nodeId: "n1",
  componentId,
  type,
  freesBytes: null,
  eta: { ms, source, runs: source === "history" ? 7 : 2 },
});

const PREVIEW: StackPreview = {
  stackId: "s",
  name: "Stack s",
  tp: 1,
  target: { groupId: null, nodeIds: ["n1"] },
  category: "calculated",
  categoryReason: "fits",
  parallel: false,
  alreadyRunning: [],
  shutdownSequence: [[step("old", "stop", "history", 18_000)]],
  startupSequence: [[step("new-a", "start", "estimate", 120_000)], [step("new-b", "start", "history", 61_000)]],
  feasible: true,
  freeBytesProjected: 0,
  targetFreeBytes: 0,
  totalEtaMs: 199_000,
  totalSource: "mixed",
  notes: ["note one"],
};

afterEach(() => {
  cleanupRenders();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("StackPreviewPanel (SC5b)", () => {
  it("shows shutdowns before startups, per-step ETA source badges and the total", async () => {
    const api: PreviewApi = { preview: vi.fn(async () => ({ preview: PREVIEW, live: [] })), live: vi.fn(async () => ({ running: [] })) };
    const { container } = render(<StackPreviewPanel stackId="s" nodeId="n1" nodeNames={{ n1: "one" }} onClose={() => {}} api={api} />);
    await flush();
    expect(api.preview).toHaveBeenCalledWith("s", "n1");
    const waves = Array.from(container.querySelectorAll('[data-testid="preview-wave"]')).map((w) => w.textContent);
    expect(waves[0]).toContain("stopold");
    expect(waves[1]).toContain("startnew-a");
    expect(waves[2]).toContain("startnew-b");
    const badges = Array.from(container.querySelectorAll('[data-testid="eta-badge"]')).map((b) => b.textContent);
    expect(badges).toEqual(["0:18 history", "2:00 estimate", "1:01 history"]);
    const total = container.querySelector('[data-testid="preview-total"]')!.textContent!;
    expect(total).toContain("feasible");
    expect(total).toContain("3:19");
    expect(total).toContain("(mixed)");
    expect(total).toContain("sequential");
    expect(container.textContent).toContain("note one");
  });

  it("polls live actions and shows elapsed against the ETA", async () => {
    vi.useFakeTimers();
    let n = 0;
    const api: PreviewApi = {
      preview: vi.fn(async () => ({ preview: PREVIEW, live: [] })),
      live: vi.fn(async () => {
        n += 1;
        return { running: [{ componentId: "new-a", nodeId: "n1", type: "start" as const, startedAt: 1, elapsedMs: n * 35_000, etaMs: 120_000 }] };
      }),
    };
    const { container } = render(<StackPreviewPanel stackId="s" nodeId="n1" nodeNames={{ n1: "one" }} onClose={() => {}} api={api} pollMs={1000} />);
    await flush();
    expect(container.querySelector('[data-testid="preview-live"]')!.textContent).toContain("no component action running");
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
    expect(container.querySelector('[data-testid="preview-live"]')!.textContent).toContain("0:35 / ETA 2:00");
  });

  it("an error is shown, not thrown", async () => {
    const api: PreviewApi = { preview: vi.fn(async () => Promise.reject(new Error("boom"))), live: vi.fn(async () => ({ running: [] })) };
    const { container } = render(<StackPreviewPanel stackId="s" nodeId={null} nodeNames={{}} onClose={() => {}} api={api} />);
    await flush();
    expect(container.textContent).toContain("Preview failed: boom");
  });

  it("fmtDuration", () => {
    expect(fmtDuration(95_000)).toBe("1:35");
    expect(fmtDuration(-1)).toBe("0:00");
  });

  it("opens from a stack card on the Components tab via POST /api/stacks/:id/preview", async () => {
    localStorage.clear();
    const f = fakeFetch({
      "/api/components": { components: [comp("a")], warnings: [] },
      "/api/fleet/nodes": { nodes: [{ id: "n1", name: "one" }] },
      "/api/stacks": { stacks: [fstack("s")], facets: { tp: [1], sources: [], engines: [], purposes: [] }, errors: [] },
      "POST /api/stacks/s/preview": { preview: PREVIEW, live: [] },
      "/api/component-actions/live": { running: [] },
    });
    vi.stubGlobal("fetch", f.fn);
    const { container } = render(<ComponentsPage />);
    await flush();
    await flush();
    act(() => (container.querySelector('[data-testid="preview-s-n1"]') as HTMLButtonElement).click());
    await flush();
    await flush();
    expect(f.calls.some((c) => c.url === "/api/stacks/s/preview?node=n1" && c.init?.method === "POST")).toBe(true);
    expect(container.querySelector('[data-testid="stack-preview"]')!.textContent).toContain("total ETA");
  });
});
