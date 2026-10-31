/**
 * memoryPool — one unified-memory pool split into parts that add up (issue #26).
 *
 * Mirrors Hasso's cockpit `poolParts()` (hasso5703/dgx-spark-qwen38,
 * dashboard/static/js/now.js#L16-L29). On a GB10 the CPU and GPU share one
 * LPDDR5X pool and nvidia-smi memory.used/total read [N/A], so the gauge is
 * /proc/meminfo:
 *
 *   inUse = total − available          (the big number)
 *   gpu   = min(GPU allocations, inUse) (the model's weights + KV pool; not reclaimable)
 *   other = inUse − gpu                 (OS, desktop, dashboard, tools)
 *   cache = min(Cached, available)      (reclaimable page cache — inside "available")
 *   free  = available − cache           (memory nobody holds)
 *   swap  = SwapTotal − SwapFree
 *
 * gpu + other + cache + free === total, so a stacked bar never over/under-fills.
 * The floor is the free-memory line under which a Spark is at risk of an OOM
 * livelock (Hasso aborts generations there; herd only displays it).
 */

export const DEFAULT_FLOOR_MB = 3 * 1024;
/** Hasso's thresholds: under 4 GiB available is critical, under 9 GiB is low. */
export const CRIT_AVAILABLE_MB = 4 * 1024;
export const LOW_AVAILABLE_MB = 9 * 1024;
/** Swap under this is noise (Hasso: 0.05 GiB). */
export const SWAP_SHOWN_MB = 0.05 * 1024;

export interface MemoryPoolInput {
  totalMB: number;
  availableMB: number;
  /** /proc/meminfo Cached; missing → 0 (older agents/servers). */
  cachedMB?: number | null;
  swapTotalMB?: number | null;
  swapFreeMB?: number | null;
  /** GPU allocations held in this pool (compute-apps sum). Ignored when `unified` is false. */
  gpuMB?: number | null;
  /** true when the GPU draws from this pool (GB10). A discrete GPU's VRAM is not part of it. */
  unified: boolean;
  floorMB?: number | null;
}

export type MemoryTone = "ok" | "low" | "crit";

export interface MemoryPool {
  totalMB: number;
  availableMB: number;
  inUseMB: number;
  gpuMB: number;
  otherMB: number;
  cacheMB: number;
  freeMB: number;
  swapUsedMB: number;
  floorMB: number;
  /** available − floor; negative when under the floor. */
  aboveFloorMB: number;
  unified: boolean;
  tone: MemoryTone;
}

const nn = (v: number | null | undefined): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Split the pool. Returns null when there is no usable total. */
export function memoryPool(input: MemoryPoolInput): MemoryPool | null {
  const totalMB = nn(input.totalMB);
  if (totalMB <= 0) return null;
  const availableMB = Math.min(nn(input.availableMB), totalMB);
  const inUseMB = totalMB - availableMB;
  const gpuMB = input.unified ? Math.min(nn(input.gpuMB), inUseMB) : 0;
  const otherMB = Math.max(0, inUseMB - gpuMB);
  const cacheMB = Math.min(nn(input.cachedMB), availableMB);
  const freeMB = Math.max(0, availableMB - cacheMB);
  const swapTotal = nn(input.swapTotalMB);
  const swapUsedMB = swapTotal > 0 ? Math.max(0, swapTotal - Math.min(nn(input.swapFreeMB), swapTotal)) : 0;
  const floorMB = input.floorMB != null && Number.isFinite(input.floorMB) && input.floorMB >= 0 ? input.floorMB : DEFAULT_FLOOR_MB;
  const tone: MemoryTone =
    availableMB < CRIT_AVAILABLE_MB ? "crit" : availableMB < LOW_AVAILABLE_MB ? "low" : "ok";
  return {
    totalMB,
    availableMB,
    inUseMB,
    gpuMB,
    otherMB,
    cacheMB,
    freeMB,
    swapUsedMB,
    floorMB,
    aboveFloorMB: availableMB - floorMB,
    unified: input.unified,
    tone,
  };
}

/** MB → "12.3" GiB (one decimal, no unit). */
export function gib(mb: number): string {
  return (mb / 1024).toFixed(1);
}

/**
 * Whether a GPU shares the OS pool. Only a positive identification counts:
 * the agent's `unifiedMemory` flag, which it sets for GB10 alone. Missing
 * data, an older agent, "[N/A]" memory or a VRAM total that happens to equal
 * MemTotal are NOT evidence: those hosts keep the separate RAM and VRAM
 * presentation, so system RAM and GPU memory are never merged into one pool.
 */
