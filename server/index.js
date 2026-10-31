import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { SparkRegistry } from "./sparks/SparkRegistry.js";
import { SparkMonitor } from "./sparks/SparkMonitor.js";
import { sshExec } from "./collectors/ssh.js";
import { comfyCancelJob } from "./collectors/comfyActions.js";
import {
  validateSparkTarget,
  createRateLimiter,
  assertAllowedTarget,
  validateDecodeBudget,
  validatePrefillBudget,
} from "./validate.js";
import { authorizeUpgrade, configuredToken, createAuthMiddleware, requireRemoteAuth } from "./auth.js";
import { inspectHealth } from "./health.js";
import { probeAll } from "./health/guardProbe.js";
import { probeAllMemoryServices } from "./health/memoryProbe.js";
import { getSettings, updateSettings, loadSettings } from "./settings.js";
import { broadcastForLanIp, effectiveMac, normalizeMac, sendWol } from "./wol.js";
import {
  decodeBenchManager,
  DECODE_BENCH_DEFAULTS,
  decodeBudgetArgs,
} from "./collectors/DecodeBench.js";
import { describeNodeProvenance, nodeBenchKey, nodeLlmEndpoints, resolveNodeBenchTarget } from "./fleet/nodeBench.js";
import {
  prefillBenchManager,
  PREFILL_BENCH_DEFAULTS,
  normalizeContextSizes,
} from "./collectors/PrefillBench.js";
import { showcaseManager } from "./collectors/ShowcaseManager.js";
import { qualityBenchManager, QUALITY_BENCH_DEFAULTS } from "./collectors/QualityBench.js";
import { BenchResultsStore } from "./bench/results/store.js";
import { createResultsRecorder } from "./bench/results/recorder.js";
import { describeProvenance } from "./bench/results/provenance.js";
import { registerBenchResultsRoutes } from "./bench/results/routes.js";
import { registerAeonPodRoutes } from "./bench/aeonPod/routes.js";
import { readRegistry, registryRecords, syncRegistryIntoStore } from "./bench/references/loader.js";
import { llmProbeHost } from "./collectors/llmHost.js";
import { onceClose, openSshLlmTunnel, probeLlmHttp, resolveLlmHttpTarget } from "./collectors/llmTunnel.js";
import { formatLlmBaseUrl, parseLlmTargetInput } from "../src/shared/llmTarget.js";
import { llmDaily } from "./collectors/LlmDaily.js";
import { closeLlmStreamAgent } from "./collectors/LlmStreaming.js";
import { compareSemver, getLatestRelease } from "./collectors/HermesReleases.js";
import { ALERTS_JSON_PATH, FLEET_ENERGY_JSON_PATH, FLEET_ENERGY_MONTHLY_JSON_PATH, FLEET_SHOWCASE_HISTORY_PATH, LLM_TOKEN_TOTALS_JSON_PATH, METRICS_HISTORY_JSON_PATH } from "./config.js";
import { FleetShowcaseManager } from "./showcase/FleetShowcaseManager.js";
import { listShowcaseTargets, resolveNodeLaneTarget } from "./showcase/fleetTargets.js";
import { registerFleetShowcaseRoutes } from "./showcase/routes.js";
import { getNodeSshPassword } from "./fleet/nodeCredentials.js";
import { LlmTokenLedger } from "./llmtokens/LlmTokenLedger.js";
import { collectTokenObservations } from "./llmtokens/observations.js";
import { createLlmTokenRuntime, registerLlmTokenRoutes, withLedgerTokens } from "./llmtokens/LlmTokenRuntime.js";
import { createAlertsRuntime, registerAlertRoutes } from "./alerts/runtime.js";
import { EventLog } from "./events/EventLog.js";
import { FleetEnergyTracker } from "./energy/FleetEnergyTracker.js";
import { UnitHistory } from "./metrics/UnitHistory.js";
import {
  createUnitHistoryRuntime,
  registerUnitHistoryRoutes,
} from "./metrics/UnitHistoryRuntime.js";
import {
  createFleetEnergyRuntime,
  registerFleetEnergyRoute,
} from "./energy/FleetEnergyRuntime.js";
import { createEnergyInputCollector, energyScopeIds } from "./energy/inputs.js";
import { buildFleetEnergyView } from "./energy/view.js";
import { testSparkConnectivity } from "./connectivity.js";
import { inspectStartupPreflight, logStartupPreflight } from "./startupPreflight.js";
import { randomUUID } from "node:crypto";
import { loadNodes, listNodes, getNode, addNode, updateNode, removeNode, claimNode } from "./fleet/registry.js";
import { bootstrapStacksForFleet } from "./fleet/stacksBootstrap.js";
import { hasNodeSshPassword, setNodeSshPassword, deleteNodeSshPassword } from "./fleet/nodeCredentials.js";
import { createFleetConnection } from "./fleet/connection.js";
import { createLinuxSshFleet } from "./fleet/linuxSshCollector.js";
import { createMacosSshFleet } from "./fleet/macosSshCollector.js";
import { createWindowsFleet } from "./fleet/windowsSshCollector.js";
import { buildTopology } from "./fleet/topology.js";
import { applyGroupsToNodes, createGroupStore } from "./fleet/groups.js";
import { registerGroupRoutes } from "./fleet/groupsRoutes.js";
import { aggregateRequests, fleetGpuFromMonitor } from "./fleet/aggregate.js";
import { renderFleetMetrics } from "./fleet/metrics.js";
import { createUpdatesProxy, createPlanStore } from "./fleet/updatesProxy.js";
import { buildComponentAction, proxyComponentAction } from "./fleet/componentActions.js";
import { loadComponentCatalog, joinComponentState } from "./fleet/componentCatalog.js";
import { createWaveSequencer } from "./fleet/waveSequencer.js";
import { activity, createActivityWatcher, withUnitNames } from "./events/activity.js";
import { registerEventRoutes } from "./events/routes.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// Default to loopback. Direct non-loopback binds fail closed because this release
// does not authenticate LAN clients. Use an SSH tunnel, authenticated reverse
// proxy, or Tailscale Serve (docs/REMOTE-ACCESS.md).
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";
const PORT = parseInt(process.env.PORT || "5555", 10);
const LLM_PORT = parseInt(process.env.LLM_PORT || "8888", 10);
const COMFY_PORT = parseInt(process.env.COMFY_PORT || "8188", 10);

/** Per-spark LLM HTTP port (1–65535), else env default. */
function resolveLlmPort(sparkOrPort) {
  if (sparkOrPort && typeof sparkOrPort === "object") {
    // Prefer llmPorts array, fall back to legacy llmPort
    const ports = sparkOrPort.llmPorts;
    if (Array.isArray(ports) && ports.length > 0) {
      const n = ports[0];
      if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    }
    const raw = sparkOrPort.llmPort;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    return LLM_PORT;
  }
  const raw = sparkOrPort;
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  return LLM_PORT;
}

/** Per-spark ComfyUI HTTP port (1–65535), else env default 8188. */
function resolveComfyPort(sparkOrPort) {
  if (sparkOrPort && typeof sparkOrPort === "object") {
    const raw = sparkOrPort.comfyPort;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    return COMFY_PORT;
  }
  const raw = sparkOrPort;
  const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  return COMFY_PORT;
}

/** Optional Bearer token for a Spark LLM port (from encrypted secrets). */
function resolveLlmApiKey(spark, port) {
  const keys = spark?.llmApiKeys;
  if (!keys || typeof keys !== "object") return null;
  const raw = keys[String(port)] ?? keys[port];
  const key = raw != null ? String(raw).trim() : "";
  return key || null;
}

/**
 * Local Spark LLM port, or an on-demand remote host (HTTPS Tailscale, etc.).
 * Custom `host` skips the configured-port allowlist and SSH tunnel.
 *
 * @param {object} spark
 * @param {number[]} configuredPorts
 * @param {object} body
 */
async function benchHttpTarget(spark, configuredPorts, body) {
  const hostRaw = body?.host != null ? String(body.host).trim() : "";
  if (hostRaw) {
    const parsed = parseLlmTargetInput(hostRaw, body?.port, body?.tls);
    const extra = extraBenchmarkHosts();
    if (!extra.has(parsed.host)) {
      const err = new Error(
        `Remote benchmark host ${parsed.host} is not allowlisted. Add it to SPARKDASH_BENCH_HOSTS or use a saved Spark LLM target.`
      );
      err.status = 403;
      throw err;
    }
    await assertAllowedTarget(parsed.host, extra);
    return {
      port: parsed.port,
      host: parsed.host,
      tls: parsed.tls,
      custom: true,
      apiKey: null,
      resolveTarget: async ({ onStatus }) => {
        onStatus?.(`Reaching ${formatLlmBaseUrl(parsed)}…`);
        return {
          host: parsed.host,
          port: parsed.port,
          tls: parsed.tls,
          via: "direct",
          close: onceClose(() => {}),
        };
      },
    };
  }

  let port = body?.port != null ? Number(body.port) : configuredPorts[0];
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const err = new Error("Invalid port");
    err.status = 400;
    throw err;
  }
  if (!configuredPorts.includes(port)) {
    const err = new Error("port is not configured for this Spark");
    err.status = 400;
    throw err;
  }
  return {
    port,
    host: null,
    tls: false,
    custom: false,
    apiKey: resolveLlmApiKey(spark, port),
    resolveTarget: ({ onStatus, signal }) =>
      resolveLlmHttpTarget(spark, port, {
        apiKey: resolveLlmApiKey(spark, port),
        onStatus,
        signal,
      }),
  };
}

