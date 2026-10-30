/**
 * gpu.js — GPU metrics via nvidia-smi (local, no SSH).
 *
 * Seam type: GpuMetrics (shared/types.ts). Returns null when nvidia-smi is
 * unavailable or reports no usable data (graceful degradation).
 *
 * GB10 note: on unified-memory GB10, nvidia-smi memory.used/memory.total are
 * often [N/A]. Mirrors sparkDash SystemCollector: vramTotal falls back to the
 * OS pool (MemTotal from /proc/meminfo), vramUsed to the compute-apps sum, and
 * vramAvailable to MemAvailable.
 *
 * Issue #26: also reports `gpuAllocMB` (sum of ALL compute apps, not just the
 * top 5 in `processes`) and `unifiedMemory` (true when nvidia-smi gives no
 * memory.total, i.e. the GPU draws from the OS pool, as on GB10). The cards use
 * them to carve the model's share out of MemTotal − MemAvailable.
 *
 * NOTE: the per-process VRAM field is `used_gpu_memory` (the actual
 * nvidia-smi field; the task spec's "utilities.gpu.memory.usage" does not
 * exist in nvidia-smi).
 */
import { runShell, readTextFile, parseSmiNumber } from "./util.js";
import fs from "node:fs";

const GPU_QUERY =
  "--query-gpu=temperature.gpu,utilization.gpu,power.draw,power.limit,memory.used,memory.total --format=csv,noheader,nounits";
const APPS_QUERY =
  "--query-compute-apps=pid,process_name,used_gpu_memory --format=csv,noheader,nounits";

/**
 * Collect GPU metrics.
 * @param {{ exec?: (cmd: string) => Promise<string>, readFile?: (path: string) => Promise<string>, smiPath?: string }} [deps]
 * @returns {Promise<{temperature:number, usage:number, powerDraw:number, powerLimit:number, vramUsedMB:number, vramTotalMB:number, vramPercentage:number, vramAvailableMB:number, processes:Array<{pid:number, name:string, vramMB:number}>, gpuAllocMB:number, unifiedMemory:boolean} | null>}
 */
