import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent, EventsResponse } from "../api/types";
import { flush, render } from "../testing/render";
import { publishActivity } from "./activityBus";
import { ACTIVITY_POLL_MS, matchesFilter, mergeEvents, useActivityEvents, type UseActivityEvents } from "./useActivityEvents";

vi.mock("../api/client", () => ({ fetchEvents: vi.fn() }));
import { fetchEvents } from "../api/client";
const fetchMock = vi.mocked(fetchEvents);

const ev = (id: number, over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id,
  ts: id * 1000,
  type: "spark.online",
  severity: "info",
  sparkId: "s1",
  sparkName: "alpha",
  message: `event ${id}`,
  ...over,
});
const page = (events: ActivityEvent[]): EventsResponse => ({
  events,
  oldestId: events.at(-1)?.id ?? null,
  newestId: events[0]?.id ?? null,
  total: events.length,
});

let latest: UseActivityEvents;
function Probe(props: Parameters<typeof useActivityEvents>[0]) {
  latest = useActivityEvents(props);
  return null;
}
const ids = () => latest.events.map((e) => e.id);

describe("helpers", () => {
  it("matchesFilter honours unit and exact / prefix types", () => {
    expect(matchesFilter(ev(1), {})).toBe(true);
    expect(matchesFilter(ev(1), { sparkId: "s2" })).toBe(false);
    expect(matchesFilter(ev(1, { type: "gpu.throttle.start" }), { types: ["gpu."] })).toBe(true);
    expect(matchesFilter(ev(1, { type: "gpu.throttle.start" }), { types: ["gpu"] })).toBe(false);
    expect(matchesFilter(ev(1, { type: "alert.fired" }), { types: ["alert.fired"] })).toBe(true);
  });

  it("mergeEvents dedupes by id, sorts newest first and caps", () => {
    expect(mergeEvents([ev(3), ev(1)], [ev(2), ev(3)], 10).map((e) => e.id)).toEqual([3, 2, 1]);
    expect(mergeEvents([ev(3), ev(1)], [ev(5)], 2).map((e) => e.id)).toEqual([5, 3]);
  });
});

describe("useActivityEvents", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("loads, takes live pushes that match, and pages older events", async () => {
    fetchMock.mockResolvedValueOnce(page([ev(5), ev(4)]));
    render(<Probe limit={2} filter={{ types: ["spark."] }} />);
    await flush();
    expect(fetchMock).toHaveBeenLastCalledWith({ limit: 2, types: ["spark."] });
    expect(ids()).toEqual([5, 4]);
    expect(latest.hasMore).toBe(true);

    act(() => publishActivity(ev(6)));
    act(() => publishActivity(ev(7, { type: "alert.fired" })));
    expect(ids()).toEqual([6, 5, 4]);

    fetchMock.mockResolvedValueOnce(page([ev(3)]));
    await act(() => latest.loadOlder());
    expect(fetchMock).toHaveBeenLastCalledWith({ limit: 2, types: ["spark."], beforeId: 4 });
    expect(ids()).toEqual([6, 5, 4, 3]);
    expect(latest.hasMore).toBe(false);
  });

  it("polls for anything newer than the newest held event", async () => {
    fetchMock.mockResolvedValueOnce(page([ev(2)]));
    render(<Probe limit={10} filter={{ sparkId: "s1" }} />);
    await flush();
    fetchMock.mockResolvedValueOnce(page([ev(4), ev(3)]));
    await act(async () => {
      vi.advanceTimersByTime(ACTIVITY_POLL_MS);
    });
    await flush();
    expect(fetchMock).toHaveBeenLastCalledWith({ limit: 10, sparkId: "s1", sinceId: 2 });
    expect(ids()).toEqual([4, 3, 2]);
  });

  it("keeps at most `cap` events and reports fetch errors", async () => {
    fetchMock.mockResolvedValueOnce(page([ev(2), ev(1)]));
    render(<Probe limit={2} cap={2} />);
    await flush();
    act(() => publishActivity(ev(3)));
    expect(ids()).toEqual([3, 2]);

    fetchMock.mockRejectedValueOnce(new Error("HTTP 500"));
    await act(() => latest.reload());
    expect(latest.error).toBe("HTTP 500");
    expect(latest.loading).toBe(false);
  });
});
