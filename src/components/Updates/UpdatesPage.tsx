import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchFleetNodes, fetchFleetUpdates, triggerUpdateNow } from "../../api/client";
import type { NodeRecord } from "../../api/client";
import type { NodeUpdatesView } from "../../api/types";
import { UpdateRow } from "./UpdateRow";
import { ScheduleDialog } from "./ScheduleDialog";
import { PlanDialog } from "./PlanDialog";
import { WAVE_LOCK_NOTICE } from "./format";

export interface UpdatesPageProps {
  /** Injectable clock for the probe-age column (tests pass a fixed value). */
  now?: number;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Status code of an apiFetch error (works with mocked rejects in tests too). */
function errStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/**
 * Ticking clock for row age labels. Date.now() lives ONLY inside effects here,
 * never in a render path (BATCH6 determinism rule); tests inject `now` instead.
 */
function useNowTick(): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * Updates page (SPEC §6.3): fleet table of spark update backends + wave
 * planner. State text comes from the server-derived view.display — the page
 * never re-derives update state client-side. Refresh: on mount; 60 s while
 * everything is idle; 5 s while any view is updating/rebooting/slow. ONE
 * interval, recreated when the mode flips, cleared on unmount.
 */
export function UpdatesPage({ now }: UpdatesPageProps = {}) {
  const liveNow = useNowTick();
  const clock = now ?? liveNow;

  const [views, setViews] = useState<NodeUpdatesView[] | null>(null);
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [scheduleFor, setScheduleFor] = useState<string | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ nodeId: string; text: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      const [updates, registry] = await Promise.all([fetchFleetUpdates(), fetchFleetNodes()]);
      setViews(updates.views);
      setNodes(registry.nodes);
      setLoadError(null);
    } catch (err) {
      setLoadError(errText(err));
    }
  }, []);

  // Refresh on mount.
  useEffect(() => {
    void reload();
  }, [reload]);

  // 5 s while any node is updating/rebooting/slow, else 60 s idle cadence.
  const anyActive = useMemo(
    () =>
      (views ?? []).some(
        (v) => v.display === "updating" || v.display === "rebooting" || v.display === "slow"
      ),
    [views]
  );
  useEffect(() => {
    const timer = window.setInterval(() => void reload(), anyActive ? 5_000 : 60_000);
    return () => window.clearInterval(timer);
  }, [anyActive, reload]);

  const runUpdateNow = useCallback(
    async (nodeId: string) => {
      setConfirmId(null);
      try {
        await triggerUpdateNow(nodeId);
        setNotice(null);
        await reload();
      } catch (err) {
        // 409 = the §6.2 trigger guard (a wave is open) → fixed inline notice.
        setNotice({
          nodeId,
          text: errStatus(err) === 409 ? WAVE_LOCK_NOTICE : errText(err),
        });
      }
    },
    [reload]
  );

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n] as const)), [nodes]);
  const scheduleView = scheduleFor != null
    ? (views ?? []).find((v) => v.nodeId === scheduleFor) ?? null
    : null;
  const confirmView = confirmId != null
    ? (views ?? []).find((v) => v.nodeId === confirmId) ?? null
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-page-gap)" }}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1
          className="font-normal leading-tight tracking-tight text-text-strong"
          style={{ fontSize: "var(--density-overview-title)" }}
        >
          Updates
        </h1>
        <div className="flex items-center gap-2">
          {views && (
            <span className="text-[11px] text-muted">
              {views.length} spark{views.length === 1 ? "" : "s"} ·{" "}
              {views.filter((v) => v.display === "available").length} with updates
            </span>
          )}
          <button
            type="button"
            onClick={() => setPlanOpen(true)}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
            data-testid="update-all-button"
          >
            Update all
          </button>
        </div>
      </div>

      {loadError && (
        <div className="rounded bg-danger/20 px-3 py-2 text-xs text-danger" role="alert">
          {loadError}
        </div>
      )}

      <div className="panel" style={{ padding: "var(--density-panel-pad)" }}>
        <h3 className="panel-title mb-3">Spark update backends</h3>
        {!views ? (
          <p className="text-xs text-muted">{loadError ? "No data yet." : "Loading fleet updates…"}</p>
        ) : views.length === 0 ? (
          <p className="text-xs text-muted">No fleet nodes registered.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted">
                  <th className="py-1.5 pr-3 font-medium">Node</th>
                  <th className="py-1.5 pr-3 font-medium">DGX build</th>
                  <th className="py-1.5 pr-3 font-medium">Applied OTA</th>
                  <th className="py-1.5 pr-3 font-medium">Available OTA</th>
                  <th className="py-1.5 pr-3 font-medium">Pkgs</th>
                  <th className="py-1.5 pr-3 font-medium">FW</th>
                  <th className="py-1.5 pr-3 font-medium">Last probe</th>
                  <th className="py-1.5 pr-3 font-medium">State</th>
                  <th className="py-1.5 pr-3 font-medium">Group · Wave</th>
                  <th className="py-1.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {views.map((view) => (
                  <UpdateRow
                    key={view.nodeId}
                    view={view}
                    node={nodeById.get(view.nodeId) ?? null}
                    now={clock}
                    expanded={expanded[view.nodeId] === true}
                    notice={notice?.nodeId === view.nodeId ? notice.text : null}
                    onToggle={(id) => setExpanded((prev) => ({ ...prev, [id]: !(prev[id] === true) }))}
                    onSchedule={(id) => setScheduleFor(id)}
                    onConfirmNow={(id) => setConfirmId(id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {notice && (
        <button
          type="button"
          className="self-start rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] text-danger"
          onClick={() => setNotice(null)}
          title="Dismiss"
        >
          {notice.text} ✕
        </button>
      )}

      <ScheduleDialog
        open={scheduleFor != null}
        nodeId={scheduleFor}
        view={scheduleView}
        onClose={() => setScheduleFor(null)}
        onChanged={() => void reload()}
      />
      <PlanDialog
        open={planOpen}
        nodes={nodes}
        views={views ?? []}
        onClose={() => setPlanOpen(false)}
        onChanged={() => void reload()}
      />
      {confirmView && (
        <ConfirmUpdateDialog
          nodeId={confirmView.nodeId}
          onCancel={() => setConfirmId(null)}
          onConfirm={() => void runUpdateNow(confirmView.nodeId)}
        />
      )}
    </div>
  );
}

/** Two-step confirm for "Update now" (SPEC §6.3 row actions). */
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap";

function ConfirmUpdateDialog({
  nodeId,
  onCancel,
  onConfirm,
}: {
  nodeId: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const trapRef = useFocusTrap(true);
  return createPortal(
    <div
      className="modal-overlay is-open"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div ref={trapRef} className="modal-sheet max-w-sm" role="dialog" aria-modal="true">
        <div className="modal-sheet__header">Update {nodeId} now?</div>
        <div className="modal-sheet__body">
          <p className="text-xs text-muted">
            This triggers the DGX update immediately. The node will install packages/firmware,
            then reboot. Recovery gets a 6-minute grace window before it is flagged slow.
          </p>
        </div>
        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions" style={{ marginLeft: "auto" }}>
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted hover:bg-surface-hover"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              data-testid="confirm-update-now"
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
            >
              Trigger update
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
