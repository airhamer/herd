import fs from "fs";
import path from "path";
import {
  SystemCollector,
  collectionWasSuccessful,
} from "../collectors/SystemCollector.js";
import { LlmProbe, normalizeModelId } from "../collectors/LlmProbe.js";
import { llmProbeHost } from "../collectors/llmHost.js";
import { ComfyProbe } from "../collectors/ComfyProbe.js";
import { HermesProbe } from "../collectors/HermesProbe.js";
import { TailscaleProbe } from "../collectors/TailscaleProbe.js";
import { llmDaily } from "../collectors/LlmDaily.js";
import { HealthEvaluator } from "../health/HealthEvaluator.js";
import { sshExec } from "../collectors/ssh.js";
import {
  POLL_INTERVAL_GPU,
  POLL_INTERVAL_CPU,
  POLL_INTERVAL_NETWORK,
  POLL_INTERVAL_STORAGE,
  POLL_INTERVAL_LLM,
  POLL_INTERVAL_COMFY,
  POLL_INTERVAL_BANDWIDTH,
  POLL_INTERVAL_LIVENESS,
  POLL_INTERVAL_HERMES,
  POLL_INTERVAL_TAILSCALE,
  LLM_PORT,
  COMFY_PORT,
  HOST_PATHS,
} from "../config.js";

const ONLINE_GRACE_MS = 10000;

// ─── Issue #93: service status probe truth ───────────────────
/** Active window: a nonzero request counter — or the last nonzero one inside
 * this window — keeps a service marked Active. */
export const SERVICE_ACTIVE_WINDOW_MS = 60_000;

/** Per-request HTTP timeout for the service probes. */
const SERVICE_PROBE_TIMEOUT_MS = 5000;

function normalizeServicePort(value) {
  const n = typeof value === "string" ? parseInt(value, 10) : Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * True when a Prometheus exposition carries a request counter with a positive
 * value (names like vllm:num_requests_running, proxy_requests_total, …).
 */
export function hasNonzeroRequestCounter(text) {
  if (typeof text !== "string" || !text) return false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([^\s{]+)(?:\{[^}]*\})?\s+(\S+)/);
    if (!m) continue;
    const value = Number(m[2]);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (/requests?[\w:]*(?:_total|_running|_waiting|_inflight)$/i.test(m[1])) return true;
  }
  return false;
}

/**
 * Resolve a proxy API-key ref. Shapes: "env:VAR" → process.env[VAR],
 * "file:/path" → file contents (trim), bare "VAR" → env var. Null when the
 * ref is empty or the referenced secret is missing/unreadable.
 */
export function resolveServiceApiKeyRef(ref, deps = {}) {
  if (typeof ref !== "string") return null;
  const s = ref.trim();
  if (!s) return null;
  const env = deps.env ?? process.env;
  const readFile =
    deps.readFile ??
    ((p) => fs.readFileSync(p, "utf8"));
  const finish = (raw) => {
    const v = raw == null ? "" : String(raw).trim();
    return v || null;
  };
  if (s.startsWith("env:")) return finish(env[s.slice(4).trim()]);
  if (s.startsWith("file:")) {
    try {
      return finish(readFile(s.slice(5).trim()));
    } catch {
      return null;
    }
  }
  return finish(env[s]);
}

/**
 * probeServiceTruth — one configured service, probe-truth status.
 *
 * Probe order: engine port → engine port + 1 → proxy (the service's own
 * proxyPort first, then any other proxy defined on the same spark via
 * opts.sparkProxies). A 2xx on an engine candidate is UP with
 * source "engine". On a proxy candidate BOTH 2xx and 401/403 are UP with
 * source "proxy" — the auth gate rejecting us still proves the process
 * behind it answers; model/version are only populated when the proxy body
 * was readable (2xx). A comfyui service probes GET /system_stats (real
 * status, not systemd state); everything else probes GET /v1/models, then
 * /version when the models body carried no version field.
 *
 * Active: any nonzero request counter on /metrics at the winning port, or a
 * previous nonzero sighting inside SERVICE_ACTIVE_WINDOW_MS (pass the prior
 * probe result as opts.previous to carry activeAt across polls).
 *
 * @param {object} service normalized per-service config {name, engine, kind,
 *   port, proxyPort, proxyApiKeyRef}
 * @param {{host?: string, fetch?: typeof globalThis.fetch, sparkProxies?:
 *   Array<{port: number, apiKeyRef?: string|null}>, previous?: {activeAt?: number|null},
 *   now?: () => number, resolveApiKeyRef?: typeof resolveServiceApiKeyRef,
 *   env?: Record<string,string|undefined>, readFile?: (p: string) => string,
 *   timeoutMs?: number}} [opts]
 * @returns {Promise<{status: "running"|"stopped", source: "engine"|"proxy"|null,
 *   port: number|null, model: string|null, engineVersion: string|null,
 *   active: boolean, activeAt: number|null, error: string|null}>}
 */
