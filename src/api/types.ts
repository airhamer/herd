// ─── Spark config (matches server/sparks.json) ────────────
export interface SparkConfig {
  id: string;
  name: string;
  /**
   * Unit type:
   * - spark: NVIDIA DGX Spark (default) — DGX Spark specs shown in the header.
   * - host: any Linux box with an NVIDIA GPU (still monitored via nvidia-smi,
   *   just not a Spark). Real hardware is auto-detected once online.
   */
  kind?: "spark" | "host";
  lanIp: string;
  cx7Ip?: string | null;
  /**
   * Optional Wake-on-LAN MAC override. When empty, the server uses
   * `detectedMacAddress` from the enP7s7 interface.
   */
  macAddress?: string | null;
  /** Last MAC read from enP7s7 while the Spark was online (read-only). */
  detectedMacAddress?: string | null;
  isLocal: boolean;
  ssh: {
    host: string;
    user: string;
    auth: "key" | "pass";
    /** Request-only: never returned by GET/list */
    password?: string;
    /** Response-only: true when a password is held in server memory */
    hasPassword?: boolean;
  };
  disabledDevices?: string[];
  /** Interface names hidden from the Network panel main view */
  disabledInterfaces?: string[];
  /** HTTP port for the LLM server on this Spark (legacy single-port, prefer llmPorts) */
  llmPort?: number;
  /** HTTP ports for LLM servers on this Spark (default [8888]) */
  llmPorts?: number[];
  /**
   * Ports that have an encrypted LLM API key stored server-side.
   * The key itself is never returned by the API.
   */
  llmApiKeyPorts?: number[];
  /**
   * Cluster role for overview + worker behavior.
   * - head / standalone: local LLM API probed
   * - worker: no local API (LLM card hidden, ports not probed)
   */
  role?: SparkRole;
  /**
   * Legacy/derived: true when role is worker. Prefer `role`.
   * Kept so existing probe/card checks keep working.
   */
  workerNode?: boolean;
  /**
   * Optional label for a worker node (cluster / model name), shown on the overview card.
   * Only meaningful when role is worker.
   */
  workerLabel?: string | null;
  /**
   * Optional id of the head Spark this worker belongs to.
   * Only meaningful when role is worker.
   */
  workerHeadId?: string | null;
  /**
   * Standalone only: probe local LLM and show the LLM card (default true).
   * Forced true for head, forced false for worker.
   */
  llmMonitoring?: boolean;
  /**
   * Probe local ComfyUI and show the ComfyUI card (default false; all roles).
   */
  comfyMonitoring?: boolean;
  /** ComfyUI HTTP port (default 8188). */
  comfyPort?: number;
  /**
   * Opt-in: Hermes Agent CLI (nousresearch/hermes-agent) is installed on this
   * machine. When enabled, sparkDash checks for Hermes updates and can run
   * `hermes update` for you via SSH.
   */
  hermesMonitoring?: boolean;
  /**
   * Report tailnet presence via `tailscale status --json` (default false; all roles).
   */
  tailscaleMonitoring?: boolean;
  /** When true, storage is only updated on manual refresh, not auto-polled. */
  storagePollDisabled?: boolean;
}

export type SparkRole = "head" | "worker" | "standalone";

// ─── Hermes Agent status ───────────────────────────────
/** Opt-in Hermes Agent update monitoring state, pushed in every snapshot. */
export interface HermesStatus {
  /** Opt-in setting from Edit Spark (hermes installed on this machine). */
  monitoring: boolean;
  /** Whether the `hermes` binary was found on the target. null before first check. */
  installed: boolean | null;
  /** Installed version string when detected (e.g. "0.20.0"). */
  version: string | null;
  /** true when `hermes update --check` reports commits behind origin/main. */
  updateAvailable: boolean | null;
  /** Number of commits behind origin/main when reported. */
  behindCommits: number | null;
  /** Last check time (ms epoch). */
  checkedAt: number | null;
  /** One-shot update job state. */
  status: "idle" | "running" | "success" | "error";
  startedAt: number | null;
  finishedAt: number | null;
  /** Short human-readable message when the last check/update failed. */
  error: string | null;
}

/** Latest public Hermes Agent release (changelog for the update dialog). */
export interface HermesRelease {
  /** GitHub release tag, e.g. "v2026.7.7.2". */
  tagName: string;
  /** Human release name, e.g. "Hermes Agent v0.18.1 (v2026.7.7.2)". */
  name: string;
  version: string;
  /** Semantic version of the release (e.g. "0.20.0") for bump detection. */
  semver: string | null;
  publishedAt: string | null;
  htmlUrl: string;
  /** Markdown release body. */
  body: string;
}

/** One pending commit an update would bring (from git HEAD..origin/main). */
export interface HermesPendingCommit {
  sha: string;
  title: string;
}

/** One Spark's outcome from a batch `update-all` call. */
export interface HermesBatchUpdateResult {
  id: string;
  name: string;
  ok: boolean;
  started: boolean;
  skipped?: boolean;
  reason?: string;
}

export interface HermesBatchUpdateResponse {
  success: boolean;
  results: HermesBatchUpdateResult[];
}

/** Per-Spark update preview used by the confirmation dialog. */
export interface HermesUpdatesResponse {
  success: boolean;
  /** Which content the dialog should lead with. */
  view: "commits" | "release";
  /** Latest tagged release (may be null on GitHub API failure). */
  release: HermesRelease | null;
  releaseError: string | null;
  /** Installed hermes version on this Spark (e.g. "0.20.0"), when known. */
  installedVersion: string | null;
  /** Pending commits from git (may be null if the repo can't be read). */
  pending: { count: number; headSha: string | null; commits: HermesPendingCommit[] } | null;
}

// ─── Hardware info ───────────────────────────────────────
export interface HardwareInfo {
  device: string;
  cpuModel: string | null;
  cpuCores: number | null;
  totalMemoryGB: number | null;
  gpuChip: string | null;
  cudaDriver: string | null;
  storageModel: string | null;
}

// ─── GPU metrics ─────────────────────────────────────────
export interface GpuThrottle {
  /** HW or SW thermal slowdown engaged. */
  thermal: boolean;
  /** HW slowdown (may include thermal or power brake). */
  hwSlowdown: boolean;
  /** SW power-cap scaling limiting clocks. */
  powerCap: boolean;
  /** Any limiting reason above. */
  active: boolean;
  reason: "ok" | "thermal" | "power" | "hw" | "unknown";
  smClockMHz: number | null;
  smClockMaxMHz: number | null;
  /** Current SM clock as % of max (0–100). null when clocks unavailable. */
  smClockPct: number | null;
  /** Max graphics clock locked with `nvidia-smi -lgc` (MHz), from the sparkdash
   *  gpu-clock-cap marker on the host. null/absent when no lock is recorded. */
  clockCapMHz?: number | null;
  /** Human-readable active reasons (tooltip). */
  detail: string;
}

