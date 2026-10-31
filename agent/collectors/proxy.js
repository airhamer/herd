/**
 * proxy.js — Keepalive / Guard proxy status (adopted from hasso5703/dgx-spark-qwen38 keepalive-proxy).
 *
 * Detects a running keepalive-proxy (Python or equivalent) in front of the text engine.
 * Probes common endpoints for the cockpit-style card:
 *   - state, version, generation probe, last probe, serving container.
 *   - Basic traffic / requests if /metrics or /proxy/status is present.
 *
 * The proxy fronts :30001 (or configured), keeps streams alive for agent clients,
 * refuses prompts the active component (lane) cannot serve, aborts generations for departed clients.
 *
 * Seam: adds ProxyStatus to telemetry / NodeAgentSnapshot (additive).
 */

import { runShell } from "./util.js";
import fs from "fs";
import path from "path";

/**
 * @typedef {object} ProxyStatus
 * @property {boolean} running
 * @property {string|null} version
 * @property {string|null} lastProbe
 * @property {string|null} generationProbe
 * @property {string|null} servingContainer
 * @property {number|null} port
 * @property {number|null} requestsInWindow
 * @property {string|null} state
 * @property {string|null} note
 */

/**
 * Collect keepalive/guard proxy status.
 * Best-effort; never throws.
 * @param {{ exec?: (cmd: string) => Promise<string> }} [deps]
 * @returns {Promise<ProxyStatus>}
 */
export async function collectProxy({ exec = runShell } = {}) {
  const status = {
    running: false,
    version: null,
    lastProbe: null,
    generationProbe: null,
    servingContainer: null,
    port: 8081,  // common in hasso setups; we auto-detect below
    requestsInWindow: null,
    state: "unknown",
    note: null,
  };

  try {
    // Pure Node detection using /host/proc (mounted by install-node-agent.sh with --pid host + -v /:/host:ro)
    // This avoids shell quoting issues and missing binaries (ps/curl) in the slim agent image.
    let detectedViaProc = false;
    let detectedNote = '';
    try {
      const procRoot = '/host/proc';
      const pids = fs.readdirSync(procRoot).filter((f) => /^[0-9]+$/.test(f));
      for (const pid of pids) {
        try {
          const cmdlinePath = path.join(procRoot, pid, 'cmdline');
          if (fs.existsSync(cmdlinePath)) {
            const cmdline = fs.readFileSync(cmdlinePath, 'utf8').replace(/\0/g, ' ');
            if (/keepalive.*proxy|qwen38-keepalive/i.test(cmdline)) {
              detectedViaProc = true;
              detectedNote = `proc/${pid}`;
              break;
            }
          }
        } catch {}
      }
    } catch (e) {
      detectedNote = 'proc scan error: ' + String(e).slice(0, 80);
    }

    const unitActive = await exec('systemctl is-active qwen38-keepalive 2>/dev/null || true');
    let unitFile = '';
    if (unitActive && unitActive.includes('active')) {
      status.running = true;
      status.state = 'running';
      status.note = 'systemd qwen38-keepalive';
      try { unitFile = await exec('systemctl cat qwen38-keepalive 2>/dev/null | cat'); } catch {}
    } else if (detectedViaProc) {
      status.running = true;
      status.state = 'running';
      status.note = detectedNote || 'host proc scan';
    }

    // Port from unit or default
    const portMatch = unitFile.match(/([0-9]{4,5})/);
    if (portMatch) {
      const p = parseInt(portMatch[1], 10);
      if (p > 1024) status.port = p;
    }
    const probePort = status.port || 8081;

    // Probe the proxy (use detected port)
    try {
      const health = await exec(`curl -s --max-time 3 http://127.0.0.1:${probePort}/health || true`);
      if (health && (health.includes('ok') || /version/i.test(health))) {
        status.running = true;
        status.state = 'running';
        const v = health.match(/v[0-9.]+/);
        if (v) status.version = v[0];
      }

      const richer = await exec(`curl -s --max-time 3 http://127.0.0.1:${probePort}/ 2>/dev/null | head -c 2000 || true`);
      if (richer) {
        const ver = richer.match(/v[0-9.]+|version[:\s]+([0-9.]+)/i);
        if (ver) status.version = (ver[1] || ver[0] || status.version || '') + ', the repo\'s copy';
        if (/qwen|flash/i.test(richer) && !status.servingContainer) {
          status.servingContainer = 'qwen38-flash';
        }
      }
    } catch {}

    // Serving container from docker (mounted in agent)
    try {
      const engines = await exec('docker ps --format "{{.Names}} {{.Image}}" 2>/dev/null | grep -E "sglang|vllm|qwen|flash" | head -1 || true');
      if (engines) {
        const m = engines.match(/(qwen[0-9-]*flash|flash[^ ]+)/i);
        if (m) status.servingContainer = m[1].toLowerCase();
      }
    } catch {}

    // Journal for probes (best effort)
    try {
      const journal = await exec(`journalctl -u qwen38-keepalive --since "5 min ago" -o cat --no-pager 2>/dev/null | tail -5 || true`);
      if (journal && /probe|ok/i.test(journal)) {
        status.lastProbe = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        status.generationProbe = 'ok (journal)';
      }
    } catch {}

    if (status.running) {
      status.state = 'running';
    }
  } catch (e) {
    status.note = `collector error: ${String(e).slice(0, 120)}`;
  }

  return status;
}

export default { collectProxy };