import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertsDialog } from "./AlertsDialog";
import { SettingsDialog } from "./SettingsDialog";
import type { AlertRule, AlertsConfig } from "../api/types";
import { flush, render } from "../testing/render";

type Call = { method: string; path: string; body?: Record<string, unknown> };

const rule = (id: string, source: AlertRule["source"], name: string, enabled = true, forSec = 60): AlertRule => ({
  id,
  source,
  name,
  description: `${name} rule`,
  defaults: { enabled, forSec },
  overrides: {},
});

/** A tiny in-memory backend for the endpoints the dialogs use. */
function fakeBackend({ alertsOn, testReply = { ok: false, error: "HTTP 500" } }: { alertsOn: boolean; testReply?: object }) {
  const state = { alertsOn };
  const calls: Call[] = [];
  const configNow = (): AlertsConfig => ({
    enabled: state.alertsOn,
    repeatIntervalMin: 0,
    rules: [rule("offline", "strip", "Unit offline"), rule("thermal", "health", "GPU temperature"), rule("concurrency", "health", "Several models loaded", false, 300)],
    channels: [
      {
        id: "ch_1",
        name: "Phone",
        type: "ntfy",
        url: "http://ntfy.lan…opic",
        hasUrl: true,
        enabled: true,
        minSeverity: "warning",
        status: { lastSentAt: null, lastError: "HTTP 403", lastErrorAt: 1 },
      },
    ],
  });
  const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      switch (`${method} ${path}`) {
        case "PUT /api/settings":
          state.alertsOn = body.alertsEnabled === true;
          return reply({ alertsEnabled: state.alertsOn });
        case "GET /api/settings":
          return reply({ alertsEnabled: state.alertsOn, pollIntervalMs: 2000, temperatureUnit: "celsius", defaultLlmPort: 8888 });
        case "GET /api/alerts/config":
        case "PUT /api/alerts/config":
          return reply(configNow());
        case "POST /api/alerts/test":
          return reply(testReply);
        case "GET /api/alerts":
          return reply({ enabled: state.alertsOn, active: [], pending: [], recent: [] });
        default:
          return reply({});
      }
    })
  );
  return { calls, last: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).at(-1) };
}

async function settled() {
  for (let i = 0; i < 3; i++) await flush();
}

async function openDialog(onSettingsSaved = vi.fn()) {
  render(<AlertsDialog open onClose={() => {}} onSettingsSaved={onSettingsSaved} />);
  await settled();
  return document.querySelector<HTMLElement>('[role="dialog"]')!;
}

const byLabel = <T extends Element = HTMLElement>(root: ParentNode, label: string) => root.querySelector<T & Element>(`[aria-label="${label}"]`)!;
const buttonNamed = (root: ParentNode, text: string) => Array.from(root.querySelectorAll("button")).find((b) => b.textContent?.trim() === text)!;

