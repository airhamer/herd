// Length caps for text that comes from units (SSH errors, kernel lines,
// finding titles) before it reaches a notification, the API or the log.
// docs/specs/alerts.md §3. Clean-room implementation (LIC1).

export const MAX_NAME_CHARS = 60;
export const MAX_SUMMARY_CHARS = 120;

// C0/C1 control characters plus any whitespace, collapsed to one space.
const NOISE = /[\s\u0000-\u001f\u007f-\u009f]+/gu;

/**
 * One-line, length-bounded text. Counts code points, so an emoji is never
 * split; anything cut ends in "…" and is exactly `max` code points long.
 */
export function capText(value, max = MAX_SUMMARY_CHARS) {
  if (value === null || value === undefined) return "";
  const flat = String(value).replace(NOISE, " ").trim();
  const points = Array.from(flat);
  if (points.length <= max) return flat;
  return `${points.slice(0, Math.max(0, max - 1)).join("")}…`;
}
