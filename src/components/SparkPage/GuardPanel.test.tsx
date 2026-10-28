import { describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import type { GuardResult } from "../../api/types";
import { GUARD_POLL_MS, GuardPanel, guardSummary } from "./GuardPanel";

/** A present, running guard; callers override only what a test is about. */
const guard = (over: Partial<GuardResult> = {}): GuardResult => ({
  id: "g1",
  label: "Guard One",
  present: true,
  status: "running",
  heldRequests: 0,
  crashTimeline: [],
  checkedAt: "2026-10-28T14:00:00.000Z",
  reason: null,
  ...over,
});

const fetcherOf = (...guards: GuardResult[]) =>
  vi.fn(async () => ({ guards }));

describe("GuardPanel", () => {
  it("shows the loading note until the first answer lands", () => {
    const never = () => new Promise<{ guards: GuardResult[] }>(() => {});
    const { container } = render(<GuardPanel fetcher={never} />);
    expect(container.textContent ?? "").toContain("Checking guards…");
  });

  it("renders the empty guard list calmly, not as an error", async () => {
    const { container } = render(<GuardPanel fetcher={fetcherOf()} />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Guard Proxy");
    expect(text).toContain("No guard proxies configured");
    expect(container.querySelector(".text-danger")).toBeNull();
  });

  it("shows a danger fetch line (without throwing) when the fetch rejects", async () => {
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    const { container } = render(<GuardPanel fetcher={failing} />);
    await flush();
    const line = container.querySelector(".text-danger");
    expect(line).not.toBeNull();
    expect(line?.textContent ?? "").toContain("boom");
    expect(container.textContent ?? "").not.toContain("Checking guards…");
  });

  it("badges a running guard with the success style", async () => {
    const { container } = render(<GuardPanel fetcher={fetcherOf(guard())} />);
    await flush();
    const badge = container.querySelector("span.text-success");
    expect(badge?.textContent).toBe("running");
    expect(container.querySelector("[data-guard-timeline]")).toBeNull(); // empty timeline renders nothing
  });

  it("badges a degraded guard with the warning style", async () => {
    const { container } = render(
      <GuardPanel fetcher={fetcherOf(guard({ status: "degraded" }))} />,
    );
    await flush();
    const badge = container.querySelector("span.text-warning");
    expect(badge?.textContent).toBe("degraded");
  });

  it("badges a stopped guard with the danger style", async () => {
    const { container } = render(
      <GuardPanel fetcher={fetcherOf(guard({ status: "stopped" }))} />,
    );
    await flush();
    const badge = container.querySelector("span.text-danger");
    expect(badge?.textContent).toBe("stopped");
  });

  it("badges an unknown status with the muted style", async () => {
    const { container } = render(
      <GuardPanel fetcher={fetcherOf(guard({ status: "unknown" }))} />,
    );
    await flush();
    const badge = container.querySelector("span.bg-border");
    expect(badge?.textContent).toBe("unknown");
  });

  it("shows held request counts, and an em-dash when the count is null", async () => {
    const { container } = render(
      <GuardPanel
        fetcher={fetcherOf(guard(), guard({ id: "g2", label: "Guard Two", heldRequests: null }))}
      />,
    );
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("held 0");
    expect(text).toContain("held —");
  });

  it("shows the probe reason on a not-present guard", async () => {
    const { container } = render(
      <GuardPanel
        fetcher={fetcherOf(
          guard({ present: false, status: "unknown", heldRequests: null, reason: "unreachable" }),
        )}
      />,
    );
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("unreachable");
  });

  it("caps the crash timeline at the 3 most recent entries, dashes null fields", async () => {
    const crashTimeline = [
      { at: "2026-10-28T10:00:00Z", kind: "alpha", detail: "segfault" },
      { at: "2026-10-28T11:00:00Z", kind: "beta", detail: null },
      { at: "2026-10-28T09:00:00Z", kind: null, detail: "oom" },
      { at: null, kind: "ghost", detail: "undated" },
      { at: "2026-10-28T08:00:00Z", kind: "early", detail: "stale" },
    ];
    const { container } = render(
      <GuardPanel fetcher={fetcherOf(guard({ crashTimeline }))} />,
    );
    await flush();
    const rows = [...container.querySelectorAll("[data-guard-timeline] > div")];
    expect(rows).toHaveLength(3);
    const text = container.textContent ?? "";
    // Newest-first; null fields render as "—" in "kind — detail".
    expect(text).toContain("beta — —");
    expect(text).toContain("alpha — segfault");
    expect(text).toContain("— — oom");
    expect(text.indexOf("beta")).toBeLessThan(text.indexOf("alpha"));
    expect(text).not.toContain("ghost");
    expect(text).not.toContain("early");
  });

  it("falls back label → id → \"unnamed guard\"", async () => {
    const byId = render(<GuardPanel fetcher={fetcherOf(guard({ label: null, id: "g9" }))} />);
    await flush();
    expect(byId.container.textContent ?? "").toContain("g9");

    const unnamed = render(
      <GuardPanel fetcher={fetcherOf(guard({ label: null, id: null }))} />,
    );
    await flush();
    expect(unnamed.container.textContent ?? "").toContain("unnamed guard");
  });

  it("counts total, running, and held requests in guardSummary", () => {
    expect(guardSummary([])).toEqual({ total: 0, running: 0, held: 0 });
    expect(
      guardSummary([
        guard({ heldRequests: 2 }),
        guard({ id: "g2", status: "degraded", heldRequests: null }),
        guard({ id: "g3", status: "stopped", heldRequests: 3 }),
      ]),
    ).toEqual({ total: 3, running: 1, held: 5 });
  });

  it("polls on a 30 s cadence", () => {
    expect(GUARD_POLL_MS).toBe(30_000);
  });
});
