import type { GpuMetrics, MemMetrics } from "../../shared/types";
import { isUnifiedGpu, memoryPool, type MemoryPool } from "./memoryPool";

/**
 * groupMemory — aggregate presentation of a TP group's unified memory (SC9).
 *
 * A group's memory story is the SUM across its members: total pools add,
 * available adds, in-use is the difference of those sums. The split into
 * Hasso's parts is done ONCE on the aggregate by memoryPool(), so the bar
 * never over/under-fills and a group view never shows a per-machine
 * breakdown (individuals live on their own pages).
 */

/** One member's raw readings, as delivered on a NodeAgentSnapshot. */
export interface MemberMemory {
  mem: MemMetrics | null | undefined;
  gpu: GpuMetrics | null | undefined;
}

const nn = (v: number | null | undefined): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

/**
 * The group's GPU share: on a unified member, the compute-apps allocation
 * (same source the Fleet card feeds the pool bar). A discrete GPU's VRAM is
 * not part of any shared pool, so non-unified members contribute nothing.
 */
function memberGpuMB(gpu: GpuMetrics | null | undefined): number {
  return gpu?.gpuAllocMB ?? (gpu?.processes ?? []).reduce((n, p) => n + (p.vramMB || 0), 0);
}

/**
 * Aggregate memory pool across group members. Members without a usable
 * memory reading are skipped (an offline member contributes no pool).
 * Returns null when no member has a usable total — callers then show the
 * waiting/empty state rather than a zero bar.
 */
export function aggregateMemoryPool(members: readonly MemberMemory[]): MemoryPool | null {
  let totalMB = 0;
  let availableMB = 0;
  let cachedMB = 0;
  let swapTotalMB = 0;
  let swapFreeMB = 0;
  let gpuMB = 0;
  let unified = false;
  let seen = false;

  for (const m of members) {
    const mem = m?.mem;
    if (!mem || !Number.isFinite(mem.totalMB) || mem.totalMB <= 0) continue;
    seen = true;
    totalMB += mem.totalMB;
    availableMB += Math.min(nn(mem.availableMB), mem.totalMB);
    cachedMB += nn(mem.cachedMB);
    swapTotalMB += nn(mem.swapTotalMB);
    swapFreeMB += nn(mem.swapFreeMB);
    if (isUnifiedGpu(m.gpu, mem.totalMB)) {
      unified = true;
      gpuMB += memberGpuMB(m.gpu);
    }
  }
  if (!seen) return null;

  return memoryPool({
    totalMB,
    availableMB,
    cachedMB,
    swapTotalMB,
    swapFreeMB,
    gpuMB,
    unified,
  });
}
