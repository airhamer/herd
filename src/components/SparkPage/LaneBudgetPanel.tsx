import type { NodeLanes } from "../../../shared/types";
import { computeLaneBudgets, type BudgetLanes } from "../../lib/laneCoexistence";
import { MetricBar } from "../ui/MetricBar";
import { Panel } from "../ui/Panel";
import { RotateIcon } from "../ui/icons";

export interface LaneBudgetPanelProps {
  /** Lane view from the node snapshot (nullish = lanes not present). */
  lanes: NodeLanes | null | undefined;
  /** GPU memory total for the unit's pools, MB (nullish / <=0 = unknown). */
  poolTotalMB: number | null;
  /**
   * Recipe name → footprint MB, merged onto each lane before the budget
   * math (the seam's LaneEntry carries no footprint). Nullish / non-finite
   * entries count as unknown: 0 MB in the math, "—" in the row, and the
   * pool shows the estimate-only hint.
   */
  recipeFootprints?: Record<string, number | null | undefined>;
  className?: string;
}

/** Mb formatter, local-copy style (mirrors NodeDetail / MemoryBudget). */
function formatMb(mb: number): string {
  if (!Number.isFinite(mb) || mb < 0) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function isKnownFootprint(mb: number | null | undefined): mb is number {
  return typeof mb === "number" && Number.isFinite(mb);
}

/**
 * Caller-side footprint merge (the lane→footprint lookup that
 * computeLaneBudgets expects on BudgetLane). Nullish lanes pass through
 * unchanged so "not present" stays not-present; a malformed lanes value is
 * forwarded to computeLaneBudgets, which guards it.
 */
function withFootprints(
  lanes: NodeLanes | null | undefined,
  recipeFootprints: Record<string, number | null | undefined> | undefined,
): BudgetLanes | null | undefined {
  if (!lanes || !Array.isArray(lanes.pools)) return lanes ?? null;
  return {
    pools: lanes.pools.map((pool) => ({
      id: pool.id,
      lanes: pool.lanes.map((lane) => ({
        ...lane,
        footprintMB: recipeFootprints?.[lane.recipe] ?? null,
      })),
    })),
  };
}

/**
 * Component (lane) coexistence / budget panel (S3.2b): per pool, how much of
 * the GPU the running component(s) hold, the headroom left, and whether each
 * stopped component would fit if started in its turn. All math lives in the
 * pure computeLaneBudgets (src/lib/laneCoexistence.ts); this component only
 * renders. Zero fetches, zero fs, deterministic.
 *
 * SC1 terminology: the UI calls these Components (former "Lanes"); internal
 * identifiers keep "lane" for wire/seam compatibility (shared/types.ts).
 */
export function LaneBudgetPanel({
  lanes,
  poolTotalMB,
  recipeFootprints,
  className,
}: LaneBudgetPanelProps) {
  const budgets = computeLaneBudgets(
    withFootprints(lanes, recipeFootprints),
    poolTotalMB,
  );
  const overPools = budgets.pools.filter((p) => p.overCommitted);

  return (
    <Panel
      title="Components"
      icon={<RotateIcon />}
      actions={
        overPools.length > 0 ? (
          <span className="rounded border border-danger/40 bg-danger/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-danger">
            Over committed
          </span>
        ) : undefined
      }
      className={className}
      bodyClassName="space-y-3"
    >
      {!budgets.available || budgets.pools.length === 0 ? (
        <p className="text-xs text-muted">No component data</p>
      ) : (
        budgets.pools.map((pool) => (
          <div key={pool.id} className="space-y-1.5">
            <div className="text-[10px] uppercase tracking-wide text-muted">
              Pool {pool.id} · {pool.runningCount} running
            </div>
            <MetricBar
              label="Running"
              value={pool.runningMB}
              max={pool.totalMB}
              caption={`${formatMb(pool.runningMB)} / ${formatMb(pool.totalMB)}`}
            />
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted">Headroom</span>
              <span
                className={`font-tabular truncate text-text ${pool.overCommitted ? "text-danger" : ""}`}
                title={`${pool.runningMB} / ${pool.totalMB} MB`}
              >
                {formatMb(pool.headroomMB)}
              </span>
            </div>
            {pool.unknownFootprint && (
              <p className="text-[10px] text-muted">Unknown footprints — estimates only</p>
            )}
            {pool.lanes.length === 0 ? (
              <p className="text-xs text-muted">No components in this pool</p>
            ) : (
              pool.lanes.map((lane) => {
                const known = isKnownFootprint(recipeFootprints?.[lane.recipe]);
                return (
                  <div
                    key={`${pool.id}:${lane.recipe}`}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs"
                  >
                    <span className="max-w-48 truncate font-medium text-text" title={lane.recipe}>
                      {lane.modelId ?? lane.recipe}
                    </span>
                    <span
                      className={`shrink-0 rounded px-1 text-[9px] font-medium uppercase tracking-wide ${
                        lane.state === "running" ? "bg-accent/15 text-accent" : "bg-border text-muted"
                      }`}
                    >
                      {lane.state}
                    </span>
                    {lane.state !== "running" &&
                      (lane.fitsWhenStopped ? (
                        <span className="text-muted">fits if stopped</span>
                      ) : (
                        <span className="text-danger">won&apos;t fit</span>
                      ))}
                    <span className="font-tabular text-text">
                      {known ? formatMb(lane.footprintMB) : "—"}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        ))
      )}
    </Panel>
  );
}
