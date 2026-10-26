// ─── Fleet Linux SSH collector (S1.4) ──────────────────────────────────────
//
// The agentless Linux collection lane: one registry record with
// protocol:"ssh" is polled over the S1.3 SSH transport (sshTransport.js — the
// ONLY seam this module consumes; specifically `exec`) using a single
// read-only sample command (pure /proc, /sys, df — no installs, no writes),
// parsed into the standard NodeAgentSnapshot (shared/types.ts).
//
// Manager surface mirrors server/fleet/connection.js for one node:
//   start, stop, getSnapshot(nodeId), getAllSnapshots(), isOnline(nodeId),
//   onSnapshot(cb), onStatus(cb)
// createLinuxSshFleet({ nodes }) composes per-node collectors into the same
// 7-method surface, filtering isSshNode — the wiring point in buildFleetSnapshot.
//
// parseLinuxSample(text, prev) is pure: no I/O, no SSH in unit tests (a fake
// `exec` returning canned text drives everything). `prev` is caller-owned
// state (cpuTotals / raplUj / net totals / ts); the parser refreshes it IN
// PLACE after each successful parse so rates continue across polls, and
// failure paths do not touch it (last-good counters survive an outage).

import { isSshNode, createSshTransport } from "./sshTransport.js";

/** The one remote sample command. All sections are best-effort (missing →
 *  that metric family degrades, never throws). RAPL/thermal globs use
 *  /sys/cl*ss/ because this fleet mixes standard (class) and nonstandard
 *  kernel layouts (spec note: 7.0.0-38 host). */
export const LINUX_SAMPLE_CMD = `
echo '===OS==='; head -n2 /etc/os-release 2>/dev/null | tr '\\n' ' '
echo '===UPTIME==='; cat /proc/uptime
echo '===CPU1==='; head -n1 /proc/stat
sleep 0.5
echo '===CPU2==='; head -n1 /proc/stat
echo '===CORES==='; grep -c ^processor /proc/cpuinfo
echo '===MEM==='; grep -E '^Mem(Total|Available):' /proc/meminfo
echo '===NET==='; tail -n +3 /proc/net/dev
echo '===DISK==='; df -P -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null
echo '===TEMP==='; for z in /sys/cl*ss/thermal/thermal_zone*; do [ -r "$z/temp" ] && echo "$(cat "$z/type" 2>/dev/null) $(cat "$z/temp")"; done
echo '===RAPL==='; for r in /sys/cl*ss/powercap/intel-rapl:*; do [ -r "$r/energy_uj" ] && cat "$r/energy_uj"; done
echo '===END==='
`;

const round = (v, dp) => {
  const f = 10 ** dp;
  return Math.round((v + Number.EPSILON) * f) / f;
};


/** Split the sample into { NAME: [lines] } on `===NAME===` markers.
 *  Markers are recognized ANYWHERE in a line, not only as whole lines: the
 *  OS section's `tr '\n' ' '` swallows its own newline, gluing the next
 *  marker onto the OS data line (proved live on the localhost sshd, 2026-10-26). */
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

/** Parse one "cpu user nice system idle iowait ..." row → { total, idle }. */
function parseCpuRow(line) {
  if (!line) return null;
  const f = line.trim().split(/\s+/);
  if (!f.length || !/^cpu\d*$/.test(f[0])) return null;
  const nums = f.slice(1).map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const total = nums.reduce((a, b) => a + b, 0);
  const idle = (nums[3] || 0) + (nums[4] || 0); // col5 idle + col6 iowait
  return { total, idle };
}

function emptyParsed() {
  return {
    os: null,
    cores: null,
    uptimeSeconds: null,
    cpu: null,
    mem: null,
    disk: [],
    net: [],
  };
}

/**
 * Parse the raw sample text into metric families. Pure function of
 * (text, prev). `prev` (caller-owned) is refreshed IN PLACE with the new
 * counters when sections parse, so the caller just keeps passing the same
 * object. Missing sections → that family is null/empty; never throws.
 *
 * @param {string} text
 * @param {{ cpuTotals?: {total:number,idle:number}, usage?: number,
 *           raplUj?: number, net?: Record<string,{rx:number,tx:number}>,
 *           ts?: number }} [prev]
 * @param {number} [nowMs] timestamp for rate windows (defaults Date.now())
 */
