// ─── Fleet macOS SSH collector (S1.5) ──────────────────────────────────────
//
// The agentless macOS collection lane: one registry record with
// protocol:"ssh" AND platform:"macos" is polled over the S1.3 SSH transport
// (sshTransport.js — the ONLY seam this module consumes; specifically `exec`)
// using a single read-only sample command (macmon pipe + sysctl + vm_stat +
// df + netstat — no installs, no writes), parsed into the standard
// NodeAgentSnapshot (shared/types.ts).
//
// Structure mirrors server/fleet/linuxSshCollector.js (S1.4) exactly:
//   start, stop, getSnapshot(nodeId), getAllSnapshots(), isOnline(nodeId),
//   onSnapshot(cb), onStatus(cb)
// createMacosSshFleet({ nodes }) composes per-node collectors into the same
// 7-method surface, filtering isSshNode && platform === "macos".
//
// parseMacosSample(text, prev) is pure: no I/O, no SSH in unit tests (a fake
// `exec` returning canned text drives everything). `prev` is caller-owned
// state (net totals / ts); the parser refreshes it IN PLACE after each
// successful parse so rates continue across polls, and failure paths do not
// touch it.
//
// UNVERIFIED-LIVE (register S1.5 ruling): no macOS hardware exists in the
// fleet, so nothing here has been executed against a real Mac. The macmon
// NDJSON field names are from the upstream description (README fetch 404'd
// on both main/master 2026-10-26 → schema: pending-upstream-check); the
// parser therefore probes several plausible name variants and degrades to
// null on any unknown shape rather than guessing wrong loudly.

import { isSshNode, createSshTransport } from "./sshTransport.js";

/** The one remote sample command: binary discovery + macmon + native
 *  metrics in a single SSH call. macOS has no `timeout` binary — the pipe
 *  stream is closed with `| head -n 1` (SIGPIPE ends macmon after one
 *  sample). dash-safe; every section is best-effort (missing → that metric
 *  family degrades, never throws). */
export const MACOS_SAMPLE_CMD = `
MACMON_BIN=""
for p in /opt/homebrew/bin/macmon /usr/local/bin/macmon "$HOME/.cargo/bin/macmon"; do
  [ -x "$p" ] && MACMON_BIN="$p" && break
done
[ -z "$MACMON_BIN" ] && MACMON_BIN=$(command -v macmon 2>/dev/null || true)
echo '===MACMON==='
[ -n "$MACMON_BIN" ] && "$MACMON_BIN" pipe 2>/dev/null | head -n 1
echo '===UPTIME==='
sysctl -n kern.boottime
echo '===MEM==='
sysctl -n hw.memsize
vm_stat
echo '===DISK==='
df -P
echo '===NET==='
netstat -ib
echo '===END==='
`;

const round = (v, dp) => {
  const f = 10 ** dp;
  return Math.round((v + Number.EPSILON) * f) / f;
};

/** Split the sample into { NAME: [lines] } on `===NAME===` markers.
 *  Markers are recognized ANYWHERE in a line (same rule that survived the
 *  S1.4 live run where a data line swallowed its newline). */
function splitSections(text) {
  const sections = {};
  if (typeof text !== "string" || !text) return sections;
  let current = null;
  const lines = text
    .replace(/(===[A-Z0-9_]+===)/g, "\n$1\n")
    .split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    const m = /^===([A-Z0-9_]+)===$/.exec(line);
    if (m) {
      current = m[1];
      if (!sections[current]) sections[current] = [];
      continue;
    }
    if (current && line) sections[current].push(line);
  }
  return sections;
}

