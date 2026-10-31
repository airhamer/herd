import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import type { GroupsApi, GroupsNode, GroupsView, SparkGroup } from "../../api/client";
import {
  addGroup,
  groupLinkSummary,
  groupOf,
  homeNodes,
  MAX_GROUP_SIZE,
  moveNode,
  removeGroup,
  renameGroup,
  setHead,
} from "../../lib/groupsModel";
import { RocePlanPanel } from "./RocePlanPanel";

/**
 * Spark group pages (SC5d, #75) — like a phone's home-screen pages.
 *
 * "Home" holds every individual node. The "+" to the right adds an empty
 * group page; sparks are dragged from Home onto a group page and back (native
 * HTML5 drag and drop — no library), or moved with each icon's "Move to"
 * menu (keyboard / screen-reader path). Every change saves straight to
 * config/groups.json via PUT /api/fleet/groups; a refused change (a 4th spark,
 * a non-Spark host) is reverted and its reason shown.
 */
export interface SparkGroupsPanelProps {
  api: GroupsApi;
  /** Called after each successful save (the fleet poll picks up the new topology). */
  onSaved?: (view: GroupsView) => void;
}

const DRAG_MIME = "application/x-herd-node";
const HOME_KEY = "__home__";

function shortLabel(nodeId: string): string {
  const parts = nodeId.split(/[-_.]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? nodeId;
  return last.slice(0, 4);
}

export function SparkGroupsPanel({ api, onSaved }: SparkGroupsPanelProps) {
  const [view, setView] = useState<GroupsView | null>(null);
  const [groups, setGroups] = useState<SparkGroup[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragging = useRef<string | null>(null);
  const savedRef = useRef<SparkGroup[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .fetch()
      .then((v) => {
        if (cancelled) return;
        setView(v);
        setGroups(v.groups);
        savedRef.current = v.groups;
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const commit = useCallback(
    async (next: SparkGroup[]) => {
      if (!view) return;
      setGroups(next);
      setError(null);
      setSaving(true);
      try {
        const saved = await api.save({ groups: next, switchPresent: view.switchPresent });
        setView(saved);
        setGroups(saved.groups);
        savedRef.current = saved.groups;
        onSaved?.(saved);
      } catch (e) {
        setGroups(savedRef.current);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [api, view, onSaved],
  );

  const nodes: GroupsNode[] = view?.nodes ?? [];
  const maxSize = view?.maxGroupSize ?? MAX_GROUP_SIZE;

  const move = (nodeId: string, target: string | null) => {
    const res = moveNode(groups, nodes, nodeId, target, maxSize);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (groupOf(groups, nodeId)?.id === (target ?? undefined)) return;
    void commit(res.groups);
  };

  if (loadError) {
    return (
      <div className="panel" style={{ padding: "var(--density-panel-pad)" }} data-testid="spark-groups">
        <h3 className="panel-title mb-2">Spark groups</h3>
        <p className="text-xs text-danger" role="alert">
          Couldn't load groups: {loadError}
        </p>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="panel" style={{ padding: "var(--density-panel-pad)" }} data-testid="spark-groups">
        <h3 className="panel-title mb-2">Spark groups</h3>
        <p className="text-xs text-muted">Loading…</p>
      </div>
    );
  }

  const nodeById = new Map(nodes.map((n) => [n.nodeId, n]));
  const pageTargets: Array<{ key: string | null; label: string }> = [
    { key: null, label: "Home" },
    ...groups.map((g) => ({ key: g.id, label: g.name })),
  ];

  const pageDropProps = (key: string | null) => {
    const k = key ?? HOME_KEY;
    return {
      onDragOver: (e: DragEvent) => {
        if (!dragging.current) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        if (dropTarget !== k) setDropTarget(k);
      },
      onDragLeave: () => setDropTarget((t) => (t === k ? null : t)),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        const id = dragging.current ?? e.dataTransfer?.getData(DRAG_MIME) ?? "";
        dragging.current = null;
        setDropTarget(null);
        if (id) move(id, key);
      },
      "data-drop-active": dropTarget === k ? "true" : undefined,
    };
  };

  const icon = (n: GroupsNode, group: SparkGroup | null, index: number) => {
    const isHead = group != null && index === 0 && group.members.length >= 2;
    return (
      <li
        key={n.nodeId}
        draggable={!saving}
        data-testid={`group-icon-${n.nodeId}`}
        data-node-id={n.nodeId}
        onDragStart={(e: DragEvent) => {
          dragging.current = n.nodeId;
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData(DRAG_MIME, n.nodeId);
            e.dataTransfer.setData("text/plain", n.nodeId);
          }
        }}
        onDragEnd={() => {
          dragging.current = null;
          setDropTarget(null);
        }}
        className="flex w-[92px] cursor-grab flex-col items-center gap-1 rounded-lg p-1.5 text-center active:cursor-grabbing"
        title={n.spark ? `${n.name} — GB10 Spark (${n.reason})` : `${n.name} — not a Spark (${n.reason}); can't join a group`}
      >
        <span
          className={`relative flex h-12 w-12 items-center justify-center rounded-2xl border text-[13px] font-semibold uppercase ${
            n.spark ? "border-accent/50 bg-accent/15 text-accent" : "border-border bg-surface text-muted"
          }`}
          aria-hidden="true"
        >
          {shortLabel(n.nodeId)}
          {isHead && (
            <span
              className="absolute -right-2 -top-2 rounded-full bg-accent px-1 py-px text-[9px] font-bold leading-none text-black"
              title="Head (rank 0)"
            >
              HEAD
            </span>
          )}
        </span>
        <span className="w-full truncate text-[11px] text-text">{n.name}</span>
        <span className="text-[9px] uppercase tracking-wide text-muted">
          {group ? (isHead ? "head · rank 0" : `rank ${index}`) : n.spark ? "Spark" : "not a Spark"}
        </span>
        <label className="sr-only" htmlFor={`move-${n.nodeId}`}>
          Move {n.name} to
        </label>
        <select
          id={`move-${n.nodeId}`}
          data-testid={`move-${n.nodeId}`}
          value={group?.id ?? HOME_KEY}
          disabled={saving}
          onChange={(e) => move(n.nodeId, e.target.value === HOME_KEY ? null : e.target.value)}
          className="w-full rounded border border-border bg-surface px-0.5 text-[10px] text-muted"
        >
          {pageTargets.map((p) => (
            <option key={p.key ?? HOME_KEY} value={p.key ?? HOME_KEY}>
              {p.key ? p.label : "Home"}
            </option>
          ))}
        </select>
        {group && !isHead && group.members.length >= 2 && (
          <button
            type="button"
            className="text-[10px] text-accent hover:underline"
            data-testid={`make-head-${n.nodeId}`}
            onClick={() => void commit(setHead(groups, group.id, n.nodeId))}
          >
            Make head
          </button>
        )}
      </li>
    );
  };

  const home = homeNodes(groups, nodes);

  return (
    <div className="panel" style={{ padding: "var(--density-panel-pad)" }} data-testid="spark-groups">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="panel-title">Spark groups</h3>
        <span className="text-[11px] text-muted">
          Drag sparks between pages · 2–3 GB10 Sparks per group over RoCE{saving ? " · saving…" : ""}
        </span>
      </div>
      {error && (
        <p
          role="alert"
          data-testid="groups-error"
          className="mb-3 rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger"
        >
          {error}
        </p>
      )}
      <div className="flex items-stretch gap-3 overflow-x-auto pb-1" data-testid="group-pages">
        <section
          aria-label="Home page"
          data-testid="group-page-home"
          className="flex min-w-[220px] flex-1 flex-col rounded-xl border border-border p-2.5 data-[drop-active=true]:border-accent data-[drop-active=true]:bg-accent/5"
          {...pageDropProps(null)}
        >
          <header className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-text-strong">Home</span>
            <span className="text-[10px] text-muted">
              {home.length} individual{home.length === 1 ? "" : "s"}
            </span>
          </header>
          {home.length === 0 ? (
            <p className="m-auto text-[11px] text-muted">Every node is in a group.</p>
          ) : (
            <ul className="flex flex-wrap gap-1">{home.map((n) => icon(n, null, -1))}</ul>
          )}
        </section>

        {groups.map((g) => {
          const members = g.members.map((m) => nodeById.get(m)).filter((n): n is GroupsNode => !!n);
          return (
            <section
              key={g.id}
              aria-label={`Group page ${g.name}`}
              data-testid={`group-page-${g.id}`}
              className="flex min-w-[220px] flex-1 flex-col rounded-xl border border-accent/30 bg-accent/[0.03] p-2.5 data-[drop-active=true]:border-accent data-[drop-active=true]:bg-accent/10"
              {...pageDropProps(g.id)}
            >
              <header className="mb-2 flex items-center gap-2">
                <input
                  aria-label={`Name of ${g.id}`}
                  data-testid={`group-name-${g.id}`}
                  defaultValue={g.name}
                  key={`${g.id}:${g.name}`}
                  maxLength={64}
                  onBlur={(e) => {
                    if (e.target.value.trim() && e.target.value.trim() !== g.name) {
                      void commit(renameGroup(groups, g.id, e.target.value));
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                  className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-xs font-semibold text-text-strong hover:border-border focus:border-accent focus:outline-none"
                />
                <span className="shrink-0 text-[10px] text-muted">
                  {g.members.length}/{maxSize}
                </span>
                <button
                  type="button"
                  aria-label={`Delete ${g.name}`}
                  data-testid={`delete-${g.id}`}
                  title="Delete this group; its sparks go back to Home"
                  onClick={() => void commit(removeGroup(groups, g.id))}
                  className="shrink-0 rounded px-1 text-[12px] text-muted hover:text-danger"
                >
                  ×
                </button>
              </header>
              {members.length === 0 ? (
                <p className="m-auto rounded-lg border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted">
                  Drag 2–3 sparks here
                </p>
              ) : (
                <ul className="flex flex-wrap gap-1">{members.map((n, i) => icon(n, g, i))}</ul>
              )}
              <footer className="mt-2 text-[10px] text-muted" data-testid={`group-summary-${g.id}`}>
                {groupLinkSummary(g.members.length)}
                {g.members.length === 1 ? " · inactive until it has 2" : ""}
              </footer>
            </section>
          );
        })}

        <button
          type="button"
          aria-label="Add a group page"
          data-testid="add-group"
          title="New empty group page"
          disabled={saving}
          onClick={() => void commit(addGroup(groups).groups)}
          className="flex w-14 shrink-0 items-center justify-center self-stretch rounded-xl border border-dashed border-border text-2xl text-muted hover:border-accent hover:text-accent"
        >
          +
        </button>
      </div>
      <p className="mt-2 text-[10px] text-muted">
        RoCE switch present: {view.switchPresent ? "yes" : "no"} (stored only — groups stay capped at {maxSize} until switch
        support lands).
      </p>

      <RocePlanPanel plan={view.plan} api={api} />
    </div>
  );
}
