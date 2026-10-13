import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, flush } from "../../testing/render";
import { ScheduleDialog, formatEpoch } from "./ScheduleDialog";
import { FIXED_NOW, makeFetchRouter, schedule, updatesView, type RecordedCall } from "./testKit";

// Fixed at-ms for the one-shot mode: 2026-10-13T07:00:00Z.
const AT_MS = Date.UTC(2026, 9, 13, 7, 0, 0);

function mount(nodeId = "n1", view = updatesView(nodeId)) {
  const router = makeFetchRouter((call: RecordedCall) => {
    if (call.method === "POST" && call.url === "/api/fleet/nodes/n1/updates/schedule") {
      return { status: 200, body: { ok: true } };
    }
    if (call.method === "DELETE" && call.url === "/api/fleet/nodes/n1/updates/schedule/sch-1") {
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { error: `unexpected ${call.method} ${call.url}` } };
  });
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(
    <ScheduleDialog open nodeId={nodeId} view={view} onClose={onClose} onChanged={onChanged} />
  );
  return { calls: router.calls, onClose, onChanged };
}

function input(placeholder?: string): HTMLInputElement {
  const els = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
  const el = placeholder ? els.find((e) => e.placeholder === placeholder) : els.find((e) => e.type === "text");
  return el as HTMLInputElement;
}

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(el: Element | null | undefined) {
  act(() => {
    (el as HTMLElement).click();
  });
}

function byText(text: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(text));
}

afterEach(() => vi.unstubAllGlobals());

describe("ScheduleDialog — mode toggle + live cron preview", () => {
  it("starts in At mode (datetime input, no cron preview)", async () => {
    mount();
    await flush();
    expect(document.querySelector('input[type="datetime-local"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="cron-preview"]')).toBeNull();
  });

  it("Cron toggle reveals the 5-field input and preview updates live", async () => {
    mount();
    await flush();
    click(byText("Cron (recurring)"));
    expect(document.querySelector('[data-testid="cron-preview"]')?.textContent).toBe(
      "type a 5-field cron expression to preview its schedule"
    );
    setValue(input("0 3 * * 0"), "0 3 * * 0");
    expect(document.querySelector('[data-testid="cron-preview"]')?.textContent).toBe("weekly Sun 03:00");
    setValue(input("0 3 * * 0"), "*/15 * * * *");
    expect(document.querySelector('[data-testid="cron-preview"]')?.textContent).toBe("every 15 minutes");
  });

  it("invalid cron shows the rejection line AND disables save", async () => {
    mount();
    await flush();
    click(byText("Cron (recurring)"));
    const save = byText("Save schedule") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    setValue(input("0 3 * * 0"), "0 25 * *");
    expect(document.querySelector('[data-testid="cron-preview"]')?.textContent).toBe(
      "not a valid 5-field cron expression"
    );
    expect(save.disabled).toBe(true);
    setValue(input("0 3 * * 0"), "0 25 * * *");
    expect(document.querySelector('[data-testid="cron-preview"]')?.textContent).toBe(
      "not a valid 5-field cron expression"
    );
    expect(save.disabled).toBe(true);
    setValue(input("0 3 * * 0"), "0 3 * * 0");
    expect(save.disabled).toBe(false); // negative control: valid cron re-enables
  });
});

describe("ScheduleDialog — payloads match ScheduleUpdateRequest", () => {
  it("cron mode posts {kind:'cron', cron, mirrorCron:true} (recurring auto-mirror)", async () => {
    const { calls, onChanged } = mount();
    await flush();
    click(byText("Cron (recurring)"));
    setValue(input("0 3 * * 0"), "0 3 * * 0");
    click(byText("Save schedule"));
    await flush();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/fleet/nodes/n1/updates/schedule");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ kind: "cron", cron: "0 3 * * 0", mirrorCron: true });
    expect(onChanged).toHaveBeenCalled();
  });

  it("At mode posts {kind:'at', at, mirrorCron:false} with epoch-ms", async () => {
    const { calls } = mount();
    await flush();
    const save = byText("Save schedule") as HTMLButtonElement;
    expect(save.disabled).toBe(true); // nothing typed yet
    setValue(document.querySelector('input[type="datetime-local"]') as HTMLInputElement, "2026-10-13T07:00");
    expect(save.disabled).toBe(false);
    click(save);
    await flush();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/fleet/nodes/n1/updates/schedule");
    // Date.parse of the same literal the input carries — TZ-independent assertion.
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      kind: "at",
      at: Date.parse("2026-10-13T07:00"),
      mirrorCron: false,
    });
  });

  it("mirrorCron checkbox flips the payload", async () => {
    const { calls } = mount();
    await flush();
    click(byText("Cron (recurring)"));
    setValue(input("0 3 * * 0"), "0 3 * * 0");
    const box = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
    click(box); // recurring auto-mirror → unchecked by the user
    click(byText("Save schedule"));
    await flush();
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ kind: "cron", cron: "0 3 * * 0", mirrorCron: false });
  });
});

describe("ScheduleDialog — pending schedule list + cancel", () => {
  it("lists only pending schedules; Cancel DELETEs that id", async () => {
    const view = updatesView("n1", {
      schedules: [
        schedule({ id: "sch-1", kind: "cron", cron: "0 3 * * 0", status: "pending", mirrorCron: true }),
        schedule({ id: "sch-2", kind: "at", at: AT_MS, nextFire: AT_MS, status: "cancelled" }),
        schedule({ id: "sch-3", kind: "at", at: AT_MS + 1000, nextFire: AT_MS + 1000, status: "pending" }),
      ],
    });
    const { calls, onChanged } = mount("n1", view);
    await flush();
    const list = document.querySelector('[data-testid="schedule-list"]')?.textContent ?? "";
    expect(list).toContain("cron 0 3 * * 0");
    expect(list).toContain("mirrored");
    expect(list).toContain(`at ${formatEpoch(AT_MS + 1000)}`);
    expect(list).not.toContain("cancelled");

    const cancel = Array.from(document.querySelectorAll("button")).filter((b) => b.textContent === "Cancel");
    // First "Cancel" inside the list (footer has "Close"/"Save schedule")
    const listCancel = cancel.find((b) => b.closest('[data-testid="schedule-list"]'));
    click(listCancel);
    await flush();
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/fleet/nodes/n1/updates/schedule/sch-1")).toBe(true);
    expect(onChanged).toHaveBeenCalled();
  });
});

describe("formatEpoch", () => {
  it("renders UTC without reading a clock", () => {
    expect(formatEpoch(AT_MS)).toBe("2026-10-13 07:00Z");
    expect(formatEpoch(Number.NaN)).toBe("—");
  });
});