/** One health finding for a Spark (server rules in server/health/HealthEvaluator.js). */
export interface HealthFinding {
  id: "thermal" | "low-power" | "memory" | "xid" | "oom" | "concurrency" | "link-speed" | "roce-link" | "roce-loss";
  severity: "warn" | "critical";
  title: string;
  detail: string;
  hint: string;
}

export interface GpuMetrics {
  temperature: number;
  usage: number;
  power: {
    draw: number;
    limit: number;
    /** Estimated total system power draw (GPU + CPU + CX7/peripherals). */
    systemDraw?: number;
  };
  vram: {
    used: number;
    total: number;
    percentage: number;
    /** MemAvailable in MB — the real free memory in the shared pool. */
    available: number;
  };
  /** Top GPU processes by VRAM usage (sorted descending, max 5). */
  processes?: Array<{ pid: number; name: string; vramMB: number }>;
  /** NVIDIA clock throttle / thermal slowdown state from nvidia-smi. */
  throttle?: GpuThrottle | null;
  /** Kernel NVRM NV_ERR_NO_MEMORY count since boot (cached ~60s). */
  nvErrNoMemory?: number;
  /** Kernel Xid errors and OOM-killer kills since boot (cached ~60s). null when the journal is unreadable. */
  kernelErrors?: { xid: number; oomKills: number; lastXid: string | null } | null;
}

// ─── CPU metrics ─────────────────────────────────────────
export interface CpuMetrics {
  usage: number;
  temperature: number;
  draw: number;
  tdp: number;
}

// ─── RAM metrics ─────────────────────────────────────────
export interface RamMetrics {
  used: number;
  total: number;
  percentage: number;
}

// ─── Storage metrics ─────────────────────────────────────
export interface StorageMetrics {
  device: string;
  label: string;
  used: number;
  total: number;
  available: number;
  percentage: number;
  readSpeed: number;
  writeSpeed: number;
  /** Present when device is in disabledDevices; still returned for Settings UI */
  disabled?: boolean;
}

// ─── Network metrics ─────────────────────────────────────
export interface NetworkInterface {
  name: string;
  rxSpeed: number;
  txSpeed: number;
  /** IPv4 address, e.g. "192.168.1.143". null when unset. */
  ip: string | null;
  /** Interface operstate: "up" | "down" | "unknown" */
  operstate: string;
  /** Present when interface is in disabledInterfaces; still returned for Settings UI */
  disabled?: boolean;
  /** Wireless details if applicable. */
  wireless?: { ssid: string | null; signalDbm: number | null; frequency: string | null } | null;
  /** MAC address. */
  mac?: string | null;
}

export interface NetworkMetrics {
  primaryInterface: string | null;
  linkSpeedMbps: number | null;
  interfaces: NetworkInterface[];
  /** MAC of enP7s7 when present (same value persisted as detectedMacAddress). */
  wolMac?: string | null;
}

// ─── RoCE / RDMA (server/collectors/roce.js) ──────────────
export interface RoceQos {
  /** "pcp" or "dscp" (mlnx_qos "Priority trust state"). */
  trust: string | null;
  /** Priorities with PFC enabled; [] means PFC is off everywhere; null when mlnx_qos is unavailable. */
  pfcPriorities: number[] | null;
  cableLen: number | null;
  /** priority -> DSCP values, present in DSCP trust mode. */
  dscpMap: Record<string, number[]> | null;
}

export interface RoceDevice {
  /** RDMA device, e.g. "rocep1s0f0". */
  name: string;
  /** Its network interface, e.g. "enp1s0f0np0". */
  netdev: string | null;
  state: string | null;
  physState: string | null;
  active: boolean;
  /** Was ACTIVE at some point while sparkDash watched; an uncabled port never is. */
  everActive: boolean;
  rateGbps: number | null;
  linkLayer: string | null;
  operstate: string | null;
  mtu: number | null;
  speedMbps: number | null;
  rxBps: number | null;
  txBps: number | null;
  rxErrors: number | null;
  txErrors: number | null;
  rxDropped: number | null;
  txDropped: number | null;
  /** RDMA hw_counters, lifetime totals. */
  counters: Record<string, number>;
  /** Change since the previous sample. */
  deltas: Record<string, number>;
  loss: { rising: string[]; streak: number };
  /** ethtool -S subset (discards, CRC, pause frames, per-priority). */
  eth: Record<string, number> | null;
  flowControl: { rx: boolean | null; tx: boolean | null } | null;
  qos: RoceQos | null;
}

export interface RoceMetrics {
  available: true;
  sampledAt: number;
  devices: RoceDevice[];
}

// ─── Unified memory metrics ──────────────────────────────
export interface UnifiedMemoryMetrics {
  total: number;
  gpuUsed: number;
  cpuUsed: number;
  used: number;
  available: number;
  percentage: number;
  oomRisk: "low" | "medium" | "high";
  bandwidth: {
    current: number;
    peak: number;
  };
  /** /proc/meminfo Cached (MB): reclaimable page cache, inside `available`. Optional (#26). */
  cached?: number;
  /** /proc/meminfo SwapTotal (MB). Optional (#26). */
  swapTotal?: number;
  /** /proc/meminfo SwapFree (MB). Optional (#26). */
  swapFree?: number;
}

// ─── LLM metrics ─────────────────────────────────────────
export interface LlmMetrics {
  available: boolean;
  backend: "vllm" | "llama.cpp" | "sglang" | "ds4" | "exl3" | "q27" | null;
  modelId: string | null;
  modelPath: string | null;
  /** For ollama etc: list of installed models. */
  installedModels?: string[] | null;
  contextLength: number | null;
  /** GPU memory utilization for the LLM engine (0–1), e.g. 0.9. Only from vLLM internal info. */
  gpuMemoryUtilization: number | null;
  slotsActive: number;
  slotsTotal: number;
  generationTps: number;
  prefillTps: number;
  /** Live cached-prefill tok/s when the backend splits kinds (ds4, llama.cpp, sglang). */
  cachedPrefillTps?: number | null;
  /** Live uncached/computed prefill tok/s when split is available. */
  uncachedPrefillTps?: number | null;
  /** Cumulative total output (generation) tokens as reported by the LLM server */
  totalOutputTokens: number;
  /** vLLM KV cache usage fraction (0–1). null when backend !== vllm or unreachable. */
  kvCacheUsage?: number | null;
  /** vLLM running request count. null when unavailable. */
  requestsRunning?: number | null;
  /** vLLM waiting request count. null when unavailable. */
  requestsWaiting?: number | null;
  /** vLLM time-to-first-token p95 in seconds. null when unavailable. */
  ttftP95Seconds?: number | null;
  /** Live recent-window mean TTFT (seconds) from vLLM histogram sum/count deltas. null when unavailable. */
  ttftSeconds?: number | null;
  /** vLLM cumulative preemption count. null when unavailable. */
  preemptionsTotal?: number | null;
  /** vLLM prefix-cache hit rate (hits/queries, 0–1). null when unavailable. */
  prefixCacheHitRate?: number | null;
  /** vLLM end-to-end request latency p95 in seconds. null when unavailable. */
  e2eP95Seconds?: number | null;
  /** vLLM inter-token latency p95 in seconds. null when unavailable. */
  itlP95Seconds?: number | null;
  /** vLLM speculative/MTP acceptance rate (accepted/drafted, 0–1). null when unavailable. */
  mtpAcceptanceRate?: number | null;
  /**
   * Observational exposure hint from unauthenticated probe reachability +
   * configured target host scope. null when auth status is unknown.
   * Does not claim process bind address.
   */
  posture?: LlmPosture | null;
  error: string | null;
}