/** First argument that is a finite number, else null. */
function firstFinite(...vals) {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** Usage percent: clamp 0–100, round 2dp. */
const pct = (v) => round(Math.min(100, Math.max(0, v)), 2);

function emptyParsed() {
  return {
    macmon: false,
    uptimeSeconds: null,
    cpu: null,
    gpu: null,
    mem: null,
    disk: [],
    net: [],
  };
}

/**
 * Parse the raw sample text into metric families. Pure function of
 * (text, prev). `prev` (caller-owned) is refreshed IN PLACE with the new net
 * counters + ts when sections parse, so the caller just keeps passing the
 * same object. Missing sections → that family is null/empty; never throws.
 *
 * macmon mapping (mW → W divides by 1000; NO temperature is exposed by
 * macmon, so temperature/tdp are 0 by tool absence — see capability
 * report). Field names are candidate variants: upstream README was
 * unreachable (pending-upstream-check), so anything unrecognized → null,
 * never a crash and never a fabricated number.
 *
 * @param {string} text
 * @param {{ net?: Record<string,{rx:number,tx:number}>, ts?: number }} [prev]
 * @param {number} [nowMs] timestamp for uptime + rate windows
 */
export function parseMacosSample(text, prev = {}, nowMs = Date.now()) {
  const s = splitSections(text);
  const out = emptyParsed();
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  // ── MACMON: one NDJSON line, JSON.parse in try/catch ──
  // Missing/blank section (binary absent) or unparseable line → cpu/gpu
  // stay null; the native families below are collected regardless.
  const mmLine = s.MACMON && s.MACMON.length ? s.MACMON[0] : null;
  let mm = null;
  if (mmLine) {
    try {
      const obj = JSON.parse(mmLine);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) mm = obj;
    } catch {
      mm = null;
    }
  }
  if (mm) {
    out.macmon = true;
    const cpuUsage = firstFinite(mm.cpu?.usage, mm.cpu_usage, mm.cpu?.load);
    const cpuMw = firstFinite(mm.cpu?.power_mw, mm.cpu?.power, mm.power?.cpu, mm.cpu_power);
    out.cpu = {
      usage: cpuUsage == null ? 0 : pct(cpuUsage),
      temperature: 0, // macmon exposes no CPU temperature
      draw: cpuMw == null ? 0 : round(cpuMw / 1000, 2),
      tdp: 0,
    };
    const gpuUsage = firstFinite(mm.gpu?.usage, mm.gpu_usage, mm.gpu?.load);
    if (gpuUsage != null) {
      const gpuMw = firstFinite(mm.gpu?.power_mw, mm.gpu?.power, mm.power?.gpu, mm.gpu_power);
      out.gpu = {
        temperature: 0,
        usage: pct(gpuUsage),
        powerDraw: gpuMw == null ? 0 : round(gpuMw / 1000, 2),
        powerLimit: 0,
        vramUsedMB: 0,
        vramTotalMB: 0,
        vramPercentage: 0,
        vramAvailableMB: 0,
        processes: [],
      };
    }
  }

  // ── UPTIME: kern.boottime `{ sec = N, usec = 0 }` ──
  if (s.UPTIME && s.UPTIME.length) {
    const m = /sec\s*=\s*(\d+)/.exec(s.UPTIME.join(" "));
    if (m) {
      out.uptimeSeconds = Math.max(0, Math.floor(now / 1000 - Number(m[1])));
    }
  }

  // ── MEM: hw.memsize bytes → totalMB; vm_stat free+inactive → available ──
  {
    const memLines = s.MEM || [];
    let totalMB = null;
    for (const line of memLines) {
      const m = /^(\d+)$/.exec(line);
      if (m) {
        totalMB = Math.round(Number(m[1]) / 1048576);
        break;
      }
    }
    if (totalMB != null && totalMB > 0) {
      // Page size from the first vm_stat line carrying one; Apple Silicon
      // default otherwise.
      let pageSize = 16384;
      let freePages = null;
      let inactivePages = null;
      for (const line of memLines) {
        const ps = /page size of (\d+) bytes/.exec(line);
        if (ps) pageSize = Number(ps[1]);
        const pf = /^Pages free:\s+([\d.]+)/.exec(line);
        if (pf) freePages = parseFloat(pf[1]);
        const pi = /^Pages inactive:\s+([\d.]+)/.exec(line);
        if (pi) inactivePages = parseFloat(pi[1]);
      }
      if (freePages != null && inactivePages != null) {
        const availableMB = Math.round(((freePages + inactivePages) * pageSize) / 1048576);
        const usedMB = Math.max(0, totalMB - availableMB);
        out.mem = {
          usedMB,
          totalMB,
          availableMB,
          percentage: round((100 * usedMB) / totalMB, 1),
        };
      }
    }
  }

  // ── DISK: df -P, 512-block rows; only /dev/ filesystems ──
  for (const line of s.DISK || []) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6 || f[0] === "Filesystem") continue;
    if (!f[0].startsWith("/dev/")) continue;
    const toMB = (blocks) => Math.round((Number(blocks) * 512) / 1048576);
    const blocksN = Number(f[1]);
    if (!Number.isFinite(blocksN) || blocksN <= 0) continue;
    out.disk.push({
      device: f[0],
      mount: f.slice(5).join(" "),
      usedMB: toMB(f[2]),
      totalMB: toMB(f[1]),
      availableMB: toMB(f[3]),
      percentage: Math.min(100, Math.max(0, parseInt(f[4], 10) || 0)),
    });
  }

  // ── NET: netstat -ib rows whose last two columns are Ibytes/Obytes ──
  // One entry per interface (first row wins — link/inet duplicate rows are
  // skipped); noise interfaces (lo0, anpd*, awdl*, llw*, utun*) dropped.
  // Rate logic identical to S1.4: prev totals + dt; first poll → 0.
  const dt = prev.ts && Number.isFinite(prev.ts) ? Math.max((now - prev.ts) / 1000, 1e-3) : 0;
  const newNetTotals = {};
  const seenIfaces = new Set();
  for (const line of s.NET || []) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    const iface = f[0];
    if (!/^[a-z]/.test(iface)) continue; // continuation/inet rows: no name col
    if (
      iface === "lo0" ||
      /^anpd/.test(iface) ||
      /^awdl/.test(iface) ||
      /^llw/.test(iface) ||
      /^utun/.test(iface)
    ) {
      continue;
    }
    if (seenIfaces.has(iface)) continue; // duplicate link-state/inet row
    const rx = f[f.length - 2];
    const tx = f[f.length - 1];
    if (!/^\d+$/.test(rx) || !/^\d+$/.test(tx)) continue; // row lacks byte cols
    seenIfaces.add(iface);
    const rxN = Number(rx);
    const txN = Number(tx);
    const before = prev.net && prev.net[iface];
    let rxSpeed = 0;
    let txSpeed = 0;
    if (before && dt > 0) {
      rxSpeed = round(Math.abs(rxN - before.rx) / dt / 1e6, 3);
      txSpeed = round(Math.abs(txN - before.tx) / dt / 1e6, 3);
    }
    out.net.push({ iface, ip: null, rxSpeed, txSpeed, linkSpeedMbps: null });
    newNetTotals[iface] = { rx: rxN, tx: txN };
  }

  // Refresh caller-owned state IN PLACE (only with what this poll proves;
  // failure paths never reach here, so last-good counters survive).
  if (Object.keys(newNetTotals).length) prev.net = newNetTotals;
  prev.ts = now;

  return out;
}

