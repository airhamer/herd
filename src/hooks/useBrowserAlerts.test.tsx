import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BADGE_COLORS, readBrowserAlertPrefs, useBrowserAlerts, writeBrowserAlertPrefs } from "./useBrowserAlerts";
import { BROWSER_ALERT_HOLD_MS, emptyDebounce, stepDebounce } from "./alertDebounce";
import { useFleetAlerts, type FleetAlertsView } from "./useFleetAlerts";
import { deriveAlerts, type FleetAlert } from "../components/OverviewPage/FleetAlertStrip";
import { BrowserAlertsSettings } from "../components/BrowserAlertsSettings";
import { makeSpark } from "../testing/fixtures";
import { flush, render } from "../testing/render";
import type { AlertInstance, SparkSnapshot } from "../api/types";

const PAGE_TITLE = "herd — fleet dashboard";
const PLAIN_ICON = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='6'/></svg>";
const HOLD = BROWSER_ALERT_HOLD_MS;

function alertRow(key: string, severity: FleetAlert["severity"] = "warning", detail?: string): FleetAlert {
  return { key, unitId: key, unitName: `Node ${key}`, label: `${key} needs attention`, severity, startsAt: null, ...(detail ? { detail } : {}) };
}

// ─── Browser doubles ─────────────────────────────────────

/** Dot colours painted onto the canvas, in order. */
let painted: string[] = [];
/** Image loads that have been requested but not finished. */
let pendingLoads: Array<() => void> = [];

class StubImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    pendingLoads.push(() => this.onload?.());
  }
}

class StubNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => StubNotification.permission);
  static log: Array<{ title: string; body?: string; tag?: string }> = [];
  onclick: (() => void) | null = null;
  constructor(title: string, options: NotificationOptions = {}) {
    StubNotification.log.push({ title, body: options.body, tag: options.tag });
  }
  close() {}
}

function secureContext(on: boolean) {
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: on });
}

