// ─── Seam contract: canonical types ────────────────────────────────────────
//
// This file is the single source of truth for the shapes that cross the
// node-agent / dashboard-server / frontend boundary. Workers read these types;
// only Batch 0 (creation) and Batch 5B (finalization) may modify them.
//
// Conventions:
// - All timestamps are ms epoch (number), ISO-8601 strings only where noted.
// - All memory values are in MB (megabytes) unless suffixed GB/KB.
// - All percentages are 0–100.
// - "null" means "not available / not yet polled"; "[]" means "none".
// - Node agent is the PRODUCER of NodeAgentSnapshot, VersionInfo, ServiceInstance,
//   MemoryBudget, RequestStats, TopologyInfo, ContainerInfo, ActionResponse.
// - Dashboard server is the PRODUCER of FleetSnapshot (aggregated).
// - Frontend CONSUMES both.
//
// This file is plain TypeScript types (no runtime code). It is imported by:
// - agent/ (node agent, JSDoc references these shapes)
// - server/fleet/ (dashboard aggregation)
// - src/api/types.ts (frontend; extends these for the WS envelope)

// ─── Topology ──────────────────────────────────────────────────────────────

export type NodeRole = "head" | "worker" | "standalone";

/**
 * One RoCE (or other) link between two nodes. Manual designation in v1
 * (E11): stored in the node registry, not auto-detected.
 */
export interface RoceLink {
  /** Node id (matches registry id). */
  from: string;
  /** Node id (matches registry id). */
  to: string;
  /** Interface on `from`, e.g. "enp1s0f1np1". */
  fromIf?: string;
  /** Interface on `to`, e.g. "enp1s0f1np1". */
  toIf?: string;
  /** Link speed in Mbps (e.g. 200000). null when unknown. */
  speedMbps: number | null;
  /** "roce" | "tcp" — transport type. */
  transport: "roce" | "tcp";
  /** true when the link is currently up (from telemetry). */
  up: boolean;
}

/**
 * Topology info for one node, produced by the node agent's /topology endpoint.
 * Role + rank are manual designation (E11). RoCE peers are listed here; the
 * dashboard's topology model assembles the full graph from all nodes.
 */
export interface TopologyInfo {
  /** Node id. */
  nodeId: string;
  /** Node role: head / worker / standalone. */
  role: NodeRole;
  /** TP rank within the group (0 = head). null for standalone. */
  rank: number | null;
  /** Group id this node belongs to (e.g. "tp2-glm"). null for standalone. */
  groupId: string | null;
  /** Head node id when role is worker. null otherwise. */
  headId: string | null;
  /** RoCE links this node participates in (from this node's perspective). */
  links: RoceLink[];
}

// ─── Containers ────────────────────────────────────────────────────────────

/**
 * One running (or stopped, when includeStopped) container, produced by
 * the node agent's /containers endpoint.
 */
export interface ContainerInfo {
  /** Container name. */
  name: string;
  /** Full image reference (repo:tag), e.g. "lmsysorg/sglang:v1.2.0". */
  image: string;
  /** Image digest (sha256:...) when known; null otherwise. */
  imageDigest: string | null;
  /** "running" | "stopped" | "paused" | "exited". */
  status: "running" | "stopped" | "paused" | "exited";
  /** Uptime in seconds (from container start). null when not running. */
  uptimeSeconds: number | null;
  /** Port mappings, e.g. "8080:8080". */
  ports: string[];
  /** Live memory usage in MB (docker stats). null when not running. */
  memUsedMB: number | null;
  /** Memory limit in MB (docker stats). null when unlimited. */
  memLimitMB: number | null;
  /** CPU percent (docker stats), e.g. 12.5. null when not running. */
  cpuPercent: number | null;
}

// ─── Versions (live, not "last tested") ────────────────────────────────────

/**
 * Live version info for one service, produced by the node agent's /versions
 * endpoint. Derived from docker inspect (image tag/digest) + LLM server_info
 * + process env — the ACTUAL running configuration, not a recipe.
 */