export async function collectGpu({ exec = runShell, readFile = readTextFile, smiPath = "nvidia-smi" } = {}) {
  // Try NVIDIA
  try {
    const out = await exec(`${smiPath} ${GPU_QUERY} 2>/dev/null`);
    const line = out.split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
    const p = line.split(",").map((s) => s.trim());
    if (p.length >= 6) {
      const temperature = parseSmiNumber(p[0]);
      const usage = parseSmiNumber(p[1]);
      const powerDraw = parseSmiNumber(p[2]) ?? 0;
      const powerLimit = parseSmiNumber(p[3]) ?? 0;
      const smiUsed = parseSmiNumber(p[4]);
      const smiTotal = parseSmiNumber(p[5]);

      // OS-visible pool (GB10 unified-memory fallback; also feeds available).
      // Prefer host /proc/meminfo (mounted by installer) for accurate GB10 vram fallback.
      let memTotalMB = 0;
      let memAvailMB = null;
      const meminfoPath = (await readFile("/host/proc/meminfo").catch(() => null)) ? "/host/proc/meminfo" : "/proc/meminfo";
      try {
        const raw = await readFile(meminfoPath);
        const total = raw.match(/MemTotal:\s+(\d+)\s+kB/);
        const avail = raw.match(/MemAvailable:\s+(\d+)\s+kB/);
        memTotalMB = total ? Math.round(parseInt(total[1], 10) / 1024) : 0;
        memAvailMB = avail ? Math.round(parseInt(avail[1], 10) / 1024) : null;
      } catch {
        /* optional */
      }

      // Compute apps
      let processes = [];
      let appsSumMB = 0;
      try {
        const raw = await exec(`${smiPath} ${APPS_QUERY} 2>/dev/null`);
        for (const l of raw.split("\n")) {
          const parts = l.split(",").map((s) => s.trim());
          if (parts.length < 3) continue;
          const pid = parseInt(parts[0], 10);
          const vramMB = parseSmiNumber(parts[2]) ?? 0;
          if (!Number.isInteger(pid) || pid <= 0) continue;
          processes.push({ pid, name: parts[1] || "unknown", vramMB });
          appsSumMB += vramMB;
        }
        processes.sort((a, b) => b.vramMB - a.vramMB);
        processes = processes.slice(0, 5);
      } catch {
        processes = [];
        appsSumMB = 0;
      }

      const memUsedMB = memTotalMB - (memAvailMB ?? memTotalMB);
      const vramUsedMB = Math.round(smiUsed != null && smiUsed > 0 ? smiUsed : (appsSumMB > 0 ? appsSumMB : memUsedMB));
      const vramTotalMB = smiTotal != null && smiTotal > 0 ? Math.round(smiTotal) : memTotalMB;
      const vramAvailableMB =
        memAvailMB != null ? memAvailMB : Math.max(0, vramTotalMB - vramUsedMB);
      const vramPercentage =
        vramTotalMB > 0
          ? Math.min(100, Math.max(0, Math.round((vramUsedMB / vramTotalMB) * 100)))
          : 0;

      // Return if we got at least usage or temp (for GB10 where some fields N/A)
      if (usage != null || temperature != null) {
        return {
          temperature,
          usage: Math.min(100, Math.max(0, usage ?? 0)),
          powerDraw,
          powerLimit,
          vramUsedMB,
          vramTotalMB,
          vramPercentage,
          vramAvailableMB,
          processes,
          gpuAllocMB: Math.round(appsSumMB),
          unifiedMemory: !(smiTotal != null && smiTotal > 0),
        };
      }
    }
  } catch {}

  // AMD sysfs (portable, no rocm-smi binary required inside container)
  // Scan cards, prefer the one with largest VRAM (discrete RX > iGPU)
  try {
    const cards = [];
    for (let i = 0; i < 4; i++) {
      try {
        const busyP = `/sys/class/drm/card${i}/device/gpu_busy_percent`;
        const busy = await readFile(busyP);
        const u = parseInt(busy.trim(), 10);
        if (!Number.isFinite(u)) continue;

        let vramTotalMB = 0, vramUsedMB = 0;
        try {
          const t = await readFile(`/sys/class/drm/card${i}/device/mem_info_vram_total`);
          const uB = await readFile(`/sys/class/drm/card${i}/device/mem_info_vram_used`);
          vramTotalMB = Math.round(parseInt(t.trim(), 10) / 1024 / 1024);
          vramUsedMB = Math.round(parseInt(uB.trim(), 10) / 1024 / 1024);
        } catch {}
        if (vramTotalMB === 0) {
          try {
            const t = await readFile(`/sys/class/drm/card${i}/device/mem_info_vis_vram_total`);
            const uB = await readFile(`/sys/class/drm/card${i}/device/mem_info_vis_vram_used`);
            vramTotalMB = Math.round(parseInt(t.trim(), 10) / 1024 / 1024);
            vramUsedMB = Math.round(parseInt(uB.trim(), 10) / 1024 / 1024);
          } catch {}
        }

        let temperature = 0;
        try {
          const hwmonBase = `/sys/class/drm/card${i}/device/hwmon`;
          let hwmonNames = [];
          try {
            hwmonNames = (await readFile(hwmonBase)).split(/\s+/).filter(Boolean); // unlikely
          } catch {}
          if (hwmonNames.length === 0) {
            try {
              const fs = await import('node:fs');
              hwmonNames = fs.readdirSync ? fs.readdirSync(hwmonBase) : [];
            } catch {}
          }
          for (const h of hwmonNames.length ? hwmonNames : ['hwmon0']) {
            for (let ti = 1; ti <= 5; ti++) {
              try {
                const raw = await readFile(`${hwmonBase}/${h}/temp${ti}_input`);
                const t = parseInt(raw.trim(), 10);
                if (Number.isFinite(t) && t > 1000) { // mC
                  temperature = Math.round(t / 1000);
                  break;
                }
              } catch {}
            }
            if (temperature > 0) break;
          }
        } catch {}
        if (!temperature) {
          try {
            const tempRaw = await readFile(`/sys/class/drm/card${i}/device/hwmon/hwmon0/temp1_input`);
            const t = parseInt(tempRaw.trim(), 10);
            if (Number.isFinite(t)) temperature = Math.round(t / 1000);
          } catch {}
        }

        cards.push({ card: i, usage: u, vramTotalMB, vramUsedMB, temperature });
      } catch {}
    }
    if (cards.length === 0) throw new Error("no amd cards");

    // Prefer largest VRAM (the RX9060xt discrete)
    cards.sort((a, b) => b.vramTotalMB - a.vramTotalMB);
    const best = cards[0];

    const vramPercentage = best.vramTotalMB > 0 ? Math.min(100, Math.round((best.vramUsedMB / best.vramTotalMB) * 100)) : 0;
    let memAvailMB = null;
    try {
      const meminfoPath = (await readFile("/host/proc/meminfo").catch(() => null)) ? "/host/proc/meminfo" : "/proc/meminfo";
      const meminfo = await readFile(meminfoPath);
      const avail = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
      memAvailMB = avail ? Math.round(parseInt(avail[1], 10) / 1024) : null;
    } catch {}

    return {
      temperature: best.temperature,
      usage: Math.min(100, Math.max(0, best.usage)),
      powerDraw: 0,
      powerLimit: 0,
      vramUsedMB: best.vramUsedMB,
      vramTotalMB: best.vramTotalMB,
      vramPercentage,
      vramAvailableMB: memAvailMB != null ? memAvailMB : Math.max(0, best.vramTotalMB - best.vramUsedMB),
      processes: [],
    };
  } catch {}

  return null;
}
