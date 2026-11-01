import { useEffect, useMemo, useState } from "react";
import { fetchComponents, type CatalogComponent } from "../../api/client";
import { groupSingles, type GroupMemberInput, type SingleFit } from "../../lib/groupSingles";
import { gib } from "../../lib/memoryPool";

const FIT_STYLE: Record<SingleFit, string> = {
  running: "border-accent/60 text-accent",
  fits: "border-success/60 text-success",
  tight: "border-warning/60 text-warning",
  unknown: "border-border text-muted",
  no_fit: "border-danger/60 text-danger",
};
const FIT_LABEL: Record<SingleFit, string> = {
  running: "running",
  fits: "fits",
  tight: "tight",
  unknown: "size unknown",
  no_fit: "doesn't fit",
};

/**
 * SC5e (#87): for a spark group, the single (tp=1) components that fit on
 * each member's remaining memory once the group's TP=x component is placed.
 * If none is running, pick one to plan with. Non-fitting singles are hidden
 * behind a toggle and flagged when shown.
 */
export function GroupSinglesPanel({
  members,
  loadComponents = fetchComponents,
}: {
  members: GroupMemberInput[];
  loadComponents?: () => Promise<{ components: CatalogComponent[] }>;
}) {
  const [components, setComponents] = useState<CatalogComponent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showNoFit, setShowNoFit] = useState(false);

  useEffect(() => {
    let alive = true;
    loadComponents()
      .then((r) => alive && setComponents(r.components ?? []))
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [loadComponents]);

  const view = useMemo(() => (components ? groupSingles(members, components, selected) : null), [members, components, selected]);
  const tp = members.length;

  return (
    <section className="panel" style={{ padding: "var(--density-panel-pad)" }} data-testid="group-singles">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="panel-title">Singles that fit beside the TP{tp} component</h3>
        <label className="ml-auto flex items-center gap-1 text-[11px] text-muted">
          <input type="checkbox" checked={showNoFit} onChange={(e) => setShowNoFit(e.target.checked)} data-testid="show-nofit" />
          show the ones that don't fit
        </label>
      </div>
      {error && <div className="mt-2 text-xs text-danger">Components unavailable: {error}</div>}
      {!view && !error && <div className="mt-2 text-xs text-muted">Loading components…</div>}
      {view && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" data-testid="tp-placement">
            {view.placement === "running" && view.tpComponent ? (
              <span>
                <b className="text-text-strong">{view.tpComponent.name}</b> <span className="text-muted">is running, so its memory is already in each member's reading.</span>
              </span>
            ) : (
              <>
                <span className="text-muted">{view.placement === "none" ? "No TP component placed yet." : "Planning with"}</span>
                <select
                  className="rounded border border-border bg-surface px-1 py-0.5 text-xs"
                  value={selected ?? ""}
                  onChange={(e) => setSelected(e.target.value || null)}
                  data-testid="tp-select"
                  aria-label={`TP${tp} component to plan with`}
                >
                  <option value="">{view.tpCandidates.length ? `pick a TP${tp} component…` : `no TP${tp} components in the catalog`}</option>
                  {view.tpCandidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.memoryPerSparkMB ? ` (${gib(c.memoryPerSparkMB)} GiB/spark)` : ""}
                    </option>
                  ))}
                </select>
                {view.placement === "none" && <span className="text-muted">Until you pick one, the fit uses current free memory.</span>}
              </>
            )}
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {view.members.map((m) => {
              const hidden = m.singles.filter((s) => s.fit === "no_fit");
              const shown = showNoFit ? m.singles : m.singles.filter((s) => s.fit !== "no_fit");
              return (
                <div key={m.nodeId} className="rounded-lg border border-border bg-surface p-2 text-xs" data-testid={`member-singles-${m.nodeId}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-text">{m.nodeName}</span>
                    <span className="font-tabular text-muted" data-testid="remaining">
                      {m.remainingMB == null ? "no memory reading" : `${gib(m.remainingMB)} GiB left above floor`}
                    </span>
                  </div>
                  {shown.length === 0 ? (
                    <div className="mt-1 text-muted">{m.singles.length === 0 ? "No single components in the catalog." : "No single fits."}</div>
                  ) : (
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {shown.map((s) => (
                        <li key={s.component.id} className="flex items-center gap-1.5" data-testid="single-row" data-fit={s.fit}>
                          <span className={`shrink-0 whitespace-nowrap rounded border px-1 text-[10px] uppercase tracking-wide ${FIT_STYLE[s.fit]}`}>{FIT_LABEL[s.fit]}</span>
                          <span className="min-w-0 truncate text-text" title={s.component.id}>{s.component.name}</span>
                          <span className="ml-auto shrink-0 font-tabular text-[10px] text-muted">
                            {s.needMB != null ? `${gib(s.needMB)} GiB` : "?"}
                            {s.fit === "no_fit" && s.leftMB != null ? ` · short ${gib(-s.leftMB)}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {!showNoFit && hidden.length > 0 && (
                    <div className="mt-1 text-[10px] text-muted" data-testid="hidden-count">
                      {hidden.length} hidden (don't fit)
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

export default GroupSinglesPanel;