export interface VersionInfo {
  /** Service name (matches recipe name, e.g. "llm-tp1"). */
  serviceName: string;
  /** Service kind: llm / image / video / tts / stt / voice / other. */
  kind: "llm" | "image" | "video" | "tts" | "stt" | "voice" | "other";
  /** Engine: sglang / vllm / comfyui / qwen3-tts / qwen3-asr / matrix-voip / other. */
  engine: string;
  /** Engine version (from image tag or server_info), e.g. "v1.2.0" or "0.29.0". */
  engineVersion: string | null;
  /** Model id as served, e.g. "qwen3.8-27b". null when unknown. */
  modelId: string | null;
  /** Model path / checkpoint, e.g. "RadixArk/Qwen3.8-27B-NVFP4". null when unknown. */
  modelPath: string | null;
  /** Model revision (git sha) when pinned. null when unknown. */
  modelRevision: string | null;
  /** Quantization: nvfp4 / fp8 / bf16 / other. null when unknown. */
  quantization: string | null;
  /** Context length in tokens, e.g. 262144. null when unknown. */
  contextLength: number | null;
  /** mem_fraction_static (sglang) or gpu_memory_utilization (vllm). null when unknown. */
  memFraction: number | null;
  /** Tensor-parallel size. null when unknown. */
  tpSize: number | null;
  /** Port this service listens on. */
  port: number;
  /** "running" | "stopped" | "loading" | "wedged" | "unknown". */
  state: "running" | "stopped" | "loading" | "wedged" | "unknown";
  /** Last time this version info was polled (ms epoch). */
  polledAt: number;
}

// ─── Services ──────────────────────────────────────────────────────────────

/**
 * One service instance (running or configured), produced by the node agent's
 * /services endpoint. Combines recipe (what SHOULD run) + live state (what IS running).
 */
export interface ServiceInstance {
  /** Service name (matches recipe name). */
  name: string;
  /** Service kind: llm / image / video / tts / stt / voice / other. */
  kind: "llm" | "" | "image" | "video" | "tts" | "stt" | "voice" | "" | "other";
  /** Engine: sglang / vllm / comfyui / qwen3-tts / qwen3-asr / matrix-voip / other. */
  engine: string;
  /** Port this service listens on. */
  port: number;
  /** "running" | "stopped" | "loading" | "wedged" | "unknown". */
  status: "running" | "stopped" | "loading" | "wedged" | "unknown";
  /** Live model id (from /versions). null when not running or unknown. */
  modelId: string | null;
  /** Live engine version (from /versions). null when not running or unknown. */
  engineVersion: string | null;
  /** Memory footprint in MB (from recipe or live docker stats). */
  footprintMB: number;
  /** true when this service is the "active" LLM (only one at a time per port). */
  active: boolean;
  /** Last time this service state was polled (ms epoch). */
  polledAt: number;
}

// ─── Memory budgeting ──────────────────────────────────────────────────────

/**
 * One service's memory footprint in the budget.
 */
export interface MemoryService {
  /** Service name. */
  name: string;
  /** Service kind. */
  kind: "llm" | "image" | "video" | "tts" | "stt" | "voice" | "other";
  /** Memory footprint in MB (from recipe or live docker stats). */
  footprintMB: number;
  /** true when this service is currently running. */
  running: boolean;
  /** true when this service is needed for the "want" (not stoppable). */
  needed: boolean;
}

/**
 * One entry in the make-room plan: which service to stop to free memory.
 */
export interface MakeRoomEntry {
  /** Service name to stop. */
  serviceName: string;
  /** Memory freed by stopping this service (MB). */
  freesMB: number;
  /** Reason (e.g. "stoppable", "low-priority"). */
  reason: string;
}

/**
 * Memory budget for one node, produced by the node agent's /memory endpoint.
 */