/** One UTC day of busy tok/s rollups (null avg = no busy samples). */
export interface LlmDailyDay {
  date: string;
  decodeMax: number;
  decodeAvg: number | null;
  prefillMax: number;
  prefillAvg: number | null;
  cachedPrefillMax: number | null;
  cachedPrefillAvg: number | null;
  uncachedPrefillMax: number | null;
  uncachedPrefillAvg: number | null;
}

export interface LlmDailyResponse {
  sparkId: string;
  port: number;
  days: LlmDailyDay[];
}

/** Security posture badge payload from LlmProbe. */
export interface LlmPosture {
  /** ok = green, warn = amber, danger = red */
  level: "ok" | "warn" | "danger";
  auth: "open" | "protected" | "keyed";
  scope: "local" | "lan" | "public" | "unknown";
  /** Short badge text */
  label: string;
  /** Tooltip / title detail */
  detail: string;
}

// ─── ComfyUI metrics ─────────────────────────────────────
/** Active or queued ComfyUI job (parsed from /queue prompt graph). */
export interface ComfyJob {
  id: string;
  status: "running" | "pending";
  /** Workflow title when present in extra_pnginfo. */
  title: string | null;
  /** Model weight files referenced by loader nodes. */
  models: string[];
  nodeCount: number;
  steps: number | null;
  width: number | null;
  height: number | null;
  batchSize: number | null;
  sampler: string | null;
  /** Queue entry create time (ms epoch when available). */
  createTime: number | null;
}

/** Live or estimated progress for the active Comfy job. */
export interface ComfyProgress {
  promptId: string | null;
  nodeId: string | null;
  nodeLabel: string | null;
  value: number;
  max: number;
  percent: number | null;
  updatedAt: number;
  /** ws = Comfy WebSocket frames; estimate = elapsed/avg heuristic */
  source?: "ws" | "estimate";
}

export interface ComfyLastJob {
  id: string;
  status: "completed" | "failed" | "cancelled" | string;
  title: string | null;
  durationMs: number | null;
  endedAt: number | null;
}

export interface ComfyModelsInstalled {
  checkpoints: string[];
  loras: string[];
}

export interface ComfyMetrics {
  available: boolean;
  port: number;
  version: string | null;
  pytorchVersion: string | null;
  /** Primary device type from /system_stats (e.g. cpu, cuda) — not VRAM. */
  deviceType?: string | null;
  queueRunning: number;
  queuePending: number;
  /** Currently executing job, if any. */
  activeJob?: ComfyJob | null;
  /** Next pending jobs (capped server-side). */
  pendingJobs?: ComfyJob[];
  progress?: ComfyProgress | null;
  lastJob?: ComfyLastJob | null;
  modelsInstalled?: ComfyModelsInstalled | null;
  /** Estimated ms until queue idle (running remainder + pending × avg). */
  queueEtaMs?: number | null;
  /** Browser-openable ComfyUI base URL (probe host + port). */
  openUrl?: string | null;
  error: string | null;
}

export interface TailscaleMetrics {
  /** True when `tailscale status --json` was read and had a Self entry. */
  available: boolean;
  /**
   * The node's OWN view of whether it is talking to the coordination server.
   * null when tailscale did not report it.
   */
  online: boolean | null;
  /** tailscaled's own state: Running | Stopped | NeedsLogin | NoState. */
  backendState: string | null;
  hostName: string | null;
  dnsName: string | null;
  tailscaleIp: string | null;
  /** DERP relay region, or null when the node has a direct path. */
  relay: string | null;
  /** ISO timestamp; null when key expiry is disabled for this node. */
  keyExpiry: string | null;
  keyExpired: boolean;
  version: string | null;
  /** Tailscale's own health warnings — these explain a false `online`. */
  health: string[];
  error: string | null;
}

// ─── Full metrics snapshot ────────────────────────────────
export interface SparkMetrics {
  gpu: GpuMetrics | null;
  cpu: CpuMetrics | null;
  ram: RamMetrics | null;
  storage: StorageMetrics[];
  network: NetworkMetrics | null;
  /** RoCE / RDMA ports; null when the unit has no RDMA devices. */
  roce?: RoceMetrics | null;
  unifiedMemory: UnifiedMemoryMetrics | null;
  /** Array of LLM metrics, one per configured port. Empty array when no ports. */
  llm: LlmMetrics[];
  /** ComfyUI probe result when monitoring is enabled; null when off or not yet polled. */
  comfy?: ComfyMetrics | null;
  /** Tailnet probe result when monitoring is enabled; null when off or not yet polled. */
  tailscale?: TailscaleMetrics | null;
}

