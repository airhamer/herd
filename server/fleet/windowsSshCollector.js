// ─── Fleet Windows SSH collector (S1.6) ────────────────────────────────────
//
// The agentless Windows collection lane: one registry record with
// protocol:"ssh" AND platform:"windows" is polled over the S1.3 SSH transport
// (sshTransport.js — the ONLY seam this module consumes; specifically `exec`)
// using a single read-only sample command, parsed into the standard
// NodeAgentSnapshot (shared/types.ts).
//
// Structure mirrors server/fleet/macosSshCollector.js (S1.5) and
// linuxSshCollector.js (S1.4) exactly:
//   start, stop, getSnapshot(nodeId), getAllSnapshots(), isOnline(nodeId),
//   onSnapshot(cb), onStatus(cb)
// createWindowsFleet({ nodes }) composes per-node collectors into the same
// 7-method surface, filtering isSshNode && platform === "windows".
//
// Transport reality (EVAL §1.3): OpenSSH on Windows lands commands in
// cmd.exe, so the remote command is
//   powershell -NoProfile -NonInteractive -EncodedCommand <b64>
// with <b64> = UTF-16LE(script) base64 — quoting-safe under any default
// shell. cmd.exe caps the command line at 8191 chars; UTF-16LE + base64
// inflates ~2.67×, so the ASCII-only PowerShell script is budgeted at 2500
// raw chars (~3000 encoded budget for the whole command is ample — the
// shipped script encodes to ~2.9k chars total). A unit test asserts the
// full encoded command length < 8191.
//
// PowerShell stdin wait: -NonInteractive plus the exec boundary closes
// stdin; no interactive prompt can hang the poll.
//
// parseWindowsSample(text, nowMs) is pure: no I/O, no SSH in unit tests (a
// fake `exec` returning canned text drives everything). Unlike the siblings
// NO prev-state is needed: Win32_PerformanceFormattedDataForNetworkInterface
// exposes BytesReceivedPersec/BytesSentPersec, which are already rates
// (bytes/s), so net speeds need no delta window.
//
// UNVERIFIED-LIVE (register S1.6 ruling): no Windows host exists in the
// fleet, so nothing here has been executed against real Windows. WMI field
// availability varies by Windows SKU; the shapes below are fixture-asserted
// truths only. See docs/S1.6-CAPABILITY.md.

import { isSshNode, createSshTransport } from "./sshTransport.js";

/**
 * Base64-encode a PowerShell script the way -EncodedCommand expects:
 * UTF-16LE bytes, then standard base64.
 * @param {string} script
 */
export function encodePsScript(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}

/**
 * The one remote sample script: pure WMI (Get-CimInstance), ASCII-only,
 * `===SECTION===` markers, `-ErrorAction SilentlyContinue` on every probe so
 * any missing/unavailable class degrades that family instead of aborting.
 * One Win32_OperatingSystem fetch is reused for OS/UPTIME/MEM to keep the
 * script well under the 2500-char raw budget. Full cmdlet names throughout
 * (encoding-safe ASCII, zero alias-availability risk).
 */
export const WINDOWS_SAMPLE_SCRIPT = [
  "Write-Output '===OS==='",
  "$os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction SilentlyContinue",
  "if ($os) { Write-Output ($os.Caption + ' | ' + $os.Version) }",
  "Write-Output '===UPTIME==='",
  "if ($os) { Write-Output ([DateTimeOffset]::ToUnixTimeSeconds([DateTime]$os.LastBootUpTime)) }",
  "Write-Output '===CPU==='",
  "$cpu = Get-CimInstance -ClassName Win32_Processor -ErrorAction SilentlyContinue",
  "if ($cpu) { Write-Output (($cpu | Measure-Object -Property LoadPercentage -Maximum).Maximum) }",
  "Write-Output '===MEM==='",
  "if ($os) { Write-Output ($os.TotalVisibleMemorySize.ToString() + ' ' + $os.FreePhysicalMemory.ToString()) }",
  "Write-Output '===DISK==='",
  "$disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue",
  "if ($disk) { $disk | ForEach-Object { Write-Output ($_.DeviceID + ' ' + $_.Size + ' ' + $_.FreeSpace) } }",
  "Write-Output '===NET==='",
  "$net = Get-CimInstance -ClassName Win32_PerformanceFormattedDataForNetworkInterface -ErrorAction SilentlyContinue",
  "if ($net) { $net | Where-Object { $_.Name -notmatch 'isatap|loopback|teredo' } | ForEach-Object { Write-Output ($_.Name + ' ' + $_.BytesReceivedPersec + ' ' + $_.BytesSentPersec) } }",
  "Write-Output '===END==='",
].join("\r\n");

/**
 * The full remote command: powershell under cmd.exe, quoting-safe.
 * @param {string} [script]
 */
export function WINDOWS_SAMPLE_CMD(script = WINDOWS_SAMPLE_SCRIPT) {
  return `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePsScript(script)}`;
}

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

/** Usage percent: clamp 0–100, round 2dp. */
const pct = (v) => round(Math.min(100, Math.max(0, v)), 2);

/** Network noise filter (belt+braces — the script already excludes these):
 *  isatap/loopback/teredo pseudo-interfaces, and the "isatap" half-name a
 *  truncated write could produce. */
const NET_SKIP = /isatap|loopback|teredo|loopback adapter/i;

function emptyParsed() {
  return {
    uptimeSeconds: null,
    cpu: null,
    mem: null,
    disk: [],
    net: [],
  };
}

