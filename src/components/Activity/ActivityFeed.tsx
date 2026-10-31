// A list of fleet activity events (issue #32): severity dot, message, unit,
// relative time. Used by the Fleet tab's Recent activity card and the
// Activity page.
import { useEffect, useState } from "react";
import type { ActivityEvent } from "../../api/types";
import { timeAgo } from "../../lib/timeAgo";
import { SEVERITY_LABEL, severityColor } from "./eventMeta";

/** Re-render every `ms` so relative times stay current. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

export interface ActivityFeedProps {
  events: ActivityEvent[];
  /** Hide the unit name (e.g. when the feed is already filtered to one unit). */
  hideUnit?: boolean;
  /** Show the event type under the message. */
  showType?: boolean;
  onSelectUnit?: (unitId: string) => void;
  now?: number;
}

export function ActivityFeed({ events, hideUnit = false, showType = false, onSelectUnit, now }: ActivityFeedProps) {
  const tickNow = useNow();
  const at = now ?? tickNow;
  return (
    <ul className="flex flex-col divide-y divide-border" data-testid="activity-feed">
      {events.map((e) => {
        const sev = SEVERITY_LABEL[e.severity] ?? "Info";
        const unit = e.sparkName || e.sparkId;
        return (
          <li key={e.id} className="flex items-start gap-2.5 py-2" data-testid="activity-row" data-type={e.type}>
            <span
              className="mt-[5px] inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: severityColor(e.severity) }}
              role="img"
              aria-label={sev}
              title={sev}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] text-text" title={e.message}>
                {e.message}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 text-[10px] text-muted">
                {!hideUnit && unit &&
                  (onSelectUnit && e.sparkId ? (
                    <button
                      type="button"
                      className="truncate text-left text-muted underline-offset-2 hover:text-text hover:underline"
                      onClick={() => onSelectUnit(e.sparkId!)}
                    >
                      {unit}
                    </button>
                  ) : (
                    <span className="truncate">{unit}</span>
                  ))}
                {showType && <span className="font-mono">{e.type}</span>}
              </div>
            </div>
            <time
              className="shrink-0 font-tabular text-[10px] text-muted"
              dateTime={new Date(e.ts).toISOString()}
              title={new Date(e.ts).toLocaleString()}
            >
              {timeAgo(e.ts, at)}
            </time>
          </li>
        );
      })}
    </ul>
  );
}
