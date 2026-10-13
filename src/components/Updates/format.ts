// Update-display formatting for server-derived fields (docs/SPEC-UPDATES.md
// §6.2/§6.3; BATCH6 binding rules). Pure — no clock reads anywhere: elapsed
// time comes from the server-computed view.graceElapsedMs, keeping renders
// deterministic (no Date.now() in any component render path).

import type { NodeUpdatesView } from "../../api/types";

/** Mirrors RECOVER_GRACE_MS in server/fleet/waveSequencer.js + server/index.js. */
export const RECOVER_GRACE_MS = 6 * 60_000;

/** §6.3 inline notice when a single-node trigger gets a 409 (trigger guard). */
export const WAVE_LOCK_NOTICE =
  "a wave is open; single-node updates are locked until it completes";

/** graceElapsedMs → "4:12" (minutes keep climbing past 59: "62:00"). */
export function formatGrace(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * §6.3 grace text: `REBOOTING 4:12`; at/past the grace window:
 * `SLOW 22:41 — firmware may run long`.
 */
export function graceLabel(
  display: "rebooting" | "slow",
  graceElapsedMs: number | null,
  graceMs: number = RECOVER_GRACE_MS
): string {
  const time = graceElapsedMs != null ? formatGrace(graceElapsedMs) : "…";
  const slow = display === "slow" || (graceElapsedMs != null && graceElapsedMs >= graceMs);
  return slow ? `SLOW ${time} — firmware may run long` : `REBOOTING ${time}`;
}

/** Row state label — renders server-derived display (+ stage/grace fields). */
export function statusLabel(view: NodeUpdatesView, graceMs: number = RECOVER_GRACE_MS): string {
  switch (view.display) {
    case "current":
      return "current";
    case "available":
      return "update available";
    case "updating":
      return `updating: ${view.state?.stage ?? "…"}`;
    case "rebooting":
    case "slow":
      return graceLabel(view.display, view.graceElapsedMs, graceMs);
    case "stale":
      return "probe stale";
    case "failed":
      return "failed";
  }
}

/** Row state tone class. */
export function statusTone(view: NodeUpdatesView): string {
  switch (view.display) {
    case "failed":
    case "stale":
      return "text-danger";
    case "available":
      return "text-warning";
    case "updating":
    case "rebooting":
    case "slow":
      return "text-accent";
    default:
      return "text-muted";
  }
}