// ─── Spark snapshot (server pushes this) ──────────────────
export interface SparkSnapshot {
  id: string;
  /** Active health findings, most important first is not guaranteed; sort with sortFindings. */
  health?: HealthFinding[];
  name: string;
  /** Unit type: spark (DGX Spark) or host (dedicated GPU Linux box). */
  kind?: "spark" | "host";
  online: boolean;
  /** Uptime in seconds, or null when offline */
  uptime: number | null;
  /** LAN IP for browser deep-links (e.g. Open ComfyUI). */
  lanIp?: string;
  isLocal?: boolean;
  disabledDevices: string[];
  disabledInterfaces: string[];
  storagePollDisabled?: boolean;
  /** Cluster role (head / worker / standalone) */
  role?: SparkRole;
  /** Distributed LLM worker — LLM card inactive / not shown (role === worker) */
  workerNode?: boolean;
  /** Optional cluster/model label when role is worker */
  workerLabel?: string | null;
  /**
   * Derived worker label: live mirror of the head's served model id.
   * Display-only (never written to config). A non-empty manual workerLabel
   * takes priority over this in the UI.
   */
  workerDerivedLabel?: string | null;
  /** Optional head Spark id when role is worker */
  workerHeadId?: string | null;
  /** Standalone: whether LLM is probed (head always true, worker always false) */
  llmMonitoring?: boolean;
  /** LLM server port (first port, for backward compat) */
  llmPort: number;
  /** All LLM server ports configured for this Spark */
  llmPorts: number[];
  /** Ports with a stored LLM API key (key itself never exposed) */
  llmApiKeyPorts?: number[];
  /** Whether ComfyUI is probed (opt-in; all roles) */
  comfyMonitoring?: boolean;
  /** ComfyUI HTTP port (default 8188) */
  comfyPort?: number;
  /** Whether tailnet presence is probed (opt-in; all roles) */
  tailscaleMonitoring?: boolean;
  /** Hermes Agent update monitoring state (present in every snapshot). */
  hermes?: HermesStatus;
  hardware: HardwareInfo;
  metrics: SparkMetrics;
}

// ─── WebSocket envelope ───────────────────────────────────
export interface WsSnapshot {
  type: "snapshot";
  /** Server generation time; optional while clients and servers roll independently. */
  generatedAt?: number;
  sparks: SparkSnapshot[];
  refreshInterval: number;
  /** Alert notifications' firing set — present only while `alertsEnabled` is on. */
  alerts?: { active: AlertInstance[] };
}

// ─── Alert notifications (server/alerts) ───
export type AlertSeverity = "warning" | "critical";

/**
 * One pending or firing alert (GET /api/alerts, WS `alerts.active`). The
 * condition is a Health finding or an Overview strip exception; `ruleId` is the
 * finding id (thermal, memory, …) or the strip's (offline, throttle, disk, llm, tailnet).
 */
export interface AlertInstance {
  /** `${unitId}:${ruleId}` — the same key the Overview strip uses. */
  key: string;
  ruleId: string;
  ruleName: string;
  unitId: string;
  unitName: string;
  severity: AlertSeverity;
  /** Highest severity reached while firing (a resolved alert is routed by it). */
  peakSeverity?: AlertSeverity;
  state: "pending" | "firing";
  /** Short predicate after the unit name ("GPU is running hot"). */
  label: string;
  summary: string;
  /** Epoch ms the condition first held — survives a server restart. */
  startsAt: number;
  firingAt: number | null;
}

/** One firing / resolved transition (newest first in `recent`). */
export interface AlertEvent {
  id: number;
  at: number;
  status: "firing" | "resolved";
  key: string;
  ruleId: string;
  ruleName: string;
  unitId: string;
  unitName: string;
  severity: AlertSeverity;
  label: string;
  summary: string;
  startsAt: number;
  endsAt: number | null;
}

export interface AlertsResponse {
  enabled: boolean;
  active: AlertInstance[];
  pending: AlertInstance[];
  recent: AlertEvent[];
}

/** A rule as GET /api/alerts/config describes it: where it comes from, on/off and `for`. */
export interface AlertRule {
  id: string;
  name: string;
  description: string;
  source: "health" | "strip";
  defaults: { enabled: boolean; forSec: number };
  /** Only the values the user changed. */
  overrides: { enabled?: boolean; forSec?: number };
}

export type AlertChannelType = "ntfy" | "discord" | "slack" | "webhook";

export interface AlertChannel {
  /** Absent on a channel added in the dialog and not yet saved. */
  id?: string;
  name: string;
  type: AlertChannelType;
  /** Masked by the server (`https://ntfy.sh…ab12`); send it back unchanged to keep it. */
  url: string;
  /** The server has a URL for this channel (in its encrypted secrets store). */
  hasUrl?: boolean;
  enabled: boolean;
  minSeverity: AlertSeverity;
  /** `lastError` is a status code or a fixed reason, never a server's answer. */
  status?: { lastSentAt: number | null; lastError: string | null; lastErrorAt: number | null };
}

export interface AlertsConfig {
  enabled: boolean;
  /** 0 = no reminders while an alert keeps firing. */
  repeatIntervalMin: number;
  rules: AlertRule[];
  channels: AlertChannel[];
}

export interface AlertsConfigUpdate {
  repeatIntervalMin?: number;
  rules?: Record<string, { enabled?: boolean; forSec?: number }>;
  channels?: AlertChannel[];
}

export interface AlertTestResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface FleetEnergy {
  estimated: boolean;
  membershipChanged: boolean;
  restartRequired: boolean;
  trackedNodeIds: string[];
  currentNodeIds: string[];
  freshNodeCount: number;
  currentWatts30s: number | null;
  energy24hKwh: number | null;
  energy31dKwh: number | null;
  whPerOutputToken24h: number | null;
  outputTokens24h: number;
  coverage24hMs: number;
  coverage31dMs: number;
  nodeCoverage24hMs: Record<string, number>;
  nodeCoverage31dMs: Record<string, number>;
  hourlyWatts24h: Array<number | null>;
}

/** One UTC month of the permanent energy roll-up. */
export interface MonthlyEnergyMonth {
  /** "YYYY-MM" (UTC). */
  month: string;
  startMs: number;
  /** Exclusive end of the month. */
  endMs: number;
  /** False while the month is still the current one. */
  closed: boolean;
  /** Nodes that reported in this month (the scope at the time). */
  nodeIds: string[];
  nodes: Record<string, { wh: number; coverageMs: number }>;
  totalWh: number;
  fleetWh: number;
  fleetCoverageMs: number;
  outputTokens: number;
  coveredOutputTokens: number;
  whPerOutputToken: number | null;
}

export interface MonthlyEnergy {
  estimated: boolean;
  generatedAt: number;
  foldedThroughMs: number;
  /** Oldest first. */
  months: MonthlyEnergyMonth[];
}

// ─── API responses ────────────────────────────────────────
export interface Settings {
  pollIntervalMs: number;
  defaultLlmPort: number;
  autoHideOffline: boolean;
  /** Hide worker-role Sparks from Overview cards and the tab bar. */
  hideWorkers: boolean;
  temperatureUnit: "celsius" | "fahrenheit";
  /** Persist prompts / HTTP traces / GPU samples on decode benchmark runs. */
  benchDebugTraces: boolean;
  /** Layout density — compact (default) or comfortable. */
  density: "comfortable" | "compact";
  /** Overview Fleet Energy card. Off by default. */
  showFleetEnergy: boolean;
  /** Overview active fleet exceptions strip. Off by default. */
  showFleetExceptions: boolean;
  /** Overview search field + status filter. Off by default. */
  showOverviewSearch: boolean;
  /** Benchmark dialogs offer "Copy image" — a PNG share card of the results. */
  benchShareImage: boolean;
  /** Alert notifications (Settings → Alerts). Off by default; while off nothing is evaluated or sent. */
  alertsEnabled?: boolean;
  /** Opt-in dense 48 h GPU/unit history + bucketed day/week tiers. Off by default (saves disk + CPU). */
  metricsHistory: boolean;
}