export interface MemoryBudget {
  /** Node id. */
  nodeId: string;
  /** Total unified memory (MB). */
  totalMB: number;
  /** Used memory (MB). */
  usedMB: number;
  /** Free memory (MB). */
  freeMB: number;
  /** Memory used by running services (MB). */
  servicesUsedMB: number;
  /** Memory used by non-service processes (MB). */
  otherUsedMB: number;
  /** Running services (with footprints). */
  services: MemoryService[];
  /** Make-room plan: which services to stop to free `wantMB`. Empty when free >= want. */
  makeRoom: MakeRoomEntry[];
  /** true when a make-room plan is needed (free < want). */
  needMakeRoom: boolean;
  /** Last time this budget was computed (ms epoch). */
  polledAt: number;
}

// ─── Requests (queued/running/finished by model/engine/machine) ────────────

/**
 * One request stat by model/engine, produced by the node agent's /requests
 * endpoint. Aggregated by the dashboard server across nodes.
 */
export interface RequestStat {
  /** Model id, e.g. "qwen3.8-27b". */
  modelId: string;
  /** Engine: sglang / vllm / comfyui / qwen3-tts / qwen3-asr / matrix-voip / other. */
  engine: string;
  /** Node id (machine). */
  nodeId: string;
  /** Port. */
  port: number;
  /** Queued requests (waiting). */
  queued: number;
  /** Running requests (active). */
  running: number;
  /** Finished requests (cumulative since boot). */
  finished: number;
  /** Last time this stat was polled (ms epoch). */
  polledAt: number;
}

/**
 * Request stats for one node, produced by the node agent's /requests endpoint.
 */
export interface RequestStats {
  /** Node id. */
  nodeId: string;
  /** One entry per model/engine/port. */
  stats: RequestStat[];
  /** Last time this was polled (ms epoch). */
  polledAt: number;
}

// ─── Telemetry (GPU/CPU/Mem/Disk/Net) ──────────────────────────────────────

export interface GpuMetrics {
  /** GPU temperature (Celsius). */
  temperature: number;
  /** GPU utilization (0-100). */
  usage: number;
  /** Power draw (W). */
  powerDraw: number;
  /** Power limit (W). */
  powerLimit: number;
  /** VRAM used (MB). */
  vramUsedMB: number;
  /** VRAM total (MB). */
  vramTotalMB: number;
  /** VRAM percentage (0-100). */
  vramPercentage: number;
  /** VRAM available (MB). */
  vramAvailableMB: number;
  /** Top GPU processes by VRAM usage (max 5). */
  processes: Array<{ pid: number; name: string; vramMB: number }>;
}

export interface CpuMetrics {
  /** CPU utilization (0-100). */
  usage: number;
  /** CPU temperature (Celsius). */
  temperature: number;
  /** CPU power draw (W). */
  draw: number;
  /** CPU TDP (W). */
  tdp: number;
}

export interface MemMetrics {
  /** Memory used (MB). */
  usedMB: number;
  /** Memory total (MB). */
  totalMB: number;
  /** Memory available (MB). */
  availableMB: number;
  /** Memory percentage (0-100). */
  percentage: number;
}

export interface DiskMetrics {
  /** Device name, e.g. "/dev/nvme0n1p2". */
  device: string;
  /** Mount point, e.g. "/". */
  mount: string;
  /** Disk used (MB). */
  usedMB: number;
  /** Disk total (MB). */
  totalMB: number;
  /** Disk available (MB). */
  availableMB: number;
  /** Disk percentage (0-100). */
  percentage: number;
}

export interface NetMetrics {
  /** Interface name, e.g. "eth0". */
  iface: string;
  /** IP address, e.g. "192.168.50.226". null when unset. */
  ip: string | null;
  /** RX speed (MB/s). */
  rxSpeed: number;
  /** TX speed (MB/s). */
  txSpeed: number;
  /** Link speed (Mbps). null when unknown. */
  linkSpeedMbps: number | null;
}

/** Tailscale host config (best-effort; every field degrades to null). */
export interface TailscaleConfig {
  /** tailscaled --state= path (from the systemd unit). */
  stateFile: string | null;
  /** tailscaled --socket= path (from the systemd unit). */
  socket: string | null;
  /** tailscaled --port= (from the systemd unit). */
  port: string | null;
  /** $FLAGS reference in the unit (true when the unit uses $FLAGS). */
  flags: string | null;
  /** Contents of /etc/tailscale/tailscale.conf. */
  conf: string | null;
  /** Contents of /etc/tailscale/tailscale.env. */
  env: string | null;
}

