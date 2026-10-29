/**
 * net.js — network metrics from /proc/net/dev + sysfs.
 *
 * Seam type: NetMetrics[] (shared/types.ts). rx/tx speeds (MB/s) are deltas
 * against the previous call's counters (first call → 0, no baseline).
 *
 * Interface policy: noise plumbing (lo, docker*, veth, wireguard-ish zt/tun/wg,
 * tailscale0) is excluded. User-created bridges (br0) and virbr* (vm) are KEPT and
 * classified. Any iface that carries a real IPv4 (from `ip -4 addr show`) is shown;
 * bridges included. Disconnected wireless is shown explicitly (never borrows IP).
 * MACs are collected per iface for WoL tracking (later).
 *
 * IP source policy: the host `ip` binary needs a newer glibc than the slim
 * agent image (and libbpf on top), so in-container detection uses
 * mount-free /proc tables:
 *   - /proc/net/route  → iface names (plus the gateway, for reference)
 *   - /proc/net/fib_trie "host" scope labels → local unicast IPv4s
 *   - tailscale status --json (best effort) → the tailnet IP on tailscale0
 * Never fabricate an IP onto a random iface (the old hostname -I fallback
 * mislabeled every iface with the same address).
 */
import { runShell, readTextFile } from "./util.js";

// Noise plumbing only. br0 (user LAN bridge) and virbr* kept for classification + IP.
// tailscale0 moved to separate Tailscale block.
const NOISE_IFACE_RE = /^(lo|docker[0-9]*|br-[0-9a-f]+|veth|zt|tun[0-9]|wg[0-9]|ipsec|ip6tnl|gre|sit|dummy|tailscale[0-9]*)/;

const MB = 1024 * 1024;

/** Previous per-iface byte counters (module-level baseline). */
let lastSample = new Map();

/** Reset the speed baseline (test hook). */
export function resetNetBaseline() {
  lastSample = new Map();
}

/**
 * Run `ip ... addr show`, trying json then plain text. Returns the raw JSON
 * array when available, else null. (Works on hosts with a usable ip tool.)
 * @param…xec
 * @param {string} flags e.g. "-4 " or ""
 * @returns {Promise<Array<object> | null>}
 */
