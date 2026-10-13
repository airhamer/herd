import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cancelSchedule, scheduleUpdate } from "../../api/client";
import type { NodeUpdatesView } from "../../api/types";
import { describeCron } from "./describeCron";

export interface ScheduleDialogProps {
  open: boolean;
  nodeId: string | null;
  /** Latest view for this node — carries the resulting pending-schedule list. */
  view: NodeUpdatesView | null;
  onClose: () => void;
  /** Called after a schedule/cancel so the parent reloads the fleet views. */
  onChanged: () => void;
}

/** Fixed-epoch → "2026-10-13 07:00Z" (UTC). No clock read — deterministic. */
export function formatEpoch(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

function useDialogEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);
}

/**
 * Schedule dialog (SPEC §6.3): mode toggle "At" (one-shot datetime) |
 * "Cron (recurring)" with a live human-readable preview of the 5-field
 * expression; "also install as system cron entry" → mirrorCron. Shows the
 * node's resulting pending schedules, each with a cancel action.
 */
export function ScheduleDialog({ open, nodeId, view, onClose, onChanged }: ScheduleDialogProps) {
  const [mode, setMode] = useState<"at" | "cron">("at");
  const [atValue, setAtValue] = useState("");
  const [cronExpr, setCronExpr] = useState("");
  const [mirrorCron, setMirrorCron] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useDialogEscape(open, onClose);

  if (!open || nodeId == null) return null;

  const preview = cronExpr.trim()
    ? describeCron(cronExpr) ?? "not a valid 5-field cron expression"
    : "type a 5-field cron expression to preview its schedule";
  const atMs = atValue === "" ? NaN : Date.parse(atValue);
  const canSubmit = mode === "at" ? Number.isFinite(atMs) : describeCron(cronExpr) != null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await scheduleUpdate(
        nodeId,
        mode === "at"
          ? { kind: "at", at: atMs, mirrorCron }
          : { kind: "cron", cron: cronExpr.trim(), mirrorCron }
      );
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const cancelOne = async (scheduleId: string) => {
    setBusy(true);
    setError(null);
    try {
      await cancelSchedule(nodeId, scheduleId);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const pending = (view?.schedules ?? []).filter((s) => s.status === "pending");

  return createPortal(
    <div
      className="modal-overlay is-open"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-sheet" role="dialog" aria-modal="true" aria-label="Schedule update">
        <div className="modal-sheet__header">Schedule update — {nodeId}</div>
        <div className="modal-sheet__body">
          <div className="mb-3 flex items-center gap-1">
            <button
              type="button"
              aria-pressed={mode === "at"}
              onClick={() => setMode("at")}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                mode === "at" ? "bg-accent-soft text-accent" : "text-muted hover:text-text"
              }`}
            >
              At
            </button>
            <button
              type="button"
              aria-pressed={mode === "cron"}
              onClick={() => {
                setMode("cron");
                setMirrorCron(true); // recurring → mirror auto-suggested (SPEC §6.3)
              }}
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                mode === "cron" ? "bg-accent-soft text-accent" : "text-muted hover:text-text"
              }`}
            >
              Cron (recurring)
            </button>
          </div>

          {mode === "at" ? (
            <div>
              <label className="mb-1 block text-xs text-muted">Run once at</label>
              <input
                type="datetime-local"
                value={atValue}
                onChange={(e) => setAtValue(e.target.value)}
                className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
              />
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-xs text-muted">Cron expression (5 fields)</label>
              <input
                type="text"
                value={cronExpr}
                placeholder="0 3 * * 0"
                onChange={(e) => setCronExpr(e.target.value)}
                className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
              />
              <p className="mt-1 text-[11px] text-muted" data-testid="cron-preview">
                {preview}
              </p>
            </div>
          )}

          <label className="mt-3 flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={mirrorCron}
              onChange={(e) => setMirrorCron(e.target.checked)}
              className="rounded border-border"
            />
            also install as system cron entry
          </label>

          <div className="mt-3" data-testid="schedule-list">
            <h4 className="mb-1 text-[10px] uppercase tracking-wide text-muted">
              Pending schedules
            </h4>
            {pending.length === 0 ? (
              <p className="text-[11px] text-muted">none</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {pending.map((s) => (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-2 rounded border border-border bg-surface-elevated px-2 py-1 text-[11px]"
                  >
                    <span className="font-tabular text-text">
                      {s.kind === "cron" ? `cron ${s.cron}` : `at ${formatEpoch(s.nextFire)}`}
                      {s.mirrorCron ? " · mirrored" : ""}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void cancelOne(s.id)}
                      className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:bg-surface-hover disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {error && (
            <div className="mt-3 rounded bg-danger/20 px-3 py-2 text-xs text-danger" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions" style={{ marginLeft: "auto" }}>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted hover:bg-surface-hover"
            >
              Close
            </button>
            <button
              type="button"
              disabled={busy || !canSubmit}
              onClick={() => void submit()}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save schedule"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
