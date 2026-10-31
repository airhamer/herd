import type {
  GroupSparkEntry,
  MakeRoomEntry,
  MemoryService,
} from "../../../shared/types";
import { Panel } from "../ui/Panel";
import { MetricBar } from "../ui/MetricBar";
import { MemoryIcon } from "../ui/icons";

export interface MemoryBudgetProps {
  totalMB: number;
  usedMB: number;
  freeMB: number;
  servicesUsedMB: number;
  otherUsedMB: number;
  services: MemoryService[];
  /** Make-room plan: which services to stop to free the wanted MB. */
  makeRoom: MakeRoomEntry[];
  needMakeRoom: boolean;
  /**
   * SC3 (unlocked in the UI): the node's availability for a TP group's
   * per-spark shard, from the agent budget (MemoryBudget.groupAvailableMB).
   */
  groupAvailableMB?: number | null;
  /**
   * SC3: per-spark group plan for this node, from the calculator
   * (agent/catalog/memory.js → computeGroupMemoryBudget, group member).
   */
  group?: GroupPlanForNode | null;
  className?: string;
}

/**
 * SC3 group view for the budget panel. A structural subset of
 * GroupResourcePlan — the parent (ServiceManagerPage / Spark page) threads
 * the member row it belongs to; the panel shows group total + per-spark
 * breakdown and never recomputes the math.
 */
export interface GroupPlanForNode {
  groupId: string;
  tp: number;
  perSparkMB: number;
  groupTotalMB: number;
  groupTotalMemMB: number;
  groupFreeMemMB: number;
  /**
   * Full per-spark breakdown (GroupResourcePlan.sparks, in sparkIds
   * order). The parent assembles it from Fleet memory.byNode budgets so
   * every member row carries its own live totals.
   */
  sparks: GroupSparkEntry[];
  /** true when the estimate is a bootstrap hardcode (basis "estimated"). */
  estimated: boolean;
  /** true when every spark in the group can host its shard. */
  fits: boolean;
}

function formatMb(mb: number): string {
  if (!Number.isFinite(mb) || mb < 0) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function safePct(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / max) * 100)));
}

/**
 * Memory-budgeting panel: total/used/free, per-service footprints, and the
 * make-room plan used by LLM auto-switch (which services to stop to fit the
 * wanted model). Panel/bar style mirrors RamPanel.
 *
 * SC3: the multi-spark/TP section is UNLOCKED — when a group plan is
 * threaded (props.group) the panel renders the group total line, the
 * per-spark breakdown, and the shard-availability bar, tagging bootstrap
 * estimates ("estimated") so they are visibly provisional until history
 * replaces them with measured averages.
 */