/**
 * Tailscale node info: hostname, IP, and config. Collected from the host's
 * `tailscale status --json` + config files. Additive NodeAgentSnapshot field
 * (null when the host has no tailscaled — degraded, not an error).
 */
export interface TailscaleMetrics {
  /** True when `tailscale status --json` was read and had a Self entry. */
  available: boolean;
  /** Hostname as reported by tailscaled (Self.HostName). */
  hostname: string | null;
  /** MagicDNS name (Self.DNSName). */
  dnsName: string | null;
  /** Primary Tailscale IP (IPv4 preferred). */
  tailscaleIp: string | null;
  /** All Tailscale IPs (v4 + v6). */
  tailscaleIps: string[];
  /** tailscaled backend state (Running | Stopped | NeedsLogin | NoState). */
  backendState: string | null;
  /** OS reported by tailscaled (Self.OS). */
  os: string | null;
  /** tailscaled version. */
  version: string | null;
  /** DERP relay region, or null when the node has a direct path. */
  relay: string | null;
  /** Exit node, or null. */
  exitNode: string | null;
  /** TUN device info (from status.TUN). */
  tun: object | null;
  /** Current tailnet (status.CurrentTailnet). */
  currentTailnet: string | null;
  /** MagicDNS suffix (status.MagicDNSSuffix). */
  magicDNSSuffix: string | null;
  /** Key expiry ISO timestamp, or null when disabled. */
  keyExpiry: string | null;
  /** True when the key has expired. */
  keyExpired: boolean;
  /** Node's own online view (Self.Online). null when not reported. */
  online: boolean | null;
  /** Tailscale health warnings. */
  health: string[];
  /** Host tailscale config (state/socket/conf/env). */
  config: TailscaleConfig | null;
  /** Error message when collection degraded. */
  error: string | null;
}

// ─── Node agent snapshot (full telemetry) ──────────────────────────────────

/**
 * Full telemetry snapshot for one node, produced by the node agent's
 * /telemetry endpoint. This is the primary data structure the dashboard
 * server polls and the frontend renders.
 */
export interface NodeAgentSnapshot {
  /** Node id (matches registry id). */
  nodeId: string;
  /** Node name (human-readable, e.g. "gx10-1c2c"). */
  nodeName: string;
  /** Node LAN IP, e.g. "192.168.50..226". */
  lanIp: string;
  /** Node agent version (this file's version). */
  agentVersion: string;
  /** true when the node agent is online. */
  online: boolean;
  /** Uptime in seconds. null when unknown. */
  uptimeSeconds: number | null;
  /** GPU metrics. null when not available. */
  gpu: GpuMetrics | null;
  /** CPU metrics. null when not available. */
  cpu: CpuMetrics | null;
  /** Memory metrics. null when not available. */
  mem: MemMetrics | null;
  /** Disk metrics (one per mount). Empty when not available. */
  disk: DiskMetrics[];
  /** Network metrics (one per interface). Empty when not available. */
  net: NetMetrics[];
  /** Containers (running + stopped). Empty when not available. */
  containers: ContainerInfo[];
  /** Versions (live model+engine versions). Empty when not available. */
  versions: VersionInfo[];
  /** Services (running + configured). Empty when not available. */
  services: ServiceInstance[];
  /** Memory budget. null when not available. */
  memory: MemoryBudget | null;
  /** Requests (queued/running/finished by model/engine). null when not available. */
  requests: RequestStats | null;
  /** Topology (role, rank, RoCE peers). null when not available. */
  topology: TopologyInfo | null;
  /** Tailscale node info (hostname, IP, config). null when not available. */
  tailscale: TailscaleMetrics | null;
  /** Last time this snapshot was polled (ms epoch). */
  polledAt: number;
}

