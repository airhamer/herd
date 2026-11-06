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
  // The 3 GiB Spark OOM floor applies to the unified GB10 pool only.
  // A discrete GPU's VRAM is a different device; do not subtract that floor
  // from VRAM or treat RAM+VRAM as one interchangeable capacity.
  const defaultFloor = input.unified ? DEFAULT_FLOOR_MB : 0;
  const floorMB = input.floorMB != null && Number.isFinite(input.floorMB) && input.floorMB >= 0 ? input.floorMB : defaultFloor;
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
 * Whether a GPU shares the OS pool. Prefers the agent's explicit flag (#26);
 * for older snapshots, a GPU whose "VRAM total" equals MemTotal (the GB10
 * fallback) is unified.
 */
export function isUnifiedGpu(
  gpu: { unifiedMemory?: boolean; vramTotalMB?: number } | null | undefined,
  memTotalMB: number,
): boolean {
  if (!gpu) return false;
  if (typeof gpu.unifiedMemory === "boolean") return gpu.unifiedMemory;
  const v = nn(gpu.vramTotalMB);
  return v > 0 && memTotalMB > 0 && Math.abs(v - memTotalMB) / memTotalMB < 0.02;
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
 * The Fleet card's "Mem Budget" stat, kept consistent with the pool bar
 * (#26): headroom above the floor = available − floor (clamped at 0) in GiB,
 * toned on available with the bar's thresholds, danger whenever the budget
 * needs a make-room plan. Prefers the pool; falls back to the budget's own
 * freeMB/totalMB only when there is no pool breakdown.
 */
export function memBudgetStat(
  pool: MemoryPool | null,
  budget: { freeMB: number; totalMB: number; needMakeRoom?: boolean } | null,
): { value: string; tone: MemBudgetTone; title: string } | null {
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


export interface VramReading {
  usedMB: number | null;
  totalMB: number | null;
}

export interface InferenceBudgetInput {
  unified: boolean;
  pool: MemoryPool | null;
  budget: { freeMB: number; totalMB: number; needMakeRoom?: boolean } | null;
  vram?: VramReading | null;
  /**
   * Measured Elephant-AI / agent / proxy footprint already included in
   * used/available. Shown in the title so it is not deducted again.
   */
  infraUsedMB?: number | null;
  /** Extra named safety reserve (not the Spark 3 GiB VRAM floor). */
  safetyReserveMB?: number | null;
  /** When true, RAM above the named reserve may be described as CPU-offload headroom. */
  cpuOffloadEnabled?: boolean;
}

/**
 * Answer "can another service fit?" without mixing RAM and VRAM.
 *
 * Unified GB10: one shared pool; the 3 GiB Spark floor applies (Hasso).
 * Discrete GPU: VRAM is the inference budget; system RAM is separate.
 * Missing VRAM totals read "unknown", never "0 GiB free".
 */
export function inferenceBudget(input: InferenceBudgetInput): { value: string; tone: MemBudgetTone; title: string } | null {
  if (input.unified) {
    const stat = memBudgetStat(input.pool, input.budget);
    if (!stat) return null;
    const infra = nn(input.infraUsedMB);
    const extra = nn(input.safetyReserveMB);
    const bits = [stat.title];
    if (infra > 0) bits.push(`infra (measured, already in use) ${gib(infra)} GiB`);
    if (extra > 0) bits.push(`safety reserve ${gib(extra)} GiB (named separately; not deducted twice)`);
    return { ...stat, title: bits.join(" · ") };
  }

  const total = input.vram && typeof input.vram.totalMB === "number" && Number.isFinite(input.vram.totalMB) && input.vram.totalMB > 0
    ? input.vram.totalMB
    : null;
  const used = input.vram && typeof input.vram.usedMB === "number" && Number.isFinite(input.vram.usedMB) && input.vram.usedMB >= 0
    ? input.vram.usedMB
    : null;
  if (total == null || used == null) {
    return {
      value: "VRAM unknown",
      tone: "warning",
      title: "No VRAM reading yet — not the same as 0 GiB free. System RAM is tracked separately and is not added to VRAM.",
    };
  }
  const free = Math.max(0, total - used);
  const extra = nn(input.safetyReserveMB);
  const usable = Math.max(0, free - extra);
  const tone: MemBudgetTone = input.budget?.needMakeRoom || usable <= 0 ? "danger" : usable < 2048 ? "warning" : "success";
  const ram = input.pool
    ? `system RAM ${gib(input.pool.availableMB)} GiB available of ${gib(input.pool.totalMB)} GiB`
    : input.budget
      ? `system RAM ${gib(nn(input.budget.freeMB))} GiB reported free`
      : "system RAM separate";
  const infra = nn(input.infraUsedMB);
  const titleParts = [
    `VRAM ${gib(used)} / ${gib(total)} GiB`,
    `${gib(free)} GiB VRAM free`,
    ram,
    "RAM and VRAM are not one interchangeable pool",
  ];
  if (infra > 0) titleParts.push(`infra (measured, already in use) ${gib(infra)} GiB`);
  if (extra > 0) titleParts.push(`safety reserve ${gib(extra)} GiB held out of VRAM free`);
  if (input.cpuOffloadEnabled) titleParts.push("CPU offload enabled: RAM above any named reserve may hold weights");
  return {
    value: `${gib(usable)} GiB VRAM free`,
    tone,
    title: titleParts.join(" · "),
  };
}