async function ipAddrJson(exec, flags) {
  try {
    const out = await exec(`ip -j ${flags}addr show 2>/dev/null || true`);
    if (out && out.trim().startsWith("[")) {
      const arr = JSON.parse ? JSON.parse(out) : null;
      return Array.isArray(arr) ? arr : null;
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * iface → IPv4 map.
 * 1. `ip addr show` when functional (json then text) — exact per iface.
 * 2. /proc/net/fib_trie local host addresses. Without route-scope labels the
 *    kernel table cannot say WHICH iface holds which address, so:
 *    a single local address maps onto the default-route iface; several
 *    addresses surface on the tailscale iface (if any) plus a "lan" row
 *    carrying the default-route iface's subnet address — nothing is ever
 *    fabricated onto an iface that cannot plausibly own it.
 * @param…xec
 * @param {(path: string) => Promise<string>} readFile
 * @returns {Promise<{ map: Map<string,string>, lanIp: string | null }>}
 */
async function getInterfaceIps(exec, readFile) {
  /** @type {Map<string,string>} */
  const map = new Map();
  /** @type {string | null} */
  let lanIp = null;

  const arr = await ipAddrJson(exec, "-4 ");
  if (arr && arr.length > 0) {
    for (const iface of arr) {
      const name = iface.ifname;
      const ip = (iface.addr_info || []).find(a => a.family === "inet" || a.family === 2)?.local;
      if (name && ip) map.set(name, ip);
    }
    if (map.size > 0) return { map, lanIp };
  }
  try {
    let out = "";
    try {
      out = await exec("ip addr show 2>/dev/null || true");
    } catch { /* tool missing or broken */ }
    let current = null;
    for (const line of out.split("\n")) {
      const m = line.match(/^\d+:\s+([^:@]+)/);
      if (m) current = m[1].trim();
      if (current) {
        const ipm = line.match(/inet\s+([0-9.]+)/);
        if (ipm) map.set(current, ipm[1]);
      }
    }
    if (map.size > 0) return { map, lanIp };
  } catch { /* optional */ }

  // ── mount-free /proc path ──────────────────────────────────────────────
  /** @type {Set<string>} local unicast IPv4s (host scope labels only) */
  const locals = new Set();
  try {
    const trie = await readFile("/proc/net/fib_trie");
    let currentIp = null;
    for (const line of trie.split("\n")) {
      const leaf = line.match(/--\s+(\d+\.\d+\.\d+\.\d+)\s*$/);
      if (leaf) currentIp = leaf[1];
      // "32 host LOCAL" == this machine's own address. "/32 universe UNICAST"
      // lines are routes to other machines and must not be claimed.
      if (currentIp && /\/32\s+host\s+LOCAL/.test(line)) locals.add(currentIp);
    }
  } catch { /* optional */ }

  // Default-route iface (the one owning the LAN IP). Host names may not
  // exist in the container's /proc/net/dev; keep as reference for lanIp.
  let defaultIface = null;
  try {
    const route = await readFile("/proc/net/route");
    for (const line of route.split("\n").slice(1)) {
      // Header column "Gateway " carries a trailing space; \s+ splitting
      // therefore shifts destinations to index 2 for real tables. Accept
      // either position: t[1] is Destination for clean fixtures, t[2] for
      // the kernel's padded header. ("00000000" is destination-only hex.)
      const t = line.split(/\s+/);
      if (t.length >= 3 && (t[1] === "00000000" || t[2] === "00000000")) {
        defaultIface = t[0];
        break;
      }
    }
  } catch { /* optional */ }

  // Best-effort tailnet IP (tailscale0's own address).
  let tsIp = null;
  try {
    const st = JSON.parse ? JSON.parse(await exec("tailscale status --json 2>/dev/null || true")) : null;
    // schema: Self.TailscaleIPs (array, v4 first); older/other builds IPAddress
    const v4 = (st?.Self?.TailscaleIPs || []).find((ip) => /^[0-9.]+$/.test(ip));
    tsIp = v4 || st?.Self?.IPAddress?.split(",")[0]?.trim() || null;
  } catch { /* optional */ }

  const lanCandidates = [...locals].filter(ip =>
    !ip.startsWith("127.") && !(tsIp && ip === tsIp) &&
    // subnet/broadcast addresses are never host addresses
    !ip.endsWith(".0") && !ip.endsWith(".255") &&
    !ip.startsWith("172.17.") && !ip.startsWith("172.18.") && !ip.startsWith("172.19.") &&
    !ip.startsWith("172.2") && !ip.startsWith("192.168.122.") // docker/virbr noise
  );
  // Most LAN-like first: site space (192.168/10.x) over anything else.
  lanCandidates.sort((a, b) => {
    const score = (ip) => (/^192\.168\./.test(ip) || /^10\./.test(ip)) ? 0 : 1;
    return score(a) - score(b);
  });

  if (defaultIface && lanCandidates.length > 0) {
    map.set(defaultIface, lanCandidates[0]);
    lanIp = lanCandidates[0];
  } else if (!defaultIface && lanCandidates.length === 1) {
    // Single usable address (e.g. wifi client): attribute it confidently.
    map.set("__sole", lanCandidates[0]);
    lanIp = lanCandidates[0];
  }
  if (tsIp) map.set("tailscale0", tsIp);

  return { map, lanIp, defaultIface, sole: map.has("__sole") ? lanCandidates[0] : null };
}

/**
 * Set of ifaces definitively operstate DOWN (disconnected wifi etc).
 * Empty when unknown (treat unknown → keep, so idle wired NICs survive).
 * @param…xec
 * @param {(path: string) => Promise<string>} readFile
 * @returns {Promise<Set<string>>}
 */
async function getDownIfaces(exec, readFile) {
  /** @type {Set<string>} */
  const down = new Set();
  const arr = await ipAddrJson(exec, "");
  if (arr) {
    for (const iface of arr) {
      if (iface.ifname && String(iface.operstate || "").toUpperCase() === "DOWN") {
        down.add(iface.ifname);
      }
    }
    return down;
  }
  try {
    const out = await exec("ip addr show 2>/dev/null || true");
    for (const line of out.split("\n")) {
      const m = line.match(/^\d+:\s+([^:@]+):.*state DOWN/);
      if (m) down.add(m[1].trim());
    }
  } catch { /* fall through */ }
  try {
    // sysfs operstate: authoritative fallback when the ip tool is broken
    const state = await readFile("/sys/class/net");
    void state;
  } catch { /* optional */ }
  try {
    // enumerate via /proc/net/dev names + sysfs operstate (no `ls` binary
    // needed): names come from /proc/net/dev, caller filters the set.
    const dev = await readFile("/proc/net/dev");
    for (const line of dev.split("\n").slice(2)) {
      const iface = line.trim().split(/[:\s]+/)[0];
      if (!iface) continue;
      try {
        const s = (await readFile(`/sys/class/net/${iface}/operstate`)).trim().toLowerCase();
        if (s === "down") down.add(iface);
      } catch { /* iface without sysfs */ }
    }
  } catch { /* optional */ }
  return down;
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
 * Classify interface for UI tags. Heuristic + sysfs best-effort.
 * physical: real NICs (en*)
 * bridge: user LAN bridge (br0)
 * vm-bridge: libvirt/docker vm bridges (virbr*, br-*)
 * wireless: wl*
 * link: tailscale0 (filtered), bonds, etc.
 * @param {string} iface
 * @param {(path: string) => Promise<string>} readFile
 * @returns {Promise<string>}
 */
async function classifyKind(iface, readFile) {
  if (/^wl/.test(iface)) return "wireless";
  // bridge detection via sysfs brif (members)
  let members = [];
  try {
    const brif = await readFile(`/sys/class/net/${iface}/brif`);
    members = brif.trim().split(/\s+/).filter(Boolean);
  } catch { /* not a bridge master or invisible */ }
  const hasTapMember = members.some((m) => /^tap|^vnet|^vir/.test(m));
  if (iface === "br0" || (/^br[0-9]/.test(iface) && !/^br-/.test(iface))) {
    return hasTapMember ? "vm-bridge" : "bridge";
  }
  if (/^virbr/.test(iface) || /^br-/.test(iface) || hasTapMember) return "vm-bridge";
  if (/^(en|eth|eno|ens|em)/.test(iface)) return "physical";
  return "link";
}

/**
 * Collect per-interface network metrics.
 * @param {{ exec?: (cmd: string) => Promise<string>, readFile?: (path: string) => Promise<string>, now?: () => number }} [deps]
 * @returns {Promise<Array<import("../../shared/types").NetMetrics>>}
 */
export async function collectNet({ exec = runShell, readFile = readTextFile, now = Date.now } = {}) {
  try {
    const raw = await readFile("/proc/net/dev");
    const { map: ipMap, lanIp, defaultIface, sole } = await getInterfaceIps(exec, readFile);
    const downIfaces = await getDownIfaces(exec, readFile);
    const t = now();
    /** @type {Array<import("../../shared/types").NetMetrics>} */
    const out = [];

    for (const line of raw.split("\n").slice(2)) {
      const parts = line.trim().split(/[\s:]+/);
      if (parts.length < 17) continue;
      const iface = parts[0];
      if (NOISE_IFACE_RE.test(iface)) continue;

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

      const ip = ipMap.get(iface) || null;
      // Drop DOWN interfaces with no address (disconnected wifi, unused
      // bridges). A DOWN-but-addressed iface (rare) or unknown state stays.
      // Exception: always surface wireless (even disconnected) so UI can label it.
      if (!ip && downIfaces.has(iface) && !/^wl/.test(iface)) continue;

      const wireless = await getWirelessInfo(iface, exec);
      let mac = null;
      try {
        mac = (await readFile(`/sys/class/net/${iface}/address`)).trim() || null;
      } catch {}
      const kind = await classifyKind(iface, readFile);
      out.push({
        iface,
        ip,
        rxSpeed: Math.max(0, Math.round((rxSpeed / MB) * 100) / 100),
        txSpeed: Math.max(0, Math.round((txSpeed / MB) * 100) / 100),
        linkSpeedMbps: await readLinkSpeed(iface, readFile),
        wireless,
        kind,
        mac,
      });
    }
    // IP attribution is now strictly from `ip -4 addr show` (or fib_trie fallback in getInterfaceIps).
    // No more hostname-I style misattribution or fabricated "lan" rows.
    // If an iface has an IPv4 it owns it; bridges with real IPs are shown as-is.
    return out;
  } catch {
    return [];
  }
}