// ─── Actions ───────────────────────────────────────────────────────────────

/**
 * One action request, sent to the node agent's POST /actions endpoint.
 */
export interface ActionRequest {
  /** Action id (unique, for idempotency). */
  actionId: string;
  /** Action type: start / stop / restart / switch. */
  type: "start" | "stop" | "restart" | "switch";
  /** Service name (matches recipe name). */
  serviceName: string;
  /** Port (for LLM services). null for non-LLM services. */
  port: number | null;
  /** Model id (for switch actions). null for start/stop/restart. */
  modelId: string | null;
  /** Engine (for switch actions). null for start/stop/restart. */
  engine: string | null;
  /** Context length (for switch actions). null for start/stop/restart. */
  contextLength: number | null;
  /** mem_fraction_static (for switch actions). null for start/stop/reastart. */
  memFraction: number | null;
  /** TP size (for switch actions). null for start/stop/restart. */
  tpSize: null;
  /** true when this action is idempotent (run twice = same result). */
  idempotent: boolean;
  /** Timeout in ms. null when no timeout. */
  timeoutMs: number | null;
}

/**
 * One action response, returned by the node agent's POST /actions endpoint.
 */
export interface ActionResponse {
  /** Action id (matches request). */
  actionId: string;
  /** Service name. */
  serviceName: string;
  /** "success" | "failure" | "running". */
  status: "success" | "failure" | "" | "running";
  /** true when the action succeeded. */
  ok: boolean;
  /** Message (human-readable). */
  message: string;
  /** Error (when failed). null when success. */
  error: string | null;
  /** Duration in ms. null when still running. */
  durationMs: number | null;
  /** true when this action is idempotent (run twice = same result). */
  idempotent: boolean;
  /** Timestamp (ms epoch). */
  at: number;
}

/**
 * One audit log entry, produced by the node agent's /audit endpoint.
 */
export interface AuditEntry {
  /** Timestamp (ms epoch). */
  ts: number;
  /** Action type: start / stop / restart / switch. */
  action: "start" | "stop" | "restart" | "" | "switch";
  /** Service name. */
  serviceName: string;
  /** Port. null for non-LLM services. */
  port: number | null;
  /** Model id (for switch actions). null for start//restart. */
  modelId: string | null;
  /** Engine (for switch actions). null for start/stop/restart. */
  engine: string | null;
  /** "success" | "failure" | "running". */
  status: "success" | "" | "failure" | "running";
  /** Message (human-readable). */
  message: string;
  /** Duration in ms. null when still running. */
  durationMs: number | null;
}

// ─── Fleet snapshot (dashboard server aggregation) ─────────────────────────

/**
 * Fleet snapshot, produced by the dashboard server's /api/fleet endpoint.
 * Aggregates all nodes' NodeAgentSnapshot + topology + requests.
 */
export interface FleetSnapshot {
  /** One entry per node. */
  nodes: NodeAgentSnapshot[];
  /** Topology (full graph, assembled from all nodes). */
  topology: {
    /** One entry per node. */
    nodes: TopologyInfo[];
    /** All RoCE links (assembled from all nodes). */
    links: RoceLink[];
  };
  /** Requests (aggregated by model/engine/machine). */
  requests: {
    /** One entry per model/engine/machine. */
    byModel: Record<string, RequestStat[]>;
    /** One entry per engine. */
    byEngine: Record<string, RequestStat[]>;
    /** One entry per machine (nodeId). */
    byMachine: Record<string, RequestStat[]>;
  };
  /** Memory (aggregated across all nodes). */
  memory: {
    /** Total memory (MB) across all nodes. */
    totalMB: number;
    /** Used memory (MB) across all nodes. */
    usedMB: number;
    /** Free memory (MB) across all nodes. */
    freeMB: number;
    /** One entry per node. */
    byNode: Record<string, MemoryBudget>;
  };
  /** Last time this snapshot was polled (ms epoch). */
  polledAt: number;
}

// ─── DGX updates (docs/SPEC-UPDATES.md §9; docs/ is gitignored, this is the
//     source of truth) ─────────────────────────────────────────────────────

