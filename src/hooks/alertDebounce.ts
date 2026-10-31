/**
 * Browser-side hysteresis for alert rows the page computes on its own (server
 * alerts off). A row only starts counting after it has been present for
 * `holdMs`, and only stops counting after it has been gone for `holdMs`, so a
 * value hovering at a threshold produces one badge change and one desktop
 * notification instead of many. Server alerts are already debounced by the
 * alert engine and bypass this.
 */
import type { FleetAlert } from "../components/OverviewPage/FleetAlertStrip";

/** Hold time (ms) in both directions for browser-derived rows. */
export const BROWSER_ALERT_HOLD_MS = 30_000;

type Tracked =
  /** Present, not counted yet; `since` = first time it was seen. */
  | { phase: "rising"; since: number; row: FleetAlert }
  /** Counted; `goneAt` = when it disappeared, null while still present. */
  | { phase: "counted"; goneAt: number | null; row: FleetAlert };

export type DebounceState = Map<string, Tracked>;

export function emptyDebounce(): DebounceState {
  return new Map();
}

/**
 * Advance `state` to `now` with the current `rows`. When `seed` is true (the
 * very first ready step) every present row counts immediately: problems that
 * exist when the page opens are shown without a wait.
 * @returns rows counted now, plus the earliest time something can change
 *   without new input (null when nothing is waiting).
 */
export function stepDebounce(
  state: DebounceState,
  rows: FleetAlert[],
  now: number,
  holdMs: number = BROWSER_ALERT_HOLD_MS,
  seed = false
): { visible: FleetAlert[]; nextCheckAt: number | null } {
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.key);
    const t = state.get(row.key);
    if (t?.phase === "counted") {
      state.set(row.key, { phase: "counted", goneAt: null, row });
    } else {
      const since = seed ? now - holdMs : (t?.since ?? now);
      state.set(row.key, now - since >= holdMs ? { phase: "counted", goneAt: null, row } : { phase: "rising", since, row });
    }
  }

  let wake = Infinity;
  const visible: FleetAlert[] = [];
  for (const [key, t] of state) {
    if (!seen.has(key)) {
      if (t.phase === "rising") {
        state.delete(key);
        continue;
      }
      const goneAt = t.goneAt ?? now;
      if (now - goneAt >= holdMs) {
        state.delete(key);
        continue;
      }
      t.goneAt = goneAt;
    }
    if (t.phase === "rising") wake = Math.min(wake, t.since + holdMs);
    else {
      visible.push(t.row);
      if (t.goneAt !== null) wake = Math.min(wake, t.goneAt + holdMs);
    }
  }
  return { visible, nextCheckAt: Number.isFinite(wake) ? wake : null };
}