export interface SparksListResponse {
  sparks: SparkConfig[];
}

export interface SparkTestResponse {
  id: string;
  capabilities: Array<{
    id: "host" | "llm" | "comfy" | "hermes" | "tailnet";
    label: string;
    status: "pass" | "fail" | "skipped";
    required: boolean;
    message: string;
    recovery: string | null;
  }>;
  ssh: { ok: boolean; message: string };
  llm: { ok: boolean; message: string; skipped?: boolean };
  comfy?: { ok: boolean; message: string; skipped?: boolean };
  ok: boolean;
}

export interface ApiError {
  error: string;
}

// ─── LLM decode benchmark ────────────────────────────────
/** Output-shape label for decode bench prompts (not guided decoding). */
export type DecodeBenchPromptType = "structured" | "prose" | "code" | "json";

/** On-demand remote LLM endpoint for decode/prefill benches. */
export interface LlmBenchTarget {
  host: string;
  port: number;
  tls: boolean;
}

/** Decode bench protocol: Herd's own waves, AEON's aeon-perf-v1 ladder (BENCH3) or Hasso's battery v1 (BENCH4). */
export type DecodeBenchProtocol = "herd" | "aeon-perf-v1" | "hasso-battery-v1";

/** Hasso battery parts: bench.sh (streamed probes) and bench-matrix.sh (two-call delta). */
export type HassoPart = "bench" | "matrix";

/** Which API a decode bench runs under: a Spark or an agent node lane. */
export type DecodeBenchScope = "spark" | "node";

export interface DecodeBenchConfig {
  port: number;
  modelId: string | null;
  concurrencies: number[];
  maxTokens: number;
  /** Absent on herd runs. */
  protocol?: DecodeBenchProtocol;
  suiteVersion?: string;
  temperature?: number;
  categories?: string[];
  /** AEON / Hasso: total requests the run sends. */
  requests?: number;
  /** Hasso: bench-matrix.sh BATTERY_VERSION and the parts run. */
  batteryVersion?: number;
  parts?: HassoPart[];
  /** Output-shape label only — not guided decoding / JSON schema. */
  promptType?: DecodeBenchPromptType;
  /** On-demand remote host (Tailscale HTTPS, etc.). */
  host?: string;
  tls?: boolean;
}

export interface DecodeBenchStreamResult {
  index: number;
  ttftMs: number;
  /** First answer token (post-reasoning) in ms from request start; null when the reply never leaves the reasoning phase. */
  ttftContentMs: number | null;
  /** Number of streamed chunks that carried reasoning (not answer) text. */
  reasoningChunks: number;
  decodeTps: number;
  decodeTokens: number;
  completionTokens: number;
  prefillTps: number;
  prefillTokens: number;
  totalMs: number;
  error: string | null;
  /** Exact prompt used for this stream (debug). */
  prompt?: string | null;
  /** Compact HTTP/SSE trace (no full completion body). */
  http?: {
    url: string | null;
    status: number | null;
    headers: Record<string, string>;
    completionId: string | null;
    finishReason: string | null;
    sseEventCount: number;
    firstSseDataPreview: string | null;
    request: {
      model: string | null;
      maxTokens: number | null;
      temperature: number;
      stream: boolean;
      promptChars: number;
    };
  };
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  contentPreview?: {
    first: string;
    last: string;
    chars: number;
  } | null;
  decodeMs?: number | null;
}

/** One concurrency wave (all streams at that concurrency). */
export interface DecodeBenchLevelResult {
  concurrency: number;
  streamsOk: number;
  streamsFailed: number;
  /** Mean per-stream decode tok/s after first token */
  meanDecodeTps: number;
  medianDecodeTps: number;
  minDecodeTps: number;
  maxDecodeTps: number;
  meanTtftMs: number;
  medianTtftMs: number;
  /** Client: total post-first-token tokens / concurrent decode window (AEON: peak wave window) */
  aggregateDecodeTps: number;
  /** AEON only: agg_saturated_est = mean per-stream decode × concurrency. */
  aggSumDecodeTps?: number;
  meanPrefillTps: number;
  medianPrefillTps: number;
  /** Sum prompt tokens / concurrent TTFT window (min start → max first token) */
  aggregatePrefillTps: number;
  totalPrefillTokens: number;
  totalDecodeTokens: number;
  totalCompletionTokens: number;
  durationMs: number;
  error: string | null;
  streams: DecodeBenchStreamResult[];
  model: string | null;
  /** ~1 Hz GPU/VRAM/power samples during the wave (debug). */
  hardwareSamples?: Array<{
    t: number;
    gpuUsage: number | null;
    temperature: number | null;
    powerDraw: number | null;
    powerLimit?: number | null;
    vramUsed: number | null;
    vramTotal: number | null;
    vramAvailable?: number | null;
    memAvailable?: number | null;
  }>;
}

export interface DecodeBenchProgress {
  currentConcurrency: number | null;
  completedLevels: number;
  totalLevels: number;
  message: string;
  /** AEON ladder: category running now, and request counts. */
  currentCategory?: string | null;
  /** Hasso battery: part running now. */
  currentPart?: HassoPart | null;
  requestsDone?: number;
  requestsTotal?: number;
}

/** One AEON cell (perf_grid.py `_agg` fields). */
export interface AeonCell {
  n: number;
  n_errors: number;
  ttft_ms_mean: number | null;
  ttft_ms_p50: number | null;
  ttft_ms_p95: number | null;
  decode_tps_mean: number | null;
  prefill_tps_mean: number | null;
  e2e_ms_mean: number | null;
  tpot_ms_mean: number | null;
  tpot_ms_p50: number | null;
  tpot_ms_p95: number | null;
  output_tokens_total: number;
  input_tokens_total: number;
  /** Peak wave concurrent window (aeon.wave_peak_concurrent_window.v1). */
  agg_decode_tps: number | null;
  agg_source: string | null;
  concurrent_window_s: number | null;
  /** decode_tps_mean × conc (aeon.agg_saturated_est.v1). */
  agg_saturated_est: number | null;
  conc: number | null;
  wave_count: number | null;
  tokens_per_wall_s: number | null;
  tokens_source: string;
  case_id: string;
  cell_wall_s?: number;
  errors?: Array<{ category: string; error: string; prompt_head: string }>;
}

