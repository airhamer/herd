/**
 * Fleet energy inputs (issue #33): turn SSH Spark snapshots and node-agent
 * snapshots into one list of per-host power samples for FleetEnergyTracker,
 * keyed on the fleet-wide unit id (Spark id or node id).
 *
 * A box registered both as an SSH Spark and as an agent node (same LAN IP) is
 * counted once, under its Spark id, so its watts are never doubled.
 */
import { estimateHostPower, normalizeBaseline, DEFAULT_IDLE_BASELINE_W } from "./powerModel.js";
import { hasFreshPowerTelemetry } from "./FleetEnergyRuntime.js";

/** A node snapshot older than this (by server clock) is not used for energy. */
export const NODE_FRESH_MS = 10_000;

const finite = (value) => Number.isFinite(value);

/** Idle baseline for one host from settings (per-host override, then the fleet default). */
export function baselineFor(id, settings = {}) {
  const fallback = normalizeBaseline(settings.energyIdleBaselineW, DEFAULT_IDLE_BASELINE_W);
  const perHost = settings.energyHostBaselines;
  const override = perHost && typeof perHost === "object" ? perHost[id] : undefined;
  return normalizeBaseline(override, fallback);
}

/** Power estimate for an SSH Spark snapshot (GB10 unless registered as kind "host"). */
export function sparkPowerEstimate(snapshot, baselineW) {
  const gpu = snapshot?.metrics?.gpu;
  const cpu = snapshot?.metrics?.cpu;
  const gpuCount = Number.isInteger(gpu?.power?.gpuCount) ? gpu.power.gpuCount : null;
  if (snapshot?.kind === "host") {
    const total = gpu?.power?.drawTotal;
    const draw = gpu?.power?.draw;
    const gpuWatts = finite(total) ? total : finite(draw) ? draw : null;
    return estimateHostPower({
      model: "measured",
      gpuWatts,
      gpuSource: gpuWatts !== null ? "nvidia-smi" : null,
      gpuCount,
      cpuWatts: cpu?.draw,
      cpuSource: typeof cpu?.drawSource === "string" ? cpu.drawSource : "estimated",
      baselineW,
    });
  }
  return estimateHostPower({
    model: "gb10",
    gpuWatts: gpu?.power?.draw,
    cpuUsage: cpu?.usage,
    gpuCount: gpuCount ?? 1,
  });
}

/**
 * Power estimate for a node-agent snapshot. Agents since #33 report
 * `gpu.powerDrawTotal` (all GPUs), `gpu.gpuCount`, `gpu.powerSource` and
 * `cpu.drawSource`; older agents only have `gpu.powerDraw` (first NVIDIA GPU)
 * and a modelled `cpu.draw`.
 */
export function nodePowerEstimate(node, baselineW) {
  const gpu = node?.gpu;
  const cpu = node?.cpu;
  const total = finite(gpu?.powerDrawTotal) ? gpu.powerDrawTotal : gpu?.powerDraw;
  let gpuSource = typeof gpu?.powerSource === "string" ? gpu.powerSource : null;
  // Pre-#33 agents: only the NVIDIA path ever fills powerDraw (AMD reported 0).
  if (!gpuSource && finite(total) && total > 0) gpuSource = "nvidia-smi";
  const gpuWatts = gpuSource && finite(total) && total >= 0 ? total : null;
  const gpuCount = Number.isInteger(gpu?.gpuCount) ? gpu.gpuCount : gpuWatts !== null ? 1 : null;

  if (gpu?.unifiedMemory === true && gpuSource === "nvidia-smi" && gpuCount === 1) {
    return estimateHostPower({ model: "gb10", gpuWatts, cpuUsage: cpu?.usage, gpuCount });
  }
  return estimateHostPower({
    model: "measured",
    gpuWatts,
    gpuSource,
    gpuCount,
    cpuWatts: cpu?.draw,
    cpuSource: typeof cpu?.drawSource === "string" ? cpu.drawSource : "estimated",
    baselineW,
  });
}

/**
 * Build the per-tick collector.
 *
 * @param {{
 *   orderedSnapshots: () => any[],
 *   monitors?: Map<string, any>,
 *   fleetNodes?: () => any[],            // buildFleetSnapshot().nodes-shaped list
 *   sparkLanIps?: () => Map<string,string>, // spark id -> registry LAN IP
 *   getSettings?: () => object,
 *   now?: () => number,
 * }} deps
 */