export async function probeServiceTruth(service, opts = {}) {
  const now = typeof opts.now === "function" ? opts.now() : Date.now();
  const fetchImpl = typeof opts.fetch === "function" ? opts.fetch : globalThis.fetch;
  const host = String(opts.host || service?.host || "127.0.0.1");
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : SERVICE_PROBE_TIMEOUT_MS;
  const resolveRef =
    typeof opts.resolveApiKeyRef === "function" ? opts.resolveApiKeyRef : resolveServiceApiKeyRef;
  const isComfy = /comfy/i.test(String(service?.engine || ""));
  const prevActiveAt = Number.isFinite(opts.previous?.activeAt) ? opts.previous.activeAt : null;

  const enginePort = normalizeServicePort(service?.port);
  const candidates = [];
  if (enginePort != null) {
    candidates.push({ port: enginePort, source: "engine", apiKeyRef: null });
    const alt = enginePort + 1;
    if (alt <= 65535) candidates.push({ port: alt, source: "engine", apiKeyRef: null });
  }
  const proxySeen = new Set();
  const pushProxy = (port, apiKeyRef) => {
    const p = normalizeServicePort(port);
    if (p == null || proxySeen.has(p)) return;
    proxySeen.add(p);
    candidates.push({ port: p, source: "proxy", apiKeyRef: apiKeyRef ?? null });
  };
  pushProxy(service?.proxyPort, service?.proxyApiKeyRef);
  for (const other of Array.isArray(opts.sparkProxies) ? opts.sparkProxies : []) {
    pushProxy(other?.port, other?.apiKeyRef ?? other?.proxyApiKeyRef);
  }

  const get = async (port, path, apiKey) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    timer.unref?.();
    try {
      const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
      return await fetchImpl(`http://${host}:${port}${path}`, { headers, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  const readJson = async (res) => {
    try {
      return await res.json();
    } catch {
      return null;
    }
  };

  for (const cand of candidates) {
    const apiKey = cand.source === "proxy" ? resolveRef(cand.apiKeyRef, opts) : null;
    try {
      const probePath = isComfy ? "/system_stats" : "/v1/models";
      const res = await get(cand.port, probePath, apiKey);
      const isAuthGate = cand.source === "proxy" && (res.status === 401 || res.status === 403);
      if (!res.ok && !isAuthGate) continue;

      let model = null;
      let engineVersion = null;
      if (!isAuthGate) {
        const body = await readJson(res);
        if (isComfy) {
          engineVersion =
            body?.system?.comfyui_version ?? body?.comfyui_version ?? body?.version ?? null;
        } else {
          model = normalizeModelId(body?.data?.[0]?.id ?? null);
          engineVersion = body?.version ?? body?.data?.[0]?.version ?? null;
          if (engineVersion == null) {
            try {
              const vRes = await get(cand.port, "/version", apiKey);
              if (vRes?.ok) {
                const vBody = await readJson(vRes);
                engineVersion = typeof vBody?.version === "string" ? vBody.version : null;
              }
            } catch {
              /* version optional */
            }
          }
        }
      }

      let countersHot = false;
      try {
        const mRes = await get(cand.port, "/metrics", apiKey);
        if (mRes?.ok) countersHot = hasNonzeroRequestCounter(await mRes.text());
      } catch {
        /* metrics optional */
      }
      const activeAt = countersHot ? now : prevActiveAt;
      const active =
        countersHot ||
        (prevActiveAt != null && now - prevActiveAt < SERVICE_ACTIVE_WINDOW_MS);
      return {
        status: "running",
        source: cand.source,
        port: cand.port,
        model,
        engineVersion: typeof engineVersion === "string" && engineVersion ? engineVersion : null,
        active,
        activeAt,
        error: null,
      };
    } catch (err) {
      // Connection failure on this candidate — fall through to the next.
      continue;
    }
  }

  return {
    status: "stopped",
    source: null,
    port: enginePort,
    model: null,
    engineVersion: null,
    active: false,
    activeAt: prevActiveAt,
    error: null,
  };
}

// LIC2 clean-room rewrite (docs/specs/unit-history.md §6, docs/specs/roce.md §3):
// the freshness accessors and the RoCE hook below were re-implemented from spec.

/** How often start() polls each domain (ram rides the CPU timer, memory the bandwidth one). */
const POLL_CADENCE = new Map([
  ["gpu", POLL_INTERVAL_GPU],
  ["cpu", POLL_INTERVAL_CPU],
  ["ram", POLL_INTERVAL_CPU],
  ["network", POLL_INTERVAL_NETWORK],
  ["storage", POLL_INTERVAL_STORAGE],
  ["memory", POLL_INTERVAL_BANDWIDTH],
  ["llm", POLL_INTERVAL_LLM],
  ["comfy", POLL_INTERVAL_COMFY],
  ["tailscale", POLL_INTERVAL_TAILSCALE],
  ["hermes", POLL_INTERVAL_HERMES],
]);

/** Longest the network poll waits for a RoCE read before going on without it. */
const ROCE_WAIT_MS = 3000;

/**
 * True when a poll result is a real reading rather than the collector's
 * stand-in (zero-filled GPU/CPU, empty RAM/pool, no interfaces, no disks).
 * An LLM probe list counts even when every engine is down.
 */
function isRealReading(domain, result) {
  if (domain === "gpu" || domain === "cpu") return collectionWasSuccessful(result);
  if (domain === "ram" || domain === "memory") return Number(result?.total) > 0;
  if (domain === "network") return (result?.interfaces?.length ?? 0) > 0;
  if (domain === "storage") return Array.isArray(result) && result.length > 0;
  if (domain === "llm") return Array.isArray(result);
  return false;
}

/**
 * The RoCE reading for this network tick, or undefined when it failed or did
 * not answer within ROCE_WAIT_MS (a stuck NIC can hang ethtool). The sampler
 * throttles itself, so calling it every tick is cheap.
 */
async function roceWithin(collector, ms) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, undefined);
    timer.unref?.();
  });
  try {
    return await Promise.race([collector.collectRoce().then((v) => v, () => undefined), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SparkMonitor — one per Spark. Owns collectors + rate state + poll loop.
 * Exposes snapshot() for WebSocket pushed payload.
 */
export class SparkMonitor {
  /**
   * @param {object} spark
   * @param {{ onWolMac?: (sparkId: string, mac: string) => void, onHermesChange?: () => void, resolveHeadModelId?: ((headId: string) => string | null) }} [options]
   */
  constructor(spark, options = {}) {
    this.spark = spark;
    this._onWolMac = typeof options.onWolMac === "function" ? options.onWolMac : null;
    this._onHermesChange =
      typeof options.onHermesChange === "function" ? options.onHermesChange : null;
    // Resolver for worker derived label: maps a head spark id to its live
    // LLM model id (or null when unknown). Wired by index.js from the monitor
    // map; never writes back to registry config (derived display only).
    this._resolveHeadModelId =
      typeof options.resolveHeadModelId === "function" ? options.resolveHeadModelId : null;
    this.collector = new SystemCollector(spark);

    // One LlmProbe per port — none when LLM monitoring is off
    this.llmProbes = new Map();
    if (this._llmMonitoringEnabled(spark)) {
      for (const port of this._llmPorts()) {
        this.llmProbes.set(port, new LlmProbe(spark, port));
      }
    }

    /** @type {ComfyProbe | null} */
    this.comfyProbe = this._comfyMonitoringEnabled(spark)
      ? new ComfyProbe(spark, this._comfyPort(spark))
      : null;

    /** @type {TailscaleProbe | null} */
    this.tailscaleProbe = this._tailscaleMonitoringEnabled(spark)
      ? new TailscaleProbe(spark)
      : null;

    /** @type {HermesProbe | null} */
    this.hermesProbe = this._hermesMonitoringEnabled(spark)
      ? new HermesProbe(spark)
      : null;
    // Hermes status is surfaced in the snapshot (not under `metrics`) and is
    // always present so the UI never has to special-case a missing field.
    this._hermes = {
      monitoring: this._hermesMonitoringEnabled(spark),
      installed: null,
      version: null,
      updateAvailable: null,
      behindCommits: null,
      checkedAt: null,
      // idle | running | success | error
      status: "idle",
      startedAt: null,
      finishedAt: null,
      error: null,
    };

    // Online status from dedicated liveness checks (not metric poll success)
    // Issue #93: probe-truth status for configured services (spark.services).
    this._serviceStates = new Map();
    this._probeDeps = options.serviceProbe || {};

    this.online = false;
    this.lastOnlineOk = 0;

    // System uptime seconds (from /proc/uptime), null when offline
    this._uptimeSeconds = null;

    // Cached metrics per domain — never null objects for UI safety
    this._metrics = {
      gpu: this.collector._defaultGpu(),
      cpu: this.collector._defaultCpu(),
      ram: this.collector._defaultRam(),
      storage: [],
      network: this.collector._defaultNetwork(),
      roce: null,
      unifiedMemory: this.collector._defaultUnifiedMemory(),
      llm: [],
      comfy: null,
      tailscale: null,
    };
    this._lastUpdate = {};
    /** domain → when a poll last brought back a real reading (see lastCollectedAt). */
    this._realAt = Object.create(null);
    this._metricCollectionSuccessful = { gpu: false, cpu: false };
    /** Health rules + their sample-streak state; findings go out in snapshot().health. */
    this._healthEval = new HealthEvaluator();
    this._health = [];

    // Hardware summary: kind "spark" uses the static DGX Spark specs; kind
    // "host" (dedicated GPU Linux box) detects real hardware once in the
    // background so the header doesn't mislabel the machine as a Spark.
    this._hardwareSummary = this._staticHardwareSummary(spark);
    this._stopped = false;
    if (spark?.kind === "host") {
      void this.collector
        .detectHardware()
        .then((detected) => {
          if (this._stopped || !detected) return;
          this._hardwareSummary = { ...this._hardwareSummary, ...detected };
        })
        .catch(() => {});
    }

    // Timers
    this._intervals = [];
    /** @type {ReturnType<typeof setInterval> | null} */
    this._llmIntervalId = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._comfyIntervalId = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._hermesIntervalId = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._tailscaleIntervalId = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._servicesIntervalId = null;
    this._running = false;
    this._runGeneration = 0;
    /** @type {Record<string, boolean | symbol>} in-flight domain guards */
    this._inflight = {};
  }

  /** Hot-update config without tearing down poll loops / rate baselines. */
  updateConfig(spark) {
    const wasLlm = this._llmMonitoringEnabled(this.spark);
    const wasComfy = this._comfyMonitoringEnabled(this.spark);
    const prevComfyPort = this._comfyPort(this.spark);
    const wasHermes = this._hermesMonitoringEnabled(this.spark);
    const wasTailscale = this._tailscaleMonitoringEnabled(this.spark);
    const wasServices = this._servicesEnabled(this.spark);
    this.collector.invalidatePendingCollections();
    this._runGeneration += 1;
    this._inflight = {};
    this._metricCollectionSuccessful = { gpu: false, cpu: false };
    this.spark = spark;
    this.collector.spark = spark;

    // Rebuild LLM probe map — add new ports, remove stale ones, update existing
    const ports = this._llmMonitoringEnabled() ? this._llmPorts() : [];
    const prevProbes = this.llmProbes;
    this.llmProbes = new Map();
    for (const port of ports) {
      const existing = prevProbes.get(port);
      if (existing) {
        existing.spark = spark;
        this.llmProbes.set(port, existing);
      } else {
        this.llmProbes.set(port, new LlmProbe(spark, port));
      }
    }
    if (!this._llmMonitoringEnabled()) {
      this._metrics.llm = [];
    }

    // ComfyUI probe — create / update / clear
    if (this._comfyMonitoringEnabled()) {
      const port = this._comfyPort();
      if (this.comfyProbe) {
        this.comfyProbe.setTarget(spark, port);
      } else {
        this.comfyProbe = new ComfyProbe(spark, port);
      }
    } else {
      if (this.comfyProbe) {
        try {
          this.comfyProbe.dispose();
        } catch {
          /* ignore */
        }
      }
      this.comfyProbe = null;
      this._metrics.comfy = null;
    }

    // Tailscale probe — create / update / clear
    if (this._tailscaleMonitoringEnabled()) {
      if (this.tailscaleProbe) {
        this.tailscaleProbe.setTarget(spark);
      } else {
        this.tailscaleProbe = new TailscaleProbe(spark);
      }
    } else {
      this.tailscaleProbe = null;
      this._metrics.tailscale = null;
    }

    // Hermes probe — create / update / clear
    if (this._hermesMonitoringEnabled()) {
      if (this.hermesProbe) {
        this.hermesProbe.setTarget(spark);
      } else {
        this.hermesProbe = new HermesProbe(spark);
      }
    } else {
      this.hermesProbe = null;
      this._hermes.status = "idle";
    }
    this._hermes.monitoring = this._hermesMonitoringEnabled();
    if (this._running && wasHermes !== this._hermesMonitoringEnabled()) {
      this._restartHermesPollInterval();
    }

    // Service probes — rebuild when the services list changes at all
    this._serviceStates = new Map();
    if (this._running && wasServices !== this._servicesEnabled()) {
      this._restartServicesPollInterval();
    }

    // Toggle LLM poll interval when monitoring enablement flips
    if (this._running && wasLlm !== this._llmMonitoringEnabled()) {
      this._restartLlmPollInterval();
    }
    const comfyOn = this._comfyMonitoringEnabled();
    const comfyPortChanged = comfyOn && prevComfyPort !== this._comfyPort();
    if (this._running && (wasComfy !== comfyOn || comfyPortChanged)) {
      this._restartComfyPollInterval();
    }
    if (this._running && wasTailscale !== this._tailscaleMonitoringEnabled()) {
      this._restartTailscalePollInterval();
    }
  }

  /**
   * Workers: never. Head: always. Standalone: llmMonitoring (default true).
   * @param {object} [spark]
   */
  _llmMonitoringEnabled(spark = this.spark) {
    const role = spark?.role || (spark?.workerNode ? "worker" : "standalone");
    if (role === "worker") return false;
    if (role === "head") return true;
    return spark?.llmMonitoring !== false;
  }

  /**
   * Live LLM model id from this monitor's own probes (first non-empty
   * modelId on an AVAILABLE entry across ports), or null when unknown /
   * offline / protected. Protected/auth-failure snapshots can retain a
   * previous modelId with available:false — those entries are skipped so a
   * dead or locked head never yields a stale model (fail-closed).
   * @returns {string | null}
   */
  headLlmModelId() {
    const llm = this._metrics?.llm;
    if (!Array.isArray(llm)) return null;
    for (const entry of llm) {
      if (entry?.available !== true) continue;
      const id = typeof entry?.modelId === "string" ? entry.modelId.trim() : "";
      if (id) return id;
    }
    return null;
  }

  /**
   * Derived worker label: mirror the head's live served model. Display-only —
   * never written back to registry config. Non-null only when ALL hold:
   * role is worker, workerHeadId points at another spark, and the resolver
   * yields a non-empty model id. A hand-written workerLabel (non-empty) is a
   * manual override and takes display priority in the frontend; it does not
   * suppress this derived value.
   * @returns {string | null}
   */
  workerDerivedLabel() {
    const spark = this.spark || {};
    const role = spark.role || (spark.workerNode ? "worker" : "standalone");
    if (role !== "worker") return null;
    const headId = typeof spark.workerHeadId === "string" ? spark.workerHeadId.trim() : "";
    if (!headId || headId === spark.id) return null;
    if (typeof this._resolveHeadModelId !== "function") return null;
    let model = null;
    try {
      model = this._resolveHeadModelId(headId);
    } catch {
      return null;
    }
    return typeof model === "string" && model.trim() ? model.trim() : null;
  }

  /** Start or clear the LLM poll timer based on monitoring flag. */
  _restartLlmPollInterval() {
    if (this._llmIntervalId != null) {
      clearInterval(this._llmIntervalId);
      this._intervals = this._intervals.filter((id) => id !== this._llmIntervalId);
      this._llmIntervalId = null;
    }
    if (this._llmMonitoringEnabled() && this._running) {
      this._llmIntervalId = setInterval(() => this._pollDomain("llm"), POLL_INTERVAL_LLM);
      this._intervals.push(this._llmIntervalId);
      void this._pollDomain("llm");
    }
  }

  /**
   * Probe-truth service monitoring is active when the spark config carries a
   * non-empty `services` list (normalized by SparkRegistry).
   * @param {object} [spark]
   */
  _servicesEnabled(spark = this.spark) {
    return Array.isArray(spark?.services) && spark.services.length > 0;
  }

  /** Start or clear the service-probe poll timer based on the services list. */
  _restartServicesPollInterval() {
    if (this._servicesIntervalId != null) {
      clearInterval(this._servicesIntervalId);
      this._intervals = this._intervals.filter((id) => id !== this._servicesIntervalId);
      this._servicesIntervalId = null;
    }
    if (this._servicesEnabled() && this._running) {
      this._servicesIntervalId = setInterval(
        () => void this.probeServicesNow(),
        POLL_INTERVAL_LLM
      );
      this._intervals.push(this._servicesIntervalId);
      void this.probeServicesNow();
    }
  }

  /**
   * Probe every configured service once, probe-truth style (engine port →
   * engine port +1 → same-spark proxy; comfyui uses /system_stats). Results
   * land in _serviceStates and ride the snapshot as `services`.
   * @returns {Promise<Array<object>>}
   */
  async probeServicesNow() {
    const services = this.spark?.services;
    if (!this._servicesEnabled()) {
      this._serviceStates = new Map();
      return [];
    }
    if (this._inflight.services) return this._serviceSnapshot();
    const runGeneration = this._runGeneration;
    const token = Symbol("services");
    this._inflight.services = token;
    try {
      const host = llmProbeHost(this.spark) || "127.0.0.1";
      const sparkProxies = services
        .filter((s) => s?.proxyPort)
        .map((s) => ({ port: s.proxyPort, apiKeyRef: s.proxyApiKeyRef ?? null }));
      const results = await Promise.all(
        services.map(async (svc) => {
          const previous = this._serviceStates.get(svc?.name);
          let out;
          try {
            out = await probeServiceTruth(svc, {
              host,
              sparkProxies,
              previous,
              fetch: this._probeDeps.fetch,
              resolveApiKeyRef: this._probeDeps.resolveApiKeyRef,
              env: this._probeDeps.env,
              readFile: this._probeDeps.readFile,
              now: this._probeDeps.now,
            });
          } catch (err) {
            out = {
              status: "stopped",
              source: null,
              port: normalizeServicePort(svc?.port),
              model: null,
              engineVersion: null,
              active: false,
              activeAt: previous?.activeAt ?? null,
              error: err instanceof Error ? err.message : String(err),
            };
          }
          return {
            name: svc?.name,
            kind: svc?.kind || "other",
            engine: svc?.engine || "",
            port: svc?.port ?? null,
            proxyPort: svc?.proxyPort ?? null,
            polledAt: Date.now(),
            ...out,
          };
        })
      );
      if (!this._running || this._runGeneration !== runGeneration) return this._serviceSnapshot();
      this._serviceStates = new Map(
        results.filter((r) => typeof r.name === "string" && r.name).map((r) => [r.name, r])
      );
      return results;
    } finally {
      if (this._inflight.services === token) this._inflight.services = false;
    }
  }

  _serviceSnapshot() {
    return Array.from(this._serviceStates.values());
  }

  /**
   * Opt-in ComfyUI monitoring (all roles; default off).
   * @param {object} [spark]
   */
  _comfyMonitoringEnabled(spark = this.spark) {
    return Boolean(spark?.comfyMonitoring);
  }

  /** @param {object} [spark] */
  _comfyPort(spark = this.spark) {
    const n = Number(spark?.comfyPort);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
    return COMFY_PORT;
  }

  /** Start or clear the ComfyUI poll timer based on monitoring flag. */
  _restartComfyPollInterval() {
    if (this._comfyIntervalId != null) {
      clearInterval(this._comfyIntervalId);
      this._intervals = this._intervals.filter((id) => id !== this._comfyIntervalId);
      this._comfyIntervalId = null;
    }
    if (this._comfyMonitoringEnabled() && this._running) {
      this._comfyIntervalId = setInterval(() => this._pollDomain("comfy"), POLL_INTERVAL_COMFY);
      this._intervals.push(this._comfyIntervalId);
      void this._pollDomain("comfy");
    }
  }

  /**
   * Opt-in tailnet monitoring (all roles; default off).
   * @param {object} [spark]
   */
  _tailscaleMonitoringEnabled(spark = this.spark) {
    return Boolean(spark?.tailscaleMonitoring);
  }

  /** Start or clear the tailnet poll timer based on monitoring flag. */
  _restartTailscalePollInterval() {
    if (this._tailscaleIntervalId != null) {
      clearInterval(this._tailscaleIntervalId);
      this._intervals = this._intervals.filter((id) => id !== this._tailscaleIntervalId);
      this._tailscaleIntervalId = null;
    }
    if (this._tailscaleMonitoringEnabled() && this._running) {
      this._tailscaleIntervalId = setInterval(
        () => this._pollDomain("tailscale"),
        POLL_INTERVAL_TAILSCALE
      );
      this._intervals.push(this._tailscaleIntervalId);
      void this._pollDomain("tailscale");
    }
  }

  /**
   * Opt-in Hermes Agent monitoring (all roles; default off).
   * @param {object} [spark]
   */
  _hermesMonitoringEnabled(spark = this.spark) {
    return Boolean(spark?.hermesMonitoring);
  }

  /** Start or clear the Hermes update-check timer when monitoring flips. */
  _restartHermesPollInterval() {
    if (this._hermesIntervalId != null) {
      clearInterval(this._hermesIntervalId);
      this._intervals = this._intervals.filter((id) => id !== this._hermesIntervalId);
      this._hermesIntervalId = null;
    }
    if (this._hermesMonitoringEnabled() && this._running) {
      this._hermesIntervalId = setInterval(
        () => this._pollDomain("hermes"),
        POLL_INTERVAL_HERMES
      );
      this._intervals.push(this._hermesIntervalId);
      void this._pollDomain("hermes");
    }
  }

  /** Returns array of LLM ports from spark config. */
  _llmPorts() {
    const raw = this.spark?.llmPorts;
    if (Array.isArray(raw)) {
      const ports = raw
        .map((v) => (typeof v === "string" ? parseInt(v, 10) : Number(v)))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
      return ports.length > 0 ? ports : [LLM_PORT];
    }
    // Legacy single port
    const n = Number(this.spark?.llmPort);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return [n];
    return [LLM_PORT];
  }

  /** Start background polling. */
  start() {
    if (this._running) return;
    this._runGeneration += 1;
    this._running = true;
    this._stopped = false;
    this._poll();
    this._intervals.push(setInterval(() => this._pollDomain("gpu"), POLL_INTERVAL_GPU));
    this._intervals.push(setInterval(() => this._pollDomain("cpu"), POLL_INTERVAL_CPU));
    this._intervals.push(setInterval(() => this._pollDomain("network"), POLL_INTERVAL_NETWORK));
    this._intervals.push(setInterval(() => this._pollDomain("storage"), POLL_INTERVAL_STORAGE));
    this._intervals.push(setInterval(() => this._pollDomain("ram"), POLL_INTERVAL_CPU));
    this._intervals.push(setInterval(() => this._pollDomain("memory"), POLL_INTERVAL_BANDWIDTH));
    this._restartLlmPollInterval();
    this._restartComfyPollInterval();
    this._restartHermesPollInterval();
    this._restartTailscalePollInterval();
    this._restartServicesPollInterval();
    // Liveness on a slightly slower cadence
    this._intervals.push(setInterval(() => this._checkOnline(), POLL_INTERVAL_LIVENESS));
    console.log(`[SparkMonitor] ${this.spark.id} started`);
  }

  /** Stop background polling. */
  stop() {
    this.collector.invalidatePendingCollections();
    this._runGeneration += 1;
    this._metricCollectionSuccessful = { gpu: false, cpu: false };
    this._running = false;
    this._stopped = true;
    for (const id of this._intervals) clearInterval(id);
    this._intervals = [];
    this._llmIntervalId = null;
    this._comfyIntervalId = null;
    this._hermesIntervalId = null;
    this._tailscaleIntervalId = null;
    this._servicesIntervalId = null;
    this._inflight = {};
    if (this.comfyProbe) {
      try {
        this.comfyProbe.dispose();
      } catch {
        /* ignore */
      }
    }
    console.log(`[SparkMonitor] ${this.spark.id} stopped`);
  }

  /**
   * Re-run the health rules over the latest metrics. Findings ride the
   * snapshot (WS push); this fork has no server-side activity bus, so the
   * upstream event emission for rule changes is intentionally skipped.
   */
  _updateHealth(domain = "other") {
    try {
      this._health = this._healthEval.evaluate(
        {
          gpu: this._metrics.gpu,
          unifiedMemory: this._metrics.unifiedMemory,
          network: this._metrics.network,
          roce: this._metrics.roce,
          llm: this._metrics.llm,
        },
        domain
      );
    } catch (err) {
      console.error(`[SparkMonitor] ${this.spark.id} health error:`, err?.message);
    }
  }

  _noteReading(domain, result) {
    if (isRealReading(domain, result)) this._realAt[domain] = this._lastUpdate[domain];
  }

  /** When `domain` last produced a real reading (epoch ms), or null if it never has. */
  lastCollectedAt(domain) {
    const at = this._realAt[domain];
    return Number.isFinite(at) ? at : null;
  }

  /**
   * Did the most recent poll of `domain` produce a real reading? GPU/CPU use
   * the collector's own success flag; for the rest, the latest poll must be
   * the one that produced the last real reading (a failed poll keeps the old
   * value, so "a value is there" proves nothing).
   */
  collectionOk(domain) {
    if (domain === "gpu" || domain === "cpu") return this._metricCollectionSuccessful[domain] === true;
    const at = this.lastCollectedAt(domain);
    return at !== null && at === this._lastUpdate[domain];
  }

  /**
   * Poll cadence of `domain` in ms, or null for a domain start() does not
   * schedule. This fork polls on fixed constants (no poll-interval setting).
   */
  pollIntervalMs(domain) {
    const ms = POLL_CADENCE.get(domain);
    return ms > 0 ? ms : null;
  }

  /** Return a full snapshot of this Spark's metrics. */
  snapshot() {
    const ports = this._llmMonitoringEnabled() ? this._llmPorts() : [];
    const comfyOn = this._comfyMonitoringEnabled();
    const tailscaleOn = this._tailscaleMonitoringEnabled();
    return {
      id: this.spark.id,
      name: this.spark.name,
      kind: this.spark.kind || "spark",
      online: this.online,
      uptime: this._uptimeSeconds,
      lanIp: this.spark.lanIp || "",
      isLocal: Boolean(this.spark.isLocal),
      disabledDevices: this.spark.disabledDevices || [],
      disabledInterfaces: this.spark.disabledInterfaces || [],
      storagePollDisabled: Boolean(this.spark.storagePollDisabled),
      workerNode: Boolean(this.spark.workerNode),
      role: this.spark.role || (this.spark.workerNode ? "worker" : "standalone"),
      workerLabel: this.spark.workerLabel || null,
      workerHeadId: this.spark.workerHeadId || null,
      // Derived display label (head model mirror). Raw workerLabel above is
      // untouched — frontend prefers a non-empty manual label over this.
      workerDerivedLabel: this.workerDerivedLabel(),
      llmMonitoring: this._llmMonitoringEnabled(),
      llmPort: ports[0] ?? LLM_PORT,
      llmPorts: ports,
      llmApiKeyPorts: Array.isArray(this.spark.llmApiKeyPorts)
        ? this.spark.llmApiKeyPorts
        : Object.keys(this.spark.llmApiKeys || {})
            .map((p) => parseInt(p, 10))
            .filter((n) => Number.isInteger(n)),
      comfyMonitoring: comfyOn,
      comfyPort: this._comfyPort(),
      // Probe-truth service status (issue #93): status/source/model/
      // engineVersion/active per configured service.
      services: this._servicesEnabled() ? this._serviceSnapshot() : [],
      tailscaleMonitoring: tailscaleOn,
      hermes: this._hermes,
      health: this._health,
      hardware: this._hardwareSummary,
      metrics: {
        // NOTE: no `timestamp` here on purpose. The broadcast path skips
        // snapshots whose JSON is byte-identical to the previous one (see
        // startBroadcast); a per-snapshot Date.now() would defeat that cache,
        // forcing a broadcast + frontend re-render every tick even when all
        // measured values are unchanged. The frontend does not consume a
        // metrics timestamp; the WS receive time can serve if one is ever
        // needed.
        gpu: this._metrics.gpu,
        cpu: this._metrics.cpu,
        ram: this._metrics.ram,
        storage: this._metrics.storage,
        network: this._metrics.network,
        roce: this._metrics.roce ?? null,
        unifiedMemory: this._metrics.unifiedMemory,
        llm: this._metrics.llm,
        comfy: comfyOn ? this._metrics.comfy : null,
        tailscale: tailscaleOn ? this._metrics.tailscale : null,
      },
    };
  }

  // ─── Uptime helper ─────────────────────────────────────────
  /** Read system uptime from /proc/uptime (local or via SSH). */
  async _readUptime() {
    let content;
    if (this.spark.isLocal) {
      const mapped = path.join(HOST_PATHS.PROC, "uptime");
      content = fs.readFileSync(mapped, "utf8");
    } else {
      content = await sshExec(this.spark, "cat /proc/uptime");
    }
    const parts = content.trim().split(/\s+/);
    const secs = parseFloat(parts[0]);
    return Number.isFinite(secs) ? Math.floor(secs) : null;
  }

  // ─── Liveness ─────────────────────────────────────────────
  async _checkOnline() {
    if (!this._running || this._inflight.online) return;
    const runGeneration = this._runGeneration;
    const checkToken = Symbol("online");
    this._inflight.online = checkToken;
    const isCurrentRun = () =>
      this._running && this._runGeneration === runGeneration;
    const local = this.spark.isLocal;
    let uptimeSeconds = this._uptimeSeconds;
    try {
      if (local) {
        await this.collector.pingHost();
        if (!isCurrentRun()) return;
        this.online = true;
        this.lastOnlineOk = Date.now();
        // Non-fatal — uptime stays at its previous value or null
        try {
          uptimeSeconds = await this._readUptime();
        } catch {
          /* ignore */
        }
      } else {
        // One SSH round trip, not two. Reading /proc/uptime already proves the
        // session came up, so the separate `echo ok` probe told us nothing the
        // uptime read doesn't — and on a remote Spark every probe is a full
        // login, which is the expensive half of this loop.
        uptimeSeconds = await this._readUptime();
        // The generation gate below (after the await) is the commit guard.
      }
      if (!isCurrentRun()) return;
      this.online = true;
      this.lastOnlineOk = Date.now();
      this._uptimeSeconds = uptimeSeconds;
    } catch {
      if (!isCurrentRun()) return;
      if (!this.lastOnlineOk || Date.now() - this.lastOnlineOk > ONLINE_GRACE_MS) {
        this.online = false;
        this._uptimeSeconds = null;
      }
    } finally {
      if (this._inflight.online === checkToken) {
        this._inflight.online = false;
      }
    }
  }

  // ─── Polling ──────────────────────────────────────────────
  async _poll() {
    if (!this._running) return;
    await Promise.all([
      this._checkOnline(),
      this._pollDomain("gpu"),
      this._pollDomain("cpu"),
      this._pollDomain("network"),
      this._pollDomain("storage"),
      this._pollDomain("ram"),
      this._pollDomain("memory"),
      this._pollDomain("llm"),
      this._pollDomain("comfy"),
      this._pollDomain("hermes"),
      this._pollDomain("tailscale"),
    ]);
  }

  async _pollDomain(domain) {
    if (!this._running || this._inflight[domain]) return;
    // Skip storage auto-poll when disabled for this spark
    if (domain === "storage" && this.spark.storagePollDisabled) return;
    // Worker nodes: no local LLM API
    if (domain === "llm" && !this._llmMonitoringEnabled()) return;
    if (domain === "comfy" && !this._comfyMonitoringEnabled()) return;
    if (domain === "hermes" && !this._hermesMonitoringEnabled()) return;
    if (domain === "tailscale" && !this._tailscaleMonitoringEnabled()) return;
    const runGeneration = this._runGeneration;
    const pollToken = Symbol(domain);
    this._inflight[domain] = pollToken;
    try {
      let result;
      let roce;
      switch (domain) {
        case "gpu":
          result = await this.collector.collectGpu();
          break;
        case "cpu":
          result = await this.collector.collectCpu();
          break;
        case "ram":
          result = await this.collector.collectRam();
          break;
        case "network":
          result = await this.collector.collectNetwork();
          roce = await roceWithin(this.collector, ROCE_WAIT_MS);
          break;
        case "storage":
          result = await this.collector.collectStorage();
          break;
        case "memory":
          result = await this.collector.collectUnifiedMemory();
          break;
        case "llm":
          // Probe all ports in parallel
          result = await Promise.all(
            Array.from(this.llmProbes.values()).map((probe) => probe.probe())
          );
          break;
        case "comfy":
          result = this.comfyProbe ? await this.comfyProbe.probe() : null;
          break;
        case "tailscale":
          result = this.tailscaleProbe ? await this.tailscaleProbe.probe() : null;
          break;
        case "hermes":
          result = this.hermesProbe ? await this.hermesProbe.check() : null;
          break;
      }
      // Re-check after the await — `stop()`/`updateSpark()` may have torn
      // this monitor down mid-flight. Writing `_metrics` on a dead monitor
      // isn't user-visible (monitors.delete already happened) but it's a
      // latent class of bug worth killing, and a replaced monitor could
      // otherwise race the tail-end await onto the wrong object.
      if (!this._running || this._runGeneration !== runGeneration) return;
      switch (domain) {
        case "gpu":
          this._metrics.gpu = result;
          this._metricCollectionSuccessful.gpu = collectionWasSuccessful(result);
          this._updateHealth("gpu");
          break;
        case "cpu":
          this._metrics.cpu = result;
          this._metricCollectionSuccessful.cpu = collectionWasSuccessful(result);
          break;
        case "ram":
          this._metrics.ram = result;
          break;
        case "network":
          this._metrics.network = result;
          // No answer this tick: the last RoCE reading stays.
          if (roce !== undefined) this._metrics.roce = roce;
          this._updateHealth();
          if (result?.wolMac && this._onWolMac) {
            try {
              this._onWolMac(this.spark.id, result.wolMac);
            } catch (err) {
              console.error(`[SparkMonitor] ${this.spark.id} wolMac persist error:`, err.message);
            }
          }
          break;
        case "storage":
          this._metrics.storage = result;
          break;
        case "memory":
          this._metrics.unifiedMemory = result;
          this._updateHealth();
          break;
        case "llm":
          this._metrics.llm = result;
          this._updateHealth();
          {
            const probes = Array.from(this.llmProbes.values());
            for (let i = 0; i < result.length; i++) {
              const probe = probes[i];
              if (probe) llmDaily.record(this.spark.id, probe.port, result[i]);
            }
          }
          break;
        case "comfy":
          this._metrics.comfy = result;
          break;
        case "tailscale":
          this._metrics.tailscale = result;
          break;
        case "hermes":
          this.applyHermesCheck(result);
          break;
      }
      this._lastUpdate[domain] = Date.now();
      this._noteReading(domain, result);
      if (Number.isFinite(roce?.sampledAt)) this._realAt.roce = roce.sampledAt;
    } catch (err) {
      if (
        this._running &&
        this._runGeneration === runGeneration &&
        (domain === "gpu" || domain === "cpu")
      ) {
        this._metricCollectionSuccessful[domain] = false;
      }
      console.error(`[SparkMonitor] ${this.spark.id} ${domain} poll error:`, err.message);
    } finally {
      if (this._inflight[domain] === pollToken) {
        this._inflight[domain] = false;
      }
    }
  }

  /** Manually refresh a single domain, bypassing auto-poll guards. */
  async refreshDomain(domain) {
    if (domain !== "storage") return this._pollDomain(domain);
    if (!this._running || this._inflight[domain]) return;
    const runGeneration = this._runGeneration;
    const refreshToken = Symbol(domain);
    this._inflight[domain] = refreshToken;
    try {
      const result = await this.collector.collectStorage();
      if (!this._running || this._runGeneration !== runGeneration) return;
      this._metrics.storage = result;
      this._lastUpdate[domain] = Date.now();
      this._noteReading(domain, result);
    } catch (err) {
      console.error(`[SparkMonitor] ${this.spark.id} ${domain} refresh error:`, err.message);
    } finally {
      if (this._inflight[domain] === refreshToken) {
        this._inflight[domain] = false;
      }
    }
  }

  // ─── Hermes Agent ─────────────────────────────────────────
  /**
   * Apply a Hermes check result to monitor state. Fires onHermesChange (force
   * broadcast) only when a user-meaningful field actually changed, so idle
   * re-checks do not spam the WS.
   * @param {object|null} result
   */
  applyHermesCheck(result) {
    if (!result || !this._running) return;
    const prev = this._hermes;
    const changed =
      result.updateAvailable !== prev.updateAvailable ||
      result.installed !== prev.installed ||
      result.version !== prev.version;
    this._hermes = {
      ...prev,
      installed: result.installed,
      version: result.version,
      updateAvailable: result.updateAvailable,
      behindCommits: result.behindCommits,
      checkedAt: result.checkedAt,
      error: result.error ?? null,
    };
    // A clean check self-heals the transient one-shot update job status, so a
    // "success / error" flag never lingers past the following poll cycle.
    if (!result.error && this._hermes.status !== "running") {
      this._hermes.status = "idle";
    }
    if (changed) this._notifyHermesChange();
  }

  /**
   * Kick off `hermes update` in the background. Returns immediately; progress
   * and result are surfaced through the snapshot + onHermesChange broadcast.
   * @returns {{ started: boolean, reason?: string }}
   */
  runHermesUpdate() {
    if (!this.hermesProbe) {
      return { started: false, reason: "Hermes Agent monitoring is disabled for this Spark" };
    }
    if (this._hermes.status === "running") {
      return { started: false, reason: "An update is already running" };
    }
    this._hermes = {
      ...this._hermes,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
    };
    this._notifyHermesChange();
    // Defer the long-running SSH work so the broadcast above lands first.
    void (async () => {
      try {
        const res = await this.hermesProbe.update();
        if (!this._running) return;
        if (res?.ok) {
          this._hermes = {
            ...this._hermes,
            status: "success",
            installed: res.installed,
            version: res.version,
            error: null,
            finishedAt: res.finishedAt ?? Date.now(),
          };
          // Refresh update availability right away (don't wait for the next poll).
          try {
            const check = await this.hermesProbe.check();
            if (this._running && check) {
              this._hermes = {
                ...this._hermes,
                installed: check.installed,
                version: check.version,
                updateAvailable: check.updateAvailable,
                behindCommits: check.behindCommits,
                checkedAt: check.checkedAt,
                error: check.error ?? null,
              };
            }
          } catch {
            /* keep the success result if the follow-up check fails */
          }
        } else {
          this._hermes = {
            ...this._hermes,
            status: "error",
            error: res?.error || res?.output?.slice(-400) || "hermes update failed",
            finishedAt: res?.finishedAt ?? Date.now(),
          };
        }
      } catch (err) {
        if (!this._running) return;
        this._hermes = {
          ...this._hermes,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          finishedAt: Date.now(),
        };
      }
      this._notifyHermesChange();
    })();
    return { started: true };
  }

  _notifyHermesChange() {
    if (typeof this._onHermesChange !== "function") return;
    try {
      this._onHermesChange(this.spark.id);
    } catch (err) {
      console.error(`[SparkMonitor] ${this.spark.id} hermes change error:`, err.message);
    }
  }

  // ─── Hardware summary ─────────────────────────────────────
  /**
   * Static summary used for kind "spark" (DGX Spark specs) and as the
   * pre-detection fallback for kind "host". kind "host" is then enriched
   * with real hardware from `detectHardware()` once available.
   */
  _staticHardwareSummary(spark) {
    if (spark?.kind === "host") {
      return {
        device: "Linux GPU host",
        cpuModel: null,
        cpuCores: null,
        totalMemoryGB: null,
        gpuChip: null,
        cudaDriver: null,
        storageModel: null,
      };
    }
    return {
      device: "NVIDIA DGX Spark",
      cpuModel: "GB10",
      cpuCores: 20,
      totalMemoryGB: 128,
      gpuChip: "GB10",
      cudaDriver: null,
      storageModel: null,
    };
  }
}