/**
 * Build the FULL NodeAgentSnapshot for a macOS node from parsed metrics.
 * Families agentless macOS SSH collection does not produce are empty/null
 * per the type. `gpu` is set ONLY when macmon reported a GPU usage % (its
 * exact GpuMetrics shape has no name field — see capability report).
 * @param {{online?: boolean}} [opts]
 */
export function snapshotFromMacos(node, parsed, polledAt = Date.now(), opts = {}) {
  const p = parsed || emptyParsed();
  return {
    nodeId: node.id,
    nodeName: node.name,
    lanIp: node.lanIp || (node.ssh && node.ssh.host) || "",
    agentVersion: "agentless-ssh-1",
    online: opts.online !== false,
    // enrollment: registry-side, never set by collectors.
    uptimeSeconds: p.uptimeSeconds ?? null,
    gpu: p.gpu || null,
    cpu: p.cpu || null,
    mem: p.mem || null,
    disk: p.disk || [],
    net: p.net || [],
    containers: [],
    versions: [],
    services: [],
    memory: null,
    requests: null,
    topology: null,
    tailscale: null,
    polledAt: Number.isFinite(polledAt) ? polledAt : Date.now(),
  };
}

/**
 * One node's SSH collector — the connection.js 7-method surface, node-scoped.
 * @param {{ node: object, exec: (cmd: string) => Promise<string>,
 *           pollIntervalMs?: number, now?: () => number }} params
 *   `exec` REQUIRED: the caller supplies the transport seam
 *   (createSshTransport(node).exec in production; an ssh-CLI wrapper or fake
 *   elsewhere — injectability keeps the port-22 transport untouched).
 */