export function createEnergyInputCollector({
  orderedSnapshots,
  monitors,
  fleetNodes = () => [],
  sparkLanIps = () => new Map(),
  getSettings = () => ({}),
  now = Date.now,
}) {
  /** node id -> { polledAt, seenAtMs } (server-clock time a new poll arrived). */
  const nodePolls = new Map();
  let lastHosts = [];
  let lastScope = [];

  function nodeFresh(node, atMs) {
    if (node?.online !== true) return false;
    const id = node.nodeId;
    const previous = nodePolls.get(id);
    const polledAt = node.polledAt ?? null;
    if (!previous || previous.polledAt !== polledAt) {
      nodePolls.set(id, { polledAt, seenAtMs: atMs });
      return true;
    }
    return atMs - previous.seenAtMs <= NODE_FRESH_MS;
  }

  function collect(atMs = now()) {
    const settings = getSettings() || {};
    const sparks = orderedSnapshots() || [];
    const nodes = fleetNodes() || [];
    const sparkIps = new Map();
    const registryIps = sparkLanIps() || new Map();
    for (const spark of sparks) {
      for (const ip of [registryIps.get(spark?.id), spark?.lanIp]) {
        if (ip && !sparkIps.has(ip)) sparkIps.set(ip, spark.id);
      }
    }

    const inputs = [];
    const hosts = [];
    const scope = [];
    for (const spark of sparks) {
      if (typeof spark?.id !== "string") continue;
      const fresh = hasFreshPowerTelemetry(spark, monitors?.get?.(spark.id), atMs);
      const power = sparkPowerEstimate(spark, baselineFor(spark.id, settings));
      // Spark clones keep role/metrics/llmPorts for the tracker's token counter.
      inputs.push({ ...spark, telemetryFresh: fresh && power !== null, power });
      scope.push(spark.id);
      hosts.push(hostRow(spark.id, spark.name, "spark", spark.online === true, fresh, power, null));
    }

    const seenNodes = new Set();
    for (const node of nodes) {
      const id = node?.nodeId;
      if (typeof id !== "string" || seenNodes.has(id)) continue;
      seenNodes.add(id);
      const duplicateOf =
        (node.registryLanIp && sparkIps.get(node.registryLanIp)) ||
        (node.lanIp && sparkIps.get(node.lanIp)) ||
        null;
      const fresh = nodeFresh(node, atMs);
      if (duplicateOf) {
        hosts.push(hostRow(id, node.nodeName, "node", node.online === true, fresh, null, duplicateOf));
        continue;
      }
      const power = nodePowerEstimate(node, baselineFor(id, settings));
      inputs.push({ id, name: node.nodeName ?? id, kind: "node", telemetryFresh: fresh && power !== null, power });
      scope.push(id);
      hosts.push(hostRow(id, node.nodeName, "node", node.online === true, fresh, power, null));
    }
    for (const id of [...nodePolls.keys()]) if (!seenNodes.has(id)) nodePolls.delete(id);

    lastHosts = hosts;
    lastScope = scope;
    return { inputs, scope, hosts };
  }

  return {
    collect,
    hosts: () => lastHosts,
    scope: () => lastScope,
  };
}

const round1 = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);

/** One row of the card's host table. Watts only while the host is reporting. */
function hostRow(id, name, kind, online, fresh, power, duplicateOf) {
  const live = Boolean(online && fresh && power);
  return {
    id,
    name: typeof name === "string" && name ? name : id,
    kind,
    online,
    reporting: live,
    duplicateOf,
    model: power?.model ?? null,
    watts: live ? round1(power.watts) : null,
    measuredWatts: live ? round1(power.measuredWatts) : null,
    gpuWatts: live ? round1(power.gpuWatts) : null,
    cpuWatts: live ? round1(power.cpuWatts) : null,
    baselineWatts: power?.baselineWatts ?? null,
    gpuSource: power?.gpuSource ?? null,
    cpuSource: power?.cpuSource ?? null,
    gpuCount: power?.gpuCount ?? null,
  };
}

/**
 * The energy scope known from the registries alone (used at startup, before
 * any snapshot exists): every Spark, plus every agent node whose registered
 * LAN IP is not already a Spark's.
 */
export function energyScopeIds(sparks = [], nodes = []) {
  const sparkIps = new Set(sparks.map((spark) => spark?.lanIp).filter(Boolean));
  const ids = sparks.map((spark) => spark?.id).filter((id) => typeof id === "string");
  for (const node of nodes) {
    if (typeof node?.id !== "string" || ids.includes(node.id)) continue;
    if (node.lanIp && sparkIps.has(node.lanIp)) continue;
    ids.push(node.id);
  }
  return ids;
}
