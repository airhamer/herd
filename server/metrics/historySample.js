// Turns a unit snapshot into one history sample: { seriesKey: number } with
// only the readings the unit really produced. LIC2 clean-room rewrite from
// docs/specs/unit-history.md §2.
import { isNum, llmKey } from "./historyTiers.js";

const always = () => true;
const nonNeg = (v) => (isNum(v) ? Math.max(0, v) : 0);

/** The collector's placeholder when a GPU read failed: everything zero. */
function placeholderGpu(gpu) {
  return gpu.temperature === 0 && gpu.usage === 0 && gpu.power?.draw === 0 && gpu.vram?.total === 0;
}

function placeholderCpu(cpu) {
  return cpu.usage === 0 && cpu.temperature === 0 && cpu.draw === 0 && cpu.tdp === 0;
}

const isHost = (snapshot) => snapshot?.kind === "host";

function usableGpu(snapshot, fresh) {
  const gpu = snapshot?.metrics?.gpu;
  if (!gpu || !fresh("gpu") || placeholderGpu(gpu)) return null;
  return gpu;
}

/**
 * Used / free memory in MB as the memory panels show it: the unified pool on
 * Spark-class units, the GPU's VRAM otherwise. null when there is no reading.
 * @returns {{ usedMB: number, freeMB: number } | null}
 */
export function memoryReading(snapshot, isFresh = always) {
  const unified = !isHost(snapshot);
  const pool = snapshot?.metrics?.unifiedMemory;
  if (unified && pool && isFresh("memory") && pool.total > 0) {
    const usedMB = nonNeg(pool.gpuUsed) + nonNeg(pool.cpuUsed);
    const freeMB = isNum(pool.available) ? Math.max(0, pool.available) : Math.max(0, pool.total - usedMB);
    return { usedMB, freeMB };
  }
  const gpu = usableGpu(snapshot, isFresh);
  const vram = gpu?.vram;
  if (!vram || !(vram.total > 0)) return null;
  const usedMB = nonNeg(vram.used);
  // On a discrete host, vram.available describes system RAM, not the card.
  const freeMB =
    unified && isNum(vram.available) ? Math.max(0, vram.available) : Math.max(0, vram.total - usedMB);
  return { usedMB, freeMB };
}

/**
 * Receive / transmit bytes per second: the primary interface when it is one
 * of the shown interfaces, else the sum of all shown ones. Disabled
 * interfaces and loopback are never shown.
 * @returns {{ rx: number, tx: number } | null}
 */
export function networkRates(network) {
  const shown = (network?.interfaces ?? []).filter((nic) => nic && !nic.disabled && nic.name !== "lo");
  const primary = shown.find((nic) => nic.name === network?.primaryInterface);
  const counted = primary ? [primary] : shown;
  let rx = 0;
  let tx = 0;
  let seen = false;
  for (const nic of counted) {
    if (isNum(nic.rxSpeed)) {
      rx += nic.rxSpeed;
      seen = true;
    }
    if (isNum(nic.txSpeed)) {
      tx += nic.txSpeed;
      seen = true;
    }
  }
  return seen ? { rx, tx } : null;
}

/**
 * One sample for the bucketed tiers, or null for a unit that is not online.
 * `isFresh(domain)` says whether a metrics domain was collected recently
 * enough to trust; stale, failed or unavailable readings are left out
 * rather than recorded as zero.
 * @returns {Record<string, number> | null}
 */
export function extractSample(snapshot, isFresh = always) {
  if (!snapshot || snapshot.online !== true) return null;
  const m = snapshot.metrics ?? {};
  const sample = {};
  const put = (key, v) => {
    if (isNum(v)) sample[key] = v;
  };

  const gpu = usableGpu(snapshot, isFresh);
  if (gpu) {
    const off = gpu.metricAvailability ?? {};
    if (off.usage !== false) put("gpuUtil", gpu.usage);
    if (off.temperature !== false && gpu.temperature > 0) put("gpuTemp", gpu.temperature);
    if (off.powerDraw !== false) put("gpuPower", gpu.power?.draw);
  }

  const mem = memoryReading(snapshot, isFresh);
  if (mem) {
    put("memUsedMB", mem.usedMB);
    put("memFreeMB", mem.freeMB);
  }

  const cpu = m.cpu;
  if (cpu && isFresh("cpu") && !placeholderCpu(cpu)) {
    put("cpuUtil", cpu.usage);
    if (cpu.temperature > 0) put("cpuTemp", cpu.temperature);
  }

  if (isHost(snapshot) && m.ram && isFresh("ram") && m.ram.total > 0) put("ramUsedMB", m.ram.used);

  if (isFresh("network")) {
    const net = networkRates(m.network);
    if (net) {
      put("netRx", net.rx);
      put("netTx", net.tx);
    }
  }

  if (Array.isArray(m.llm) && isFresh("llm")) {
    const ports = Array.isArray(snapshot.llmPorts) ? snapshot.llmPorts : [];
    m.llm.forEach((engine, i) => {
      const port = ports[i];
      if (!Number.isInteger(port) || engine?.available !== true) return;
      put(llmKey(port, "genTps"), engine.generationTps);
      put(llmKey(port, "prefillTps"), engine.prefillTps);
      if (isNum(engine.kvCacheUsage)) put(llmKey(port, "kvUsage"), Math.min(1, Math.max(0, engine.kvCacheUsage)));
    });
  }

  return sample;
}