export interface AeonLevel {
  conc: number;
  wallClockS: number | null;
  overall: AeonCell;
  categories: Record<string, AeonCell>;
}

export interface AeonLadderRun {
  suite: "aeon-perf-v1";
  nonce: string;
  levels: AeonLevel[];
}

/** One streamed bench.sh run. */
export interface HassoBenchRun {
  /** (out − 1) / (t_last − t_first); null = "not timed". */
  tps: number | null;
  completionTokens: number | null;
  ttftMs: number | null;
  decodeMs: number | null;
}

export interface HassoBenchProbe {
  key: string;
  name: string;
  temperature: number;
  maxTokens: number;
  /** Counts toward the greedy median (code, reasoning). */
  inMedian: boolean;
  runs: HassoBenchRun[];
  median: number | null;
}

export interface HassoMatrixCall {
  wallS: number;
  tokens: number;
}

export interface HassoMatrixProbe {
  key: string;
  name: string;
  lang: string;
  short: HassoMatrixCall;
  long: HassoMatrixCall;
  deltaTokens: number;
  deltaS: number;
  /** Null when the sample was refused as unreliable. */
  tps: number | null;
  reliable: boolean;
  reason: string | null;
}

export interface HassoBatteryRun {
  suite: "hasso-battery-v1";
  batteryVersion: number;
  parts: HassoPart[];
  model: string | null;
  bench: {
    probes: HassoBenchProbe[];
    greedyMedian: number | null;
    greedyRuns: number;
    untimed: number;
  } | null;
  matrix: {
    batteryVersion: number;
    warmup: { wallS: number; tokens: number; discarded: boolean } | null;
    probes: HassoMatrixProbe[];
  } | null;
}

export interface HassoBatteryDefaults {
  suite: "hasso-battery-v1";
  suiteVersion: string;
  batteryVersion: number;
  parts: HassoPart[];
  runsPerProbe: number;
  benchProbes: Array<{ key: string; name: string; temperature: number; maxTokens: number; inMedian: boolean }>;
  matrixProbes: Array<{ key: string; name: string; lang: string }>;
  matrixMaxTokens: [number, number];
  minDeltaTokens: number;
  minDeltaS: number;
  requests: number;
}

export interface DecodeBenchJob {
  benchId: string;
  sparkId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt: number | null;
  config: DecodeBenchConfig & { debug?: boolean };
  progress: DecodeBenchProgress;
  results: DecodeBenchLevelResult[];
  /** AEON ladder runs only. */
  aeon?: AeonLadderRun;
  /** Hasso battery runs only. */
  hasso?: HassoBatteryRun;
  /** Agent-node runs only. */
  nodeId?: string;
  error: string | null;
  durationMs: number;
}

export interface AeonLadderDefaults {
  suite: "aeon-perf-v1";
  suiteVersion: string;
  ladder: number[];
  maxTokens: number;
  temperature: number;
  categories: string[];
  promptsPerCategory: number;
  requests: number;
}

/** LLM endpoint an agent node reports (GET /api/fleet/nodes/:id/llm/bench). */
export interface NodeLlmEndpoint {
  port: number;
  modelId: string | null;
  engine: string | null;
  engineVersion: string | null;
  quantization: string | null;
  contextLength: number | null;
  lane: string | null;
  pool: string | null;
}

export interface DecodeBenchDefaults {
  allowedConcurrencies: number[];
  defaultMaxTokens: number;
  minMaxTokens: number;
  maxMaxTokens: number;
  promptTypes: DecodeBenchPromptType[];
  defaultPromptType: DecodeBenchPromptType;
  protocols?: DecodeBenchProtocol[];
  aeon?: AeonLadderDefaults;
  hasso?: HassoBatteryDefaults;
}

export interface DecodeBenchListResponse {
  active: DecodeBenchJob | null;
  /** Most recent finished job (optionally for a given port) */
  last: DecodeBenchJob | null;
  history: DecodeBenchJob[];
  defaults: DecodeBenchDefaults;
  /** Node scope only. */
  endpoints?: NodeLlmEndpoint[];
}

export interface StartDecodeBenchRequest {
  port?: number;
  concurrencies: number[];
  maxTokens?: number;
  modelId?: string | null;
  /** Output type: structured (default), prose, code, json. Prompt only. */
  promptType?: DecodeBenchPromptType;
  /** On-demand remote LLM host (hostname or URL). Skips this Spark's LAN/SSH path. */
  host?: string;
  tls?: boolean;
  /** "aeon-perf-v1": AEON ladder (concurrencies ⊆ 1/4/8/16/32, 256 tokens). */
  protocol?: DecodeBenchProtocol;
  /** Hasso battery parts to run (default both). */
  parts?: HassoPart[];
}

// ─── LLM prefill benchmark ───────────────────────────────
export interface PrefillBenchConfig {
  port: number;
  modelId: string | null;
  contextSizes: number[];
  host?: string;
  tls?: boolean;
}

export interface PrefillBenchSizeResult {
  targetTokens: number;
  promptTokens: number;
  promptChars: number;
  prefillTps: number;
  ttftMs: number;
  ttftContentMs: number | null;
  completionTokens: number;
  durationMs: number;
  model: string | null;
  error: string | null;
}

export interface PrefillBenchProgress {
  currentContext: number | null;
  completedLevels: number;
  totalLevels: number;
  message: string;
}

export interface PrefillBenchJob {
  benchId: string;
  sparkId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt: number | null;
  config: PrefillBenchConfig;
  progress: PrefillBenchProgress;
  results: PrefillBenchSizeResult[];
  error: string | null;
  durationMs: number;
}

export interface PrefillBenchDefaults {
  allowedContextSizes: number[];
  defaultContextSizes: number[];
  minContextSize?: number;
  maxContextSize?: number;
}

export interface PrefillBenchListResponse {
  active: PrefillBenchJob | null;
  last: PrefillBenchJob | null;
  history: PrefillBenchJob[];
  defaults: PrefillBenchDefaults;
}

export interface StartPrefillBenchRequest {
  port?: number;
  contextSizes: number[];
  modelId?: string | null;
  host?: string;
  tls?: boolean;
}

// ─── LLM quality benchmark (#42) ─────────────────────────
export type QualityCategoryKey =
  | "qa"
  | "reasoning"
  | "arithmetic"
  | "state"
  | "gsm8k"
  | "mmlu"
  | "instruction"
  | "longctx";

export interface QualityCategoryInfo {
  key: QualityCategoryKey;
  label: string;
  count: number;
  optIn: boolean;
  source: string;
}

export interface QualityCategoryScore {
  key: QualityCategoryKey;
  label: string;
  total: number;
  attempted: number;
  scored: number;
  passed: number;
  errored: number;
  /** % of scored items passed; null when nothing was scored. */
  accuracy: number | null;
  maxTokens: number | null;
}

