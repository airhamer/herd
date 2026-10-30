/**
 * mem.js — memory metrics from /proc/meminfo.
 *
 * Seam type: MemMetrics (shared/types.ts). usedMB = totalMB − availableMB
 * (MemAvailable basis, same as sparkDash SystemCollector._getRamUsage).
 *
 * Issue #26: also reports Cached, SwapTotal and SwapFree so the cards can split
 * the pool the way Hasso's cockpit does (model / system / page cache / free,
 * plus swap). Page cache is reclaimable: it sits inside MemAvailable, so the UI
 * carves it out of "available", never out of "used". Prefers the host's
 * /proc/meminfo (mounted at /host/proc/meminfo by the installer), as gpu.js does.
 */
import { readTextFile } from "./util.js";

/** Read one `Key:   N kB` line as whole MB; 0 when absent. `^` anchors so SwapCached ≠ Cached. */
function fieldMB(raw, key) {
  const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
  if (!m) return 0;
  const kb = parseInt(m[1], 10);
  return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : 0;
}

/**
 * Collect memory metrics.
 * @param {{ readFile?: (path: string) => Promise<string> }} [deps]
 * @returns {Promise<{usedMB:number, totalMB:number, availableMB:number, percentage:number, cachedMB:number, swapTotalMB:number, swapFreeMB:number} | null>}
 */
export async function collectMem({ readFile = readTextFile } = {}) {
  try {
    const raw = await readFile("/host/proc/meminfo").catch(() => readFile("/proc/meminfo"));
    const totalM = raw.match(/MemTotal:\s+(\d+)\s+kB/);
    if (!totalM) return null;
    const availM = raw.match(/MemAvailable:\s+(\d+)\s+kB/);
    const totalKB = parseInt(totalM[1], 10);
    if (!Number.isFinite(totalKB) || totalKB <= 0) return null;
    const availKB = availM ? parseInt(availM[1], 10) : 0;

    const totalMB = Math.round(totalKB / 1024);
    const availableMB = Math.round(availKB / 1024);
    const usedMB = Math.max(0, totalMB - availableMB);
    const percentage = Math.min(100, Math.max(0, Math.round((usedMB / totalMB) * 100)));

    return {
      usedMB,
      totalMB,
      availableMB,
      percentage,
      cachedMB: fieldMB(raw, "Cached"),
      swapTotalMB: fieldMB(raw, "SwapTotal"),
      swapFreeMB: fieldMB(raw, "SwapFree"),
    };
  } catch {
    return null;
  }
}