function extraBenchmarkHosts() {
  return new Set(
    String(process.env.SPARKDASH_BENCH_HOSTS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function fleetTargetHosts() {
  const hosts = new Set();
  for (const spark of registry.sparks) {
    if (spark.lanIp) hosts.add(spark.lanIp);
    if (spark.ssh?.host) hosts.add(spark.ssh.host);
  }
  return hosts;
}

async function assertFleetTarget(body) {
  const validationError = validateSparkTarget(body);
  if (validationError) {
    const err = new Error(validationError);
    err.status = 400;
    throw err;
  }
  const sshHost = body?.ssh?.host || "";
  const lanIp = body?.lanIp || "";
  const target = sshHost || lanIp;
  const allowed = fleetTargetHosts();
  if (target) allowed.add(target);
  if (lanIp) allowed.add(lanIp);
  if (target) await assertAllowedTarget(target, allowed);
  if (lanIp && lanIp !== target) await assertAllowedTarget(lanIp, allowed);
}

function principalKey(req) {
  return req.principal?.id || clientKey(req);
}

function rejectLimited(res, message) {
  return res.status(429).json({ error: message });
}

const allowTest = createRateLimiter(20, 60_000);
const allowDestructive = createRateLimiter(10, 60_000);
/** Decode + prefill starts per principal (retries that 400/409 do not count). */
const allowBench = createRateLimiter(20, 60_000);
const allowGlobalDestructive = createRateLimiter(30, 60_000);
/** Anti double-submit only; per-Spark mutex + MAX_ACTIVE_BENCH_JOBS cap load. */
const benchCooldown = createRateLimiter(1, 3_000);
const MAX_ACTIVE_BENCH_JOBS = 2;

/** Running decode, prefill and quality jobs across all Sparks (global cap). */
function activeBenchJobCount() {
  return decodeBenchManager.activeCount() + prefillBenchManager.activeCount() + qualityBenchManager.activeCount();
}

/** Consume bench-start quota only when every limiter would allow it. */
function consumeBenchStartQuota(req, res) {
  const key = principalKey(req);
  const ip = clientKey(req);
  if (!allowBench(key, true)) {
    rejectLimited(res, "Too many benchmark requests; try again shortly");
    return false;
  }
  if (!benchCooldown(key, true)) {
    rejectLimited(res, "Benchmark cooldown is active; wait before starting another job");
    return false;
  }
  if (!allowGlobalDestructive(ip, true)) {
    rejectLimited(res, "Too many requests; try again shortly");
    return false;
  }
  allowBench(key);
  benchCooldown(key);
  allowGlobalDestructive(ip);
  return true;
}

// ─── Spark registry ──────────────────────────────────────
const registry = new SparkRegistry();

// Fleet energy (issue #33) covers SSH Sparks and agent nodes, keyed on the
// fleet-wide unit id; a node on a Spark's LAN IP is the same box, counted once.
const currentEnergyScope = () => energyScopeIds(registry.sparks, loadNodes());

const fleetEnergyTracker = new FleetEnergyTracker({
  nodeIds: currentEnergyScope(),
  filePath: FLEET_ENERGY_JSON_PATH,
  monthlyFilePath: FLEET_ENERGY_MONTHLY_JSON_PATH,
});

// ─── Monitor map ─────────────────────────────────────────
const monitors = new Map();

// ─── Start monitor for a Spark ───────────────────────────
function startMonitor(spark) {
  if (monitors.has(spark.id)) return;
  const monitor = new SparkMonitor(spark, {
    onWolMac: (id, mac) => {
      const updated = registry.noteDetectedMac(id, mac);
      if (updated) {
        const mon = monitors.get(id);
        if (mon) mon.updateConfig(registry.getSpark(id));
      }
    },
    // Hermes check / update results must not wait for the next broadcast tick.
    onHermesChange: () => forceBroadcast(),
    // Worker derived label: resolve a head id to its live LLM model id.
    // Returns null when the head is unknown/offline/model-less so workers
    // never display a stale model. Display-only; never writes to config.
    resolveHeadModelId: (headId) => monitors.get(headId)?.headLlmModelId() ?? null,
  });
  monitors.set(spark.id, monitor);
  monitor.start();
}

// ─── Stop and remove monitor for a Spark ─────────────────
function stopMonitor(id) {
  const monitor = monitors.get(id);
  if (monitor) {
    monitor.stop();
    monitors.delete(id);
  }
}

// ─── Start all monitors from registry ───────────────────
function startAllMonitors() {
  for (const spark of registry.sparks) {
    startMonitor(spark);
  }
}

/** Snapshots in registry tab order (not Map insertion order). */
function orderedSnapshots() {
  return registry.sparkIds
    .map((id) => monitors.get(id))
    .filter(Boolean)
    .map((m) => m.snapshot());
}

// Agent / agentless nodes, each with its registered LAN IP for de-duplication.
// buildFleetSnapshot() lists nodes in listNodes() order; key on the registry id.
function registeredFleetNodes() {
  const records = listNodes();
  return buildFleetSnapshot().nodes.map((node, index) => ({
    ...node,
    nodeId: records[index]?.id ?? node.nodeId,
    registryLanIp: records[index]?.lanIp ?? null,
  }));
}

const fleetEnergyInputs = createEnergyInputCollector({
  orderedSnapshots,
  monitors,
  fleetNodes: registeredFleetNodes,
  sparkLanIps: () => new Map(registry.sparks.map((spark) => [spark.id, spark.lanIp])),
  getSettings,
});

const fleetEnergyRuntime = createFleetEnergyRuntime({
  tracker: fleetEnergyTracker,
  orderedSnapshots,
  monitors,
  collectInputs: (atMs) => fleetEnergyInputs.collect(atMs),
});

// ─── LLM token ledger (FLEET3, issue #38) ───────────────
// Every 15 s: cumulative token counters of SSH Spark LLM ports (LlmProbe) and
// agent-node engines (STAT3 counters, STAT4 relay where no counter exists),
// diffed into hourly / daily / all-time totals per model and endpoint.
const llmTokenLedger = new LlmTokenLedger({ filePath: LLM_TOKEN_TOTALS_JSON_PATH });
const llmTokenRuntime = createLlmTokenRuntime({
  ledger: llmTokenLedger,
  collect: () => collectTokenObservations({ sparks: orderedSnapshots(), nodes: registeredFleetNodes() }),
});

// ─── Unit history (docs/specs/unit-history.md) ──────────
// The GPU raw series (8 h dense + 7 d by minute) is always recorded; the
// 48 h / 30 d buckets only while settings.metricsHistory is true. The flag is
// re-read on every sample, so toggling it needs no restart.
const metricsHistoryEnabled = () => getSettings().metricsHistory === true;
const unitHistory = new UnitHistory({
  file: process.env.GPU_HISTORY_JSON_PATH || path.join(ROOT, "config", "gpu-history.json"),
  longFile:
    process.env.GPU_HISTORY_LONG_JSON_PATH || path.join(ROOT, "config", "gpu-history-long.json"),
  tiersFile: METRICS_HISTORY_JSON_PATH,
  tiersEnabled: metricsHistoryEnabled,
});

const unitHistoryRuntime = createUnitHistoryRuntime({
  store: unitHistory,
  orderedSnapshots,
  monitors,
  isEnabled: metricsHistoryEnabled,
});
unitHistoryRuntime.start();

// ─── Event log (fleet activity, issue #32) ────────────────
// Every alert send (delivered or failed), alert firing/resolving, unit and
// service transition, power/update/component action and benchmark run lands
// here. Served by GET /api/events, pushed live over the ws as
// {type:"event"}, and shown in the Fleet tab's Recent activity card and on
// the Activity page.
const eventLog = new EventLog({
  file: process.env.EVENTS_JSON_PATH || path.join(ROOT, "config", "events.json"),
  max: 2000,
});

/** Display name for a fleet-wide unit id (Spark id or node agent id). */
function unitNameFor(id) {
  return registry.getSpark(id)?.name || getNode(id)?.name || null;
}

const recordNamed = withUnitNames((event) => eventLog.record(event), unitNameFor);

/** Record an event; never throws (callers sit in poll loops and routes). */
function recordEvent(event) {
  try {
    return recordNamed(event);
  } catch {
    return null;
  }
}

decodeBenchManager.setEventSink((job) => recordEvent(activity.bench("decode", job)));
prefillBenchManager.setEventSink((job) => recordEvent(activity.bench("prefill", job)));
showcaseManager.setEventSink((session) => recordEvent(activity.showcase(session)));

// Alerts (docs/specs/alerts.md): Health findings + Overview strip exceptions,
// pushed to the configured channels. Gated by settings.alertsEnabled — when it
// is false nothing is evaluated or sent and the write/test routes answer 409.
// Each delivery attempt lands in the event log above.
const alertsRuntime = createAlertsRuntime({
  filePath: ALERTS_JSON_PATH,
  isEnabled: () => getSettings().alertsEnabled === true,
  recordEvent,
});

// ─── Fleet (node-agent) layer ────────────────────────────
// Separate from the SSH-based Spark monitors above: each fleet node runs
// sparkdash-node-agent (default :30091) and the dashboard polls its
// /telemetry endpoint over plain HTTP. Registry: config/nodes.json
// (missing file → empty fleet, not an error — mirrors SparkRegistry).
let fleetConnection = attachFleetEnrollment(createFleetConnection(loadNodes()));
// S1.4: the agentless-Linux SSH lane — same 7-method surface, scoped to
// protocol:"ssh" records (the HTTP poller above skips exactly those). Built
// once at boot; a registry-mutation rebuild is S1.4 follow-up scope.
const sshFleet = createLinuxSshFleet({ nodes: loadNodes() });
// S1.5: the agentless-macOS (macmon) SSH lane — same 7-method surface,
// scoped to protocol:"ssh" records whose platform is exactly "macos".
// Built once at boot like sshFleet; registry-mutation rebuild stays out of
// scope (same documented limitation as S1.4).
const macosSshFleet = createMacosSshFleet({ nodes: loadNodes() });
// S1.6: the agentless-Windows (PowerShell -EncodedCommand) SSH lane — same
// 7-method surface, scoped to protocol:"ssh" records whose platform is
// exactly "windows". Built once at boot like sshFleet; registry-mutation
// rebuild stays out of scope (same documented limitation as S1.4/S1.5).
const windowsFleet = createWindowsFleet({ nodes: loadNodes() });

// ─── DGX fleet-updates layer (Batch 5, docs/SPEC-UPDATES.md) ────
// Live plan store (config/fleet-update-plan.json, gitignored; the file
// materializes at the FIRST plan write), fan-out updates proxy, and the wave
// gate. The proxy + sequencer capture the node list and plan at construction,
// so both are rebuilt alongside the connection on registry mutations and on
// plan writes (refreshUpdatesLayer).
const updatePlanStore = createPlanStore();
let updatesProxy = null;
let waveSequencer = null;

function refreshUpdatesLayer() {
  const nodes = loadNodes();
  const plan = updatePlanStore.read();
  updatesProxy = createUpdatesProxy({ nodes, plan });
  // BATCH 6c: the gate's evidence source is the proxy's own /updates fan-out
  // cache (arrow re-reads the current proxy across refreshes; production
  // /telemetry carries no update mount).
  waveSequencer = createWaveSequencer({
    nodes,
    connection: fleetConnection,
    plan,
    updateStates: () => updatesProxy.getCachedStates(),
  });
}
refreshUpdatesLayer();

// ─── Spark groups (SC5d, #75) ─────────────────────────────
// config/groups.json (seeded from the registry's groupId designation on first
// run) is the source of truth for TopologyInfo groupId / role / rank / headId.
const groupStore = createGroupStore();
/** Registry records with the persisted spark groups overlaid. */
function groupedNodes(nodes) {
  return applyGroupsToNodes(nodes, groupStore.read(nodes));
}

/** Minimal NodeAgentSnapshot for a registered node that has never polled successfully. */
function emptyNodeSnapshot(rec) {
  return {
    nodeId: rec.id,
    nodeName: rec.name,
    lanIp: rec.lanIp,
    agentVersion: null,
    online: false,
    uptimeSeconds: null,
    gpu: null,
    cpu: null,
    mem: null,
    disk: [],
    net: [],
    containers: [],
    versions: [],
    services: [],
    memory: null,
    requests: null,
    topology: null,
    polledAt: 0,
  };
}

/**
 * Assemble the FleetSnapshot (shared/types.ts) from the registry + cached
 * node-agent snapshots. A node that has never polled successfully degrades
 * to an online:false stub so the UI can render every registered node.
 */
function buildFleetSnapshot() {
  const nodes = listNodes();
  const cached = fleetConnection.getAllSnapshots();
  // Batch 10-B fallback: agent snapshots can carry gpu:null (pre-NVML agents,
  // or containers without the /dev/nvidia* + libnvidia-ml mounts the installer
  // adds since dd22fa2 — agents now report real GPU when the mounts exist).
  // The dashboard's SparkMonitor collects GPU metrics for the same boxes over
  // SSH regardless — fall back to it, matched by lanIp.
  const monitorByLanIp = new Map();
  for (const [id, mon] of monitors) {
    try {
      const ms = typeof mon.snapshot === "function" ? mon.snapshot() : null;
      const ip = (ms && ms.lanIp) || (registry.getSpark(id) || {}).lanIp;
      if (ip && !monitorByLanIp.has(ip)) monitorByLanIp.set(ip, (ms && ms.metrics) || null);
    } catch {
      /* monitor not ready — fallback stays unavailable for this box */
    }
  }
  const nodeSnaps = nodes.map((rec) => {
    const snap =
      fleetConnection.getSnapshot(rec.id) ??
      sshFleet.getSnapshot(rec.id) ??
      macosSshFleet.getSnapshot(rec.id) ??
      windowsFleet.getSnapshot(rec.id) ??
      emptyNodeSnapshot(rec);
    const lanIp = snap.lanIp || rec.lanIp;
    return {
      ...snap,
      nodeName: snap.nodeName || rec.name,
      lanIp,
      online:
        fleetConnection.isOnline(rec.id) ||
        sshFleet.isOnline(rec.id) ||
        macosSshFleet.isOnline(rec.id) ||
        windowsFleet.isOnline(rec.id),
      enrollment: rec.status === "pending" ? "pending" : "claimed",
      // Lookup prefers the REGISTRY lanIp: the agent's self-reported lanIp can
      // be a management/Tailscale address (live: 10.200.0.x on two boxes),
      // which never matches the Spark monitor's LAN key.
      gpu: snap.gpu ?? fleetGpuFromMonitor(monitorByLanIp.get(rec.lanIp) ?? monitorByLanIp.get(lanIp) ?? null),
    };
  });
  const requests = aggregateRequests(cached);
  const byNode = {};
  let totalMB = 0;
  let usedMB = 0;
  let freeMB = 0;
  for (const rec of nodes) {
    const snap = cached[rec.id];
    if (!snap || !snap.memory) continue;
    byNode[rec.id] = snap.memory;
    totalMB += snap.memory.totalMB || 0;
    usedMB += snap.memory.usedMB || 0;
    freeMB += snap.memory.freeMB || 0;
  }
  return {
    nodes: nodeSnaps,
    topology: buildTopology(groupedNodes(nodes)),
    requests,
    memory: { totalMB, usedMB, freeMB, byNode },
    polledAt: Date.now(),
  };
}

/**
 * Rebuild the poller after a registry mutation (node add/update/delete).
 * The connection manager is immutable after creation, so swap in a fresh
 * one; start/stop are both idempotent.
 */
/**
 * S1.2 enrollment flip (EVAL §4.1 gap 2): a successful poll IS authenticated
 * contact (the poller presents the node's bearer token when set) — flip any
 * still-pending registry record to claimed. Idempotent: claimed records have
 * no status key, and updateNode re-normalization drops status + claimToken.
 * Attached at every connection construction (boot + registry mutations).
 */
function attachFleetEnrollment(conn) {
  conn.onSnapshot((nodeId) => {
    const rec = getNode(nodeId);
    if (rec && rec.status === "pending") {
      updateNode(nodeId, { status: "claimed" });
    }
  });
  return conn;
}

function restartFleetConnection() {
  const prev = fleetConnection;
  fleetConnection = attachFleetEnrollment(createFleetConnection(loadNodes()));
  refreshUpdatesLayer();
  void fleetConnection
    .start()
    .catch((err) => console.error("[fleet] poller start failed:", err.message));
  void prev.stop().catch(() => {});
}

// ─── Express app ─────────────────────────────────────────
const app = express();
const server = createServer(app);

app.use(express.json());
app.use(createAuthMiddleware());

// ─── Bench results store (BENCH1) ─────────────────────────
const benchResultsStore = new BenchResultsStore();
/** Fleet energy tracker read over a bench run window (BENCH6 run cost). */
const benchEnergyWindow = (nodeId, startMs, endMs) => fleetEnergyTracker.windowEnergy(nodeId, startMs, endMs);
/** Unified-memory headroom of a monitored node right now, in MB (BENCH6 run cost). */
function benchMemoryNow(nodeId) {
  const mem = monitors.get(nodeId)?.snapshot()?.metrics?.unifiedMemory;
  if (!mem || !(mem.available > 0) || !(mem.total > 0)) return null;
  return { available_mb: mem.available, total_mb: mem.total };
}
const benchResultsRecorder = createResultsRecorder({
  store: benchResultsStore,
  energyWindow: benchEnergyWindow,
  memoryNow: benchMemoryNow,
});
decodeBenchManager.resultSink = benchResultsRecorder.sinkFor("DecodeBench");
prefillBenchManager.resultSink = benchResultsRecorder.sinkFor("PrefillBench");
showcaseManager.resultSink = benchResultsRecorder.sinkFor("Showcase");
qualityBenchManager.resultSink = benchResultsRecorder.sinkFor("QualityBench");
qualityBenchManager.store = benchResultsStore;
try {
  const imported = benchResultsStore.importLegacyHistories({
    decode: decodeBenchManager.historyPath,
    prefill: prefillBenchManager.historyPath,
    showcase: showcaseManager.historyPath,
  });
  const added = Object.values(imported).reduce((n, r) => n + (r.added || 0), 0);
  if (added) console.log(`[bench-results] imported ${added} result(s) from bench history files`);
} catch (err) {
  console.warn(`[bench-results] legacy history import failed: ${err.message}`);
}
// Published reference figures (BENCH5): stored as origin "reference", never as Herd results.
let referenceRegistry = null;
try {
  const doc = readRegistry();
  const records = registryRecords(doc);
  referenceRegistry = doc;
  const seeded = syncRegistryIntoStore(benchResultsStore, records);
  if (seeded.added || seeded.updated || seeded.removed) {
    console.log(
      `[bench-results] reference registry: ${seeded.added} added, ${seeded.updated} updated, ${seeded.removed} removed`
    );
  }
} catch (err) {
  console.warn(`[bench-results] reference registry: ${err.message}`);
}
registerBenchResultsRoutes(app, { store: benchResultsStore, registry: referenceRegistry, energyWindow: benchEnergyWindow });
// AEON Bench Pod import (BENCH7): provenance is Herd's view of the benched lane now.
registerAeonPodRoutes(app, {
  store: benchResultsStore,
  provenanceFor(nodeId, port) {
    const spark = registry.getSpark(nodeId);
    if (spark) {
      const ports = Array.isArray(spark.llmPorts) && spark.llmPorts.length ? spark.llmPorts : [resolveLlmPort(spark)];
      if (port != null && !ports.includes(port)) {
        throw Object.assign(new Error(`Port ${port} is not an LLM port of ${spark.id}`), { status: 400 });
      }
      return benchProvenance(spark, monitors.get(spark.id), port ?? ports[0], ports);
    }
    const rec = getNode(nodeId);
    if (!rec) throw Object.assign(new Error(`Node ${nodeId} not found`), { status: 404 });
    const snapshot = fleetConnection ? fleetConnection.getSnapshot(rec.id) : null;
    return describeNodeProvenance(rec, snapshot, resolveNodeBenchTarget(rec, snapshot, { port }));
  },
});

/** Host + lane provenance for a bench run starting now (null on failure). */
function benchProvenance(spark, monitor, port, ports, customHost = false) {
  try {
    return describeProvenance({
      snapshot: monitor ? monitor.snapshot() : null,
      allSnapshots: [...monitors.values()].map((m) => m.snapshot()),
      nodeId: spark.id,
      port,
      ports,
      customHost,
    });
  } catch {
    return null;
  }
}

// ─── Fleet Prompt Showcase (SHOW1, issue #39) ───────────
// One session fans the shared Showcase prompts out to any set of LLM lanes:
// SSH Spark ports (LAN or SSH tunnel) and agent-node engines (LAN first, SSH
// tunnel for protocol:"ssh" nodes). Client timing everywhere; server tok/s
// from the engine counters polled every 400 ms where the engine has them.
const fleetShowcaseManager = new FleetShowcaseManager({ historyPath: FLEET_SHOWCASE_HISTORY_PATH });
fleetShowcaseManager.resultSink = benchResultsRecorder.sinkFor("FleetShowcase");
fleetShowcaseManager.eventSink = (session) => recordEvent(activity.fleetShowcase(session));

function fleetShowcaseTargets() {
  return listShowcaseTargets({
    sparks: registry.sparks,
    sparkSnapshot: (id) => monitors.get(id)?.snapshot() ?? null,
    nodes: registeredFleetNodes(),
    nodeRecord: (id) => getNode(id),
  });
}

function sparkPortsOf(spark) {
  return Array.isArray(spark.llmPorts) && spark.llmPorts.length ? spark.llmPorts : [resolveLlmPort(spark)];
}

/** Why a lane cannot join a fleet session now (Spark-level jobs only), or null. */
function fleetShowcaseLaneBusy(target) {
  if (target.kind !== "spark") return null;
  if (showcaseManager.getActive(target.nodeId)) return "a prompt showcase is already running on this Spark";
  if (decodeBenchManager.getActive(target.nodeId)) return "a decode benchmark is running on this Spark";
  if (prefillBenchManager.getActive(target.nodeId)) return "a prefill benchmark is running on this Spark";
  return null;
}

function buildFleetShowcaseLane(target) {
  const base = {
    laneId: target.laneId,
    kind: target.kind,
    nodeId: target.nodeId,
    nodeName: target.nodeName,
    host: target.host,
    port: target.port,
    modelId: target.modelId,
    backend: target.backend,
    serverCounters: target.serverCounters,
  };
  if (target.kind === "spark") {
    const spark = registry.getSpark(target.nodeId);
    const apiKey = resolveLlmApiKey(spark, target.port);
    const monitor = monitors.get(target.nodeId);
    return {
      lane: {
        ...base,
        apiKey,
        resolveTarget: ({ signal, onStatus }) => resolveLlmHttpTarget(spark, target.port, { apiKey, signal, onStatus }),
      },
      provenance: benchProvenance(spark, monitor, target.port, sparkPortsOf(spark)),
    };
  }
  let provenance = null;
  try {
    provenance = describeProvenance({
      snapshot: {
        id: target.nodeId,
        name: target.nodeName,
        kind: "node",
        metrics: { llm: [{ backend: target.backend, modelId: target.modelId }] },
      },
      nodeId: target.nodeId,
      port: target.port,
      ports: [target.port],
    });
  } catch {
    provenance = null;
  }
  return {
    lane: {
      ...base,
      apiKey: null,
      resolveTarget: ({ signal, onStatus }) =>
        resolveNodeLaneTarget(
          target,
          { probe: probeLlmHttp, openTunnel: openSshLlmTunnel, nodeRecord: getNode, getPassword: getNodeSshPassword },
          { signal, onStatus }
        ),
    },
    provenance,
  };
}

registerFleetShowcaseRoutes(app, {
  manager: fleetShowcaseManager,
  listTargets: fleetShowcaseTargets,
  buildLane: buildFleetShowcaseLane,
  laneBusy: fleetShowcaseLaneBusy,
  noteStart: (sessionId, provenance) => benchResultsRecorder.noteStart("FleetShowcase", sessionId, provenance),
});

app.get("/api/health", (_req, res) => {
  res.json(inspectHealth(process.env.BIND_HOST || "127.0.0.1"));
});

// S4.1a guard probe: read-only, settings-tolerant. No .guard config (or
// entries without a string baseUrl) is the graceful "not present" state —
// the route then answers {guards:[]}. The panel (S4.1b) owns presentation.
app.get("/api/guard", async (_req, res) => {
  try {
    const configured = getSettings()?.guard?.endpoints;
    const endpoints = (Array.isArray(configured) ? configured : []).filter(
      (e) => typeof e?.baseUrl === "string" && e.baseUrl
    );
    const guards = await probeAll(endpoints, { fetchImpl: globalThis.fetch });
    res.json({ guards });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// S5.1a memory-health probe: read-only, settings-tolerant. No .memoryHealth
// config (or entries without a string baseUrl) is the graceful "not present"
// state — the route then answers {services:[]}. The panel (S5.1b) owns
// presentation.
app.get("/api/memory-health", async (_req, res) => {
  try {
    const configured = getSettings()?.memoryHealth?.endpoints;
    const endpoints = (Array.isArray(configured) ? configured : []).filter(
      (e) => typeof e?.baseUrl === "string" && e.baseUrl
    );
    const services = await probeAllMemoryServices(endpoints, { fetchImpl: globalThis.fetch });
    res.json({ services });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

// ─── REST API ────────────────────────────────────────────
registerFleetEnergyRoute(app, fleetEnergyTracker, {
  // FLEET3: Wh/token from the fleet-wide token ledger when it has tokens.
  decorate: (snapshot) =>
    withLedgerTokens(
      buildFleetEnergyView(snapshot, { hosts: fleetEnergyInputs.hosts(), settings: getSettings() }),
      llmTokenLedger.totals("24h")
    ),
});
registerLlmTokenRoutes(app, llmTokenLedger);
registerAlertRoutes(app, alertsRuntime);

// Never return SSH passwords in any response
app.get("/api/sparks", (_req, res) => {
  res.json({ sparks: registry.publicSparks });
});

// Ephemeral connectivity test — does not persist or start a monitor
app.post("/api/sparks/test", async (req, res) => {
  try {
    if (!allowTest(principalKey(req)) || !allowGlobalDestructive(clientKey(req))) {
      return rejectLimited(res, "Too many test requests; try again shortly");
    }
    const body = req.body || {};
    const validationError = validateSparkTarget(body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const spark = {
      id: body.id || "ephemeral-test",
      name: body.name || "test",
      lanIp: body.lanIp || "",
      cx7Ip: body.cx7Ip || null,
      isLocal: Boolean(body.isLocal),
      role: body.role,
      workerNode: Boolean(body.workerNode),
      llmMonitoring: body.llmMonitoring,
      llmPort: resolveLlmPort(body),
      comfyPort: resolveComfyPort(body),
      comfyMonitoring: Boolean(body.comfyMonitoring),
      hermesMonitoring: Boolean(body.hermesMonitoring),
      tailscaleMonitoring: Boolean(body.tailscaleMonitoring),
      ssh: {
        host: body.ssh?.host || body.lanIp || "",
        user: body.ssh?.user || "root",
        auth: body.ssh?.auth === "pass" ? "pass" : "key",
        password: body.ssh?.password,
      },
    };
    if (!spark.isLocal && !spark.lanIp && !spark.ssh.host) {
      return res.status(400).json({ error: "lanIp or ssh.host required" });
    }
    const llmPort = resolveLlmPort(spark);
    const comfyPort = resolveComfyPort(spark);
    const result = await testSparkConnectivity(spark, { llmPort, comfyPort });
    const byId = Object.fromEntries(result.capabilities.map((capability) => [capability.id, capability]));
    res.json({
      id: spark.id,
      capabilities: result.capabilities,
      ssh: { ok: byId.host.status === "pass", message: byId.host.message },
      llm: { ok: byId.llm.status !== "fail", message: byId.llm.message, skipped: byId.llm.status === "skipped" },
      comfy: { ok: byId.comfy.status !== "fail", message: byId.comfy.message, skipped: byId.comfy.status === "skipped" },
      ok: result.ok,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sparks", (req, res) => {
  try {
    const validationError = validateSparkTarget(req.body || {});
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const spark = registry.addSpark(req.body);
    fleetEnergyTracker.setNodeIds(currentEnergyScope());
    startMonitor(spark);
    recordEvent(activity.sparkAdded(spark));
    res.json({ success: true, spark: registry.toPublic(spark) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.patch("/api/sparks/:id", (req, res) => {
  try {
    const body = req.body || {};
    // Only validate host fields if they are being updated
    if (body.lanIp != null || body.ssh?.host != null || body.ssh?.user != null) {
      const existing = registry.getSpark(req.params.id);
      if (!existing) return res.status(404).json({ error: "Spark not found" });
      const merged = {
        lanIp: body.lanIp ?? existing.lanIp,
        ssh: { ...existing.ssh, ...(body.ssh || {}) },
      };
      const validationError = validateSparkTarget(merged);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }
    }

    // Password-only update: hot-apply without full monitor restart
    const keys = Object.keys(body).filter((k) => k !== "ssh");
    const sshKeys = body.ssh ? Object.keys(body.ssh) : [];
    const passwordOnly =
      keys.length === 0 &&
      sshKeys.length > 0 &&
      sshKeys.every((k) => k === "password");

    if (passwordOnly && body.ssh?.password) {
      const spark = registry.setPassword(req.params.id, body.ssh.password);
      const mon = monitors.get(req.params.id);
      if (mon) mon.updateConfig(registry.getSpark(req.params.id));
      return res.json({ success: true, spark, hasPassword: true });
    }

    // LLM API keys: an llmPorts change is the second bypass besides out-of-band
    // sparks.json writes. patchSpark() arms the reconcile on the llmPorts
    // own-property (any shape — [] and the legacy scalar are applied by the
    // normalizer too) and syncs against the post-normalize ports.
    const { spark } = registry.patchSpark(req.params.id, body);
    // Restart monitor so collectors pick up host/auth/isLocal changes
    stopMonitor(req.params.id);
    startMonitor(spark);
    res.json({
      success: true,
      spark: registry.toPublic(spark),
      hasPassword: registry.hasPassword(req.params.id),
    });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.delete("/api/sparks/:id", (req, res) => {
  try {
    const removed = registry.removeSpark(req.params.id);
    if (!removed) return res.status(404).json({ error: "Spark not found" });
    fleetEnergyTracker.setNodeIds(currentEnergyScope());
    stopMonitor(req.params.id);
    unitHistory.remove(req.params.id);
    recordEvent(activity.sparkRemoved(removed));
    res.json({ success: true, removed });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Reorder Sparks in the tab bar (persisted to sparks.json)
app.put("/api/sparks/order", (req, res) => {
  try {
    const order = req.body?.order;
    if (!Array.isArray(order)) {
      return res.status(400).json({ error: "body.order must be an array of spark ids" });
    }
    const sparks = registry.reorderSparks(order);
    res.json({ success: true, sparks });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Fleet (node-agent) API ────────────────────────────────
// Registry CRUD (persisted to config/nodes.json) + aggregated fleet snapshot.
// The fleet layer is independent of the SSH-based Spark monitors above: both
// coexist, each with its own registry and poller.

app.get("/api/fleet", (_req, res) => {
  res.json(buildFleetSnapshot());
});

// S2.1: Prometheus text exposition twin of GET /api/fleet. Root path per
// Prometheus convention (BEFORE the static/SPA fallback); same exposure
// class as /api/fleet — no auth, no caching. renderFleetMetrics is pure.
app.get("/metrics", (_req, res) => {
  res.type("text/plain; version=0.0.4; charset=utf-8").send(renderFleetMetrics(buildFleetSnapshot()));
});

app.get("/api/fleet/nodes", (_req, res) => {
  res.json({ nodes: listNodes() });
});

app.post("/api/fleet/nodes", (req, res) => {
  try {
    const node = addNode(req.body || {});
    restartFleetConnection();
    recordEvent(activity.nodeAdded(node));
    res.json({ success: true, node });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/**
 * S1.2 enrollment claim (EVAL §4.1 gap 2, Netdata shape): present a pending
 * node's one-time claim token (minted in the POST /api/fleet/nodes response).
 * On match the record flips pending → claimed and the token is consumed —
 * both keys drop, so a repeat presentation can never match. 404 unknown node,
 * 403 unknown-or-claimed or token mismatch.
 */
app.post("/api/fleet/nodes/:id/claim", (req, res) => {
  if (!getNode(req.params.id)) return res.status(404).json({ error: "Node not found" });
  const node = claimNode(req.params.id, (req.body || {}).claimToken);
  if (!node) return res.status(403).json({ error: "Claim rejected: already claimed or token mismatch" });
  res.json({ success: true, node });
});

/**
 * S1.3 SSH credential routes (EVAL §4.4 item 3): the sshTransport dials
 * auth:"pass" records with a password resolved from the ENCRYPTED secrets
 * store (server/fleet/nodeCredentials.js, key `node:<id>`). The value is
 * write-only over the API — GET reveals presence only, and credentials are
 * never stored on the record (nodes.json) nor served by any endpoint.
 */
app.get("/api/fleet/nodes/:id/ssh-password", (req, res) => {
  if (!getNode(req.params.id)) return res.status(404).json({ error: "Node not found" });
  res.json({ hasPassword: hasNodeSshPassword(req.params.id) });
});

app.put("/api/fleet/nodes/:id/ssh-password", (req, res) => {
  if (!getNode(req.params.id)) return res.status(404).json({ error: "Node not found" });
  try {
    setNodeSshPassword(req.params.id, (req.body || {}).password);
    res.json({ success: true, hasPassword: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/fleet/nodes/:id/ssh-password", (req, res) => {
  if (!getNode(req.params.id)) return res.status(404).json({ error: "Node not found" });
  res.json({ success: true, removed: deleteNodeSshPassword(req.params.id) });
});

app.put("/api/fleet/nodes/:id", (req, res) => {
  try {
    const node = updateNode(req.params.id, req.body || {});
    restartFleetConnection();
    res.json({ success: true, node });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

app.delete("/api/fleet/nodes/:id", (req, res) => {
  try {
    const removed = removeNode(req.params.id);
    if (!removed) return res.status(404).json({ error: "Node not found" });
    restartFleetConnection();
    recordEvent(activity.nodeRemoved(typeof removed === "object" ? removed : { id: req.params.id }));
    res.json({ success: true, removed });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

/**
 * Proxy a service action (start/stop/restart/switch) to the node's agent
 * POST /actions. The deployed agent build (0.1.0) is telemetry-only (GET),
 * so this surfaces 501 until an agent build that ships the actions endpoint
 * is deployed — the proxy itself then needs no changes.
 */
app.post("/api/fleet/nodes/:id/actions", async (req, res) => {
  const rec = listNodes().find((n) => n.id === req.params.id);
  if (!rec) return res.status(404).json({ error: "Node not found" });
  const actionInfo = {
    action: String(req.body?.type ?? req.body?.action ?? "action"),
    service: req.body?.service ?? req.body?.serviceName ?? req.body?.name ?? null,
  };
  const noteAction = (ok, error) => recordEvent(activity.serviceAction(rec, { ...actionInfo, ok, error }));
  const endpoint = (rec.endpoint || `${rec.lanIp}:${rec.agentPort}`).replace(/\/+$/, "");
  try {
    const upstream = await fetch(`http://${endpoint}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actionId: randomUUID(),
        idempotent: true,
        timeoutMs: null,
        ...(req.body || {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await upstream.json().catch(() => null);
    if (upstream.status === 405) {
      noteAction(false, "agent has no /actions endpoint");
      return res.status(501).json({
        error:
          "The node agent on this node is a telemetry-only build (no /actions endpoint yet). Service start/stop is available once the agent actions build is deployed.",
      });
    }
    if (!upstream.ok) {
      noteAction(false, body?.error || `agent responded ${upstream.status}`);
      return res.status(502).json({
        error: body?.error || `Node agent responded ${upstream.status}`,
      });
    }
    noteAction(true);
    res.json(body ?? { ok: true });
  } catch (err) {
    noteAction(false, `agent unreachable: ${err.message}`);
    res.status(502).json({ error: `Node agent unreachable: ${err.message}` });
  }
});

/**
 * v2 component actions (SC action seam, docs/COMPONENTS-DESIGN-PROPOSAL.md
 * §7). The browser posts the browser-owned fields of a ComponentActionRequest
 * to this per-node route; the server mints actionId, pins nodeId from the
 * route, stamps actor, and proxies the v2 request to the node agent
 * POST /actions (agent is validator of last resort). Status mapping matches
 * the legacy /actions proxy: 405 upstream → 501 telemetry-only build,
 * non-ok/transport → 502. Boot-class timeouts (long sglang boots) live in
 * proxyComponentAction, not the 60 s updates window.
 */
app.post("/api/fleet/nodes/:id/component-actions", async (req, res) => {
  const rec = listNodes().find((n) => n.id === req.params.id);
  if (!rec) return res.status(404).json({ error: "Node not found" });
  const built = buildComponentAction(req.body, {
    nodeId: req.params.id,
    actor: req.auth?.actor ?? req.headers["x-actor"] ?? null,
  });
  if (!built.ok) return res.status(built.status).json({ error: built.error });
  const { status, body } = await proxyComponentAction(rec, built.request);
  recordEvent(
    activity.componentAction(rec, {
      type: built.request.type,
      componentId: built.request.componentId,
      dryRun: built.request.dryRun,
      ok: status === 200,
      error: body?.error,
    }),
  );
  res.status(status).json(body);
});

/**
 * POC components tab (issue #7): POC1 catalog definitions (agent/catalog/
 * components/*.json) joined with live per-node state. Read-only: the action
 * seam itself is the per-node POST /api/fleet/nodes/:id/component-actions
 * route above — the browser sends ComponentActionRequest fields there and
 * gets ComponentActionResult back (dry-run preview = same route, dryRun:true).
 */
app.get("/api/components", (_req, res) => {
  const { components, warnings } = loadComponentCatalog();
  const nodeSnaps = Object.values({
    ...fleetConnection.getAllSnapshots(),
    ...sshFleet.getAllSnapshots(),
    ...macosSshFleet.getAllSnapshots(),
    ...windowsFleet.getAllSnapshots(),
  }).filter((s) => s && s.nodeId);
  joinComponentState(components, nodeSnaps);
  res.json({ components, warnings });
});

/**
 * SC10 stacks (issue #19): the hardcoded pre-defined bootstrap stacks (POC
 * step 1, the Hasso recipes — agent/catalog/stacks-catalog.js) scoped over
 * the fleet/node registry, each entry defaulted tp=1 for a single machine /
 * tp=x for an x-machine group. Read-only projection; the stacks UI consumes
 * this to list available stacks. Server/fleet/stacksBootstrap.js.
 */
app.get("/api/stacks", (_req, res) => {
  // SC5d: group scopes come from the persisted spark groups (group-first).
  res.json({ stacks: bootstrapStacksForFleet(groupedNodes(listNodes())) });
});

// SC5d (#75): spark groups edited on the Topology tab + the computed RoCE
// plan. Apply defaults to a dry run; a real apply is a 501 stub for now.
registerGroupRoutes(app, {
  store: groupStore,
  listNodes,
  getSnapshot: (id) =>
    fleetConnection.getSnapshot(id) ??
    sshFleet.getSnapshot(id) ??
    macosSshFleet.getSnapshot(id) ??
    windowsFleet.getSnapshot(id) ??
    null,
});

// ─── Fleet updates API (Batch 5, docs/SPEC-UPDATES.md §6) ───
// The seven SPEC §6 routes. Node-agent actions ride the existing
// POST /actions seam with request.type as the discriminator (per the
// committed dispatch code): dgx-update-now / schedule-update /
// cancel-schedule. fetch semantics mirror the /actions proxy above.

/**
 * Proxy one updates action to the node agent POST /actions, mirroring the
 * /api/fleet/nodes/:id/actions fetch pattern (405 -> 501 telemetry-only,
 * non-ok/unreachable -> 502 with the upstream error when present).
 * @returns {Promise<{status: number, body: object}>}
 */
async function proxyUpdatesAction(rec, request, timeoutMs = 60_000) {
  const endpoint = (rec.endpoint || `${rec.lanIp}:${rec.agentPort}`).replace(/\/+$/, "");
  try {
    const upstream = await fetch(`http://${endpoint}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actionId: randomUUID(),
        idempotent: true,
        timeoutMs: null,
        ...request,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await upstream.json().catch(() => null);
    if (upstream.status === 405) {
      return {
        status: 501,
        body: {
          error:
            "The node agent on this node is a telemetry-only build (no /actions endpoint yet). Fleet update actions are available once the agent updates build is deployed.",
        },
      };
    }
    if (!upstream.ok) {
      return {
        status: 502,
        body: { error: body?.error || `Node agent responded ${upstream.status}` },
      };
    }
    return { status: 200, body: body ?? { ok: true } };
  } catch (err) {
    return { status: 502, body: { error: `Node agent unreachable: ${err.message}` } };
  }
}

/** Registry lookup for the :id updates routes; answers 404 and returns null. */
function updatesNodeOr404(req, res) {
  const rec = listNodes().find((n) => n.id === req.params.id);
  if (!rec) res.status(404).json({ error: "Node not found" });
  return rec || null;
}

// 1. Fleet-wide updates view: one NodeUpdatesView per registered node.
app.get("/api/fleet/updates", async (_req, res) => {
  try {
    const views = await updatesProxy.getAllViews();
    res.json({ views });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Trigger an immediate DGX update on one node. 409 while any wave is
// open (SPEC §6.2 trigger guard). The first successful single-node trigger
// stamps plan.startedAt (orchestrator-ratified) so outcome attribution has
// a time floor; a stamp failure never masks the accepted trigger.
app.post("/api/fleet/nodes/:id/updates/now", async (req, res) => {
  // BATCH 6c: refresh the fan-out cache at decision time; on fan-out failure
  // proceed with the last-known cache (fail-closed path covers it).
  try { await updatesProxy.getAllViews(); } catch { /* keep last-known */ }
  if (waveSequencer.isWaveOpen()) {
    return res.status(409).json({
      error: "A fleet wave is in flight; single-node updates are disabled while any wave is open.",
    });
  }
  const rec = updatesNodeOr404(req, res);
  if (!rec) return;
  const result = await proxyUpdatesAction(rec, { type: "dgx-update-now" });
  recordEvent(activity.updateStarted(rec, { ok: result.status === 200, error: result.body?.error }));
  if (result.status === 200) {
    const plan = updatePlanStore.read();
    if (plan && plan.startedAt == null) {
      plan.startedAt = Date.now();
      try {
        updatePlanStore.write(plan);
      } catch (err) {
        console.error("[fleet-updates] failed to stamp plan.startedAt:", err.message);
      }
      refreshUpdatesLayer();
    }
  }
  res.status(result.status).json(result.body);
});

// 3. Schedule this node's single pending update ({ kind, at|cron,
// mirrorCron }); the agent owns the one-pending-per-node rule.
app.post("/api/fleet/nodes/:id/updates/schedule", async (req, res) => {
  const rec = updatesNodeOr404(req, res);
  if (!rec) return;
  const { kind, at, cron, mirrorCron } = req.body || {};
  const result = await proxyUpdatesAction(rec, {
    type: "schedule-update",
    kind,
    at,
    cron,
    mirrorCron,
  });
  if (result.status === 200) recordEvent(activity.updateScheduled(rec, { kind, at, cron }));
  res.status(result.status).json(result.body);
});

// 4. Cancel a node's pending schedule by id.
app.delete("/api/fleet/nodes/:id/updates/schedule/:sid", async (req, res) => {
  const rec = updatesNodeOr404(req, res);
  if (!rec) return;
  const result = await proxyUpdatesAction(rec, {
    type: "cancel-schedule",
    scheduleId: req.params.sid,
  });
  if (result.status === 200) recordEvent(activity.updateScheduled(rec, null));
  res.status(result.status).json(result.body);
});

// 5. Store the fleet plan: waves are ordered groups. Accepts
// [["node-a","node-b"], ...] or [{ nodeIds: [...], reason }, ...]; the
// store validates, normalizes, and atomically writes the live file.
app.post("/api/fleet/updates/plan", (req, res) => {
  try {
    const groups = (Array.isArray(req.body?.groups) ? req.body.groups : []).map((g) =>
      Array.isArray(g) ? { nodeIds: g } : g
    );
    const plan = {
      groups,
      createdAt: Date.now(),
      startedAt: null,
      waveStates: groups.map(() => "pending"),
    };
    updatePlanStore.write(plan);
    refreshUpdatesLayer();
    res.json({ success: true, plan: updatePlanStore.read() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 6. Current plan + live waveStates ("pending"|"running"|"rebooting"|"slow"|
// "healthy"; stuck members surface as "running", the truth is per-node view).
app.get("/api/fleet/updates/plan", (_req, res) => {
  res.json({
    plan: updatePlanStore.read(),
    waveStates: waveSequencer.getWaveStates(),
  });
});

// 7. Abandon the plan — only while no wave is in flight (a wave must run to
// its gate; deleting the plan mid-wave would orphan the running members).
app.delete("/api/fleet/updates/plan", async (_req, res) => {
  // BATCH 6c: same decision-time cache refresh as the trigger guard.
  try { await updatesProxy.getAllViews(); } catch { /* keep last-known */ }
  if (waveSequencer.isWaveOpen()) {
    return res.status(409).json({
      error: "A fleet wave is in flight; the plan cannot be abandoned until every wave has closed.",
    });
  }
  try {
    updatePlanStore.write(null);
    refreshUpdatesLayer();
    res.json({ success: true, abandoned: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Global settings ──────────────────────────────────────
app.get("/api/settings", (_req, res) => {
  res.json(getSettings());
});

app.put("/api/settings", (req, res) => {
  try {
    const patch = req.body || {};
    const newSettings = updateSettings(patch);
    // If poll interval changed, restart the broadcast timer
    if (patch.pollIntervalMs != null) {
      restartBroadcast();
    }
    res.json(newSettings);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// /api/sparks/:id/gpu-history and /api/sparks/:id/history; these must be
// registered ahead of the catch-all :id/metrics handler below.
registerUnitHistoryRoutes(app, {
  store: unitHistory,
  hasUnit: (id) => Boolean(registry.getSpark(id)),
  isEnabled: metricsHistoryEnabled,
});

app.get("/api/sparks/:id/metrics", (req, res) => {
  const monitor = monitors.get(req.params.id);
  if (!monitor) return res.status(404).json({ error: "Spark not found" });
  res.json(monitor.snapshot());
});

// Test SSH + LLM connectivity for a registered Spark.
// Optional body.ssh.password is ALWAYS saved (even if the host is down).
app.post("/api/sparks/:id/test", async (req, res) => {
  if (!allowTest(principalKey(req)) || !allowGlobalDestructive(clientKey(req))) {
    return rejectLimited(res, "Too many test requests; try again shortly");
  }
  try {
    const body = req.body || {};
    const incomingPassword = body.ssh?.password ?? body.password;
    // Persist password first — does not require host reachability
    if (incomingPassword != null && incomingPassword !== "") {
      registry.setPassword(req.params.id, incomingPassword);
    }

    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const result = await testSparkConnectivity(spark, {
      llmPort: resolveLlmPort(spark),
      comfyPort: resolveComfyPort(spark),
    });
    const byId = Object.fromEntries(result.capabilities.map((capability) => [capability.id, capability]));
    res.json({
      id: req.params.id,
      capabilities: result.capabilities,
      ssh: { ok: byId.host.status === "pass", message: byId.host.message },
      llm: { ok: byId.llm.status !== "fail", message: byId.llm.message, skipped: byId.llm.status === "skipped" },
      comfy: { ok: byId.comfy.status !== "fail", message: byId.comfy.message, skipped: byId.comfy.status === "skipped" },
      ok: result.ok,
      hasPassword: registry.hasPassword(req.params.id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a ComfyUI job (running interrupt and/or pending dequeue).
app.post("/api/sparks/:id/comfy/cancel", async (req, res) => {
  if (!allowDestructive(principalKey(req)) || !allowGlobalDestructive(clientKey(req))) {
    return rejectLimited(res, "Too many cancellation requests; try again shortly");
  }
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (!spark.comfyMonitoring) {
      return res.status(400).json({ error: "ComfyUI monitoring is disabled for this Spark" });
    }
    const promptId = req.body?.promptId ?? req.body?.prompt_id;
    if (!promptId || typeof promptId !== "string") {
      return res.status(400).json({ error: "promptId is required" });
    }
    const result = await comfyCancelJob(spark, promptId, resolveComfyPort(spark));
    // Nudge a comfy re-poll so UI updates quickly
    const mon = monitors.get(req.params.id);
    if (mon) void mon._pollDomain?.("comfy");
    res.json({ success: result.ok, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Manual metric refresh ──────────────────────────────
app.post("/api/sparks/:id/refresh/:domain", async (req, res) => {
  try {
    const monitor = monitors.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: "Spark not found" });
    const { domain } = req.params;
    if (domain !== "storage") {
      return res.status(400).json({ error: "Only 'storage' domain is supported" });
    }
    await monitor.refreshDomain(domain);
    forceBroadcast();
    res.json({ success: true, domain });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Hermes Agent ───────────────────────────────────
// Batch route first (like shutdown-all/wake-all): a plain Sparks-suffixed
// path (3 segments) that cannot be captured by /api/sparks/:id/hermes/* (4).
/** One-click `hermes update` on every Spark with hermes monitoring enabled. */
app.post("/api/sparks/hermes/update-all", async (_req, res) => {
  const results = [];
  for (const spark of registry.sparks) {
    const monitor = monitors.get(spark.id);
    const entry = { id: spark.id, name: spark.name, ok: false, started: false, skipped: false };
    if (!spark.hermesMonitoring || !monitor) {
      entry.skipped = true;
      entry.reason = spark.hermesMonitoring
        ? "monitor not running"
        : "Hermes Agent monitoring is disabled (enable it in Edit Spark)";
      results.push(entry);
      continue;
    }
    const result = monitor.runHermesUpdate();
    entry.started = Boolean(result.started);
    entry.ok = Boolean(result.started);
    if (!result.started) {
      entry.skipped = true;
      entry.reason = result.reason || "update already running";
    }
    results.push(entry);
  }
  res.json({ success: true, results });
});

/** Re-check for a hermes update now (bypasses the poll cadence). */
app.post("/api/sparks/:id/hermes/check", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (!spark.hermesMonitoring) {
      return res.status(400).json({
        error: "Hermes Agent monitoring is disabled for this Spark (enable it in Edit Spark)",
      });
    }
    const monitor = monitors.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: "Spark not found" });
    const result = await monitor.hermesProbe.check();
    monitor.applyHermesCheck(result);
    res.json({ success: true, hermes: monitor.snapshot().hermes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** One-click `hermes update` via SSH. Returns 202; progress via snapshot. */
app.post("/api/sparks/:id/hermes/update", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (!spark.hermesMonitoring) {
      return res.status(400).json({
        error: "Hermes Agent monitoring is disabled for this Spark (enable it in Edit Spark)",
      });
    }
    const monitor = monitors.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: "Spark not found" });
    const result = await monitor.runHermesUpdate();
    res.status(result.started ? 202 : 200).json({
      success: result.started,
      reason: result.reason,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Per-Spark Hermes update preview: the latest release (cached globally), the
// installed version, the actual pending commits on this Spark (HEAD..origin/main)
// and a resolved `view` so the dialog shows the commit list for minor /
// no-bump updates and the full release changelog only when a real version bump
// is pending.
app.get("/api/sparks/:id/hermes/updates", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    if (!spark.hermesMonitoring) {
      return res.status(400).json({
        error: "Hermes Agent monitoring is disabled for this Spark (enable it in Edit Spark)",
      });
    }
    const monitor = monitors.get(req.params.id);
    if (!monitor) return res.status(404).json({ error: "Spark not found" });

    const installedVersion = monitor.snapshot().hermes?.version || null;
    const pending = await monitor.hermesProbe.pendingCommits();

    let release = null;
    let releaseError = null;
    try {
      release = await getLatestRelease();
    } catch (err) {
      releaseError = err instanceof Error ? err.message : String(err);
    }

    // Resolve which content the dialog should lead with. A version bump exists
    // only when the latest tagged release is newer than what is installed;
    // otherwise the pending update is commits on main and those are the honest
    // changelog. Without both versions, fall back to the release when available.
    const hasPending = Boolean(pending && pending.commits && pending.commits.length > 0);
    const releaseNewer =
      release?.semver && installedVersion && compareSemver(release.semver, installedVersion) > 0;
    const view = releaseNewer ? "release" : hasPending ? "commits" : "release";

    res.json({
      success: true,
      view,
      release,
      releaseError,
      installedVersion,
      pending,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save / update SSH password only (works while host is offline)
app.put("/api/sparks/:id/password", (req, res) => {
  try {
    const password = req.body?.password ?? req.body?.ssh?.password;
    if (password == null || password === "") {
      return res.status(400).json({ error: "password is required" });
    }
    const spark = registry.setPassword(req.params.id, password);
    // Refresh monitor with password in memory (no need if already running — updateConfig)
    const mon = monitors.get(req.params.id);
    if (mon) mon.updateConfig(registry.getSpark(req.params.id));
    res.json({ success: true, spark, hasPassword: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update disabled storage devices for a Spark (hot — no monitor restart)
app.put("/api/sparks/:id/disabled-devices", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const { disabledDevices } = req.body;
    if (!Array.isArray(disabledDevices)) {
      return res.status(400).json({ error: "disabledDevices must be an array" });
    }

    const updated = registry.updateSpark(req.params.id, { disabledDevices });
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(updated);
    } else {
      startMonitor(updated);
    }
    res.json({ success: true, disabledDevices });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update disabled network interfaces for a Spark (hot — no monitor restart)
app.put("/api/sparks/:id/disabled-interfaces", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const { disabledInterfaces } = req.body;
    if (!Array.isArray(disabledInterfaces)) {
      return res.status(400).json({ error: "disabledInterfaces must be an array" });
    }

    const cleaned = disabledInterfaces.filter((n) => typeof n === "string" && n.length > 0);
    const updated = registry.updateSpark(req.params.id, { disabledInterfaces: cleaned });
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(updated);
    } else {
      startMonitor(updated);
    }
    res.json({ success: true, disabledInterfaces: cleaned });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update LLM probe ports for a Spark (hot — no monitor restart)
app.put("/api/sparks/:id/llm-ports", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const raw = req.body?.llmPorts;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: "llmPorts must be an array" });
    }
    const ports = raw
      .map((v) => (typeof v === "string" ? parseInt(v, 10) : Number(v)))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
    // Deduplicate
    const unique = [...new Set(ports)];
    if (unique.length === 0) {
      return res.status(400).json({ error: "llmPorts must contain at least one valid port 1–65535" });
    }

    const prevPorts = Array.isArray(spark.llmPorts) ? [...spark.llmPorts] : [];
    const updated = registry.updateSpark(req.params.id, { llmPorts: unique });
    registry.syncLlmApiKeysToPorts(req.params.id, prevPorts, unique);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      llmPorts: updated.llmPorts,
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Backward-compat: update single LLM port (delegates to llm-ports)
app.put("/api/sparks/:id/llm-port", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const raw = req.body?.llmPort;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return res.status(400).json({ error: "llmPort must be an integer 1–65535" });
    }

    const prevPorts = Array.isArray(spark.llmPorts) ? [...spark.llmPorts] : [];
    // Replace the ports list with just this single port
    const updated = registry.updateSpark(req.params.id, { llmPorts: [n] });
    registry.syncLlmApiKeysToPorts(req.params.id, prevPorts, [n]);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      llmPort: n,
      llmPorts: updated.llmPorts,
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Add a single LLM port to a Spark (hot — no monitor restart)
app.post("/api/sparks/:id/llm-ports", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const raw = req.body?.port;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return res.status(400).json({ error: "port must be an integer 1–65535" });
    }

    const currentPorts = spark.llmPorts || [];
    if (currentPorts.includes(n)) {
      return res.json({ success: true, llmPorts: currentPorts });
    }

    const updated = registry.updateSpark(req.params.id, { llmPorts: [...currentPorts, n] });
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(updated);
    } else {
      startMonitor(updated);
    }
    res.json({ success: true, llmPorts: updated.llmPorts });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove an LLM port from a Spark (hot — no monitor restart)
app.delete("/api/sparks/:id/llm-ports/:port", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const port = parseInt(req.params.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: "port must be an integer 1–65535" });
    }

    const currentPorts = spark.llmPorts || [];
    // Primary (first) port cannot be removed — only additional ports
    if (currentPorts[0] === port) {
      return res.status(400).json({ error: "Cannot remove the primary LLM port" });
    }
    const newPorts = currentPorts.filter((p) => p !== port);
    if (newPorts.length === 0) {
      return res.status(400).json({ error: "Cannot remove the last LLM port" });
    }
    if (newPorts.length === currentPorts.length) {
      return res.json({ success: true, llmPorts: currentPorts });
    }

    const updated = registry.updateSpark(req.params.id, { llmPorts: newPorts });
    registry.clearLlmApiKey(req.params.id, port);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      llmPorts: updated.llmPorts,
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Set / clear optional LLM API key for one port (encrypted secrets store)
app.put("/api/sparks/:id/llm-ports/:port/api-key", (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    const port = parseInt(req.params.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: "port must be an integer 1–65535" });
    }

    if (!Object.prototype.hasOwnProperty.call(req.body || {}, "apiKey")) {
      return res.status(400).json({ error: "apiKey is required (use \"\" to clear)" });
    }

    const apiKey = req.body.apiKey == null ? "" : String(req.body.apiKey);
    const publicSpark = registry.setLlmApiKey(req.params.id, port, apiKey);
    const withSecrets = registry.getSpark(req.params.id);
    const monitor = monitors.get(req.params.id);
    if (monitor) {
      monitor.updateConfig(withSecrets);
    } else {
      startMonitor(withSecrets);
    }
    res.json({
      success: true,
      spark: publicSpark,
      hasApiKey: registry.hasLlmApiKey(req.params.id, port),
      llmApiKeyPorts: registry.llmApiKeyPorts(req.params.id),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Daily decode / prefill tok/s rollups (busy samples, last 14 UTC days by default).
 * Query: port (required for multi-port), days (1–30).
 */
app.get("/api/sparks/:id/llm/daily", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const ports =
    Array.isArray(spark.llmPorts) && spark.llmPorts.length
      ? spark.llmPorts
      : [resolveLlmPort(spark)];
  let port = req.query.port != null ? Number(req.query.port) : ports[0];
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: "Invalid port" });
  }
  let days = req.query.days != null ? Number(req.query.days) : 14;
  if (!Number.isFinite(days)) days = 14;
  res.json(llmDaily.getSeries(spark.id, port, { days }));
});

/**
 * Decode throughput benchmark (streaming, post-first-token tok/s).
 *
 * POST body: { port?, concurrencies: number[], maxTokens?, promptType?, protocol?, parts? }
 * promptType is structured | prose | code | json (default structured).
 * protocol "aeon-perf-v1" runs AEON's ladder (BENCH3): `concurrencies` is a
 * subset of 1/4/8/16/32 (default all), maxTokens is fixed at 256.
 * protocol "hasso-battery-v1" runs Hasso's bench.sh + bench-matrix.sh
 * battery (BENCH4): `parts` ⊆ ["bench", "matrix"] (default both), no
 * concurrencies or maxTokens.
 * Returns immediately with a bench job; poll GET for progress/results.
 */
app.post("/api/sparks/:id/llm/bench", async (req, res) => {
  if (activeBenchJobCount() >= MAX_ACTIVE_BENCH_JOBS) {
    return res.status(429).json({ error: "Global active benchmark cap reached; wait for a job to finish" });
  }
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(400).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(400).json({ error: "LLM monitoring is disabled for this Spark" });
  }
  if (showcaseManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A prompt showcase is already running for this Spark" });
  }
  if (fleetShowcaseManager.busySparkIds().has(spark.id)) {
    return res.status(409).json({ error: "A fleet prompt showcase is running on this Spark" });
  }
  if (prefillBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A prefill benchmark is already running for this Spark" });
  }
  if (qualityBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A quality benchmark is already running for this Spark" });
  }

  const monitor = monitors.get(req.params.id);
  const ports = Array.isArray(spark.llmPorts) && spark.llmPorts.length
    ? spark.llmPorts
    : [resolveLlmPort(spark)];

  let target;
  try {
    target = await benchHttpTarget(spark, ports, req.body || {});
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const port = target.port;
  try {
    validateDecodeBudget(...decodeBudgetArgs(req.body));
  } catch (err) {
    return res.status(err.status || 429).json({ error: err.message });
  }

  // Resolve model id for this port from live snapshot when possible
  let modelId = req.body?.modelId || null;
  if (!modelId && !target.custom && monitor) {
    const snap = monitor.snapshot();
    const llmList = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
    const portIndex = ports.indexOf(port);
    const llm =
      (portIndex >= 0 ? llmList[portIndex] : null) ||
      llmList.find((m) => m?.available) ||
      llmList[0];
    modelId = llm?.modelId || null;
  }

  try {
    if (!consumeBenchStartQuota(req, res)) return;
    const benchDebug = Boolean(getSettings().benchDebugTraces);
    const job = decodeBenchManager.start({
      sparkId: spark.id,
      lanIp: llmProbeHost(spark),
      port,
      modelId,
      concurrencies: req.body?.concurrencies,
      maxTokens: req.body?.maxTokens,
      promptType: req.body?.promptType,
      protocol: req.body?.protocol,
      parts: req.body?.parts,
      debug: benchDebug,
      apiKey: target.apiKey,
      host: target.host,
      tls: target.tls,
      resolveTarget: target.resolveTarget,
      sampleHardware:
        benchDebug && monitor && !target.custom
          ? async () => {
              const fromGpu = (gpu, um) =>
                gpu
                  ? {
                      gpuUsage: gpu.usage ?? null,
                      temperature: gpu.temperature ?? null,
                      powerDraw: gpu.power?.draw ?? null,
                      powerLimit: gpu.power?.limit ?? null,
                      vramUsed: gpu.vram?.used ?? null,
                      vramTotal: gpu.vram?.total ?? null,
                      vramAvailable: gpu.vram?.available ?? null,
                      memAvailable: um?.available ?? null,
                    }
                  : null;

              // Local: fresh collect so the timeline isn't stuck on the 2s poll cache.
              // Remote: use snapshot only — SSH collectGpu every 1s is too heavy mid-bench.
              if (spark.isLocal) {
                try {
                  const [gpu, um] = await Promise.all([
                    monitor.collector.collectGpu(),
                    monitor.collector.collectUnifiedMemory(),
                  ]);
                  return fromGpu(gpu, um);
                } catch {
                  /* fall through */
                }
              }
              const snap = monitor.snapshot();
              return fromGpu(snap?.metrics?.gpu, snap?.metrics?.unifiedMemory);
            }
          : null,
    });
    benchResultsRecorder.noteStart("DecodeBench", job.benchId, benchProvenance(spark, monitor, port, ports, target.custom));
    res.status(202).json(job);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

app.get("/api/sparks/:id/llm/bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const active = decodeBenchManager.getActive(spark.id);
  const history = decodeBenchManager.getHistory(spark.id);
  const portRaw = req.query.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  const last = decodeBenchManager.getLast(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({
    active,
    last,
    history,
    defaults: DECODE_BENCH_DEFAULTS,
  });
});

/** Clear finished bench history for a Spark (optional ?port=). Does not cancel a running job. */
app.delete("/api/sparks/:id/llm/bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (decodeBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "Cannot clear history while a benchmark is running" });
  }
  const portRaw = req.query.port ?? req.body?.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  decodeBenchManager.clearHistory(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({ success: true });
});

app.get("/api/sparks/:id/llm/bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = decodeBenchManager.getJob(req.params.benchId);
  if (!job || job.sparkId !== spark.id) {
    return res.status(404).json({ error: "Benchmark not found" });
  }
  res.json(job); // already public shape from manager
});

app.delete("/api/sparks/:id/llm/bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = decodeBenchManager.cancel(spark.id, req.params.benchId);
  if (!job) return res.status(404).json({ error: "Benchmark not found" });
  res.json(job);
});

// ─── Agent-node decode bench (BENCH3) ────────────────────────────────────
// Same DecodeBench (herd, AEON aeon-perf-v1 or Hasso battery v1 protocol) against an LLM lane
// the node agent reports, reached at <node lanIp>:<lane port>.

function nodeBenchContext(req, res) {
  const rec = getNode(req.params.id);
  if (!rec) {
    res.status(404).json({ error: "Node not found" });
    return null;
  }
  return { rec, key: nodeBenchKey(rec.id), snapshot: fleetConnection ? fleetConnection.getSnapshot(rec.id) : null };
}

app.post("/api/fleet/nodes/:id/llm/bench", async (req, res) => {
  if (activeBenchJobCount() >= MAX_ACTIVE_BENCH_JOBS) {
    return res.status(429).json({ error: "Global active benchmark cap reached; wait for a job to finish" });
  }
  const ctx = nodeBenchContext(req, res);
  if (!ctx) return;
  const body = req.body || {};
  let target;
  try {
    target = resolveNodeBenchTarget(ctx.rec, ctx.snapshot, body);
    await assertAllowedTarget(target.host, new Set([target.host]));
    validateDecodeBudget(...decodeBudgetArgs(body));
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  try {
    if (!consumeBenchStartQuota(req, res)) return;
    const job = decodeBenchManager.start({
      sparkId: ctx.key,
      nodeId: ctx.rec.id,
      lanIp: target.host,
      host: target.host,
      port: target.port,
      modelId: target.modelId,
      concurrencies: body.concurrencies,
      maxTokens: body.maxTokens,
      promptType: body.promptType,
      protocol: body.protocol,
      parts: body.parts,
    });
    let prov = null;
    try {
      prov = describeNodeProvenance(ctx.rec, ctx.snapshot, target);
    } catch {
      prov = null;
    }
    benchResultsRecorder.noteStart("DecodeBench", job.benchId, prov);
    res.status(202).json(job);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/fleet/nodes/:id/llm/bench", (req, res) => {
  const ctx = nodeBenchContext(req, res);
  if (!ctx) return;
  const port = req.query.port != null && req.query.port !== "" ? parseInt(String(req.query.port), 10) : null;
  res.json({
    active: decodeBenchManager.getActive(ctx.key),
    last: decodeBenchManager.getLast(ctx.key, Number.isInteger(port) ? port : null),
    history: decodeBenchManager.getHistory(ctx.key),
    defaults: DECODE_BENCH_DEFAULTS,
    endpoints: nodeLlmEndpoints(ctx.snapshot),
  });
});

app.delete("/api/fleet/nodes/:id/llm/bench", (req, res) => {
  const ctx = nodeBenchContext(req, res);
  if (!ctx) return;
  if (decodeBenchManager.getActive(ctx.key)) {
    return res.status(409).json({ error: "Cannot clear history while a benchmark is running" });
  }
  const portRaw = req.query.port ?? req.body?.port;
  const port = portRaw != null && portRaw !== "" ? parseInt(String(portRaw), 10) : null;
  decodeBenchManager.clearHistory(ctx.key, Number.isInteger(port) ? port : null);
  res.json({ success: true });
});

app.get("/api/fleet/nodes/:id/llm/bench/:benchId", (req, res) => {
  const ctx = nodeBenchContext(req, res);
  if (!ctx) return;
  const job = decodeBenchManager.getJob(req.params.benchId);
  if (!job || job.sparkId !== ctx.key) return res.status(404).json({ error: "Benchmark not found" });
  res.json(job);
});

app.delete("/api/fleet/nodes/:id/llm/bench/:benchId", (req, res) => {
  const ctx = nodeBenchContext(req, res);
  if (!ctx) return;
  const job = decodeBenchManager.cancel(ctx.key, req.params.benchId);
  if (!job) return res.status(404).json({ error: "Benchmark not found" });
  res.json(job);
});

/**
 * Prefill throughput + TTFT at selected context sizes (up to 300k).
 *
 * POST body: { port?, contextSizes: number[] }
 * Returns 202 job; poll GET for progress/results.
 */
app.post("/api/sparks/:id/llm/prefill-bench", async (req, res) => {
  if (activeBenchJobCount() >= MAX_ACTIVE_BENCH_JOBS) {
    return res.status(429).json({ error: "Global active benchmark cap reached; wait for a job to finish" });
  }
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(400).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(400).json({ error: "LLM monitoring is disabled for this Spark" });
  }
  if (showcaseManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A prompt showcase is already running for this Spark" });
  }
  if (fleetShowcaseManager.busySparkIds().has(spark.id)) {
    return res.status(409).json({ error: "A fleet prompt showcase is running on this Spark" });
  }
  if (decodeBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A decode benchmark is already running for this Spark" });
  }
  if (qualityBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A quality benchmark is already running for this Spark" });
  }

  const monitor = monitors.get(req.params.id);
  const ports = Array.isArray(spark.llmPorts) && spark.llmPorts.length
    ? spark.llmPorts
    : [resolveLlmPort(spark)];

  let target;
  try {
    target = await benchHttpTarget(spark, ports, req.body || {});
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const port = target.port;
  try {
    validatePrefillBudget(normalizeContextSizes(req.body?.contextSizes));
  } catch (err) {
    return res.status(err.status || 429).json({ error: err.message });
  }

  let modelId = req.body?.modelId || null;
  if (!modelId && !target.custom && monitor) {
    const snap = monitor.snapshot();
    const llmList = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
    const portIndex = ports.indexOf(port);
    const llm =
      (portIndex >= 0 ? llmList[portIndex] : null) ||
      llmList.find((m) => m?.available) ||
      llmList[0];
    modelId = llm?.modelId || null;
  }

  try {
    if (!consumeBenchStartQuota(req, res)) return;
    const job = prefillBenchManager.start({
      sparkId: spark.id,
      lanIp: llmProbeHost(spark),
      port,
      modelId,
      contextSizes: req.body?.contextSizes,
      apiKey: target.apiKey,
      host: target.host,
      tls: target.tls,
      resolveTarget: target.resolveTarget,
    });
    benchResultsRecorder.noteStart("PrefillBench", job.benchId, benchProvenance(spark, monitor, port, ports, target.custom));
    res.status(202).json(job);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

app.get("/api/sparks/:id/llm/prefill-bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const active = prefillBenchManager.getActive(spark.id);
  const history = prefillBenchManager.getHistory(spark.id);
  const portRaw = req.query.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  const last = prefillBenchManager.getLast(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({
    active,
    last,
    history,
    defaults: PREFILL_BENCH_DEFAULTS,
  });
});

app.delete("/api/sparks/:id/llm/prefill-bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (prefillBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "Cannot clear history while a benchmark is running" });
  }
  const portRaw = req.query.port ?? req.body?.port;
  const port =
    portRaw != null && portRaw !== ""
      ? parseInt(String(portRaw), 10)
      : null;
  prefillBenchManager.clearHistory(
    spark.id,
    Number.isInteger(port) ? port : null
  );
  res.json({ success: true });
});

app.get("/api/sparks/:id/llm/prefill-bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = prefillBenchManager.getJob(req.params.benchId);
  if (!job || job.sparkId !== spark.id) {
    return res.status(404).json({ error: "Benchmark not found" });
  }
  res.json(job);
});

app.delete("/api/sparks/:id/llm/prefill-bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = prefillBenchManager.cancel(spark.id, req.params.benchId);
  if (!job) return res.status(404).json({ error: "Benchmark not found" });
  res.json(job);
});

/**
 * LLM quality bench (#42) — accuracy over fixed item sets, McNemar between runs.
 *
 * POST body: { port?, host?, tls?, apiKey?, modelId?, categories?: string[], concurrency?: 1|2|4|8 }
 * Returns 202 job; poll GET /:benchId for progress. Finished runs live in the
 * bench results store (per-category + overall records with per-item vectors).
 */
app.post("/api/sparks/:id/llm/quality-bench", async (req, res) => {
  if (activeBenchJobCount() >= MAX_ACTIVE_BENCH_JOBS) {
    return res.status(429).json({ error: "Global active benchmark cap reached; wait for a job to finish" });
  }
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(400).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(400).json({ error: "LLM monitoring is disabled for this Spark" });
  }
  if (showcaseManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A prompt showcase is already running for this Spark" });
  }
  if (decodeBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A decode benchmark is already running for this Spark" });
  }
  if (prefillBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A prefill benchmark is already running for this Spark" });
  }

  const monitor = monitors.get(req.params.id);
  const ports = Array.isArray(spark.llmPorts) && spark.llmPorts.length
    ? spark.llmPorts
    : [resolveLlmPort(spark)];

  let target;
  try {
    target = await benchHttpTarget(spark, ports, req.body || {});
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const port = target.port;

  let modelId = req.body?.modelId || null;
  if (!modelId && !target.custom && monitor) {
    const snap = monitor.snapshot();
    const llmList = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
    const portIndex = ports.indexOf(port);
    const llm =
      (portIndex >= 0 ? llmList[portIndex] : null) ||
      llmList.find((m) => m?.available) ||
      llmList[0];
    modelId = llm?.modelId || null;
  }

  try {
    if (!consumeBenchStartQuota(req, res)) return;
    const job = qualityBenchManager.start({
      sparkId: spark.id,
      lanIp: llmProbeHost(spark),
      port,
      modelId,
      categories: req.body?.categories,
      concurrency: req.body?.concurrency,
      apiKey: target.apiKey,
      host: target.host,
      tls: target.tls,
      resolveTarget: target.resolveTarget,
    });
    benchResultsRecorder.noteStart("QualityBench", job.benchId, benchProvenance(spark, monitor, port, ports, target.custom));
    res.status(202).json(job);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/sparks/:id/llm/quality-bench", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  res.json({
    active: qualityBenchManager.getActive(spark.id),
    runs: qualityBenchManager.history(spark.id),
    defaults: QUALITY_BENCH_DEFAULTS,
  });
});

app.get("/api/sparks/:id/llm/quality-bench/compare", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const baseline = typeof req.query.baseline === "string" ? req.query.baseline : "";
  const candidate = typeof req.query.candidate === "string" ? req.query.candidate : "";
  if (!baseline || !candidate) return res.status(400).json({ error: "baseline and candidate are required" });
  try {
    res.json(qualityBenchManager.compare(spark.id, baseline, candidate));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/sparks/:id/llm/quality-bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = qualityBenchManager.getJob(req.params.benchId);
  if (!job || job.sparkId !== spark.id) {
    return res.status(404).json({ error: "Benchmark not found" });
  }
  res.json(job);
});

app.delete("/api/sparks/:id/llm/quality-bench/:benchId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  const job = qualityBenchManager.cancel(spark.id, req.params.benchId);
  if (!job) return res.status(404).json({ error: "Benchmark not found" });
  res.json(job);
});

/**
 * LLM Prompt Showcase — concurrent streaming demos.
 *
 * POST body: { port, modelId?, maxTokens?, temperature?, thinking?, promptType?, prompts: string[] }
 * Returns 202 { sessionId }; poll GET for deltas; DELETE :sessionId to cancel.
 * Finished runs are archived; GET collection lists history; DELETE collection clears it.
 */
app.post("/api/sparks/:id/llm/showcase", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }
  if (qualityBenchManager.getActive(spark.id)) {
    return res.status(409).json({ error: "A quality benchmark is already running for this Spark" });
  }

  const monitor = monitors.get(req.params.id);
  const ports = Array.isArray(spark.llmPorts) && spark.llmPorts.length
    ? spark.llmPorts
    : [resolveLlmPort(spark)];

  if (req.body?.port == null) {
    return res.status(400).json({ error: "port is required" });
  }
  const port = Number(req.body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: "Invalid port" });
  }
  if (!ports.includes(port)) {
    return res.status(400).json({ error: "port is not configured for this Spark" });
  }
  if (fleetShowcaseManager.busySparkIds().has(spark.id)) {
    return res.status(409).json({ error: "A fleet prompt showcase is running on this Spark" });
  }

  let modelId = req.body?.modelId || null;
  if (!modelId && monitor) {
    const snap = monitor.snapshot();
    const llmList = Array.isArray(snap?.metrics?.llm) ? snap.metrics.llm : [];
    const portIndex = ports.indexOf(port);
    const llm =
      (portIndex >= 0 ? llmList[portIndex] : null) ||
      llmList.find((m) => m?.available) ||
      llmList[0];
    modelId = llm?.modelId || null;
  }

  try {
    const result = showcaseManager.start({
      sparkId: spark.id,
      lanIp: llmProbeHost(spark),
      port,
      modelId,
      maxTokens: req.body?.maxTokens,
      temperature: req.body?.temperature,
      thinking: req.body?.thinking,
      promptType: req.body?.promptType,
      prompts: req.body?.prompts,
      apiKey: resolveLlmApiKey(spark, port),
    });
    benchResultsRecorder.noteStart("Showcase", result.sessionId, benchProvenance(spark, monitor, port, ports));
    res.status(202).json(result);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

/** Active session + finished history summaries (no stream bodies). */
app.get("/api/sparks/:id/llm/showcase", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  res.json({
    active: showcaseManager.getActive(spark.id),
    history: showcaseManager.getHistory(spark.id),
  });
});

/** Clear finished showcase history for a Spark. Does not cancel a running session. */
app.delete("/api/sparks/:id/llm/showcase", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }
  if (showcaseManager.getActive(spark.id)) {
    return res.status(409).json({ error: "Cannot clear history while a showcase is running" });
  }
  showcaseManager.clearHistory(spark.id);
  res.json({ success: true });
});

app.get("/api/sparks/:id/llm/showcase/:sessionId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  const sinceRaw = req.query.since;
  const since =
    sinceRaw != null && sinceRaw !== ""
      ? parseInt(String(sinceRaw), 10)
      : null;
  const session = showcaseManager.getSession(
    spark.id,
    req.params.sessionId,
    Number.isInteger(since) ? since : null
  );
  if (!session) return res.status(404).json({ error: "Showcase session not found" });
  res.json(session);
});

app.delete("/api/sparks/:id/llm/showcase/:sessionId", (req, res) => {
  const spark = registry.getSpark(req.params.id);
  if (!spark) return res.status(404).json({ error: "Spark not found" });
  if (spark.workerNode) {
    return res.status(403).json({ error: "Worker nodes do not expose a local LLM API" });
  }
  if (spark.llmMonitoring === false) {
    return res.status(403).json({ error: "LLM monitoring is disabled for this Spark" });
  }

  const session = showcaseManager.cancel(spark.id, req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Showcase session not found" });
  res.json(session);
});

// ─── Power management ────────────────────────────────────
// Shutdown uses host script: sudo -n /usr/local/bin/spark-shutdown (passwordless).
// These routes are unauthenticated like the rest of the LAN dashboard — do not
// expose port 5555 beyond a trusted network.

const SHUTDOWN_BIN = "/usr/local/bin/spark-shutdown";
/**
 * Remote: verify script + passwordless sudo, then background shutdown so SSH
 * returns before the host dies. Failures before backgrounding surface to the UI.
 */
const SHUTDOWN_REMOTE_CMD = [
  `test -x ${SHUTDOWN_BIN} || { echo "missing ${SHUTDOWN_BIN}" >&2; exit 127; }`,
  `sudo -n true || { echo "sudo -n required for ${SHUTDOWN_BIN}" >&2; exit 126; }`,
  `nohup sudo -n ${SHUTDOWN_BIN} >/dev/null 2>&1 &`,
  `sleep 0.3`,
  `exit 0`,
].join("; ");

function shutdownErrorStatus(msg) {
  if (/timed out|connection refused|unreachable|no route|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
    return 503;
  }
  return 500;
}

/**
 * Only treat "host dropped the SSH session mid-shutdown" as success.
 * Connect timeouts / auth / missing script must remain real errors.
 */
function isBenignShutdownSshError(msg) {
  return /ECONNRESET|Connection reset|broken pipe|Connection closed by remote|closed by remote host|Connection to .* closed/i.test(
    String(msg || "")
  );
}

/**
 * Kick off graceful shutdown. Always aims to return quickly so the browser
 * gets a real JSON response instead of "Failed to fetch" when the SSH session
 * drops as the host powers off.
 */
function initiateSparkShutdown(spark) {
  if (spark.isLocal) {
    return new Promise((resolve, reject) => {
      try {
        const child = spawn("sudo", ["-n", SHUTDOWN_BIN], {
          detached: true,
          stdio: "ignore",
        });
        child.on("error", (err) => {
          const msg = err.message || String(err);
          if (/ENOENT|not found/i.test(msg)) {
            reject(new Error(`${SHUTDOWN_BIN} not found on this host`));
          } else {
            reject(new Error(msg));
          }
        });
        child.unref();
        resolve("Shutdown initiated");
      } catch (err) {
        reject(err);
      }
    });
  }

  return sshExec(spark, SHUTDOWN_REMOTE_CMD, { timeoutMs: 8000 })
    .then(() => "Shutdown initiated")
    .catch((err) => {
      const msg = err.message || String(err);
      if (isBenignShutdownSshError(msg)) {
        return "Shutdown initiated";
      }
      throw err;
    });
}

/** Batch routes first so they never collide with /:id/* if routing changes. */
app.post("/api/sparks/shutdown-all", async (_req, res) => {
  const results = [];
  // Remotes first, local last — shutting down the dashboard host mid-loop would
  // skip remaining Sparks.
  const ordered = [
    ...registry.sparks.filter((s) => !s.isLocal),
    ...registry.sparks.filter((s) => s.isLocal),
  ];
  for (const spark of ordered) {
    const monitor = monitors.get(spark.id);
    if (!monitor?.online) {
      results.push({ id: spark.id, ok: false, skipped: true, error: "Offline — skipped" });
      continue;
    }
    try {
      // Local dashboard host: acknowledge before power-off kills this process.
      if (spark.isLocal) {
        results.push({ id: spark.id, ok: true, message: "Shutdown initiated" });
        recordEvent(activity.powerShutdown(spark));
        eventLog.flush();
        setImmediate(() => {
          void initiateSparkShutdown(spark).catch((err) => {
            console.error(`[shutdown-all] local ${spark.id}:`, err.message);
          });
        });
        continue;
      }
      await initiateSparkShutdown(spark);
      results.push({ id: spark.id, ok: true });
      recordEvent(activity.powerShutdown(spark));
    } catch (err) {
      results.push({ id: spark.id, ok: false, error: err.message || String(err) });
      recordEvent(activity.powerShutdown(spark, { ok: false, error: err.message || String(err) }));
    }
  }
  res.json({ success: true, results });
});

app.post("/api/sparks/wake-all", async (_req, res) => {
  const results = [];
  for (const spark of registry.sparks) {
    const cleanMac = effectiveMac(spark);
    if (!cleanMac) {
      results.push({
        id: spark.id,
        ok: false,
        error: "No MAC address (enP7s7 not seen yet; set override in Edit Spark)",
      });
      continue;
    }
    try {
      const broadcast = broadcastForLanIp(spark.lanIp);
      const sent = await sendWol(cleanMac, broadcast);
      results.push({ id: spark.id, ok: true, mac: sent.mac, broadcast: sent.broadcast });
      recordEvent(activity.powerWake(spark));
    } catch (err) {
      results.push({ id: spark.id, ok: false, error: err.message || String(err) });
      recordEvent(activity.powerWake(spark, { ok: false, error: err.message || String(err) }));
    }
  }
  res.json({ success: true, results });
});

app.post("/api/sparks/:id/shutdown", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    // Local: send JSON first, then power off — otherwise the process dies mid-response
    // and the UI shows "Failed to fetch".
    if (spark.isLocal) {
      recordEvent(activity.powerShutdown(spark));
      eventLog.flush();
      res.json({ success: true, message: "Shutdown initiated" });
      setImmediate(() => {
        void initiateSparkShutdown(spark).catch((err) => {
          console.error(`[shutdown] local ${spark.id}:`, err.message);
        });
      });
      return;
    }

    try {
      const message = await initiateSparkShutdown(spark);
      recordEvent(activity.powerShutdown(spark));
      res.json({ success: true, message, output: message });
    } catch (err) {
      const msg = err.message || String(err);
      recordEvent(activity.powerShutdown(spark, { ok: false, error: msg }));
      res.status(shutdownErrorStatus(msg)).json({
        error: shutdownErrorStatus(msg) === 503 ? `Spark unreachable: ${msg}` : msg,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sparks/:id/wake", async (req, res) => {
  try {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });

    // Body mac > user override > auto-detected enP7s7
    const cleanMac = normalizeMac(req.body?.mac) || effectiveMac(spark);
    if (!cleanMac) {
      if (req.body?.mac || spark.macAddress) {
        return res.status(400).json({
          error: `Invalid MAC address: ${req.body?.mac || spark.macAddress}`,
        });
      }
      return res.status(400).json({
        error:
          "No MAC address yet. Wait until the node is online so enP7s7 can be detected, or set a MAC override in Edit Spark.",
      });
    }

    const broadcast = broadcastForLanIp(spark.lanIp);
    try {
      const sent = await sendWol(cleanMac, broadcast);
      recordEvent(activity.powerWake(spark));
      res.json({
        success: true,
        message: `Magic packet sent to ${sent.mac} via ${sent.broadcast}`,
        mac: sent.mac,
        broadcast: sent.broadcast,
      });
    } catch (err) {
      recordEvent(activity.powerWake(spark, { ok: false, error: err.message || String(err) }));
      res.status(500).json({ error: `WoL send failed: ${err.message || String(err)}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Activity (issue #32) ─────────────────────────────────
registerEventRoutes(app, { eventLog });

/**
 * Per-node state the activity watcher diffs: online, enrollment, containers
 * and services, keyed on the registry id. Lighter than buildFleetSnapshot()
 * (no topology, request or memory aggregation).
 */
function fleetNodeStates() {
  return listNodes().map((rec) => {
    const snap =
      fleetConnection.getSnapshot(rec.id) ??
      sshFleet.getSnapshot(rec.id) ??
      macosSshFleet.getSnapshot(rec.id) ??
      windowsFleet.getSnapshot(rec.id) ??
      null;
    return {
      nodeId: rec.id,
      nodeName: snap?.nodeName || rec.name,
      online:
        fleetConnection.isOnline(rec.id) ||
        sshFleet.isOnline(rec.id) ||
        macosSshFleet.isOnline(rec.id) ||
        windowsFleet.isOnline(rec.id),
      enrollment: rec.status === "pending" ? "pending" : "claimed",
      containers: Array.isArray(snap?.containers) ? snap.containers : [],
      services: Array.isArray(snap?.services) ? snap.services : [],
    };
  });
}

const activityWatcher = createActivityWatcher({
  getSparks: orderedSnapshots,
  getNodes: fleetNodeStates,
  record: recordEvent,
  warmupMs: 30_000,
});

// ─── Static files (built frontend) ───────────────────────
const distDir = path.join(ROOT, "dist");
const indexHtml = path.join(distDir, "index.html");
app.use(express.static(distDir));

// ─── SPA fallback (Express v5 wildcard) ───────────────────
// Note: sendFile MUST use the root option here — with express 5.2 / send 1.2,
// a bare absolute path silently 404s even when the file exists.
app.get("*splat", (_req, res) => {
  if (!fs.existsSync(indexHtml)) {
    return res
      .status(503)
      .type("text")
      .send("Frontend not built. Run `npm run build` or use `npm run dev`.");
  }
  res.sendFile("index.html", { root: distDir });
});

// ─── WebSocket ──────────────────────────────────────────
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: ({ req }, done) => done(authorizeUpgrade(req)),
});
// Live activity push: every recorded event goes to open clients as
// {type:"event", event}; the browser merges it into the feed.
eventLog.subscribe((event) => {
  broadcastPayload(JSON.stringify({ type: "event", event }));
});

wss.on("connection", (ws) => {
  console.log("[ws] client connected");
  // This snapshot belongs only to the new client. Broadcasting it would add a
  // duplicate history sample to every existing dashboard whenever a tab opens.
  try {
    ws.send(buildSnapshotPayload());
  } catch {
    // The close handler will clean up a client that disappears during connect.
  }
  ws.on("close", () => {
    console.log("[ws] client disconnected");
  });
});

// ─── Broadcast snapshot (dynamic interval) ────────────────
let broadcastTimer = null;
let _lastBroadcastPayload = null;

/** Build the snapshot payload string. Centralized so broadcast + refresh share it. */
function buildSnapshotPayload(sparks = orderedSnapshots()) {
  const payload = {
    type: "snapshot",
    generatedAt: Date.now(),
    sparks,
    refreshInterval: getSettings().pollIntervalMs,
  };
  // The alerts block exists only while alerting is switched on; the UI falls
  // back to its own exception rows when the field is missing.
  const alertBlock = alertsRuntime.snapshotBlock();
  if (alertBlock) payload.alerts = alertBlock;
  return JSON.stringify(payload);
}

/**
 * Send a payload to every open WS client.
 * - Drops clients whose send queue is backlogged (>1 MB) to avoid unbounded
 *   buffering on slow/flaky connections (e.g. phone over spotty WiFi).
 * - Returns the payload so callers can compare against the previous broadcast.
 */
function broadcastPayload(payload) {
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return; // OPEN only
    if (client.bufferedAmount > 1_000_000) {
      try {
        client.close(1008, "client too slow");
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      client.send(payload);
    } catch {
      /* per-client send failure — ignore, close handler will clean up */
    }
  });
}

/**
 * Force an immediate broadcast, ignoring the diff cache.
 * Used after a user action (manual refresh / hermes check / update) so the
 * UI reflects the result right away instead of on the next poll tick.
 */
function forceBroadcast() {
  const payload = buildSnapshotPayload();
  _lastBroadcastPayload = payload;
  broadcastPayload(payload);
}

function startBroadcast() {
  const interval = getSettings().pollIntervalMs;
  broadcastTimer = setInterval(() => {
    const sparks = orderedSnapshots();
    // Run the alert rules on this tick's fleet first, so the payload built
    // next already reflects what they decided.
    alertsRuntime.tick(sparks);
    const payload = buildSnapshotPayload(sparks);
    // Skip the broadcast entirely when nothing changed since the last tick.
    // A 1s poll that produces identical snapshots becomes free for idle tabs.
    if (_lastBroadcastPayload !== null && payload === _lastBroadcastPayload) return;
    _lastBroadcastPayload = payload;
    broadcastPayload(payload);
  }, interval);
}

function restartBroadcast() {
  if (broadcastTimer) {
    clearInterval(broadcastTimer);
    broadcastTimer = null;
  }
  _lastBroadcastPayload = null; // force a fresh broadcast on the new cadence
  startBroadcast();
}

// ─── Start ───────────────────────────────────────────────
loadSettings();
const startupPreflight = inspectStartupPreflight(BIND_HOST);
logStartupPreflight(startupPreflight, BIND_HOST, PORT);

if (!startupPreflight.fatal) {
  startBroadcast();
  server.listen(PORT, BIND_HOST, () => {
    console.log(`[sparkDash] server listening on http://${BIND_HOST}:${PORT}`);
    console.log(`[sparkDash] WebSocket endpoint ws://${BIND_HOST}:${PORT}/ws`);
    const remote = requireRemoteAuth(BIND_HOST);
    const tokenConfigured = Boolean(configuredToken());
    console.log(`[sparkDash] bind=${BIND_HOST} auth=${tokenConfigured ? "bearer" : remote ? "required-missing" : "loopback-open"}`);
    if (remote && !tokenConfigured) {
      console.warn("[sparkDash] WARNING: remote bind without SPARKDASH_TOKEN — mutations and telemetry will fail closed until a token is set.");
    }
    startAllMonitors();
    alertsRuntime.start();
    fleetEnergyRuntime.start();
    llmTokenRuntime.start();
    activityWatcher.start();
    void fleetConnection
      .start()
      .catch((err) => console.error("[fleet] initial poll failed:", err.message));
    sshFleet.start();
    macosSshFleet.start();
    windowsFleet.start();
  });
} else {
  process.exitCode = 1;
}

// ─── Graceful shutdown ─────────────────────────────────
let _shuttingDown = false;
async function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[sparkDash] ${signal} received, shutting down…`);
  try {
    // Finalize in-flight benches before the process dies so clients polling
    // GET /llm/bench/:id do not hit "Benchmark not found" after --watch reload.
    decodeBenchManager.interruptAll(
      "Interrupted — server restarted while the benchmark was running"
    );
    prefillBenchManager.interruptAll(
      "Interrupted — server restarted while the benchmark was running"
    );
    qualityBenchManager.interruptAll(
      "Interrupted — server restarted while the benchmark was running"
    );
  } catch (err) {
    console.error("[sparkDash] failed to finalize benchmarks:", err.message);
  }
  try {
    llmDaily.flush();
  } catch (err) {
    console.error("[sparkDash] failed to flush LLM daily history:", err.message);
  }
  const energyPersistenceSucceeded = fleetEnergyRuntime.stop();
  llmTokenRuntime.stop();
  fleetShowcaseManager.stop();
  activityWatcher.stop();
  eventLog.flush();
  try {
    unitHistoryRuntime.stop();
  } catch (err) {
    console.error("[sparkDash] failed to flush unit history:", err.message);
  }
  const streamAgentClosedGracefully = await closeLlmStreamAgent();
  if (!streamAgentClosedGracefully) {
    console.warn("[sparkDash] LLM dispatcher close timed out; destroyed open sockets");
  }
  try {
    if (broadcastTimer) {
      clearInterval(broadcastTimer);
      broadcastTimer = null;
    }
    for (const m of monitors.values()) m.stop();
    monitors.clear();
  } catch (err) {
    console.error("[sparkDash] error during shutdown:", err.message);
  }
  try {
    await fleetConnection.stop();
  } catch (err) {
    console.error("[sparkDash] fleet stop error:", err.message);
  }
  try {
    await sshFleet.stop();
  } catch (err) {
    console.error("[sparkDash] ssh fleet stop error:", err.message);
  }
  try {
    await macosSshFleet.stop();
  } catch (err) {
    console.error("[sparkDash] macos ssh fleet stop error:", err.message);
  }
  try {
    await windowsFleet.stop();
  } catch (err) {
    console.error("[sparkDash] windows ssh fleet stop error:", err.message);
  }
  // Tell WS clients the server is going away, then close the server.
  try {
    wss.clients.forEach((c) => {
      try {
        c.close(1001, "server shutting down");
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
  wss.close();
  server.close(() => process.exit(energyPersistenceSucceeded ? 0 : 1));
  // Safety net: if server.close hangs (lingering keep-alive), force-exit.
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { app, server, wss };
