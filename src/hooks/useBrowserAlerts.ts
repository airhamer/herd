import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FleetAlert } from "../components/OverviewPage/FleetAlertStrip";
import { BROWSER_ALERT_HOLD_MS, emptyDebounce, stepDebounce, type DebounceState } from "./alertDebounce";

/*
 * Per-browser alert signals: "(N) title" on the tab, a coloured dot on the
 * favicon and OS notifications for alerts that become active while the page
 * is open. Both are opt-in and stored in localStorage (the notification
 * permission is per browser anyway). localStorage can throw (private mode,
 * strict policies), so every access is guarded.
 */

// ─── Preferences ─────────────────────────────────────────

const PREFS_KEY = "sparkdash.browserAlerts";
const PREFS_EVENT = "sparkdash:browser-alerts";

export interface BrowserAlertPrefs {
  /** Count in the tab title plus a red/amber favicon dot. */
  tabBadge: boolean;
  /** OS notification when an alert starts. */
  desktop: boolean;
}

export const DEFAULT_BROWSER_ALERT_PREFS: BrowserAlertPrefs = Object.freeze({ tabBadge: false, desktop: false });

function storedPrefsText(): string | null {
  try {
    return localStorage.getItem(PREFS_KEY);
  } catch {
    return null;
  }
}

function parsePrefs(text: string | null): BrowserAlertPrefs {
  if (!text) return { ...DEFAULT_BROWSER_ALERT_PREFS };
  try {
    const value = JSON.parse(text) as Partial<BrowserAlertPrefs> | null;
    return { tabBadge: value?.tabBadge === true, desktop: value?.desktop === true };
  } catch {
    return { ...DEFAULT_BROWSER_ALERT_PREFS };
  }
}

export function readBrowserAlertPrefs(): BrowserAlertPrefs {
  return parsePrefs(storedPrefsText());
}

/** Prefs set on this page when storage refused the write; they still apply until reload. */
let unsavedPrefs: BrowserAlertPrefs | null = null;

export function writeBrowserAlertPrefs(prefs: BrowserAlertPrefs): void {
  const next = { tabBadge: prefs.tabBadge === true, desktop: prefs.desktop === true };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    unsavedPrefs = null;
  } catch {
    unsavedPrefs = next;
  }
  window.dispatchEvent(new Event(PREFS_EVENT));
}

let cached: { text: string | null; unsaved: BrowserAlertPrefs | null; prefs: BrowserAlertPrefs } | null = null;

function prefsSnapshot(): BrowserAlertPrefs {
  const text = storedPrefsText();
  if (!cached || cached.text !== text || cached.unsaved !== unsavedPrefs) {
    cached = { text, unsaved: unsavedPrefs, prefs: unsavedPrefs ?? parsePrefs(text) };
  }
  return cached.prefs;
}

function subscribePrefs(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === PREFS_KEY) onChange();
  };
  window.addEventListener(PREFS_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PREFS_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** The prefs, shared by every component on the page and kept in sync with other tabs. */
export function useBrowserAlertPrefs(): [BrowserAlertPrefs, (next: BrowserAlertPrefs) => void] {
  const prefs = useSyncExternalStore(subscribePrefs, prefsSnapshot, () => DEFAULT_BROWSER_ALERT_PREFS);
  return [prefs, writeBrowserAlertPrefs];
}

// ─── Notification support ───────────────────────────────

/**
 * "insecure": the page is not HTTPS/localhost, where browsers refuse the
 * Notification API; the settings show an explanation instead of a dead switch.
 */
export type NotificationSupport = "ok" | "insecure" | "unsupported";

export function notificationSupport(): NotificationSupport {
  if (typeof window === "undefined") return "unsupported";
  if (window.isSecureContext !== true) return "insecure";
  return typeof window.Notification === "function" ? "ok" : "unsupported";
}

// ─── Favicon badge ──────────────────────────────────────

export const BADGE_COLORS = Object.freeze({ critical: "#dc2626", warning: "#f59e0b" });

/** Some browsers rasterise a dimensionless SVG at 300×150; add explicit dimensions. */
function withSvgSize(href: string, px: number): string {
  const prefix = "data:image/svg+xml";
  if (!href.startsWith(prefix)) return href;
  const comma = href.indexOf(",");
  if (comma < 0) return href;
  try {
    const head = href.slice(0, comma);
    const payload = href.slice(comma + 1);
    const svg = head.endsWith(";base64") ? atob(payload) : decodeURIComponent(payload);
    const open = /<svg\b[^>]*>/.exec(svg);
    if (!open || /\swidth\s*=/.test(open[0])) return href;
    return `${prefix},${encodeURIComponent(svg.replace("<svg", `<svg width="${px}" height="${px}"`))}`;
  } catch {
    return href;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not load the favicon"));
    img.src = src;
  });
}

/** Render `href` with a dot of `color` at the top right; returns a PNG data URL (null without a 2D context). */
export async function drawBadgedFavicon(href: string, color: string, size = 64): Promise<string | null> {
  const img = await loadImage(withSvgSize(href, size));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  const radius = Math.round(size * 0.2);
  const centre = { x: size - radius - 3, y: radius + 3 };
  // An outline keeps the dot visible on both light and dark tab bars.
  for (const [fill, r] of [["#0b0b0b", radius + 3], [color, radius]] as const) {
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = fill;
    ctx.fill();
  }
  return canvas.toDataURL("image/png");
}

function iconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
}

type IconAttrs = { href: string | null; type: string | null };

function setIcon(link: HTMLLinkElement, attrs: IconAttrs) {
  for (const name of ["href", "type"] as const) {
    const value = attrs[name];
    if (value == null) link.removeAttribute(name);
    else link.setAttribute(name, value);
  }
}

// ─── Counting ───────────────────────────────────────────

/**
 * The rows that count for badge and notifications, or null before the first
 * ready step for the current source. Server rows pass straight through (the
 * server has its own hold times); browser rows are debounced.
 */
export function useCountedAlerts(rows: FleetAlert[], ready: boolean, source: string, holdMs = BROWSER_ALERT_HOLD_MS): FleetAlert[] | null {
  const [result, setResult] = useState<{ source: string; rows: FleetAlert[] } | null>(null);
  const debounce = useRef<{ source: string; state: DebounceState; first: boolean }>({ source: "", state: emptyDebounce(), first: true });

  useEffect(() => {
    if (!ready) return;
    if (source === "server") {
      setResult({ source, rows });
      return;
    }
    if (debounce.current.source !== source) debounce.current = { source, state: emptyDebounce(), first: true };
    const d = debounce.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      const { visible, nextCheckAt } = stepDebounce(d.state, rows, Date.now(), holdMs, d.first);
      d.first = false;
      setResult({ source, rows: visible });
      if (nextCheckAt !== null) timer = setTimeout(run, Math.max(0, nextCheckAt - Date.now()));
    };
    run();
    return () => clearTimeout(timer);
  }, [rows, ready, source, holdMs]);

  // Leaving the browser source discards its debounce history.
  useEffect(() => {
    if (source === "server") debounce.current = { source: "", state: emptyDebounce(), first: true };
  }, [source]);

  if (!ready || result === null || result.source !== source) return null;
  return result.rows;
}

// ─── The hook ───────────────────────────────────────────

const COUNT_PREFIX = /^\(\d+\)\s+/;

function notificationTitle(row: FleetAlert): string {
  return `${row.severity === "critical" ? "Critical" : "Warning"} · ${row.unitName}`;
}

/**
 * Drives the tab badge and desktop notifications from `rows`. Nothing happens
 * until `ready`; the rows present at the first counted state (and again after
 * `source` switches between server and browser) are the baseline and do not
 * notify, since the same problems would otherwise be announced twice.
 */
export function useBrowserAlerts(rows: FleetAlert[], ready: boolean, source: "server" | "browser" = "browser"): void {
  const [prefs] = useBrowserAlertPrefs();
  const counted = useCountedAlerts(rows, ready, source);
  const count = counted ? counted.length : 0;
  const worst: keyof typeof BADGE_COLORS | null = !counted || count === 0 ? null : counted.some((r) => r.severity === "critical") ? "critical" : "warning";
  const showBadge = prefs.tabBadge && worst !== null;

  // What the page looked like before we touched it, captured once.
  const pageTitle = useRef<string | null>(null);
  const pageIcon = useRef<IconAttrs | null>(null);
  const drawSeq = useRef(0);

  useEffect(() => {
    pageTitle.current ??= document.title.replace(COUNT_PREFIX, "");
    document.title = showBadge ? `(${count}) ${pageTitle.current}` : pageTitle.current;
  }, [showBadge, count]);

  useEffect(() => {
    const link = iconLink();
    if (!link) return;
    pageIcon.current ??= { href: link.getAttribute("href"), type: link.getAttribute("type") };
    const original = pageIcon.current;
    const seq = ++drawSeq.current;
    if (!showBadge || worst === null || original.href == null) {
      setIcon(link, original);
      return;
    }
    drawBadgedFavicon(original.href, BADGE_COLORS[worst]).then(
      (png) => {
        // Ignore a draw that a newer state (or clearing) has overtaken.
        if (png && seq === drawSeq.current) setIcon(link, { href: png, type: "image/png" });
      },
      () => {
        /* plain icon stays; the title still shows the count */
      }
    );
  }, [showBadge, worst]);

  useEffect(
    () => () => {
      drawSeq.current++;
      if (pageTitle.current !== null) document.title = pageTitle.current;
      const link = iconLink();
      if (link && pageIcon.current?.href != null) setIcon(link, pageIcon.current);
    },
    []
  );

  const baseline = useRef<{ source: string; keys: Set<string> } | null>(null);
  useEffect(() => {
    if (counted === null) return;
    const before = baseline.current?.source === source ? baseline.current.keys : null;
    baseline.current = { source, keys: new Set(counted.map((r) => r.key)) };
    if (!before || !prefs.desktop) return;
    if (notificationSupport() !== "ok" || Notification.permission !== "granted") return;
    for (const row of counted.filter((r) => !before.has(r.key))) {
      try {
        const note = new Notification(notificationTitle(row), {
          body: row.detail ? `${row.label} — ${row.detail}` : row.label,
          // Reusing the alert key lets the OS replace rather than stack.
          tag: row.key,
        });
        note.onclick = () => {
          window.focus();
          note.close();
        };
      } catch {
        /* some platforms (Android Chrome) only allow notifications from a service worker */
      }
    }
  }, [counted, source, prefs.desktop]);
}