export function parseLinuxSample(text, prev = {}, nowMs = Date.now()) {
  const s = splitSections(text);
  const out = emptyParsed();
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  // OS / cores: informational (NodeAgentSnapshot has no field for them).
  out.os = s.OS && s.OS.length ? s.OS.join(" ").trim() : null;
  if (s.CORES && s.CORES.length) {
    const c = parseInt(s.CORES[0], 10);
    out.cores = Number.isFinite(c) ? c : null;
  }

  // Uptime: first field of /proc/uptime.
  if (s.UPTIME && s.UPTIME.length) {
    const up = Number(s.UPTIME[0].trim().split(/\s+/)[0]);
    out.uptimeSeconds = Number.isFinite(up) ? Math.floor(up) : null;
  }

  // CPU usage from the CPU1/CPU2 jiffie delta.
  const c1 = parseCpuRow(s.CPU1 && s.CPU1[0]);
  const c2 = parseCpuRow(s.CPU2 && s.CPU2[0]);
  let temperature = 0;
  let draw = 0;

  // Temperature: first zone whose type looks CPU-ish, millidegrees → C.
  for (const line of s.TEMP || []) {
    const i = line.lastIndexOf(" ");
    if (i <= 0) continue;
    const type = line.slice(0, i);
    const milli = Number(line.slice(i + 1));
    if (!Number.isFinite(milli)) continue;
    if (/cpu|soc|k10|acpitz|edge|pkg/i.test(type)) {
      temperature = round(milli / 1000, 1);
      break;
    }
  }

  // Power: consecutive RAPL energy_uj samples over the sample's 0.5 s
  // window. <2 samples this poll (or first poll) → 0. tdp: no portable
  // source on agentless Linux → 0 (capability report notes it).
  const rapl = (s.RAPL || []).map(Number).filter((n) => Number.isFinite(n));
  if (rapl.length >= 2) {
    draw = Math.max(0, round((rapl[rapl.length - 1] - rapl[0]) / 0.5 / 1e6, 2));
  }

  let usage = Number.isFinite(prev.usage) ? prev.usage : 0;
  if (c1 && c2) {
    const dTotal = c2.total - c1.total;
    const dIdle = c2.idle - c1.idle;
    if (dTotal > 0) {
      const raw = 100 * (1 - dIdle / dTotal);
      usage = round(Math.min(100, Math.max(0, raw)), 2);
    }
    // dTotal === 0 → keep previous usage (spec).
  }

  if (c1 || c2) {
    out.cpu = { usage, temperature, draw, tdp: 0 };
  }

  // Memory: kB → integer MB.
  let mem = null;
  for (const line of s.MEM || []) {
    const m = /^Mem(Total|Available):\s+(\d+)/.exec(line);
    if (!m) continue;
    if (!mem) mem = { totalMB: 0, availableMB: 0 };
    const mb = Math.round(Number(m[2]) / 1024);
    if (m[1] === "Total") mem.totalMB = mb;
    else mem.availableMB = mb;
  }
  if (mem && mem.totalMB > 0) {
    const usedMB = Math.max(0, mem.totalMB - mem.availableMB);
    out.mem = {
      usedMB,
      totalMB: mem.totalMB,
      availableMB: mem.availableMB,
      percentage: round((100 * usedMB) / mem.totalMB, 1),
    };
  }

  // Disks: df -P lines; skip header, loop devices, /snap mounts.
  const toMB = (kb) => Math.round((kb * 1024) / 1e6);
  for (const line of s.DISK || []) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6 || f[0] === "Filesystem") continue;
    const [device, blocks, used, avail, pctRaw, mount] = f;
    if (device.startsWith("/dev/loop") || mount.startsWith("/snap")) continue;
    const blocksN = Number(blocks);
    if (!Number.isFinite(blocksN) || blocksN <= 0) continue;
    out.disk.push({
      device,
      mount,
      usedMB: toMB(Number(used) || 0),
      totalMB: toMB(blocksN),
      availableMB: toMB(Number(avail) || 0),
      percentage: Math.min(100, Math.max(0, parseInt(pctRaw, 10) || 0)),
    });
  }

  // Networks: /proc/net/dev rows; col2 = rx bytes, col10 = tx bytes.
  // Rates need the previous totals + ts; first poll → 0.
  const dt = prev.ts && Number.isFinite(prev.ts) ? Math.max((now - prev.ts) / 1000, 1e-3) : 0;
  const newNetTotals = {};
  for (const line of s.NET || []) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const iface = line.slice(0, i).trim();
    if (!iface || iface === "lo") continue;
    const nums = line.slice(i + 1).trim().split(/\s+/).map(Number);
    if (nums.length < 9 || !Number.isFinite(nums[0]) || !Number.isFinite(nums[8])) continue;
    const rx = nums[0];
    const tx = nums[8];
    const before = prev.net && prev.net[iface];
    let rxSpeed = 0;
    let txSpeed = 0;
    if (before && dt > 0) {
      rxSpeed = round(Math.abs(rx - before.rx) / dt / 1e6, 3);
      txSpeed = round(Math.abs(tx - before.tx) / dt / 1e6, 3);
    }
    out.net.push({ iface, ip: null, rxSpeed, txSpeed, linkSpeedMbps: null });
    newNetTotals[iface] = { rx, tx };
  }

  // Refresh caller-owned state IN PLACE (only with what this poll proves;
  // failure paths never reach here, so last-good counters survive).
  if (c2) prev.cpuTotals = c2;
  if (c1 && c2 && c2.total - c1.total > 0) prev.usage = usage;
  if (rapl.length) prev.raplUj = rapl[rapl.length - 1];
  if (Object.keys(newNetTotals).length) prev.net = newNetTotals;
  prev.ts = now;

  return out;
}