function setInputValue(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AlertsDialog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts locked when off; the master switch saves immediately and unlocks editing", async () => {
    const backend = fakeBackend({ alertsOn: false });
    const saved = vi.fn();
    const dlg = await openDialog(saved);
    const master = byLabel<HTMLButtonElement>(dlg, "Send notifications");

    expect(master.getAttribute("aria-checked")).toBe("false");
    expect(dlg.querySelector("fieldset")?.disabled).toBe(true);
    expect(buttonNamed(dlg, "Save").disabled).toBe(true);

    act(() => master.click());
    await settled();

    expect(backend.last("PUT", "/api/settings")?.body).toEqual({ alertsEnabled: true });
    expect(saved).toHaveBeenCalledWith({ alertsEnabled: true });
    expect(master.getAttribute("aria-checked")).toBe("true");
    expect(dlg.querySelector("fieldset")?.disabled).toBe(false);
  });

  it("groups rules by source as setting rows with a switch and a wait, no thresholds", async () => {
    fakeBackend({ alertsOn: true });
    const dlg = await openDialog();
    const overview = byLabel(dlg, "Overview exceptions");
    const health = byLabel(dlg, "Health findings");

    expect(overview.querySelectorAll(".set-row")).toHaveLength(1);
    expect(health.querySelectorAll(".set-row")).toHaveLength(2);
    expect(byLabel(health, "Several models loaded notifications").getAttribute("aria-checked")).toBe("false");
    expect(byLabel<HTMLInputElement>(health, "GPU temperature wait (seconds)").value).toBe("60");
    expect(dlg.querySelectorAll('input[type="number"]')).toHaveLength(3);
    expect(dlg.textContent).not.toContain("°C");
  });

  it("shows a channel's stored delivery failure", async () => {
    fakeBackend({ alertsOn: true });
    const dlg = await openDialog();
    expect(byLabel(dlg, "Channels").textContent).toContain("Last send failed: HTTP 403");
  });

  it("Save sends only the rule values that differ from the defaults, and channels without read-only fields", async () => {
    const backend = fakeBackend({ alertsOn: true });
    const dlg = await openDialog();

    setInputValue(byLabel<HTMLInputElement>(dlg, "GPU temperature wait (seconds)"), "120");
    act(() => byLabel<HTMLButtonElement>(dlg, "Unit offline notifications").click());
    expect(dlg.textContent).toContain("Unsaved changes");
    act(() => buttonNamed(dlg, "Save").click());
    await settled();

    const body = backend.last("PUT", "/api/alerts/config")!.body as { rules: object; channels: Array<Record<string, unknown>> };
    expect(body.rules).toEqual({ offline: { enabled: false }, thermal: { forSec: 120 } });
    expect(body.channels).toEqual([{ id: "ch_1", name: "Phone", type: "ntfy", url: "http://ntfy.lan…opic", enabled: true, minSeverity: "warning" }]);
    expect(dlg.textContent).toContain("Saved");
  });

  it("refuses to save a wait that is not a number", async () => {
    const backend = fakeBackend({ alertsOn: true });
    const dlg = await openDialog();
    setInputValue(byLabel<HTMLInputElement>(dlg, "Unit offline wait (seconds)"), "");
    act(() => buttonNamed(dlg, "Save").click());
    await settled();
    expect(backend.last("PUT", "/api/alerts/config")).toBeUndefined();
    expect(dlg.querySelector('[role="alert"]')?.textContent).toMatch(/Unit offline/);
  });

  it("Send test posts the draft with its id and shows the server's short result", async () => {
    const backend = fakeBackend({ alertsOn: true });
    const dlg = await openDialog();
    act(() => buttonNamed(dlg, "Send test").click());
    await settled();

    expect(backend.last("POST", "/api/alerts/test")?.body).toMatchObject({ channelId: "ch_1", channel: { type: "ntfy", url: "http://ntfy.lan…opic" } });
    expect(dlg.querySelector('[role="status"].field-hint')?.textContent).toBe("HTTP 500");
  });

  it("a successful test reads Sent", async () => {
    fakeBackend({ alertsOn: true, testReply: { ok: true, status: 200 } });
    const dlg = await openDialog();
    act(() => buttonNamed(dlg, "Send test").click());
    await settled();
    expect(byLabel(dlg, "Channels").querySelector('[role="status"]')?.textContent).toBe("Sent");
  });
});

describe("Settings → Alert notifications", () => {
  beforeEach(() => fakeBackend({ alertsOn: false }));
  afterEach(() => vi.unstubAllGlobals());

  it("reports Off, opens the dialog, and Escape only closes the top dialog", async () => {
    const closeSettings = vi.fn();
    render(<SettingsDialog open onClose={closeSettings} onSaved={() => {}} />);
    await settled();
    expect(document.querySelector('[data-testid="alerts-state"]')?.textContent).toBe("Off");

    act(() => buttonNamed(document, "Configure…").click());
    await settled();
    expect(byLabel(document, "Send notifications")).toBeTruthy();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await settled();
    expect(closeSettings).not.toHaveBeenCalled();
  });
});