export interface QualitySummary {
  categories: QualityCategoryScore[];
  /** Mean of category %. */
  overall: number | null;
  itemsTotal: number;
  itemsScored: number;
  itemsErrored: number;
  passed: number;
}

export interface QualityBenchJob {
  benchId: string;
  sparkId: string;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  startedAt: number;
  completedAt: number | null;
  config: {
    port: number;
    modelId: string | null;
    categories: QualityCategoryKey[];
    concurrency: number;
    seed: number;
    suiteVersion: string;
    requests: number;
    host?: string;
    tls?: boolean;
  };
  progress: {
    done: number;
    total: number;
    errored: number;
    currentCategory: QualityCategoryKey | null;
    message: string;
  };
  summary: QualitySummary;
  error: string | null;
  durationMs: number;
}

/** One stored run (overall record in the bench results store). */
export interface QualityRunSummary {
  benchId: string;
  runId: string;
  status: string | null;
  startedAt: string | null;
  completedAt: string | null;
  modelId: string | null;
  engine: string | null;
  hwBucket: string | null;
  concurrency: number | null;
  categories: QualityCategoryScore[];
  overall: number | null;
  itemsScored: number | null;
  itemsErrored: number | null;
  passed: number | null;
  durationMs: number | null;
  suiteVersion: string | null;
}

export interface QualityBenchDefaults {
  categories: QualityCategoryInfo[];
  defaultCategories: QualityCategoryKey[];
  concurrencyOptions: number[];
  defaultConcurrency: number;
  seed: number;
  suiteVersion: string;
  noiseP: number;
  historyLimit: number;
}

export interface QualityBenchListResponse {
  active: QualityBenchJob | null;
  runs: QualityRunSummary[];
  defaults: QualityBenchDefaults;
}

export interface StartQualityBenchRequest {
  port?: number;
  categories: QualityCategoryKey[];
  concurrency: number;
  modelId?: string | null;
  host?: string;
  tls?: boolean;
}

export interface QualityMcNemar {
  paired: number;
  both_pass: number;
  both_fail: number;
  baseline_only: number;
  candidate_only: number;
  p: number;
  within_noise: boolean;
}

export interface QualityCompareResponse {
  baseline: QualityRunSummary;
  candidate: QualityRunSummary;
  warnings: string[];
  overall: { baseline: number | null; candidate: number | null; delta: number | null; mcnemar: QualityMcNemar };
  categories: Array<{
    key: QualityCategoryKey;
    label: string;
    baseline: number | null;
    candidate: number | null;
    delta: number | null;
    mcnemar: QualityMcNemar;
  }>;
  /** Item ids that passed in the baseline only. */
  regressed: string[];
  /** Item ids that passed in the candidate only. */
  improved: string[];
  noiseP: number;
}

// ─── LLM Prompt Showcase ─────────────────────────────────
export type ShowcasePromptType = "structural" | "text" | "mixed";

export interface ShowcaseStartRequest {
  port: number;
  modelId?: string | null;
  maxTokens?: number;
  /** Sampling temperature (0–2). Defaults to 0.7 on the server. */
  temperature?: number;
  /** When true, enable model thinking/reasoning flags (UI defaults to off). */
  thinking?: boolean;
  /** Catalog mode used to seed prompts (structural / text / mixed). */
  promptType?: ShowcasePromptType | null;
  prompts: string[];
}

export interface ShowcaseStreamState {
  streamId: string;
  label: string;
  prompt: string;
  status: "pending" | "streaming" | "completed" | "error" | "cancelled";
  contentAppend?: string;
  content?: string;
  contentLength: number;
  reasoningAppend?: string;
  reasoning?: string;
  reasoningLength?: number;
  resetContent?: boolean;
  tokenCount: number;
  ttftMs: number | null;
  decodeTps: number;
  liveTokPerSec: number;
  peakTokPerSec?: number;
  model: string | null;
  error: string | null;
}

export interface ShowcaseSessionState {
  sessionId: string;
  sparkId: string;
  status: "running" | "completed" | "cancelled" | "error";
  rev: number;
  port: number;
  modelId?: string | null;
  maxTokens?: number | null;
  temperature?: number;
  thinking?: boolean;
  promptType?: ShowcasePromptType | null;
  startedAt?: number;
  completedAt?: number | null;
  /** Median server generation tok/s from /metrics during the run (null if unavailable). */
  serverGenerationTps?: number | null;
  serverGenerationTpsMax?: number | null;
  serverGenerationSamples?: number;
  totalTokens?: number;
  meanDecodeTps?: number;
  peakStreamTps?: number;
  streamCount?: number;
  streams: ShowcaseStreamState[];
  error?: string | null;
  /** True when loaded from disk history (not a live poll session). */
  fromHistory?: boolean;
}

/** List-row for finished showcase runs (no stream bodies). */
export interface ShowcaseHistorySummary {
  sessionId: string;
  sparkId: string;
  status: "completed" | "cancelled" | "error" | string;
  port: number;
  modelId?: string | null;
  maxTokens?: number | null;
  temperature?: number;
  thinking?: boolean;
  promptType?: ShowcasePromptType | null;
  startedAt?: number | null;
  completedAt?: number | null;
  serverGenerationTps?: number | null;
  serverGenerationTpsMax?: number | null;
  totalTokens: number;
  meanDecodeTps: number;
  peakStreamTps: number;
  streamCount: number;
  error?: string | null;
}

export interface ShowcaseListResponse {
  active: { sessionId: string; status: string } | null;
  history: ShowcaseHistorySummary[];
}

export interface ShowcaseStartResponse {
  sessionId: string;
  status: "running";
}

// ─── Fleet (node-agent) — seam types re-exported from shared/types.ts ──────
// The node-agent fleet layer shares its seam types with the agent and the
// dashboard server; the frontend consumes them through this module. Names
// that collide with the Spark-side types above (GpuMetrics, CpuMetrics, …)
// stay shared-only and are imported directly from shared/types where needed.
export type {
  FleetSnapshot,
  NodeAgentSnapshot,
  MemoryBudget,
  MakeRoomEntry,
  MemoryService,
  RequestStat,
  RequestStats,
  RoceLink,
  ServiceInstance,
  TopologyInfo,
  VersionInfo,
  ContainerInfo,
  // S3.1 lane seam types (types only — no component reads them yet; S3.2 owns the UI).
  RecipeLane,
  LaneEntry,
  LanePool,
  LaneCandidate,
  NodeLanes,
  // POC2 component-action seam types (issue #7 Components tab consumes these).
  ComponentActionType,
  ComponentActionConfirm,
  ComponentActionRequest,
  ComponentActionStep,
  ComponentActionTraffic,
  ComponentActionResult,
  ComponentActionPlan,
} from "../../shared/types";

