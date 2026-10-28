/**
 * Lane coexistence / budget math — PURE (S3.2a).
 *
 * Answers, per GPU pool: how much of the pool the running lane(s) already
 * hold, how much headroom is left, and whether a stopped lane would fit if
 * it were started in its turn. This is the budgeting brain for the S3.2b
 * lane panel; nothing here imports React, reads fs, or touches the network.
 *
 * Input is the S3.1 lane seam (NodeLanes from shared/types.ts, derived by
 * agent/catalog/lanes.js deriveLanes). LaneEntry itself carries no
 * footprintMB — the caller merges it in from the recipe (Recipe.footprintMB
 * is required by shared/recipe.schema.json), which BudgetLane models as an
 * optional field. Unknown (nullish / non-finite) footprints count as 0 and
 * set `unknownFootprint` on the pool so the UI can say "estimate only".
 *
 * Graceful-absence pattern mirrors the guard panels: when lanes are absent
 * (null/undefined — e.g. pre-S3.1 agent, enrich failure) or the pool total
 * is unknown (null / <= 0 — no live GPU memory family), the result is
 * `{ available: false, pools: [] }`, never a throw.
 */
import type { LaneEntry } from "../../shared/types";

/** Lane seam entry plus the caller-merged recipe footprint. */
export type BudgetLane = LaneEntry & { footprintMB?: number | null };

/** Lane pool plus caller-merged footprints (LanePool is assignable). */
export interface BudgetPool {
  id: string;
  lanes: BudgetLane[];
}

/** What computeLaneBudgets accepts: NodeLanes (or a bare { pools } view). */
export interface BudgetLanes {
  pools: BudgetPool[];
}

/** One lane within a budget pool view. */
export interface LaneBudgetLane {
  recipe: string;
  modelId: string | null;
  /** "running" | "stopped" (verbatim from the seam). */
  state: string;
  /** Effective footprint used in the math (unknown → 0). */
  footprintMB: number;
  order: number;
  /**
   * Present only for stopped lanes: would this lane fit in the pool's
   * current headroom if started? Running lanes omit it (they already run).
   */
  fitsWhenStopped?: boolean;
}

/** One pool's budget view. */
export interface LaneBudgetPool {
  id: string;
  /** Live GPU total for this pool's unit, MB (echoed from poolTotalMB). */
  totalMB: number;
  /** Sum of effective footprints of running lanes. */
  runningMB: number;
  /** How many lanes in this pool are running. */
  runningCount: number;
  /** totalMB − runningMB; negative exactly when overCommitted. */
  headroomMB: number;
  /** runningMB > totalMB (more lanes running than the pool can hold). */
  overCommitted: boolean;
  /** Present (true) only when some lane's footprint was unknown. */
  unknownFootprint?: true;
  lanes: LaneBudgetLane[];
}

/** Result of computeLaneBudgets. */
export interface LaneBudgets {
  available: boolean;
  pools: LaneBudgetPool[];
}

const NOT_PRESENT: LaneBudgets = { available: false, pools: [] };

function isRunning(lane: BudgetLane): boolean {
  // running wins when present (seam boolean); state string is the fallback.
  return lane.running ?? lane.state === "running";
}

function effectiveFootprint(lane: BudgetLane): { mb: number; unknown: boolean } {
  const raw = lane.footprintMB;
  if (typeof raw === "number" && Number.isFinite(raw)) return { mb: raw, unknown: false };
  return { mb: 0, unknown: true };
}

/**
 * Compute per-pool coexistence budgets for one unit's lane view.
 *
 * @param lanes  NodeLanes view from the snapshot (nullish = not present)
 * @param poolTotalMB live GPU total for the unit, MB (nullish/<=0 = unknown)
 * @returns budget pools in input order, lanes in input order; pure, total.
 */
export function computeLaneBudgets(
  lanes: BudgetLanes | null | undefined,
  poolTotalMB: number | null,
): LaneBudgets {
  if (!lanes || !Array.isArray(lanes.pools)) return NOT_PRESENT;
  if (typeof poolTotalMB !== "number" || !Number.isFinite(poolTotalMB) || poolTotalMB <= 0) {
    return NOT_PRESENT;
  }

  const pools: LaneBudgetPool[] = lanes.pools.map((pool) => {
    // Pass 1: running totals (effective footprints).
    let runningMB = 0;
    let runningCount = 0;
    let unknown = false;
    const running = pool.lanes.map((lane) => {
      const { mb, unknown: unk } = effectiveFootprint(lane);
      if (unk) unknown = true;
      const isRun = isRunning(lane);
      if (isRun) {
        runningMB += mb;
        runningCount += 1;
      }
      return isRun;
    });

    const headroomMB = poolTotalMB - runningMB;
    const overCommitted = runningMB > poolTotalMB;

    // Pass 2: per-lane view; stopped lanes ask whether they fit the headroom.
    const budgetLanes: LaneBudgetLane[] = pool.lanes.map((lane, i) => {
      const out: LaneBudgetLane = {
        recipe: lane.recipe,
        modelId: lane.modelId,
        state: lane.state,
        footprintMB: effectiveFootprint(lane).mb,
        order: lane.order,
      };
      if (!running[i]) out.fitsWhenStopped = out.footprintMB <= headroomMB;
      return out;
    });

    const view: LaneBudgetPool = {
      id: pool.id,
      totalMB: poolTotalMB,
      runningMB,
      runningCount,
      headroomMB,
      overCommitted,
      lanes: budgetLanes,
    };
    if (unknown) view.unknownFootprint = true;
    return view;
  });

  return { available: true, pools };
}
