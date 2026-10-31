/**
 * Fleet Prompt Showcase targets (SHOW1, #39): every LLM lane the dashboard
 * knows, from SSH Sparks (LlmProbe snapshots) and node-agent nodes
 * (telemetry `llm[]`), as one engine-agnostic list of (host, port, model).
 *
 * Reachability:
 *   - Spark lanes use the Spark's LAN address, or an SSH local forward when
 *     the engine binds loopback only (resolveLlmHttpTarget, as the benches do).
 *   - Agent lanes go straight to the node's LAN address. When the engine is
 *     not reachable there and the node is registered with SSH access
 *     (protocol "ssh"), an SSH local forward to 127.0.0.1:<port> is opened.
 *     Agent-only nodes without SSH access need the engine bound to the LAN.
 *
 * An agent lane on the same LAN address and port as a Spark lane is the same
 * engine; it is listed once, as the Spark lane.
 *
 * SC11 (#20) proxy-only rule: when a node's telemetry reports a running
 * guard/keepalive proxy, that proxy front is the node's only LLM traffic
 * address — the front never changes and a component action only changes what
 * answers behind it (shared/types.ts, component-action seam). Every engine
 * lane on such a node is therefore published at the proxy's port (one lane
 * per proxy front, `viaProxy: true`); the engine's own port is claimed so
 * the direct address can never surface as a second lane.
 */

import { hasServerCounters } from "./serverCounters.js";

/** @param {string} kind @param {string} nodeId @param {number} port */
export function laneIdOf(kind, nodeId, port) {
  return `${kind}:${nodeId}:${port}`;
}