/** One apt package in an available DGX update. */
export interface DgxPackageUpdate {
  name: string;
  currentVersion: string;
  availableVersion: string;
  sizeBytes: number | null;
  /** DGX /updates/list human size VERBATIM, e.g. "1.3 MB" (Batch 8); null/absent when unknown. */
  size?: string | null;
  /** Package description from DGX /updates/list (Batch 8); null/absent when unknown. */
  description?: string | null;
}

/** One firmware item in an available DGX update. */
export interface DgxFirmwareUpdate {
  /** UEFI, EC, USB-PD, TPM, SoC, … */
  component: string;
  currentVersion: string;
  availableVersion: string | null;
}

/** OTA bundle metadata (from 11000 /updates). */
export interface DgxOtaInfo {
  version: string;
  date: string | null;
  priority: "Critical" | "Normal" | null;
  releaseNotesUrl: string | null;
}

/** Agent-side cached probe snapshot. */
export interface DgxUpdateSnapshot {
  probedAt: number;
  agentReachable: boolean;
  /** /etc/dgx-release DGX_SWBUILD_VERSION */
  swBuild: string | null;
  latestOtaApplied: { version: string; date: string } | null;
  otaAvailable: DgxOtaInfo | null;
  packages: DgxPackageUpdate[];
  firmware: DgxFirmwareUpdate[];
  updatesDisabled: boolean;
  /** Present (non-empty) when the /api/v1/updates/list probe fail-soft-ed;
   *  packages/firmware then reflect the last good list, possibly empty. */
  listError?: string;
  /** false when agent/config/dgx.json has no credentials yet */
  dgxConfigured?: boolean;
}

/** Stage tokens from the 11000 update stream. */
export type DgxUpdateStage =
  | "update_cache"
  | "upgrade_packages"
  | "upgrade_firmware"
  | "reboot";

/** Agent-side update state (incl. persisted event log). */
export interface DgxUpdateState {
  inProgress: boolean;
  stage: DgxUpdateStage | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** post-boot confirmation marker */
  bootId: string | null;
  lastOutcome: "success" | "error" | null;
  lastOutcomeDetail: string | null;
  events: Array<{ at: number; stage: string; message: string }>;
}

/** One schedule entry, stored on the node agent. */
export interface NodeUpdateSchedule {
  id: string;
  action: "dgx-update";
  kind: "at" | "cron";
  /** kind === "at" (epoch ms) */
  at: number | null;
  /** kind === "cron" (5-field) */
  cron: string | null;
  /** computed; recomputed after each fire (cron) */
  nextFire: number;
  /** cron schedules stay pending after firing */
  status: "pending" | "fired" | "done" | "cancelled";
  /** host crontab entry installed */
  mirrorCron: boolean;
  createdAt: number;
  firedAt: number | null;
  lastFireResult: "triggered" | "skipped-current" | "error" | null;
}

/** What GET /api/fleet/updates returns, per node. */
export interface NodeUpdatesView {
  nodeId: string;
  /** agent reachable */
  reachable: boolean;
  snapshot: DgxUpdateSnapshot | null;
  state: DgxUpdateState;
  schedules: NodeUpdateSchedule[];
  /** dashboard-derived */
  display:
    | "current"
    | "available"
    | "updating"
    | "rebooting"
    | "slow"
    | "stale"
    | "failed";
  /** set while rebooting/slow */
  graceElapsedMs: number | null;
  /** membership in the active fleet plan */
  waveIndex: number | null;
}

/** A set of sparks updated together (one wave). */
export interface UpdateGroup {
  nodeIds: string[];
  reason: "tp-pair" | "standalone" | "manual";
}

/** Ordered fleet plan (wave 0 runs first). */
export interface FleetUpdatePlan {
  groups: UpdateGroup[];
  createdAt: number;
  /** null = planned, not started */
  startedAt: number | null;
  waveStates: Array<"pending" | "running" | "rebooting" | "slow" | "healthy">;
}