export function MemoryBudget({
  totalMB,
  usedMB,
  freeMB,
  servicesUsedMB,
  otherUsedMB,
  services,
  makeRoom,
  needMakeRoom,
  groupAvailableMB,
  group,
  className,
}: MemoryBudgetProps) {
  const svcs = services ?? [];
  const plan = makeRoom ?? [];
  const freePct = safePct(freeMB, totalMB);

  return (
    <Panel
      title="Memory Budget"
      icon={<MemoryIcon />}
      accent
      actions={
        needMakeRoom ? (
          <span className="rounded border border-danger/40 bg-danger/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-danger">
            Make room needed
          </span>
        ) : (
          <span className="rounded border border-border bg-surface-elevated px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
            OK
          </span>
        )
      }
      className={className}
      bodyClassName="space-y-3"
    >
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted">Total</span>
        <span className="font-tabular text-sm font-semibold text-text-strong">{formatMb(totalMB)}</span>
      </div>
      <MetricBar
        label="Used"
        value={usedMB}
        max={totalMB}
        caption={`${formatMb(usedMB)} / ${formatMb(totalMB)}`}
      />
      {/* Free bar: constant accent. MetricBar's band colors treat high % as
          bad (usage), but for free memory high % is good. */}
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted">Free</span>
          <span className="font-tabular text-sm text-text">{formatMb(freeMB)}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
            style={{ width: `${freePct}%` }}
          />
        </div>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted">Services used</span>
        <span className="font-tabular text-sm text-text">{formatMb(servicesUsedMB)}</span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted">Other used</span>
        <span className="font-tabular text-sm text-text">{formatMb(otherUsedMB)}</span>
      </div>
      {group && (
        <div className="space-y-1.5 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] uppercase tracking-wide text-muted">
              TP{group.tp} group · {group.groupId}
            </div>
            <span
              className={`rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${
                group.fits ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
              }`}
            >
              {group.fits ? "fits" : "does not fit"}
            </span>
            {group.estimated && (
              <span
                className="rounded border border-warning/40 bg-warning/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-warning"
                title="Bootstrap estimate — refine after 5 history runs"
              >
                estimated
              </span>
            )}
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">Group total</span>
            <span className="font-tabular text-sm text-text" title="Σ across sparks">
              {formatMb(group.groupTotalMB)} / {formatMb(group.groupTotalMemMB)}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">Group free</span>
            <span className="font-tabular text-sm text-text">{formatMb(group.groupFreeMemMB)}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">Per-spark shard</span>
            <span className="font-tabular text-sm text-text">{formatMb(group.perSparkMB)}</span>
          </div>
          {groupAvailableMB != null && Number.isFinite(groupAvailableMB) && (
            <div className="space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs text-muted">Available here for shard</span>
                <span className="font-tabular text-sm text-text">{formatMb(groupAvailableMB)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-border">
                <div
                  className={`h-full rounded-full transition-[width] duration-300 ease-out ${
                    groupAvailableMB >= group.perSparkMB ? "bg-success" : "bg-warning"
                  }`}
                  style={{ width: `${safePct(Math.min(groupAvailableMB, group.perSparkMB), Math.max(group.perSparkMB, 1))}%` }}
                />
              </div>
            </div>
          )}
          <div className="text-[10px] uppercase tracking-wide text-muted">Per-spark breakdown</div>
          {group.sparks.map((sp) => (
            <div key={sp.nodeId} className="flex items-center justify-between gap-2 text-xs">
              <div className="flex min-w-0 items-baseline gap-1.5">
                <span className="min-w-0 truncate text-text" title={sp.nodeId}>
                  {sp.nodeId}
                </span>
                {sp.head && <span className="shrink-0 text-muted">(head)</span>}
                {sp.makeRoom.length > 0 && (
                  <span className="shrink-0 text-muted">
                    make-room: {sp.makeRoom.map((m) => m.serviceName).join(", ")}
                  </span>
                )}
              </div>
              <span
                className={`shrink-0 font-tabular ${
                  sp.feasible ? "text-text" : "text-danger"
                }`}
                title={`free ${formatMb(sp.freeMB)} + make-room − shard ${formatMb(sp.plannedMB)}`}
              >
                {sp.feasible ? "" : "−"}
                {formatMb(Math.abs(sp.projectedFreeMB))} free after
              </span>
            </div>
          ))}
        </div>
      )}
      {svcs.length > 0 && (
        <div className="space-y-1.5 border-t border-border pt-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">Services</div>
          {svcs.map((s) => (
            <div key={s.name} className="flex items-center justify-between gap-2 text-xs">
              <div className="flex min-w-0 items-baseline gap-1.5">
                <span className="min-w-0 truncate text-text" title={s.name}>
                  {s.name}
                </span>
                <span className="shrink-0 text-muted">({s.kind})</span>
              </div>
              <span className="shrink-0 font-tabular text-text">
                {formatMb(s.footprintMB)}
                {s.running ? " · running" : ""}
                {s.needed ? " · needed" : ""}
              </span>
            </div>
          ))}
        </div>
      )}
      {plan.length > 0 && (
        <div className="space-y-1.5 border-t border-border pt-3">
          <div className="text-[10px] uppercase tracking-wide text-muted">Make-room plan</div>
          {plan.map((m) => (
            <div key={m.serviceName} className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate text-text" title={m.reason}>
                {m.serviceName} <span className="text-muted">— {m.reason}</span>
              </span>
              <span className="shrink-0 font-tabular text-accent">+{formatMb(m.freesMB)}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
