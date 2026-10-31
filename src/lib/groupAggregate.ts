import type { CpuMetrics, GpuMetrics, MemMetrics } from "../../shared/types";
import type { MemoryPool } from "./memoryPool";
import { aggregateMemoryPool } from "./groupMemory";

/**
 * groupAggregate — one set of Fleet-card bars for several "parts" (SC5d, #75).
 *
 * A part is anything with its own mem/gpu/cpu readings. Today the parts are
 * the sparks of a group; the Fleet group card shows ONE bar per metric:
 *   - memory: the Hasso pool over the summed members (used and total add up);
 *   - GPU / CPU usage: summed use over summed capacity (= the mean %);
 *   - GPU / CPU temperature: the hottest part (a sum of °C means nothing);
 *   - GPU power: summed draw over summed limit;
 *   - VRAM (discrete GPUs only): summed used over summed total.
 *
 * TODO(#30, MGPU1): a non-Spark multi-GPU host should feed one part per GPU
 * here so its Fleet card shows all VRAM combined, with per-GPU bars on
 * drill-down. Not implemented yet — keep this helper free of Spark specifics.
 */
export interface MetricPart {
  mem: MemMetrics | null | undefined;
  gpu: GpuMetrics | null | undefined;
  cpu: CpuMetrics | null | undefined;
}

export interface AggregatedMetrics {
  /** Parts given. */
  parts: number;
  /** Parts with any reading. */
  reporting: number;
  pool: MemoryPool | null;
  gpu: {
    usage: number;
    temperatureMax: number | null;
    powerDraw: number;
    powerLimit: number;
    vramUsedMB: number;
    vramTotalMB: number;
    /** true when every reporting GPU draws from its host's unified pool. */
    unified: boolean;
  } | null;
  cpu: { usage: number; temperatureMax: number | null } | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const max = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.max(a, b));

export function aggregateMetrics(parts: readonly MetricPart[]): AggregatedMetrics {
  let reporting = 0;
  let gpuN = 0;
  let gpuUsage = 0;
  let gpuTemp: number | null = null;
  let powerDraw = 0;
  let powerLimit = 0;
  let vramUsed = 0;
  let vramTotal = 0;
  let unified = true;
  let cpuN = 0;
  let cpuUsage = 0;
  let cpuTemp: number | null = null;

  for (const p of parts) {
    if (p.mem || p.gpu || p.cpu) reporting += 1;
    if (p.gpu) {
      gpuN += 1;
      gpuUsage += num(p.gpu.usage) ?? 0;
      gpuTemp = max(gpuTemp, num(p.gpu.temperature));
      powerDraw += num(p.gpu.powerDraw) ?? 0;
      powerLimit += num(p.gpu.powerLimit) ?? 0;
      if (p.gpu.unifiedMemory !== true) {
        unified = false;
        vramUsed += num(p.gpu.vramUsedMB) ?? 0;
        vramTotal += num(p.gpu.vramTotalMB) ?? 0;
      }
    }
    if (p.cpu) {
      cpuN += 1;
      cpuUsage += num(p.cpu.usage) ?? 0;
      cpuTemp = max(cpuTemp, num(p.cpu.temperature));
    }
  }

  return {
    parts: parts.length,
    reporting,
    pool: aggregateMemoryPool(parts.map((p) => ({ mem: p.mem, gpu: p.gpu }))),
    gpu: gpuN
      ? {
          usage: Math.round(gpuUsage / gpuN),
          temperatureMax: gpuTemp,
          powerDraw: Math.round(powerDraw),
          powerLimit: Math.round(powerLimit),
          vramUsedMB: vramUsed,
          vramTotalMB: vramTotal,
          unified,
        }
      : null,
    cpu: cpuN ? { usage: Math.round(cpuUsage / cpuN), temperatureMax: cpuTemp } : null,
  };
}