/**
 * Build the FULL NodeAgentSnapshot for a Linux node from parsed metrics.
 * Families agentless Linux does not collect are empty/null per the type.
 * @param {{online?: boolean}} [opts]
 */
export function snapshotFromLinux(node, parsed, polledAt = Date.now(), opts = {}) {
  const p = parsed || emptyParsed();
  return {
    nodeId: node.id,
    nodeName: node.name,
    lanIp: node.lanIp || (node.ssh && node.ssh.host) || "",
    agentVersion: "agentless-ssh-1",
    online: opts.online !== false,
    // enrollment: registry-side, never set by collectors.
    uptimeSeconds: p.uptimeSeconds ?? null,
    gpu: null,
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
 *   elsewhere — injectability is what keeps the port-22 transport untouched).
 */
export function createLinuxSshCollector({ node, exec, pollIntervalMs = 15000, now = Date.now }) {
  if (!node || typeof node.id !== "string" || !node.id) {
    throw new TypeError("createLinuxSshCollector: node with a string id is required");
  }
  if (typeof exec !== "function") {
    throw new TypeError(
      "createLinuxSshCollector: exec(command)->Promise<string> is required (pass the sshTransport exec seam)"
    );
  }

  const snapshotCbs = new Set();
  const statusCbs = new Set();
  const prev = {};
  let lastSnap = null;
  let lastOnline = null; // tri-state so the first result (either way) fires onStatus
  let timer = null;
  let polling = false;

  function setStatus(online) {
    if (lastOnline === online) return;
    lastOnline = online;
    for (const cb of [...statusCbs]) cb(node.id, online ? "online" : "offline");
  }

  async function pollOnce() {
    if (polling) return; // never overlap one node's polls
    polling = true;
    try {
      const text = await exec(LINUX_SAMPLE_CMD);
      const parsed = parseLinuxSample(text, prev, now());
      lastSnap = snapshotFromLinux(node, parsed, now());
      setStatus(true);
    } catch {
      // exec/parse failure → offline snapshot; prev counters untouched so
      // rates resume correctly after recovery.
      lastSnap = snapshotFromLinux(node, emptyParsed(), now(), { online: false });
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
 * Fleet view: one collector per protocol:"ssh" record, sharing the
 * connection.js 7-method surface. Non-ssh records are ignored entirely
 * (the HTTP poller in connection.js keeps owning them).
 * @param {{ nodes: object[], transportFactory?: (node) => {exec},
 *           pollIntervalMs?: number }} params
 */
export function createLinuxSshFleet({ nodes, transportFactory = createSshTransport, pollIntervalMs = 15000 } = {}) {
  const collectors = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!isSshNode(node)) continue;
    // S1.5 split: a platform-tagged record belongs to its own lane; the
    // Linux lane collects platform:"linux" and legacy platform-less records.
    if (node.platform && node.platform !== "linux") continue;
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
        createLinuxSshCollector({ node, exec, pollIntervalMs })
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
