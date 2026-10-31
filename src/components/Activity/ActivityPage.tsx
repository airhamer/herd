// Full fleet activity log (issue #32): filter by unit and category, page
// back through older events, prune.
import { useState } from "react";
import { clearEvents } from "../../api/client";
import { useActivityEvents } from "../../hooks/useActivityEvents";
import { ActivityFeed } from "./ActivityFeed";
import { ACTIVITY_CATEGORIES } from "./eventMeta";

export const ACTIVITY_PAGE_SIZE = 100;
const WEEK_MS = 7 * 86_400_000;

export interface ActivityUnit {
  id: string;
  name: string;
}

export function ActivityPage({
  units,
  onSelectUnit,
  confirm = (text: string) => window.confirm(text),
}: {
  /** Units offered in the filter (Sparks and fleet nodes). */
  units: ActivityUnit[];
  onSelectUnit?: (unitId: string) => void;
  confirm?: (text: string) => boolean;
}) {
  const [unitId, setUnitId] = useState("");
  const [categoryId, setCategoryId] = useState("all");
  const [notice, setNotice] = useState<string | null>(null);
  const category = ACTIVITY_CATEGORIES.find((c) => c.id === categoryId) ?? ACTIVITY_CATEGORIES[0];
  const { events, loading, error, hasMore, loadOlder, reload } = useActivityEvents({
    limit: ACTIVITY_PAGE_SIZE,
    filter: { sparkId: unitId || undefined, types: category.types },
  });

  const prune = async (olderThanMs?: number) => {
    const what = olderThanMs ? "events older than 7 days" : "all activity";
    if (!confirm(`Delete ${what}? This cannot be undone.`)) return;
    try {
      const { removed } = await clearEvents(olderThanMs);
      setNotice(`Removed ${removed} event${removed === 1 ? "" : "s"}.`);
      await reload();
    } catch (err) {
      setNotice(`Could not clear activity: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-page-gap)" }}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1
          className="font-normal leading-tight tracking-tight text-text-strong"
          style={{ fontSize: "var(--density-overview-title)" }}
        >
          Activity
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="text-xs text-muted hover:text-text" onClick={() => void prune(WEEK_MS)}>
            Clear older than 7 days
          </button>
          <button type="button" className="text-xs text-danger hover:underline" onClick={() => void prune()}>
            Clear all
          </button>
        </div>
      </div>

      <div className="panel flex flex-wrap items-center gap-3" style={{ padding: "var(--density-panel-pad)" }}>
        <label className="flex items-center gap-2 text-[11px] text-muted">
          Unit
          <select
            aria-label="Filter by unit"
            className="rounded border border-border bg-surface-elevated px-2 py-1 text-xs text-text"
            value={unitId}
            onChange={(e) => setUnitId(e.target.value)}
          >
            <option value="">All units</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by category">
          {ACTIVITY_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={c.id === category.id}
              onClick={() => setCategoryId(c.id)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                c.id === category.id
                  ? "border-accent bg-accent-soft text-text-strong"
                  : "border-border text-muted hover:text-text"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {notice && (
        <p className="text-xs text-muted" role="status">
          {notice}
        </p>
      )}

      <section className="panel p-4" aria-label="Activity log">
        {error && (
          <p className="mb-2 rounded bg-warning/10 px-3 py-2 text-xs text-warning" role="status">
            Activity unavailable: {error}
          </p>
        )}
        {events.length > 0 ? (
          <>
            <ActivityFeed events={events} showType hideUnit={Boolean(unitId)} onSelectUnit={onSelectUnit} />
            {hasMore && (
              <div className="mt-3 text-center">
                <button type="button" className="text-xs text-accent hover:underline" onClick={() => void loadOlder()}>
                  Load older
                </button>
              </div>
            )}
          </>
        ) : loading ? (
          <p className="text-xs text-muted">Loading activity…</p>
        ) : (
          !error && (
            <p className="py-6 text-center text-xs text-muted" data-testid="activity-empty">
              {unitId || category.types.length > 0 ? "No events match these filters." : "No activity recorded yet."}
            </p>
          )
        )}
      </section>
    </div>
  );
}
