import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ActivityEvent, EventsResponse } from "../../api/types";
import { flush, render } from "../../testing/render";
import { ACTIVITY_PAGE_SIZE, ActivityPage } from "./ActivityPage";

vi.mock("../../api/client", () => ({ fetchEvents: vi.fn(), clearEvents: vi.fn() }));
import { clearEvents, fetchEvents } from "../../api/client";
const fetchMock = vi.mocked(fetchEvents);
const clearMock = vi.mocked(clearEvents);

const ev = (id: number, over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id,
  ts: Date.now(),
  type: "gpu.throttle.start",
  severity: "warn",
  sparkId: "s1",
  sparkName: "alpha",
  message: `event ${id}`,
  ...over,
});
const page = (events: ActivityEvent[]): EventsResponse => ({ events, oldestId: null, newestId: null, total: events.length });
const units = [
  { id: "s1", name: "alpha" },
  { id: "n1", name: "node-one" },
];

function select(container: HTMLElement, value: string) {
  const el = container.querySelector("select")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const button = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === text)!;

describe("ActivityPage", () => {
  it("filters by unit and category on the server", async () => {
    fetchMock.mockResolvedValue(page([ev(1)]));
    const { container } = render(<ActivityPage units={units} />);
    await flush();
    expect(fetchMock).toHaveBeenLastCalledWith({ limit: ACTIVITY_PAGE_SIZE });
    expect(container.textContent).toContain("gpu.throttle.start");

    select(container, "n1");
    await flush();
    expect(fetchMock).toHaveBeenLastCalledWith({ limit: ACTIVITY_PAGE_SIZE, sparkId: "n1" });

    act(() => button(container, "GPU & health").click());
    await flush();
    expect(fetchMock).toHaveBeenLastCalledWith({ limit: ACTIVITY_PAGE_SIZE, sparkId: "n1", types: ["gpu.", "health."] });
    expect(button(container, "GPU & health").getAttribute("aria-pressed")).toBe("true");
  });

  it("says when filters match nothing, and when nothing was ever recorded", async () => {
    fetchMock.mockResolvedValue(page([]));
    const { container } = render(<ActivityPage units={units} />);
    await flush();
    expect(container.querySelector('[data-testid="activity-empty"]')?.textContent).toBe("No activity recorded yet.");
    act(() => button(container, "Alerts").click());
    await flush();
    expect(container.querySelector('[data-testid="activity-empty"]')?.textContent).toBe("No events match these filters.");
  });

  it("offers older pages when a full page came back", async () => {
    const full = Array.from({ length: ACTIVITY_PAGE_SIZE }, (_, i) => ev(500 - i));
    fetchMock.mockResolvedValueOnce(page(full));
    const { container } = render(<ActivityPage units={units} />);
    await flush();
    fetchMock.mockResolvedValueOnce(page([ev(10)]));
    await act(async () => button(container, "Load older").click());
    await flush();
    expect(fetchMock).toHaveBeenLastCalledWith({ limit: ACTIVITY_PAGE_SIZE, beforeId: 500 - ACTIVITY_PAGE_SIZE + 1 });
    expect(container.querySelectorAll('[data-testid="activity-row"]')).toHaveLength(ACTIVITY_PAGE_SIZE + 1);
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Load older")).toBe(false);
  });

  it("clears only after confirmation, then reloads", async () => {
    fetchMock.mockResolvedValue(page([ev(1)]));
    clearMock.mockResolvedValue({ removed: 1 });
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const { container } = render(<ActivityPage units={units} confirm={confirm} />);
    await flush();
    await act(async () => button(container, "Clear all").click());
    expect(clearMock).not.toHaveBeenCalled();
    await act(async () => button(container, "Clear older than 7 days").click());
    await flush();
    expect(clearMock).toHaveBeenCalledWith(7 * 86_400_000);
    expect(container.textContent).toContain("Removed 1 event.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
