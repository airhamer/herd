// Fleet tab card: the latest few activity events, live (issue #32).
import { useActivityEvents } from "../../hooks/useActivityEvents";
import { ActivityFeed } from "./ActivityFeed";

export const RECENT_ACTIVITY_COUNT = 8;

export function RecentActivityCard({
  onViewAll,
  onSelectUnit,
}: {
  onViewAll?: () => void;
  onSelectUnit?: (unitId: string) => void;
}) {
  const { events, loading, error } = useActivityEvents({ limit: RECENT_ACTIVITY_COUNT, cap: RECENT_ACTIVITY_COUNT });

  let body;
  if (events.length > 0) {
    body = <ActivityFeed events={events} onSelectUnit={onSelectUnit} />;
  } else if (loading) {
    body = <p className="text-xs text-muted">Loading activity…</p>;
  } else if (error) {
    body = (
      <p className="rounded bg-warning/10 px-3 py-2 text-xs text-warning" role="status">
        Activity unavailable: {error}
      </p>
    );
  } else {
    body = (
      <div className="py-4 text-center" data-testid="activity-empty">
        <p className="text-xs font-semibold text-text-strong">No activity yet</p>
        <p className="mt-1 text-[11px] text-muted">
          Nodes going online or offline, services starting or stopping, alerts, power actions and benchmark runs
          will show up here.
        </p>
      </div>
    );
  }

  return (
    <section className="panel p-4" aria-labelledby="recent-activity-title" data-testid="recent-activity-card">
      <div className="mb-1 flex items-start justify-between gap-2">
        <div>
          <h2 id="recent-activity-title" className="text-sm font-semibold text-text-strong">
            Recent activity
          </h2>
          <p className="text-[10px] text-muted">Live across the fleet</p>
        </div>
        {onViewAll && (
          <button type="button" className="text-xs text-accent underline-offset-2 hover:underline" onClick={onViewAll}>
            View all
          </button>
        )}
      </div>
      {error && events.length > 0 && (
        <p className="mb-1 text-[10px] text-warning" role="status">
          Not refreshing: {error}
        </p>
      )}
      {body}
    </section>
  );
}
