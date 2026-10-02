/**
 * tailscale.js — Tailscale node info: hostname, IP, and config.
 *
 * Read-only: `tailscale status --json` (via the host socket + CLI) plus the
 * host config files. Surfaces the node's OWN view of its tailnet presence —
 * never a peer's (possibly stale) view.
 *
 * Seam type: TailscaleMetrics (shared/types.ts).
 *
 * Style mirrors the other collectors: pure parse fn (exported for tests) +
 * async collect fn that takes injectable deps ({ exec, readFile }).
 */
import { runShell, readTextFile } from "./util.js";

/**
 * Trimmed string or null.
 * @param {unknown} v
 * @returns {string | null}
 */
function str(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

/**
 * Normalize `tailscale status --json` into the TailscaleMetrics fields.
 * Pure (no I/O) — exported for unit tests.
 *
 * @param {object} raw
 * @returns {object}
 */
export function parseTailscaleStatus(raw) {
  const self =
    raw && typeof raw === "object" && raw.Self && typeof raw.Self === "object"
      ? raw.Self
      : null;

  const health = Array.isArray(raw?.Health)
    ? raw.Health.filter((m) => typeof m === "string" && m.trim().length > 0)
    : [];

  const ips = Array.isArray(self?.TailscaleIPs)
    ? self.TailscaleIPs.filter((ip) => typeof ip === "string")
    : [];

  // Prefer the IPv4 100.x address as the primary tailscaleIp.
  const tailscaleIp = ips.find((ip) => ip.includes(".")) ?? ips[0] ?? null;

  return {
    available: self != null,
    hostname: str(self?.HostName),
    dnsName: str(self?.DNSName),
    tailscaleIp,
    tailscaleIps: ips,
    backendState: str(raw?.BackendState),
    os: str(self?.OS),
    version: str(raw?.Version),
    relay: str(self?.Relay),
    exitNode: str(self?.ExitNode),
    tun: raw?.TUN && typeof raw.TUN === "object" ? raw.TUN : null,
    currentTailnet: str(raw?.CurrentTailnet),
    magicDNSSuffix: str(raw?.MagicDNSSuffix),
    keyExpiry: str(self?.KeyExpiry),
    keyExpired: self?.Expired === true,
    online: typeof self?.Online === "boolean" ? self.Online : null,
    health,
  };
}

/**
 * Read the host tailscale config (best-effort): the systemd unit's state /
 * socket / port / flags, plus /etc/tailscale/tailscale.conf and
 * /etc/tailscale/tailscale.env when present. Every field degrades to null.
 *
 * @param {{ exec?: (cmd: string) => Promise<string>, readFile?: (path: string) => Promise<string> }} deps
 * @returns {Promise<object>}
 */
async function readTailscaleConfig(deps) {
  const { exec = runShell, readFile = readTextFile } = deps;
  const config = {
    stateFile: null,
    socket: null,
    port: null,
    flags: null,
    conf: null,
    env: null,
  };

  // systemd unit (ExecStart) — the tailscaled service config.
  try {
    const out = await exec("systemctl cat tailscaled 2>/dev/null");
    const stateM = out.match(/--state=([^\s]+)/);
    if (stateM) config.stateFile = stateM[1];
    const socketM = out.match(/--socket=([^\s]+)/);
    if (socketM) config.socket = socketM[1];
    const portM = out.match(/--port=(\S+)/);
    if (portM) config.port = portM[1];
    const flagsM = out.match(/\$FLAGS\b/);
    if (flagsM) config.flags = "$FLAGS";
  } catch {
    /* unit optional */
  }

  // /etc/tailscale/tailscale.conf
  try {
    config.conf = (await readFile("/etc/tailscale/tailscale.conf")).trim() || null;
  } catch {
    /* not present */
  }

  // /etc/tailscale/tailscale.env
  try {
    config.env = (await readFile("/etc/tailscale/tailscale.env")).trim() || null;
  } catch {
    /* not present */
  }

  return config;
}

/**
 * Build the empty/degraded TailscaleMetrics shape.
 * @param {string | null} [error]
 * @returns {object}
 */
function emptyMetrics(error) {
  return {
    available: false,
    hostname: null,
    dnsName: null,
    tailscaleIp: null,
    tailscaleIps: [],
    backendState: null,
    os: null,
    version: null,
    relay: null,
    exitNode: null,
    tun: null,
    currentTailnet: null,
    magicDNSSuffix: null,
    keyExpiry: null,
    keyExpired: false,
    online: null,
    health: [],
    config: null,
    error,
  };
}

/**
 * Collect Tailscale node info: hostname, IP, and config.
 *
 * @param {{ exec?: (cmd: string) => Promise<string>, readFile?: (path: string) => Promise<string> }} [deps]
 * @returns {Promise<object>} TailscaleMetrics
 */
export async function collectTailscale(deps = {}) {
  const { exec = runShell, readFile = readTextFile } = deps;
  try {
    const out = await exec("tailscale status --json 2>/dev/null");
    const raw = JSON.parse(out);
    const parsed = parseTailscaleStatus(raw);
    parsed.config = await readTailscaleConfig({ exec, readFile });
    parsed.error = null;
    return parsed;
  } catch (err) {
    return emptyMetrics(err && err.message ? err.message : "tailscale status failed");
  }
}
