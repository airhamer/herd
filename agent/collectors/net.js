/**
 * net.js — network metrics from /proc/net/dev + sysfs.
 *
 * Seam type: NetMetrics[] (shared/types.ts). rx/tx speeds (MB/s) are deltas
 * against the previous call's counters (first call → 0, no baseline).
 * Virtual interfaces (lo, docker*, br-*, veth*, ...) are excluded, same prefix
 * set as sparkDash SystemCollector._isVirtualNetworkInterface.
 */
import { runShell, readTextFile } from "./util.js";

const VIRTUAL_IFACE_RE = /^(lo|docker|br-|veth|virbr|zt|tun|wg|tailscale|ipsec|ip6tnl|gre|sit|dummy)/;

const MB = 1024 * 1024;

/** Previous per-iface byte counters (module-level baseline). */
let lastSample = new Map();

/** Reset the speed baseline (test hook). */
export function resetNetBaseline() {
  lastSample = new Map();
}

/**
 * Map iface → IPv4 address from `ip -4 addr show`. Empty when unavailable.
 * @param {(cmd: string) => Promise<string>} exec
 * @returns {Promise<Map<string, string>>}
 */
async function getInterfaceIpMap(exec) {
  const map = new Map();
  try {
    // Try json first
    let out = await exec("ip -j -4 addr show 2>/dev/null || true");
    if (out && out.trim().startsWith("[")) {
      try {
        const arr = JSON.parse(out);
        for (const iface of arr) {
          const name = iface.ifname;
          const ip = (iface.addr_info || []).find(a => a.family === "inet")?.local;
          if (name && ip) map.set(name, ip);
        }
      } catch {}
    }
    if (map.size === 0) {
      out = await exec("ip -4 addr show 2>/dev/null || ip addr show 2>/dev/null");
      let currentIface = null;
      for (const line of out.split("\n")) {
        const m = line.match(/^\d+:\s+([^:]+):/);
        if (m) {
          currentIface = m[1].trim();
        }
        if (currentIface) {
          const ipm = line.match(/inet\s+([0-9.]+)/);
          if (ipm) {
            map.set(currentIface, ipm[1]);
          }
        }
      }
    }
    // Fallback: hostname -I for main IP, assign to first non-virtual iface without IP
  try {
    const h = await exec("hostname -I 2>/dev/null || true");
    const ips = h.trim().split(/\s+/).filter((x) => x && !x.includes(":")); // IPv4 only
    if (ips.length > 0) {
      const mainIp = ips[0];
      // assign to first iface in map or a common name
      if (map.size === 0) {
        map.set("eth0", mainIp);
      } else {
        // fill first without ip
        for (const [k, v] of map) {
          if (!v) {
            map.set(k, mainIp);
            break;
          }
        }
      }
    }
  } catch {}
  } catch {
    /* optional */
  }
  return map;
}

/**
 * Link speed from /sys/class/net/<iface>/speed (Mbps). null when unknown.
 * @param {string} iface
 * @param {(path: string) => Promise<string>} readFile
 * @returns {Promise<number | null>}
 */
async function readLinkSpeed(iface, readFile) {
  try {
    const n = parseInt((await readFile(`/sys/class/net/${iface}/speed`)).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort wireless info for a WiFi interface using iw if available.
 * Returns null for non-wireless or failure.
 */
async function getWirelessInfo(iface, exec) {
  try {
    // Quick check if wireless
    const devInfo = await exec(`iw dev ${iface} info 2>/dev/null || true`).catch(() => "");
    if (!devInfo || !/Interface/.test(devInfo)) return null;
    const link = await exec(`iw dev ${iface} link 2>/dev/null || true`).catch(() => "");
    const ssidMatch = link.match(/SSID: (.+)/);
    const signalMatch = link.match(/signal: (-?\d+) dBm/);
    const freqMatch = link.match(/freq: (\d+)/);
    return {
      ssid: ssidMatch ? ssidMatch[1].trim() : null,
      signalDbm: signalMatch ? parseInt(signalMatch[1], 10) : null,
      frequency: freqMatch ? freqMatch[1] + " MHz" : null,
    };
  } catch {
    return null;
  }
}

/**
 * Collect per-interface network metrics.
 * @param {{ exec?: (cmd: string) => Promise<string>, readFile?: (path: string) => Promise<string>, now?: () => number }} [deps]
 * @returns {Promise<Array<{iface:string, ip:string|null, rxSpeed:number, txSpeed:number, linkSpeedMbps:number|null}>>}
 */
export async function collectNet({ exec = runShell, readFile = readTextFile, now = Date.now } = {}) {
  try {
    const raw = await readFile("/proc/net/dev");
    const ipMap = await getInterfaceIpMap(exec);
    const t = now();
    /** @type {Array<{iface:string, ip:string|null, rxSpeed:number, txSpeed:number, linkSpeedMbps:number|null}>} */
    const out = [];

    for (const line of raw.split("\n").slice(2)) {
      const parts = line.trim().split(/[\s:]+/);
      if (parts.length < 17) continue;
      const iface = parts[0];
      if (VIRTUAL_IFACE_RE.test(iface)) continue;

      const rxBytes = parseInt(parts[1], 10) || 0;
      const txBytes = parseInt(parts[9], 10) || 0;
      const last = lastSample.get(iface);
      let rxSpeed = 0;
      let txSpeed = 0;
      if (last && t > last.time) {
        const dtSec = (t - last.time) / 1000;
        rxSpeed = (rxBytes - last.rxBytes) / dtSec;
        txSpeed = (txBytes - last.txBytes) / dtSec;
      }
      lastSample.set(iface, { rxBytes, txBytes, time: t });

      const wireless = await getWirelessInfo(iface, exec);
      let mac = null;
      try {
        mac = (await readFile(`/sys/class/net/${iface}/address`)).trim() || null;
      } catch {}
      out.push({
        iface,
        ip: ipMap.get(iface) || null,
        rxSpeed: Math.max(0, Math.round((rxSpeed / MB) * 100) / 100),
        txSpeed: Math.max(0, Math.round((txSpeed / MB) * 100) / 100),
        linkSpeedMbps: await readLinkSpeed(iface, readFile),
        wireless,
        mac,
      });
    }
    // Fallback IP for display if none detected (common when ip tool parse misses bridge/wireless)
    if (out.length > 0) {
      try {
        const h = await exec("hostname -I 2>/dev/null || true");
        const ip = h.trim().split(/\s+/).filter(Boolean)[0];
        if (ip && !out[0].ip) out[0].ip = ip;
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}