/** @param {string} laneId */
export function parseLaneId(laneId) {
  const m = /^(spark|node):(.+):(\d{1,5})$/.exec(String(laneId || ""));
  if (!m) return null;
  const port = Number(m[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { kind: /** @type {"spark"|"node"} */ (m[1]), nodeId: m[2], port };
}

function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * SC11: the node's proxy front port, from telemetry's ProxyStatus
 * (agent/collectors/proxy.js) passed through the fleet snapshot. Non-null
 * only when the proxy reports itself running on a valid port — everything
 * else (absent status, stopped, malformed port) means "no proxy", so lanes
 * keep their direct engine port exactly as before.
 *
 * @param {any} node fleet node record (buildFleetSnapshot spread + registry keys)
 * @returns {number | null}
 */
export function proxyFront(node) {
  const p = node && node.proxy;
  if (!p || typeof p !== "object" || p.running !== true) return null;
  const port = Number(p.port);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * @param {object} deps
 * @param {any[]} deps.sparks             registry Spark configs
 * @param {(id: string) => any} deps.sparkSnapshot   monitor snapshot or null
 * @param {any[]} deps.nodes              registeredFleetNodes()
 * @param {(id: string) => any} [deps.nodeRecord]    registry node record (protocol / ssh)
 * @returns {import("../../src/api/types").FleetShowcaseTarget[]}
 */
export function listShowcaseTargets({ sparks = [], sparkSnapshot = () => null, nodes = [], nodeRecord = () => null }) {
  /** @type {any[]} */
  const out = [];
  const claimed = new Set();

  for (const spark of sparks) {
    if (!spark || spark.workerNode || spark.llmMonitoring === false) continue;
    const snap = sparkSnapshot(spark.id) || null;
    const ports = Array.isArray(spark.llmPorts) && spark.llmPorts.length ? spark.llmPorts : [];
    const llm = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
    const host = spark.isLocal ? "127.0.0.1" : str(spark.lanIp);
    ports.forEach((port, i) => {
      const entry = llm[i] || null;
      if (spark.lanIp) claimed.add(`${spark.lanIp}:${port}`);
      const backend = str(entry?.backend);
      out.push({
        laneId: laneIdOf("spark", spark.id, port),
        kind: "spark",
        nodeId: spark.id,
        nodeName: str(spark.name) || spark.id,
        host,
        port,
        modelId: str(entry?.modelId),
        backend,
        available: Boolean(snap?.online !== false && entry?.available),
        serverCounters: hasServerCounters(backend),
        access: spark.isLocal ? "local" : "lan-or-ssh",
      });
    });
  }

  for (const node of nodes) {
    if (!node || !Array.isArray(node.llm)) continue;
    const ips = [node.registryLanIp, node.lanIp].filter(Boolean);
    const rec = nodeRecord(node.nodeId) || null;
    const ssh = rec?.protocol === "ssh" && rec?.ssh?.user ? true : false;
    // SC11: a running proxy fronts every LLM port on this node; all its
    // lanes publish at the proxy port (and collapse to one lane per front).
    const proxyPort = proxyFront(node);
    for (const entry of node.llm) {
      const enginePort = Number(entry?.port);
      if (!Number.isInteger(enginePort) || enginePort < 1 || enginePort > 65535) continue;
      const port = proxyPort ?? enginePort;
      if (ips.some((ip) => claimed.has(`${ip}:${port}`) || claimed.has(`${ip}:${enginePort}`))) continue;
      const backend = str(entry?.backend);
      out.push({
        laneId: laneIdOf("node", node.nodeId, port),
        kind: "node",
        nodeId: node.nodeId,
        nodeName: str(node.nodeName) || node.nodeId,
        host: str(node.registryLanIp) || str(node.lanIp),
        port,
        modelId: str(entry?.modelId),
        backend,
        available: Boolean(node.online) && Boolean(entry?.modelId || backend),
        serverCounters: hasServerCounters(backend),
        access: ssh ? "lan-or-ssh" : "lan",
        ...(proxyPort != null ? { viaProxy: true } : {}),
      });
      // Claim the direct engine address too: with a proxy in front it is no
      // longer a legitimate showcase target, and later records (a second
      // agent entry, or another lane behind the same front) must not
      // republish it beside the proxy lane.
      for (const ip of ips) {
        claimed.add(`${ip}:${enginePort}`);
        if (proxyPort != null) claimed.add(`${ip}:${proxyPort}`);
      }
    }
  }

  return out.sort((a, b) =>
    a.kind === b.kind
      ? a.nodeName.localeCompare(b.nodeName) || a.port - b.port
      : a.kind === "spark" ? -1 : 1
  );
}

/**
 * Resolve a node-agent lane to an HTTP target: LAN first, then an SSH local
 * forward when the node has SSH access.
 *
 * @param {object} target   FleetShowcaseTarget (kind "node")
 * @param {object} deps
 * @param {(host: string, port: number, opts?: object) => Promise<boolean>} deps.probe
 * @param {(spark: object, port: number, opts?: object) => Promise<{host: string, port: number, via: string, close: () => void}>} deps.openTunnel
 * @param {(id: string) => any} deps.nodeRecord
 * @param {(id: string) => string | null} [deps.getPassword]
 * @param {{ signal?: AbortSignal, onStatus?: (m: string) => void }} [opts]
 */
export async function resolveNodeLaneTarget(target, deps, opts = {}) {
  const host = target.host;
  const direct = { host, port: target.port, via: "direct", close: () => {} };
  if (host) {
    opts.onStatus?.(`Reaching ${host}:${target.port}…`);
    if (await deps.probe(host, target.port, {})) return direct;
  }
  const rec = deps.nodeRecord(target.nodeId);
  if (rec?.protocol === "ssh" && rec?.ssh?.user) {
    const password = rec.ssh.auth === "pass" ? deps.getPassword?.(rec.id) ?? null : null;
    const sparkLike = { id: rec.id, lanIp: rec.lanIp, ssh: { ...rec.ssh, password } };
    return deps.openTunnel(sparkLike, target.port, { signal: opts.signal, onStatus: opts.onStatus });
  }
  throw new Error(
    `LLM on ${host || "(no LAN IP)"}:${target.port} is not reachable over the LAN and node ${target.nodeId} has no SSH access for a tunnel`
  );
}
