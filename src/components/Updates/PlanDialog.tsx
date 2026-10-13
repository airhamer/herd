import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  abandonUpdatePlan,
  fetchUpdatePlan,
  saveUpdatePlan,
  scheduleUpdate,
  triggerUpdateNow,
  type NodeRecord,
} from "../../api/client";
import type { FleetPlanResponse, NodeUpdatesView } from "../../api/types";
import { WAVE_LOCK_NOTICE } from "./format";

export interface PlanDialogProps {
  open: boolean;
  /** Fleet registry records — the source for role-derived wave grouping. */
  nodes: NodeRecord[];
  views: NodeUpdatesView[];
  onClose: () => void;
  onChanged: () => void;
}

/** A wave is open when its live state is any of these (BATCH5 waveStates). */
const OPEN_WAVE_STATES = new Set(["running", "rebooting", "slow"]);

/**
 * Pure wave derivation: nodes sharing a groupId form ONE group (a tp pair);
 * headless/standalone nodes form their own single-member groups. Head/
 * standalone groups lead, worker pairs follow — the §6.3 "1c2c → 102c + 25ed"
 * fleet ordering. Deterministic: groups sorted by first member id.
 */
export function deriveGroups(nodes: NodeRecord[]): string[][] {
  const byKey = new Map<string, NodeRecord[]>();
  for (const n of nodes) {
    const key = n.groupId ?? n.id;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(n);
    else byKey.set(key, [n]);
  }
  const roleRank = (n: NodeRecord) => (n.role === "worker" ? 1 : 0);
  const groups = [...byKey.values()].map((members) =>
    [...members]
      .sort((a, b) => roleRank(a) - roleRank(b) || (a.rank ?? 0) - (b.rank ?? 0) || (a.id < b.id ? -1 : 1))
      .map((m) => m.id)
  );
  // Head/standalone-led groups first, then worker groups; ties by first id.
  const roleOf = (id: string) => nodes.find((n) => n.id === id)?.role;
  return groups.sort((a, b) => {
    const wa = roleOf(a[0]) === "worker" ? 1 : 0;
    const wb = roleOf(b[0]) === "worker" ? 1 : 0;
    return wa - wb || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  });
}

/**
 * Fleet plan dialog ("Update all", SPEC §6.3): stored plan or role-derived
 * groups as ordered wave cards; reorder with ▲▼; "Run now" stores the plan
 * then triggers wave 1 through the per-node now routes; "Start at…" stores
 * the plan and puts an `at` schedule on each wave-1 member. DELETE plan is
 * disabled while any wave is open (the server 409s regardless).
 */
