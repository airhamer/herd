import type { GpuMetrics, MemMetrics } from "../../shared/types";
import type { CatalogComponent } from "../api/client";
import { DEFAULT_FLOOR_MB, LOW_AVAILABLE_MB, isUnifiedGpu, memoryPool } from "./memoryPool";

/**
 * groupSingles: the single (tp=1) components that fit on each member of a
 * spark group once the group's TP=x component is placed (SC5e, #87).
 *
 * Each member's remaining memory is its Hasso pool headroom above the OOM floor
 * (memoryPool().aboveFloorMB, which is available − floor):
 *   - TP component running: its weights and KV are already in the reading, so
 *     remaining = aboveFloor.
 *   - TP component selected, not running: remaining = aboveFloor − its
 *     memoryPerSparkMB (what it will take on every member).
 *   - no TP component: remaining = aboveFloor, and the view says nothing is
 *     placed yet.
 * A single fits when its memoryPerSparkMB ≤ remaining. "Tight" means it fits
 * but would leave less than Hasso's low line (9 GiB) above the floor. A
 * component with no memory figure cannot be checked.
 */

/** Version states that mean "this component holds memory on the node". */
export const HOLDING_STATES = new Set(["running", "ready", "healthy", "starting", "loading"]);

export interface GroupMemberInput {
  nodeId: string;
  nodeName: string;
  mem: MemMetrics | null | undefined;
  gpu: GpuMetrics | null | undefined;
}

export type SingleFit = "fits" | "tight" | "no_fit" | "unknown" | "running";

export interface SingleVerdict {
  component: CatalogComponent;
  fit: SingleFit;
  /** memoryPerSparkMB, null when unknown. */
  needMB: number | null;
  /** remaining − need (negative = short by). null when either side is unknown. */
  leftMB: number | null;
}

export interface MemberSingles {
  nodeId: string;
  nodeName: string;
  /** null when the member has no memory reading. */
  remainingMB: number | null;
  singles: SingleVerdict[];
}

export interface GroupSinglesView {
  /** The TP=x component the numbers assume, or null. */
  tpComponent: CatalogComponent | null;
  /** "running" = already in the readings; "planned" = selected and subtracted; "none" = nothing placed. */
  placement: "running" | "planned" | "none";
  /** TP=x components the group could run (for the selector). */
  tpCandidates: CatalogComponent[];
  members: MemberSingles[];
}

const holds = (c: CatalogComponent, nodeIds: Set<string>): boolean =>
  (c.nodes ?? []).some((n) => nodeIds.has(n.nodeId) && HOLDING_STATES.has(String(n.state).toLowerCase()));

const ORDER: Record<SingleFit, number> = { running: 0, fits: 1, tight: 2, unknown: 3, no_fit: 4 };

/**
 * @param members the group's members (head first)
 * @param components the live catalog (GET /api/components)
 * @param selectedTpId a TP=x component the user picked; ignored when one is already running
 */
export function groupSingles(
  members: readonly GroupMemberInput[],
  components: readonly CatalogComponent[],
  selectedTpId: string | null = null,
  floorMB: number = DEFAULT_FLOOR_MB,
): GroupSinglesView {
  const size = members.length;
  const ids = new Set(members.map((m) => m.nodeId));
  const llm = components.filter((c) => c.kind === "llm" || c.kind == null || c.kind === "");
  const tpCandidates = size > 1 ? llm.filter((c) => c.tp === size) : [];
  const running = tpCandidates.find((c) => holds(c, ids)) ?? null;
  const selected = running ? null : tpCandidates.find((c) => c.id === selectedTpId) ?? null;
  const tpComponent = running ?? selected;
  const placement = running ? "running" : selected ? "planned" : "none";
  const plannedMB = selected?.memoryPerSparkMB ?? 0;
  const singles = llm.filter((c) => c.tp === 1);

  return {
    tpComponent,
    placement,
    tpCandidates,
    members: members.map((m) => {
      const total = m.mem?.totalMB ?? 0;
      const pool =
        m.mem && total > 0
          ? memoryPool({ totalMB: total, availableMB: m.mem.availableMB, cachedMB: m.mem.cachedMB, unified: isUnifiedGpu(m.gpu, total), floorMB })
          : null;
      const remainingMB = pool ? pool.aboveFloorMB - plannedMB : null;
      const one = new Set([m.nodeId]);
      const verdicts: SingleVerdict[] = singles.map((c) => {
        const needMB = c.memoryPerSparkMB != null && c.memoryPerSparkMB > 0 ? c.memoryPerSparkMB : null;
        if (holds(c, one)) return { component: c, fit: "running", needMB, leftMB: null };
        if (needMB == null || remainingMB == null) return { component: c, fit: "unknown", needMB, leftMB: null };
        const leftMB = remainingMB - needMB;
        const fit: SingleFit = leftMB < 0 ? "no_fit" : leftMB < LOW_AVAILABLE_MB ? "tight" : "fits";
        return { component: c, fit, needMB, leftMB };
      });
      verdicts.sort((a, b) => ORDER[a.fit] - ORDER[b.fit] || (a.needMB ?? 0) - (b.needMB ?? 0) || a.component.id.localeCompare(b.component.id));
      return { nodeId: m.nodeId, nodeName: m.nodeName, remainingMB, singles: verdicts };
    }),
  };
}
