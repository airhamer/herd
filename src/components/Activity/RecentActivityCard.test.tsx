import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ActivityEvent, EventsResponse } from "../../api/types";
import { flush, render } from "../../testing/render";
import { publishActivity } from "../../hooks/activityBus";
import { RECENT_ACTIVITY_COUNT, RecentActivityCard } from "./RecentActivityCard";

vi.mock("../../api/client", () => ({ fetchEvents: vi.fn() }));
import { fetchEvents } from "../../api/client";
const fetchMock = vi.mocked(fetchEvents);

const ev = (id: number, over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id,
  ts: Date.now() - 120_000,
  type: "spark.offline",
  severity: "warn",
  sparkId: "s1",
  sparkName: "alpha",
  message: `alpha went offline ${id}`,
  ...over,
});
const page = (events: ActivityEvent[]): EventsResponse => ({ events, oldestId: null, newestId: null, total: events.length });

describe("RecentActivityCard", () => {
  it("shows an empty state when nothing has happened", async () => {
    fetchMock.mockResolvedValue(page([]));
    const { container } = render(<RecentActivityCard />);
    await flush();
    expect(fetchMock).toHaveBeenCalledWith({ limit: RECENT_ACTIVITY_COUNT });
    expect(container.querySelector('[data-testid="activity-empty"]')?.textContent).toContain("No activity yet");
    expect(container.querySelector('[data-testid="activity-feed"]')).toBeNull();
  });

  it("lists events newest first with unit, severity and relative time", async () => {
    fetchMock.mockResolvedValue(
      page([ev(2, { message: "Service vllm stopped", severity: "info", sparkName: "node-a" }), ev(1)]),
    );
    const { container } = render(<RecentActivityCard />);
    await flush();
    const rows = [...container.querySelectorAll('[data-testid="activity-row"]')];
    expect(rows.map((r) => r.textContent)).toEqual([
      "Service vllm stoppednode-a2m ago",
      "alpha went offline 1alpha2m ago",
    ]);
    expect(rows[1].querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Warning");
  });

  it("takes live pushes, keeping only the most recent few", async () => {
    fetchMock.mockResolvedValue(page(Array.from({ length: RECENT_ACTIVITY_COUNT }, (_, i) => ev(RECENT_ACTIVITY_COUNT - i))));
    const { container } = render(<RecentActivityCard />);
    await flush();
    act(() => publishActivity(ev(100, { message: "fresh", ts: Date.now() })));
    const rows = container.querySelectorAll('[data-testid="activity-row"]');
    expect(rows).toHaveLength(RECENT_ACTIVITY_COUNT);
    expect(rows[0].textContent).toContain("fresh");
    expect(rows[0].textContent).toContain("just now");
  });

  it("explains a failed load, and links to the full log and to units", async () => {
    fetchMock.mockRejectedValueOnce(new Error("HTTP 503"));
    const failed = render(<RecentActivityCard />);
    await flush();
    expect(failed.container.textContent).toContain("Activity unavailable: HTTP 503");

    fetchMock.mockResolvedValue(page([ev(1)]));
    const onViewAll = vi.fn();
    const onSelectUnit = vi.fn();
    const ok = render(<RecentActivityCard onViewAll={onViewAll} onSelectUnit={onSelectUnit} />);
    await flush();
    const buttons = [...ok.container.querySelectorAll("button")];
    act(() => buttons.find((b) => b.textContent === "View all")!.click());
    act(() => buttons.find((b) => b.textContent === "alpha")!.click());
    expect(onViewAll).toHaveBeenCalledTimes(1);
    expect(onSelectUnit).toHaveBeenCalledWith("s1");
  });
});
