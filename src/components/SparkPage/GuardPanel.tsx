import { useEffect, useState } from "react";
import { fetchGuard } from "../../api/client";
import type {
  GuardProxyResult,
  GuardResponse,
  GuardResult,
  GuardStatus,
  GuardTimelineEntry,
} from "../../api/types";
import { Panel } from "../ui/Panel";

/** Poll cadence for the guard endpoint, same 30 s as the other status panels. */
export const GUARD_POLL_MS = 30_000;

/** How many crash-timeline entries one guard row shows at most. */
const TIMELINE_LIMIT = 3;

/** Hand-rolled shield glyph in the fork's inline-SVG idiom (see ui/icons.tsx). */
function GuardIcon({ className = "" }: { className?: string }) {
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
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

/** Status → badge classes: running green, degraded amber, stopped red, unknown muted. */
const STATUS_BADGE: Record<GuardStatus, string> = {
  running: "bg-success/15 text-success",
  degraded: "bg-warning/15 text-warning",
  stopped: "bg-danger/15 text-danger",
  unknown: "bg-border text-muted",
};

/**
 * Up to TIMELINE_LIMIT most-recent entries by `at` (descending). Entries with
 * a null or unparseable `at` sort last (original order kept among them), so
 * dated crashes always crowd them out first.
 */
function recentCrashEntries(entries: GuardTimelineEntry[]): GuardTimelineEntry[] {
  const stamp = (entry: GuardTimelineEntry) =>
    entry.at === null ? NaN : Date.parse(entry.at);
  return entries
    .map((entry, i) => ({ entry, i, t: stamp(entry) }))
    .sort((a, b) => {
      const badA = Number.isNaN(a.t);
      const badB = Number.isNaN(b.t);
      if (badA !== badB) return badA ? 1 : -1;
      return badA ? a.i - b.i : b.t - a.t;
    })
    .slice(0, TIMELINE_LIMIT)
    .map((row) => row.entry);
}

export interface GuardSummary {
  total: number;
  running: number;
  held: number;
}

/**
 * Fleet-level counts for the panel header: guards on file, how many report
 * "running", and the total held requests (a null count adds 0).
 */
export function guardSummary(guards: readonly GuardResult[]): GuardSummary {
  let running = 0;
  let held = 0;
  for (const guard of guards) {
    if (guard.status === "running") running += 1;
    held += guard.heldRequests ?? 0;
  }
  return { total: guards.length, running, held };
}

/**
 * Poll the guard endpoint while mounted (setInterval + cancelled flag, the
 * useUnitHistory idiom). The last good answer stays on screen across a
 * failed refresh; the first failure before any answer sets `error`.
 */
function useGuardStatus(fetcher: () => Promise<GuardResponse>) {
  const [data, setData] = useState<GuardResponse | null>(null);
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
    const timer = setInterval(load, GUARD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fetcher]);

  return { data, error };
}

export interface GuardPanelProps {
  className?: string;
  /**
   * Injectable fetcher (tests pass a stub; production default is fetchGuard,
   * GET /api/guard). The component itself never calls fetch directly.
   */
  fetcher?: () => Promise<GuardResponse>;
}

/** Seconds → "45s" / "7m" / "2h 13m"; null renders an em-dash. */
export function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * One keepalive-proxy row (GUARD1 #95): endpoint, liveness (auth-gate alive
 * counts, per the SRV1 convention), uptime + request count when the proxy
 * exposes them — else "no metrics endpoint" — the engine behind it when the
 * fleet's SRV1 service truth knows, and the last-probe time. A dead proxy
 * shows its reason, never a blank.
 */