export function PlanDialog({ open, nodes, views, onClose, onChanged }: PlanDialogProps) {
  const [groups, setGroups] = useState<string[][]>([]);
  const [waveStates, setWaveStates] = useState<string[]>([]);
  const [hasPlan, setHasPlan] = useState(false);
  const [atValue, setAtValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchUpdatePlan()
      .then((r) => {
        if (cancelled) return;
        setWaveStates(r.waveStates);
        setHasPlan(r.plan != null);
        setGroups(r.plan ? r.plan.groups.map((g) => [...g.nodeIds]) : deriveGroups(nodes));
      })
      .catch(() => {
        if (!cancelled) setGroups(deriveGroups(nodes));
      });
    return () => {
      cancelled = true;
    };
  }, [open, nodes]);

  if (!open) return null;

  const waveOpen = waveStates.some((s) => OPEN_WAVE_STATES.has(s));
  const atMs = atValue === "" ? NaN : Date.parse(atValue);

  const errText = (err: unknown) => {
    const status = (err as { status?: unknown } | null)?.status;
    return status === 409 ? WAVE_LOCK_NOTICE : err instanceof Error ? err.message : String(err);
  };

  const storeAndAct = async (act: (wave1: string[]) => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await saveUpdatePlan(groups);
      const wave1 = saved.plan.groups[0]?.nodeIds ?? groups[0] ?? [];
      await act(wave1);
      onChanged();
      onClose();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const runNow = () =>
    storeAndAct(async (wave1) => {
      const results = await Promise.allSettled(wave1.map((id) => triggerUpdateNow(id)));
      const failed = results.find((r) => r.status === "rejected");
      if (failed && failed.status === "rejected") throw failed.reason;
    });

  const startAt = () =>
    storeAndAct(async (wave1) => {
      const results = await Promise.allSettled(
        wave1.map((id) => scheduleUpdate(id, { kind: "at", at: atMs }))
      );
      const failed = results.find((r) => r.status === "rejected");
      if (failed && failed.status === "rejected") throw failed.reason;
    });

  const deletePlan = async () => {
    setBusy(true);
    setError(null);
    try {
      await abandonUpdatePlan();
      setHasPlan(false);
      setWaveStates([]);
      setGroups(deriveGroups(nodes));
      onChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, delta: number) => {
    setGroups((prev) => {
      const next = [...prev];
      const j = index + delta;
      if (j < 0 || j >= next.length) return prev;
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  };

  const nameOf = (id: string) => {
    const rec = nodes.find((n) => n.id === id);
    const view = views.find((v) => v.nodeId === id);
    return rec?.name ?? view?.nodeId ?? id;
  };

  return createPortal(
    <div
      className="modal-overlay is-open"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="plan-dialog-title">
        <div className="modal-sheet__header" id="plan-dialog-title">
          Fleet update plan
        </div>
        <div className="modal-sheet__body">
          <div className="flex flex-col gap-2" data-testid="wave-cards">
            {groups.length === 0 ? (
              <p className="text-xs text-muted">No fleet nodes to plan.</p>
            ) : (
              groups.map((memberIds, i) => (
                <div
                  key={`${i}:${memberIds.join(",")}`}
                  className="rounded border border-border bg-surface-elevated px-3 py-2"
                  data-testid="wave-card"
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                      Wave {i + 1}
                      {hasPlan && waveStates[i] ? ` · ${waveStates[i]}` : ""}
                    </span>
                    <span className="inline-flex gap-1">
                      <button
                        type="button"
                        aria-label="move wave up"
                        disabled={busy || i === 0}
                        onClick={() => move(i, -1)}
                        className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:bg-surface-hover disabled:opacity-40"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        aria-label="move wave down"
                        disabled={busy || i === groups.length - 1}
                        onClick={() => move(i, 1)}
                        className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:bg-surface-hover disabled:opacity-40"
                      >
                        ▼
                      </button>
                    </span>
                  </div>
                  <ul className="flex flex-col gap-0.5 text-xs text-text">
                    {memberIds.map((id) => (
                      <li key={id} className="font-tabular">
                        {nameOf(id)}
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>

          <div className="mt-3">
            <label className="mb-1 block text-xs text-muted">Start wave 1 at (for “Start at…”)</label>
            <input
              type="datetime-local"
              value={atValue}
              onChange={(e) => setAtValue(e.target.value)}
              className="w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent"
            />
          </div>

          {error && (
            <div className="mt-3 rounded bg-danger/20 px-3 py-2 text-xs text-danger" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-sheet__footer">
          <button
            type="button"
            disabled={busy || !hasPlan || waveOpen}
            onClick={() => void deletePlan()}
            title={waveOpen ? "A wave is open — the plan cannot be abandoned until every wave closes" : undefined}
            className="rounded border border-danger/40 px-3 py-1.5 text-xs text-danger hover:bg-danger/10 disabled:opacity-40"
          >
            Delete plan
          </button>
          <div className="modal-sheet__footer-actions" style={{ marginLeft: "auto" }}>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted hover:bg-surface-hover"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || groups.length === 0 || !Number.isFinite(atMs)}
              onClick={() => void startAt()}
              className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted hover:bg-surface-hover disabled:opacity-50"
            >
              Start at…
            </button>
            <button
              type="button"
              disabled={busy || groups.length === 0}
              onClick={() => void runNow()}
              data-testid="plan-run-now"
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? "Working…" : "Run now"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