export function isUnifiedGpu(gpu: { unifiedMemory?: boolean } | null | undefined): boolean {
  return gpu?.unifiedMemory === true;
}

/**
 * Whether a server-side Spark snapshot is a unified-memory DGX Spark (GB10):
 * not a "host" unit (the app's explicit marker for discrete-GPU / non-Spark
 * Linux boxes), with GB10 hardware and a unified-memory reading.
 */
export function isUnifiedSpark(spark: {
  kind?: string;
  hardware?: { gpuChip?: string | null } | null;
  metrics?: { unifiedMemory?: { total?: number } | null };
}): boolean {
  return (
    spark.kind !== "host" &&
    /\bGB10\b/i.test(spark.hardware?.gpuChip ?? "") &&
    nn(spark.metrics?.unifiedMemory?.total) > 0
  );
}

/**
 * Who holds the GPU part, Hasso-style ("flash 176B … holds its weights and its
 * KV pool"): the running model, "N models", else the biggest GPU process, else
 * a generic label.
 */
export function gpuHolderLabel(models: Array<string | null | undefined>, topProcess?: string | null): string {
  const names = [...new Set(models.filter((m): m is string => typeof m === "string" && m.trim() !== ""))];
  if (names.length === 1) return shortModel(names[0]);
  if (names.length > 1) return `${names.length} models`;
  if (topProcess && topProcess.trim() && topProcess !== "unknown") return topProcess.trim();
  return "GPU allocations";
}

/** "org/Model-Name" → "Model-Name" (cards are narrow). */
export function shortModel(id: string): string {
  const t = id.trim();
  const i = t.lastIndexOf("/");
  return i >= 0 && i < t.length - 1 ? t.slice(i + 1) : t;
}

/**
 * The size a box is sold as, from what Linux sees (Hasso's boxmem.py: a 128 GB
 * GB10 shows 121.6 GiB of MemTotal). Prefers the hardware's own figure.
 */
export function poolClassGB(totalMB: number, hardwareGB?: number | null): number | null {
  if (typeof hardwareGB === "number" && Number.isFinite(hardwareGB) && hardwareGB > 0) return Math.round(hardwareGB);
  const g = nn(totalMB) / 1024;
  if (g <= 0) return null;
  for (const cls of [16, 32, 64, 128, 256, 512]) if (g <= cls) return cls;
  return Math.round(g);
}

/** Scale labels under the full bar: every 32 GiB that leaves room before the total (Hasso: 0/32/64/96/total). */
export function poolScaleGiB(totalMB: number): number[] {
  const g = nn(totalMB) / 1024;
  const marks: number[] = [];
  for (let m = 0; m < g - 12; m += 32) marks.push(m);
  return marks;
}

export type MemBudgetTone = "success" | "warning" | "danger";

/**
 * The Fleet card's "Mem Budget" stat on a UNIFIED-memory host, kept
 * consistent with the pool bar (#26): headroom above the floor = available −
 * floor (clamped at 0) in GiB, toned on available with the bar's thresholds,
 * danger whenever the budget needs a make-room plan. Prefers the pool; falls
 * back to the budget's own freeMB/totalMB only when there is no pool.
 *
 * Returns null on a host that is not unified (discrete GPU, CPU-only) or for a
 * non-unified pool: the floor is a GB10 OOM-livelock concept, so those hosts
 * keep the original system-RAM "X free" stat.
 */
export function memBudgetStat(
  pool: MemoryPool | null,
  budget: { freeMB: number; totalMB: number; needMakeRoom?: boolean } | null,
  unified = true,
): { value: string; tone: MemBudgetTone; title: string } | null {
  if (!unified || (pool && !pool.unified)) return null;
  const src = pool
    ? { availableMB: pool.availableMB, totalMB: pool.totalMB, floorMB: pool.floorMB }
    : budget
      ? { availableMB: nn(budget.freeMB), totalMB: nn(budget.totalMB), floorMB: DEFAULT_FLOOR_MB }
      : null;
  if (!src) return null;
  const above = Math.max(0, src.availableMB - src.floorMB);
  const tone: MemBudgetTone =
    budget?.needMakeRoom || src.availableMB < CRIT_AVAILABLE_MB
      ? "danger"
      : src.availableMB < LOW_AVAILABLE_MB
        ? "warning"
        : "success";
  const floorGiB = (src.floorMB / 1024).toFixed(0);
  return {
    value: `${gib(above)} GiB above floor`,
    tone,
    title: `available ${gib(src.availableMB)} GiB · floor ${floorGiB} GiB · total ${gib(src.totalMB)} GiB`,
  };
}