function GuardProxyRow({ proxy }: { proxy: GuardProxyResult }) {
  const badge = proxy.alive
    ? "bg-success/15 text-success"
    : proxy.status === "not-configured"
      ? "bg-border text-muted"
      : "bg-danger/15 text-danger";
  const badgeText = proxy.alive ? "alive" : proxy.status === "not-configured" ? "unset" : "down";
  const engine = proxy.engine;
  return (
    <div
      data-guard-proxy
      className="rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="max-w-48 truncate font-medium text-text" title={proxy.label ?? undefined}>
          {proxy.label || "Guard proxy"}
        </span>
        <span
          className={`shrink-0 rounded px-1 text-[9px] font-medium uppercase tracking-wide ${badge}`}
          title={proxy.authGate ? "alive via auth gate (401/403 proves the process answers)" : undefined}
        >
          {badgeText}
        </span>
      </div>
      <p className="mt-0.5 break-all text-[10px] text-muted">{proxy.baseUrl ?? "no URL"}</p>
      {proxy.alive && (
        <p className="mt-0.5 text-[10px] text-muted">
          {proxy.hasMetrics
            ? `up ${formatUptime(proxy.uptimeSeconds)} · ${proxy.requestCount ?? "—"} requests`
            : "no metrics endpoint"}
        </p>
      )}
      <p className="mt-0.5 text-[10px] text-muted">
        engine behind proxy: {engine ? [engine.engine, engine.model].filter(Boolean).join(" · ") || engine.name || "configured" : "unknown"}
      </p>
      {!proxy.alive && proxy.reason && (
        <p className="mt-0.5 text-[10px] text-danger">{proxy.reason}</p>
      )}
      <p className="mt-0.5 text-[9px] text-muted" data-guard-proxy-probed>
        probed {proxy.checkedAt}
      </p>
    </div>
  );
}

/**
 * Guard-proxy status panel (S4.1b): one row per configured guard from the
 * tolerant server probe (server/health/guardProbe.js → GET /api/guard).
 * Self-fetching and fleet-level, so it needs no props threaded from a node;
 * `{ guards: [] }` is the designed "nothing configured" state and renders
 * calmly. A failing endpoint is data (a present:false row with its reason),
 * never a crash — the only error style is the fetch line itself.
 */
export function GuardPanel({ className, fetcher = fetchGuard }: GuardPanelProps) {
  const { data, error } = useGuardStatus(fetcher);
  const summary = data && data.guards.length > 0 ? guardSummary(data.guards) : null;
  const proxy = data?.proxy ?? null;

  let body;
  if (error && !data) {
    body = <p className="text-xs text-danger">Could not load guard status: {error}</p>;
  } else if (!data) {
    body = <p className="text-xs text-muted">Checking guards…</p>;
  } else if (data.guards.length === 0 && !proxy) {
    // GUARD1 (#95): the old empty state hinted at a settings field with no
    // way to set it. The empty state now names the reason and the fix.
    body = (
      <p className="text-xs text-muted">
        No guard proxies configured — not configured, so nothing to probe. Add the
        keepalive proxy URL in Settings ("Guard proxy URL", e.g.
        http://192.168.50.226:8081) and this panel will show its liveness and the
        engine behind it.
      </p>
    );
  } else {
    body = (
      <div className="space-y-2">
        {proxy && <GuardProxyRow proxy={proxy} />}
        {data.guards.map((guard, i) => {
          const name = guard.label || guard.id || "unnamed guard";
          const timeline = recentCrashEntries(guard.crashTimeline);
          return (
            <div
              key={guard.id ?? `guard-${i}`}
              className="rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="max-w-48 truncate font-medium text-text" title={name}>
                  {name}
                </span>
                <span
                  className={`shrink-0 rounded px-1 text-[9px] font-medium uppercase tracking-wide ${STATUS_BADGE[guard.status]}`}
                >
                  {guard.status}
                </span>
                <span className="font-tabular text-muted">held {guard.heldRequests ?? "—"}</span>
              </div>
              {!guard.present && guard.reason && (
                <p className="mt-0.5 text-[10px] text-muted">{guard.reason}</p>
              )}
              {timeline.length > 0 && (
                <div data-guard-timeline className="mt-1 space-y-0.5 border-t border-border pt-1">
                  {timeline.map((entry, j) => (
                    <div key={j} className="text-[10px] text-muted">
                      {entry.kind ?? "—"} — {entry.detail ?? "—"}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <Panel
      title="Guard Proxy"
      icon={<GuardIcon />}
      className={className}
      bodyClassName="space-y-2"
      actions={
        summary ? (
          <span className="text-[10px] text-muted">
            {summary.running}/{summary.total} running · {summary.held} held
            {proxy ? ` · proxy ${proxy.alive ? "alive" : "down"}` : ""}
          </span>
        ) : proxy ? (
          <span className="text-[10px] text-muted">proxy {proxy.alive ? "alive" : "down"}</span>
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