export function createMacosSshCollector({ node, exec, pollIntervalMs = 15000, now = Date.now }) {
  if (!node || typeof node.id !== "string" || !node.id) {
    throw new TypeError("createMacosSshCollector: node with a string id is required");
  }
  if (typeof exec !== "function") {
    throw new TypeError(
      "createMacosSshCollector: exec(command)->Promise<string> is required (pass the sshTransport exec seam)"
    );
  }

  const snapshotCbs = new Set();
  const statusCbs = new Set();
  const prev = {};
  let lastSnap = null;
  let lastOnline = null; // tri-state so the first result (either way) fires onStatus
  let timer = null;
  let polling = false;
  let macmonState = null; // tri-state for the logged-once macmon absence

  function setStatus(online) {
    if (lastOnline === online) return;
    lastOnline = online;
    for (const cb of [...statusCbs]) cb(node.id, online ? "online" : "offline");
  }

  /** macmon absence is a logged-once state (re-probe rides the per-poll
   *  discovery loop inside MACOS_SAMPLE_CMD — 4 `[ -x ]` stats, macmon is
   *  only ever exec'd when present). */
  function logMacmonState(seen) {
    if (macmonState === seen) return;
    const wasAbsent = macmonState === false;
    macmonState = seen;
    if (!seen) {
      console.warn(
        `[macosSshCollector ${node.id}] macmon not found — CPU/GPU families degraded (native families unaffected)`
      );
    } else if (wasAbsent) {
      console.log(`[macosSshCollector ${node.id}] macmon detected — cpu/gpu families restored`);
    }
  }

  async function pollOnce() {
    if (polling) return; // never overlap one node's polls
    polling = true;
    try {
      const text = await exec(MACOS_SAMPLE_CMD);
      const parsed = parseMacosSample(text, prev, now());
      logMacmonState(parsed.macmon);
      lastSnap = snapshotFromMacos(node, parsed, now());
      setStatus(true);
    } catch {
      // exec/parse failure → offline snapshot; prev counters untouched so
      // rates resume correctly after recovery.
      lastSnap = snapshotFromMacos(node, emptyParsed(), now(), { online: false });
      setStatus(false);
    } finally {
      polling = false;
    }
    for (const cb of [...snapshotCbs]) cb(node.id, lastSnap);
  }

  function start() {
    if (timer) return;
    void pollOnce();
    timer = setInterval(() => void pollOnce(), pollIntervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    nodeId: node.id,
    start,
    stop,
    getSnapshot(nodeId) {
      return nodeId === node.id ? lastSnap : null;
    },
    getAllSnapshots() {
      return lastSnap ? { [node.id]: lastSnap } : {};
    },
    isOnline(nodeId) {
      return Boolean(nodeId === node.id && lastSnap && lastSnap.online);
    },
    onSnapshot(cb) {
      snapshotCbs.add(cb);
      return () => snapshotCbs.delete(cb);
    },
    onStatus(cb) {
      statusCbs.add(cb);
      return () => statusCbs.delete(cb);
    },
  };
}

/**
 * Fleet view: one collector per protocol:"ssh" record whose platform is
 * exactly "macos", sharing the connection.js 7-method surface. Everything
 * else is ignored entirely (the linuxSshCollector lane owns platform-less
 * legacy + "linux" ssh records; the HTTP poller owns the rest).
 * @param {{ nodes: object[], transportFactory?: (node) => {exec},
 *           pollIntervalMs?: number }} params
 */
export function createMacosSshFleet({ nodes, transportFactory = createSshTransport, pollIntervalMs = 15000 } = {}) {
  const collectors = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!isSshNode(node) || node.platform !== "macos") continue;
    let exec;
    try {
      exec = transportFactory(node).exec;
    } catch (err) {
      // Misconfigured record (no ssh.user / no secret / bad host): surface it
      // as that node being offline, never sink the whole fleet.
      const msg = err && err.message ? err.message : String(err);
      exec = async () => {
        throw new Error(`SSH collector config error for ${node.id}: ${msg}`);
      };
    }
    try {
      collectors.set(
        node.id,
        createMacosSshCollector({ node, exec, pollIntervalMs })
      );
    } catch {
      // Malformed record even for the collector (no id) — skip it outright.
    }
  }

  const all = () => [...collectors.values()];

  return {
    start() {
      for (const c of all()) c.start();
    },
    async stop() {
      for (const c of all()) c.stop();
    },
    getSnapshot(nodeId) {
      const c = collectors.get(nodeId);
      return c ? c.getSnapshot(nodeId) : null;
    },
    getAllSnapshots() {
      const out = {};
      for (const c of all()) Object.assign(out, c.getAllSnapshots());
      return out;
    },
    isOnline(nodeId) {
      const c = collectors.get(nodeId);
      return c ? c.isOnline(nodeId) : false;
    },
    onSnapshot(cb) {
      const unsubs = all().map((c) => c.onSnapshot(cb));
      return () => unsubs.forEach((u) => u());
    },
    onStatus(cb) {
      const unsubs = all().map((c) => c.onStatus(cb));
      return () => unsubs.forEach((u) => u());
    },
  };
}
