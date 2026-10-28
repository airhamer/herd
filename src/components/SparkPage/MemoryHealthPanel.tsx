import { useEffect, useState } from "react";
import { fetchMemoryHealth } from "../../api/client";
import type { MemoryServiceResult, MemoryStatus } from "../../api/types";
import { Panel } from "../ui/Panel";

/** Poll cadence for the memory-health endpoint, same 30 s as the other status panels. */
export const MEMORY_HEALTH_POLL_MS = 30_000;

/** Hand-rolled database-stack glyph in the fork's inline-SVG idiom (see ui/icons.tsx). */
function MemoryIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
      className={className}
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5" />
      <path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3" />
    </svg>
  );
}

/** Status → badge classes: ok green, degraded amber, unknown muted (GuardPanel map). */
const STATUS_BADGE: Record<MemoryStatus, string> = {
  ok: "bg-success/15 text-success",
  degraded: "bg-warning/15 text-warning",
  unknown: "bg-border text-muted",
};

export interface MemoryHealthSummary {
  total: number;
  ok: number;
  degraded: number;
  unknown: number;
}

/**
 * Fleet-level counts for the panel header badge: services on file and how
 * many report each status.
 */
export function memoryHealthSummary(
  services: readonly MemoryServiceResult[],
): MemoryHealthSummary {
  const summary: MemoryHealthSummary = { total: services.length, ok: 0, degraded: 0, unknown: 0 };
  for (const service of services) summary[service.status] += 1;
  return summary;
}

/**
 * Poll the memory-health endpoint while mounted (setInterval + cancelled
 * flag, the useGuardStatus idiom). The last good answer stays on screen
 * across a failed refresh; the first failure before any answer sets `error`.
 */
function useMemoryHealthStatus(fetcher: () => Promise<{ services: MemoryServiceResult[] }>) {
  const [data, setData] = useState<{ services: MemoryServiceResult[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetcher()
        .then((res) => {
          if (cancelled) return;
          setData(res);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    };
    load();
    const timer = setInterval(load, MEMORY_HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fetcher]);

  return { data, error };
}

export interface MemoryHealthPanelProps {
  className?: string;
  /**
   * Injectable fetcher (tests pass a stub; production default is
   * fetchMemoryHealth, GET /api/memory-health). The component itself never
   * calls fetch directly.
   */
  fetcher?: () => Promise<{ services: MemoryServiceResult[] }>;
}

/**
 * AI-memory service health panel (S5.1b): one row per configured memory
 * service from the tolerant server probe (server/health/memoryProbe.js →
 * GET /api/memory-health). Self-fetching and fleet-level, so it needs no
 * props threaded from a node; `{ services: [] }` is the designed "nothing
 * configured" state and renders calmly. A failing endpoint is data (a
 * present:false row with its reason), never a crash — the only error style
 * is the fetch line itself.
 */
export function MemoryHealthPanel({
  className,
  fetcher = fetchMemoryHealth,
}: MemoryHealthPanelProps) {
  const { data, error } = useMemoryHealthStatus(fetcher);
  const summary = data && data.services.length > 0 ? memoryHealthSummary(data.services) : null;

  let body;
  if (error && !data) {
    body = <p className="text-xs text-danger">Could not load memory health: {error}</p>;
  } else if (!data) {
    body = <p className="text-xs text-muted">Checking memory services…</p>;
  } else if (data.services.length === 0) {
    body = <p className="text-xs text-muted">No memory services configured</p>;
  } else {
    body = (
      <div className="space-y-2">
        {data.services.map((service, i) => {
          const name = service.label || service.id || "?";
          return (
            <div
              key={service.id ?? `memory-${i}`}
              className="rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="max-w-48 truncate font-medium text-text" title={name}>
                  {name}
                </span>
                <span
                  className={`shrink-0 rounded px-1 text-[9px] font-medium uppercase tracking-wide ${STATUS_BADGE[service.status]}`}
                >
                  {service.status}
                </span>
                <span className="shrink-0 rounded px-1 text-[9px] uppercase tracking-wide text-muted">
                  {service.kind ?? "—"}
                </span>
                {service.version != null && (
                  <span className="font-tabular text-muted">v{service.version}</span>
                )}
                {service.modelCount != null && (
                  <span className="font-tabular text-muted">{service.modelCount} models</span>
                )}
                <span className="font-tabular text-muted">
                  {new Date(service.checkedAt).toLocaleTimeString()}
                </span>
              </div>
              {!service.present && service.reason && (
                <p className="mt-0.5 text-[10px] text-muted">{service.reason}</p>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <Panel
      title="Memory Health"
      icon={<MemoryIcon />}
      className={className}
      bodyClassName="space-y-2"
      actions={
        summary ? (
          <span className="text-[10px] text-muted">
            {summary.ok}/{summary.total} ok · {summary.degraded} degraded · {summary.unknown}{" "}
            unknown
          </span>
        ) : undefined
      }
    >
      {error && data && (
        <p className="text-[10px] text-danger" role="status">
          Stale: could not refresh ({error})
        </p>
      )}
      {body}
    </Panel>
  );
}
