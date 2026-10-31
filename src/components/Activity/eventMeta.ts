// Presentation helpers for activity events (issue #32).
import type { ActivitySeverity } from "../../api/types";

export interface ActivityCategory {
  id: string;
  label: string;
  /** Type prefixes (trailing dot) or exact types sent as ?type=. Empty = all. */
  types: string[];
}

export const ACTIVITY_CATEGORIES: ActivityCategory[] = [
  { id: "all", label: "All", types: [] },
  { id: "units", label: "Nodes", types: ["spark.", "node."] },
  { id: "gpu", label: "GPU & health", types: ["gpu.", "health."] },
  { id: "services", label: "Services", types: ["service.", "container.", "component."] },
  { id: "alerts", label: "Alerts", types: ["alert."] },
  { id: "power", label: "Power & updates", types: ["power.", "update."] },
  { id: "bench", label: "Benchmarks", types: ["bench.", "showcase."] },
];

const SEVERITY_COLOR: Record<ActivitySeverity, string> = {
  info: "var(--color-muted)",
  success: "var(--color-success)",
  warn: "var(--color-warning)",
  error: "var(--color-danger)",
};

export function severityColor(severity: string): string {
  return SEVERITY_COLOR[severity as ActivitySeverity] ?? SEVERITY_COLOR.info;
}

export const SEVERITY_LABEL: Record<ActivitySeverity, string> = {
  info: "Info",
  success: "OK",
  warn: "Warning",
  error: "Error",
};