/** Let pending favicon loads finish and their promises settle. */
async function finishDraws() {
  await act(async () => {
    for (const load of pendingLoads.splice(0)) load();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const favicon = () => document.head.querySelector<HTMLLinkElement>('link[rel~="icon"]')!;

function installDoubles() {
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/svg+xml";
  link.href = PLAIN_ICON;
  document.head.replaceChildren(link);
  document.title = PAGE_TITLE;
  localStorage.clear();
  painted = [];
  pendingLoads = [];
  vi.stubGlobal("Image", StubImage);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function () {
    const ctx = { fillStyle: "", drawImage() {}, beginPath() {}, arc() {}, fill: () => painted.push(ctx.fillStyle) };
    return ctx as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,DOT");
  StubNotification.permission = "granted";
  StubNotification.log = [];
  StubNotification.requestPermission.mockClear();
  vi.stubGlobal("Notification", StubNotification);
  secureContext(true);
}

function Probe(props: { rows: FleetAlert[]; ready: boolean; source: "server" | "browser" }) {
  useBrowserAlerts(props.rows, props.ready, props.source);
  return null;
}

/** Mount the hook; the returned function re-renders it with new inputs. */
function mountHook(rows: FleetAlert[], { ready = true, source = "server" as "server" | "browser" } = {}) {
  const { root } = render(<Probe rows={rows} ready={ready} source={source} />);
  return (next: FleetAlert[], opts: { ready?: boolean; source?: "server" | "browser" } = {}) =>
    act(() => root.render(<Probe rows={next} ready={opts.ready ?? true} source={opts.source ?? source} />));
}

const enable = (prefs: { tabBadge?: boolean; desktop?: boolean }) => writeBrowserAlertPrefs({ tabBadge: false, desktop: false, ...prefs });
const notified = () => StubNotification.log.map((n) => n.title);

describe("useBrowserAlerts: tab badge", () => {
  beforeEach(installDoubles);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("is off by default: title and icon are left alone", async () => {
    expect(readBrowserAlertPrefs()).toEqual({ tabBadge: false, desktop: false });
    mountHook([alertRow("a", "critical")]);
    await finishDraws();
    expect(document.title).toBe(PAGE_TITLE);
    expect(favicon().getAttribute("href")).toBe(PLAIN_ICON);
  });

  it("prefixes the title with the count and removes it when everything clears", () => {
    enable({ tabBadge: true });
    const rerender = mountHook([alertRow("a"), alertRow("b")]);
    expect(document.title).toBe(`(2) ${PAGE_TITLE}`);
    rerender([alertRow("a")]);
    expect(document.title).toBe(`(1) ${PAGE_TITLE}`);
    rerender([]);
    expect(document.title).toBe(PAGE_TITLE);
  });

  it("paints a red dot when anything is critical, amber otherwise, and restores the original icon", async () => {
    enable({ tabBadge: true });
    const rerender = mountHook([alertRow("a"), alertRow("b", "critical")]);
    await finishDraws();
    expect(painted.at(-1)).toBe(BADGE_COLORS.critical);
    expect(favicon().getAttribute("href")).toBe("data:image/png;base64,DOT");
    expect(favicon().getAttribute("type")).toBe("image/png");

    rerender([alertRow("a")]);
    await finishDraws();
    expect(painted.at(-1)).toBe(BADGE_COLORS.warning);

    rerender([]);
    expect(favicon().getAttribute("href")).toBe(PLAIN_ICON);
    expect(favicon().getAttribute("type")).toBe("image/svg+xml");
  });

  it("discards a draw that finishes after the alerts have cleared", async () => {
    enable({ tabBadge: true });
    const rerender = mountHook([alertRow("a")]);
    rerender([]);
    await finishDraws();
    expect(favicon().getAttribute("href")).toBe(PLAIN_ICON);
  });

  it("shows nothing until ready", () => {
    enable({ tabBadge: true });
    const rerender = mountHook([alertRow("a")], { ready: false });
    expect(document.title).toBe(PAGE_TITLE);
    rerender([alertRow("a")], { ready: true });
    expect(document.title).toBe(`(1) ${PAGE_TITLE}`);
  });

  it("puts the page back on unmount", async () => {
    enable({ tabBadge: true });
    const { root } = render(<Probe rows={[alertRow("a")]} ready source="server" />);
    await finishDraws();
    act(() => root.unmount());
    expect(document.title).toBe(PAGE_TITLE);
    expect(favicon().getAttribute("href")).toBe(PLAIN_ICON);
  });
});

describe("useBrowserAlerts: desktop notifications", () => {
  beforeEach(() => {
    installDoubles();
    enable({ desktop: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("server source: rows present when ready are the baseline; later ones notify once", () => {
    const rerender = mountHook([alertRow("a")]);
    expect(notified()).toEqual([]);
    rerender([alertRow("a"), alertRow("b", "critical", "GPU at 91°C")]);
    rerender([alertRow("a"), alertRow("b", "critical", "GPU at 91°C")]);
    expect(StubNotification.log).toEqual([{ title: "Critical · Node b", body: "b needs attention — GPU at 91°C", tag: "b" }]);
  });

  it("a source switch starts a new baseline", () => {
    const rerender = mountHook([alertRow("a")]);
    rerender([alertRow("a"), alertRow("c")], { source: "browser" });
    expect(notified()).toEqual([]);
  });

  it("browser source: a new condition must last the hold time before it counts", () => {
    vi.useFakeTimers();
    enable({ tabBadge: true, desktop: true });
    const rerender = mountHook([], { source: "browser" });
    rerender([alertRow("a")]);
    expect(document.title).toBe(PAGE_TITLE);
    act(() => vi.advanceTimersByTime(HOLD - 1));
    expect(notified()).toEqual([]);
    act(() => vi.advanceTimersByTime(1));
    expect(document.title).toBe(`(1) ${PAGE_TITLE}`);
    expect(notified()).toEqual(["Warning · Node a"]);
  });

  it("browser source: flapping notifies once and clears only after the hold time", () => {
    vi.useFakeTimers();
    enable({ tabBadge: true, desktop: true });
    const rerender = mountHook([], { source: "browser" });
    rerender([alertRow("a")]);
    act(() => vi.advanceTimersByTime(HOLD));
    for (let i = 0; i < 4; i++) {
      rerender([]);
      act(() => vi.advanceTimersByTime(5_000));
      rerender([alertRow("a")]);
      act(() => vi.advanceTimersByTime(5_000));
    }
    expect(notified()).toEqual(["Warning · Node a"]);
    rerender([]);
    act(() => vi.advanceTimersByTime(HOLD - 1));
    expect(document.title).toBe(`(1) ${PAGE_TITLE}`);
    act(() => vi.advanceTimersByTime(1));
    expect(document.title).toBe(PAGE_TITLE);
  });

  it("browser source: problems present at page open count at once without notifying", () => {
    enable({ tabBadge: true, desktop: true });
    mountHook([alertRow("a"), alertRow("b")], { source: "browser" });
    expect(document.title).toBe(`(2) ${PAGE_TITLE}`);
    expect(notified()).toEqual([]);
  });

  it("stays silent without permission, without the preference, or outside a secure context", () => {
    const cases: Array<() => void> = [
      () => (StubNotification.permission = "denied"),
      () => enable({ desktop: false }),
      () => secureContext(false),
    ];
    for (const setup of cases) {
      installDoubles();
      enable({ desktop: true });
      setup();
      const rerender = mountHook([]);
      rerender([alertRow("z")]);
    }
    expect(notified()).toEqual([]);
  });
});

describe("stepDebounce", () => {
  it("waits the hold time to show and to clear, and reports when to check again", () => {
    const state = emptyDebounce();
    const a = alertRow("a");
    expect(stepDebounce(state, [a], 1_000, 100)).toEqual({ visible: [], nextCheckAt: 1_100 });
    expect(stepDebounce(state, [a], 1_100, 100)).toEqual({ visible: [a], nextCheckAt: null });
    expect(stepDebounce(state, [], 1_200, 100)).toEqual({ visible: [a], nextCheckAt: 1_300 });
    expect(stepDebounce(state, [], 1_300, 100)).toEqual({ visible: [], nextCheckAt: null });
  });

  it("forgets a condition that vanished before it was held long enough", () => {
    const state = emptyDebounce();
    stepDebounce(state, [alertRow("a")], 0, 100);
    expect(stepDebounce(state, [], 50, 100)).toEqual({ visible: [], nextCheckAt: null });
    expect(stepDebounce(state, [alertRow("a")], 60, 100).nextCheckAt).toBe(160);
  });

  it("a seed step counts present rows immediately and keeps the newest row data", () => {
    const state = emptyDebounce();
    expect(stepDebounce(state, [alertRow("a")], 0, 100, true).visible).toHaveLength(1);
    const updated = { ...alertRow("a"), label: "changed" };
    expect(stepDebounce(state, [updated], 10, 100).visible).toEqual([updated]);
  });
});

describe("BrowserAlertsSettings", () => {
  beforeEach(installDoubles);
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const switchNamed = (name: string) => document.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${name}"]`)!;

  it("renders two setting rows, both off; the tab badge saves on click", () => {
    render(<BrowserAlertsSettings />);
    expect(document.querySelectorAll(".set-row")).toHaveLength(2);
    expect(switchNamed("Tab badge").getAttribute("aria-checked")).toBe("false");
    expect(switchNamed("Desktop notifications").getAttribute("aria-checked")).toBe("false");
    act(() => switchNamed("Tab badge").click());
    expect(switchNamed("Tab badge").getAttribute("aria-checked")).toBe("true");
    expect(readBrowserAlertPrefs().tabBadge).toBe(true);
  });

  it("asks for permission on the click only, and turns on when granted", async () => {
    StubNotification.permission = "default";
    StubNotification.requestPermission.mockImplementationOnce(async () => "granted");
    render(<BrowserAlertsSettings />);
    expect(StubNotification.requestPermission).not.toHaveBeenCalled();
    act(() => switchNamed("Desktop notifications").click());
    await flush();
    expect(StubNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(readBrowserAlertPrefs().desktop).toBe(true);
    expect(switchNamed("Desktop notifications").getAttribute("aria-checked")).toBe("true");
  });

  it("explains a denied permission and stays off", async () => {
    StubNotification.permission = "denied";
    render(<BrowserAlertsSettings />);
    act(() => switchNamed("Desktop notifications").click());
    await flush();
    expect(readBrowserAlertPrefs().desktop).toBe(false);
    expect(document.querySelector('[role="note"]')?.textContent).toContain("Notifications are blocked for this site");
  });

  it("over plain HTTP the desktop switch is disabled and a note points to HTTPS or localhost", () => {
    secureContext(false);
    render(<BrowserAlertsSettings />);
    expect(switchNamed("Desktop notifications").disabled).toBe(true);
    expect(document.querySelector('[role="note"]')?.textContent).toContain("HTTPS or localhost");
  });
});

describe("useFleetAlerts", () => {
  let view: FleetAlertsView | null = null;
  function Capture(props: Parameters<typeof useFleetAlerts>[0]) {
    view = useFleetAlerts(props);
    return null;
  }
  const base = { alertsEnabled: false, serverAlerts: null as AlertInstance[] | null, showExceptions: true, temperatureUnit: "celsius" as const };

  it("matches the strip's own derivation, including showExceptions", () => {
    const sparks: SparkSnapshot[] = [makeSpark("a", false), makeSpark("b")];
    render(<Capture sparks={sparks} {...base} />);
    expect(view).toEqual({ rows: deriveAlerts(sparks), ready: true, source: "browser" });

    render(<Capture sparks={sparks} {...base} showExceptions={false} />);
    expect(view!.rows).toEqual([]);
  });

  it("is not ready without units", () => {
    render(<Capture sparks={[]} {...base} />);
    expect(view!.ready).toBe(false);
  });

  it("with notifications on, waits for the server's set and then uses it", () => {
    const sparks = [makeSpark("a", false)];
    render(<Capture sparks={sparks} {...base} alertsEnabled />);
    expect(view).toMatchObject({ ready: false, source: "browser" });

    const server: AlertInstance = {
      key: "q:disk",
      ruleId: "disk",
      ruleName: "Disk",
      unitId: "q",
      unitName: "Q",
      severity: "warning",
      state: "firing",
      label: "Disk nearly full",
      summary: "95% used",
      startsAt: 5,
      firingAt: 6,
    };
    render(<Capture sparks={sparks} {...base} alertsEnabled serverAlerts={[server]} />);
    expect(view).toMatchObject({ ready: true, source: "server" });
    expect(view!.rows.map((r) => r.key)).toEqual(["q:disk"]);
  });
});