// ─── Fleet updates (docs/SPEC-UPDATES.md §6/§9) ────
// NodeUpdatesView / FleetUpdatePlan et al. are the §9 seam types; the
// dashboard server (server/index.js + server/fleet/updatesProxy.js) emits
// exactly those shapes. The wrappers below mirror the 7 updates routes' actual
// response bodies, route by route.
export type {
  DgxFirmwareUpdate,
  DgxOtaInfo,
  DgxPackageUpdate,
  DgxUpdateSnapshot,
  DgxUpdateStage,
  DgxUpdateState,
  FleetUpdatePlan,
  NodeUpdateSchedule,
  NodeUpdatesView,
  UpdateGroup,
} from "../../shared/types";

// Local bindings for the two §9 names the wrappers below reference (the
// `export type … from` re-export does not introduce local names).
import type { FleetUpdatePlan, NodeUpdatesView } from "../../shared/types";

/** GET /api/fleet/updates → one NodeUpdatesView per registered node. */
export interface FleetUpdatesResponse {
  views: NodeUpdatesView[];
}

/** Live wave state, as emitted by waveSequencer.getWaveStates(). */
export type FleetWaveState = "pending" | "running" | "rebooting" | "slow" | "healthy";

/** GET /api/fleet/updates/plan → stored plan (null = none) + live wave states. */
export interface FleetPlanResponse {
  plan: FleetUpdatePlan | null;
  waveStates: FleetWaveState[];
}

/** POST /api/fleet/updates/plan → stored (normalized) plan echoed back. */
export interface SavePlanResponse {
  success: boolean;
  plan: FleetUpdatePlan;
}

/** DELETE /api/fleet/updates/plan. */
export interface AbandonPlanResponse {
  success: boolean;
  abandoned: boolean;
}

/**
 * Passthrough body of an agent action (now / schedule / cancel) proxied via
 * POST /actions: the server forwards the agent's JSON (or `{ ok: true }`).
 * The authoritative schedule list arrives via the refreshed fleet-updates view,
 * never from this passthrough.
 */
export interface UpdateActionResponse {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * POST /api/fleet/nodes/:id/updates/schedule request body. `at` is epoch-ms
 * (§9 NodeUpdateSchedule.at); `cron` a 5-field expression; mirrorCron installs
 * a host crontab entry too. The agent owns the one-pending-per-node rule.
 */
export interface ScheduleUpdateRequest {
  kind: "at" | "cron";
  at?: number;
  cron?: string;
  mirrorCron?: boolean;
}
// ─── Unit history (GET /api/sparks/:id/history) ──────────
export type MetricsHistoryRange = "1h" | "6h" | "24h" | "7d" | "30d";

/** One series in one bucket. `min` only on memFreeMB (headroom's low point). */
export interface HistoryStat {
  avg: number;
  max: number;
  min?: number;
}

/** Unit-level series: %, °C, W, MB, bytes/s. */
export type HistoryUnitSeries =
  | "gpuUtil"
  | "gpuTemp"
  | "gpuPower"
  | "memUsedMB"
  | "memFreeMB"
  | "cpuUtil"
  | "cpuTemp"
  | "ramUsedMB"
  | "netRx"
  | "netTx";

/** Per LLM endpoint: tok/s, and the KV pool fill as 0–1. */
export type HistoryLlmSeries = "genTps" | "prefillTps" | "kvUsage";

/** A bucket; a series the unit did not report in it is absent (a gap). */
export type HistoryPoint = { t: number } & Partial<Record<HistoryUnitSeries, HistoryStat>>;
export type HistoryLlmPoint = { t: number } & Partial<Record<HistoryLlmSeries, HistoryStat>>;

export interface MetricsHistoryData {
  enabled: true;
  range: MetricsHistoryRange;
  /** Bucket width of the points; a jump larger than this is a gap. */
  stepMs: number;
  /** Window the range covers (epoch ms); the x-axis spans exactly this. */
  from: number;
  to: number;
  points: HistoryPoint[];
  llm: Array<{ port: number; points: HistoryLlmPoint[] }>;
}

export type MetricsHistoryResponse = MetricsHistoryData | { enabled: false };

// ─── GPU raw history (GET /api/sparks/:id/gpu-history) ───
/**
 * Parallel arrays, newest last. `p` may hold nulls (power unknown). `gpus`
 * lists the cards of a multi-GPU host, each with arrays parallel to `t`.
 */
export interface GpuHistoryDevice {
  index: number;
  name: string | null;
  u: Array<number | null>;
  c: Array<number | null>;
  p: Array<number | null>;
}

export interface GpuHistoryResponse {
  t: number[];
  u: number[];
  c: number[];
  p: Array<number | null>;
  gpus: GpuHistoryDevice[];
}

// ─── Guard proxy (GET /api/guard) ─────────────────────────

/** Normalized guard status; anything the probe cannot classify is "unknown". */
export type GuardStatus = "running" | "degraded" | "stopped" | "unknown";

/** One crash-timeline entry; a null field means the guard reported none. */
export interface GuardTimelineEntry {
  at: string | null;
  kind: string | null;
  detail: string | null;
}

/**
 * One probed guard-proxy. Field names mirror the server JSDoc in
 * server/health/guardProbe.js exactly (S4.1b).
 */
export interface GuardResult {
  id: string | null;
  label: string | null;
  present: boolean;
  status: GuardStatus;
  /** Held requests in the guard's queue; null when absent or malformed. */
  heldRequests: number | null;
  crashTimeline: GuardTimelineEntry[];
  /** ISO timestamp of when the probe ran. */
  checkedAt: string;
  /** null when present; else "unreachable" | "timeout" | "malformed" | "http-<code>". */
  reason: string | null;
}

// ─── Memory health (GET /api/memory-health) ───────────────────────

/** Normalized memory-service status; anything outside ok/degraded is "unknown". */
export type MemoryStatus = "ok" | "degraded" | "unknown";

/**
 * One probed AI-memory service (Qdrant store or embedder). Field names mirror
 * the server JSDoc in server/health/memoryProbe.js exactly (S5.1b).
 */
export interface MemoryServiceResult {
  id: string | null;
  label: string | null;
  /** "qdrant" | "embedder" | any other string the config carries. */
  kind: string | null;
  /** true only for usable JSON with reason null. */
  present: boolean;
  status: MemoryStatus;
  version: string | null;
  /** /v1/models data length, else null. */
  modelCount: number | null;
  /** ISO timestamp of when the probe ran. */
  checkedAt: string;
  /** null when present; else "unreachable" | "timeout" | "malformed" | "http-<code>". */
  reason: string | null;
}