/**
 * Parse the raw sample text into metric families. Pure function of
 * (text, nowMs) — no prev-state: the NET counters are per-second rates
 * already (unlike the Linux/macOS byte totals). Missing/garbled section →
 * that family null/empty; never throws.
 *
 * @param {string} text
 * @param {number} [nowMs] timestamp for the uptime computation
 */
export function parseWindowsSample(text, nowMs = Date.now()) {
  const s = splitSections(text);
  const out = emptyParsed();
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  // ── UPTIME: LastBootUpTime as unix seconds → uptime ──
  if (s.UPTIME && s.UPTIME.length) {
    const m = /^(\d+)(?:\.\d+)?$/.exec(s.UPTIME[0].trim());
    if (m) {
      const bootSec = Number(m[1]);
      out.uptimeSeconds = Math.max(0, Math.floor(now / 1000 - bootSec));
    }
  }

  // ── CPU: LoadPercentage max across sockets, 0–100 round 2 ──
  // temperature/draw/tdp are 0: no portable source on Windows without
  // vendor tools (see capability report).
  if (s.CPU && s.CPU.length) {
    const v = parseFloat(s.CPU[0].trim());
    if (Number.isFinite(v)) {
      out.cpu = { usage: pct(v), temperature: 0, draw: 0, tdp: 0 };
    }
  }

  // ── MEM: `TotalVisibleMemorySize FreePhysicalMemory` in KB → MB ints ──
  if (s.MEM && s.MEM.length) {
    const m = /^(\d+)\s+(\d+)$/.exec(s.MEM[0].trim());
    if (m) {
      const totalMB = Math.round(Number(m[1]) / 1024);
      const availableMB = Math.round(Number(m[2]) / 1024);
      if (totalMB > 0) {
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

  // ── DISK: `C: sizeBytes freeBytes` → MB via /1048576, keep `C:` style ──
  for (const line of s.DISK || []) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3) continue;
    const size = Number(f[1]);
    const free = Number(f[2]);
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(free)) continue;
    const totalMB = Math.round(size / 1048576);
    const availableMB = Math.round(free / 1048576);
    const usedMB = Math.max(0, totalMB - availableMB);
    out.disk.push({
      device: f[0],
      mount: f[0] + "\\",
      usedMB,
      totalMB,
      availableMB,
      percentage: pct((100 * usedMB) / totalMB),
    });
  }

  // ── NET: `name rxPerSec txPersec` — counters ALREADY rates (bytes/s) ──
  // Name may contain spaces (perf-counter "Name" is a description), so the
  // numeric columns are taken from the RIGHT. No prev needed (rates).
  for (const line of s.NET || []) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3) continue;
    const name = f.slice(0, f.length - 2).join(" ");
    if (!name || NET_SKIP.test(name)) continue;
    const rx = Number(f[f.length - 2]);
    const tx = Number(f[f.length - 1]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    out.net.push({
      iface: name,
      ip: null,
      rxSpeed: round(rx / 1048576, 3),
      txSpeed: round(tx / 1048576, 3),
      linkSpeedMbps: null,
    });
  }

  return out;
}

/**
 * Build the FULL NodeAgentSnapshot for a Windows node from parsed metrics.
 * Families agentless Windows SSH collection does not produce are empty/null
 * per the type. NOTE: the spec's NET sketch wrote `name`; shared/types.ts
 * NetMetrics is `iface` — types win (documented deviation).
 * @param {{online?: boolean}} [opts]
 */
export function snapshotFromWindows(node, parsed, polledAt = Date.now(), opts = {}) {
  const p = parsed || emptyParsed();
  return {
    nodeId: node.id,
    nodeName: node.name,
    lanIp: node.lanIp || (node.ssh && node.ssh.host) || "",
    agentVersion: "agentless-ssh-1",
    online: opts.online !== false,
    // enrollment: registry-side, never set by collectors.
    uptimeSeconds: p.uptimeSeconds ?? null,
    gpu: null, // AMD perf-counter fallback explicitly out of scope
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
 *   (createSshTransport(node).exec in production; a fake in tests —
 *   injectability keeps the port-22 transport untouched).
 */
export function createWindowsSshCollector({ node, exec, pollIntervalMs = 15000, now = Date.now }) {
  if (!node || typeof node.id !== "string" || !node.id) {
    throw new TypeError("createWindowsSshCollector: node with a string id is required");
  }
  if (typeof exec !== "function") {
    throw new TypeError(
      "createWindowsSshCollector: exec(command)->Promise<string> is required (pass the sshTransport exec seam)"
    );
  }

  const snapshotCbs = new Set();
  const statusCbs = new Set();
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
      const text = await exec(WINDOWS_SAMPLE_CMD());
      const parsed = parseWindowsSample(text, now());
      lastSnap = snapshotFromWindows(node, parsed, now());
      setStatus(true);
    } catch {
      // exec/parse failure → offline snapshot with null/empty families;
      // last-good snapshot is replaced (matches the siblings), while the
      // pure parser means nothing else to preserve.
      lastSnap = snapshotFromWindows(node, emptyParsed(), now(), { online: false });
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
 * exactly "windows", sharing the connection.js 7-method surface. Everything
 * else is ignored entirely (the linuxSshCollector lane owns platform-less
 * legacy + "linux" ssh records; macosSshCollector owns "macos"; the HTTP
 * poller owns the rest).
 * @param {{ nodes: object[], transportFactory?: (node) => {exec},
 *           pollIntervalMs?: number }} params
 */
export function createWindowsFleet({ nodes, transportFactory = createSshTransport, pollIntervalMs = 15000 } = {}) {
  const collectors = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!isSshNode(node) || node.platform !== "windows") continue;
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
        createWindowsSshCollector({ node, exec, pollIntervalMs })
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
