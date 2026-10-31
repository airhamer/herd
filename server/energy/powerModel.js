/**
 * Per-host power model for fleet energy (issue #33).
 *
 * Nothing here is wall-metered. Each host's draw is built from whatever its
 * telemetry can actually measure, plus an estimate for the rest:
 *
 *   - "gb10": DGX Spark / GB10 boxes keep the calibrated whole-system formula
 *     clamp(GPU draw + 5.2 + 59.8 x CPU% + 23, 0, 240) W. The GPU term is
 *     measured by nvidia-smi; the CPU and board terms are modelled.
 *   - "measured": every other host (x86 or ARM with discrete GPUs, AMD cards,
 *     CPU-only boxes). Watts = sum of per-GPU power (nvidia-smi or AMD hwmon)
 *     + CPU package power (RAPL / hwmon when the host exposes it, otherwise
 *     the collector's TDP x utilisation estimate) + a per-host idle baseline
 *     for the board, RAM, disks, fans and PSU losses (configurable).
 *
 * The result also says how many of those watts came from a sensor, so the
 * card can show what share of the estimate is measured.
 */

export const GB10_MAX_WATTS = 240;
/** Plausibility ceiling for one host (an 8-GPU server plus headroom). */
export const MAX_HOST_WATTS = 20_000;
/** Default idle baseline for non-GB10 hosts (board, RAM, disks, fans, PSU loss). */
export const DEFAULT_IDLE_BASELINE_W = 40;
export const MAX_IDLE_BASELINE_W = 2_000;

/** CPU power sources that read a hardware counter rather than a model. */
const MEASURED_CPU_SOURCES = new Set(["rapl", "hwmon", "thermal"]);
/** GPU power sources that read a hardware counter. */
const MEASURED_GPU_SOURCES = new Set(["nvidia-smi", "amd-hwmon"]);

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteNonnegative(value) {
  return Number.isFinite(value) && value >= 0;
}

const round1 = (value) => Math.round(value * 10) / 10;

/** The GB10 whole-system estimate. null when either input is unusable. */
export function gb10Watts(gpuDraw, cpuUsage) {
  if (!finiteNonnegative(gpuDraw) || !Number.isFinite(cpuUsage)) return null;
  const cpuWatts = 5.2 + ((65 - 5.2) * clamp(cpuUsage, 0, 100)) / 100;
  return clamp(gpuDraw + cpuWatts + 23, 0, GB10_MAX_WATTS);
}

/** Clamp a configured idle baseline; anything unusable falls back to the default. */
export function normalizeBaseline(value, fallback = DEFAULT_IDLE_BASELINE_W) {
  return Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_IDLE_BASELINE_W) : fallback;
}

/**
 * Estimate one host's draw.
 *
 * @param {{
 *   model: "gb10" | "measured",
 *   gpuWatts?: number | null, gpuSource?: string | null, gpuCount?: number | null,
 *   cpuWatts?: number | null, cpuSource?: string | null, cpuUsage?: number | null,
 *   baselineW?: number | null,
 * }} input
 * @returns {null | {
 *   model: "gb10" | "measured", watts: number, measuredWatts: number,
 *   gpuWatts: number | null, cpuWatts: number | null, baselineWatts: number,
 *   gpuSource: string | null, cpuSource: string | null, gpuCount: number | null,
 * }} null when the host reports nothing power-related.
 */
export function estimateHostPower(input = {}) {
  const gpuCount = Number.isInteger(input.gpuCount) && input.gpuCount > 0 ? input.gpuCount : null;
  if (input.model === "gb10") {
    const watts = gb10Watts(input.gpuWatts, input.cpuUsage);
    if (watts === null) return null;
    const cpuWatts = 5.2 + ((65 - 5.2) * clamp(input.cpuUsage, 0, 100)) / 100;
    return {
      model: "gb10",
      watts,
      measuredWatts: Math.min(watts, input.gpuWatts),
      gpuWatts: input.gpuWatts,
      cpuWatts: round1(cpuWatts),
      baselineWatts: 23,
      gpuSource: "nvidia-smi",
      cpuSource: "estimated",
      gpuCount,
    };
  }

  const hasGpu = finiteNonnegative(input.gpuWatts) && typeof input.gpuSource === "string";
  const hasCpu = finiteNonnegative(input.cpuWatts) && input.cpuWatts > 0;
  if (!hasGpu && !hasCpu) return null;

  const gpuWatts = hasGpu ? input.gpuWatts : null;
  const cpuWatts = hasCpu ? input.cpuWatts : null;
  const cpuSource = hasCpu ? (typeof input.cpuSource === "string" ? input.cpuSource : "estimated") : null;
  const gpuSource = hasGpu ? input.gpuSource : null;
  const baselineWatts = normalizeBaseline(input.baselineW);
  const watts = clamp((gpuWatts ?? 0) + (cpuWatts ?? 0) + baselineWatts, 0, MAX_HOST_WATTS);
  const measuredWatts =
    (gpuWatts !== null && MEASURED_GPU_SOURCES.has(gpuSource) ? gpuWatts : 0) +
    (cpuWatts !== null && MEASURED_CPU_SOURCES.has(cpuSource) ? cpuWatts : 0);
  return {
    model: "measured",
    watts,
    measuredWatts: Math.min(watts, measuredWatts),
    gpuWatts,
    cpuWatts,
    baselineWatts,
    gpuSource,
    cpuSource,
    gpuCount,
  };
}
