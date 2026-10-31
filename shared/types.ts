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
  /** true when a make-room plan is needed (free < want, or a TP group's
   *  per-spark need exceeds free — SC3). */
  needMakeRoom: boolean;
  /**
   * SC3: memory here available to a TP group's per-spark shard (MB). Only
   * present when the budget was computed with a group context
   * (agent/catalog/memory.js → computeMemoryBudget opts.group).
   */
  groupAvailableMB?: number;
  /** Last time this budget was computed (ms epoch). */
  polledAt: number;
}

// ─── Multi-spark / TP-group resource calculator (SC3) ────────────────────
//
// Extends the single-node MemoryBudget above to a group of sparks running
// one TP=x service (agent/catalog/memory.js → computeGroupMemoryBudget).
// A TP group is n sparks holding ONE model: each spark carries an equal
// shard, so the group's memory story is per-spark plus a group total —
// never a plain fleet sum (shared per-spark state would be double-counted).

/**
 * One spark inside a group resource plan (SC3).
 */
export interface GroupSparkEntry {
  /** Node id (matches registry id). */
  nodeId: string;
  /** true when this spark is the TP rank-0 head of the group. */
  head: boolean;
  /** Total unified memory on this spark (MB). */
  totalMB: number;
  /** Memory currently used on this spark (MB). */
  usedMB: number;
  /** Memory free on this spark before the plan (MB). */
  freeMB: number;
  /** Per-spark footprint of the planned TP service (MB, perSpark × shards). */
  plannedMB: number;
  /** Projected free after the plan (can go negative → tight/blocked). */
  projectedFreeMB: number;
  /** One make-room entry per spark (mirrors MemoryBudget.makeRoom). */
  makeRoom: MakeRoomEntry[];
  /** true when this spark can host its shard (make-room applied if needed). */
  feasible: boolean;
}

/**
 * Group-level resource plan for one TP=x service across n sparks
 * (agent/catalog/memory.js → computeGroupMemoryBudget). The single-node
 * per-spark math is delegated to computeMemoryBudget; this wrapper adds the
 * TP sharding, the group total + per-spark breakdown, and the bootstrap
 * estimate provenance.
 */
export interface GroupResourcePlan {
  /** Group id (e.g. "tp2-glm"). */
  groupId: string;
  /** Tensor-parallel size of the planned service (== number of shards). */
  tp: number;
  /** Spark ids in the group, sorted; length must equal tp. */
  sparkIds: string[];
  /** Per-spark footprint of the planned service (MB, after TP sharding). */
  perSparkMB: number;
  /** Group total footprint of the planned service (MB). */
  groupTotalMB: number;
  /** Group aggregate: Σ per-spark totalMB (MB). */
  groupTotalMemMB: number;
  /** Group aggregate: Σ per-spark usedMB (MB). */
  groupUsedMemMB: number;
  /** Group aggregate: Σ per-spark freeMB (MB). */
  groupFreeMemMB: number;
  /** Headroom held back per spark (MB) — system/floor guard, summed. */
  groupFloorMB: number;
  /** Per-spark breakdown, in sparkIds order. */
  sparks: GroupSparkEntry[];
  /** true when every spark can host its shard (with make-room if needed). */
  fits: boolean;
  /** true when the estimate is a bootstrap hardcode (basis "estimated"). */
  estimated: boolean;
}

/**
 * One single-spark stack component to place onto a TP group (SC7,
 * agent/catalog/memory.js → computeGroupAddonPlan). A stack is usually a
 * TP=x model plus tp=1 helpers (embedder, TTS, router); helpers with
 * tp > 1 are group members in their own right and are rejected here.
 */
export interface GroupAddonSpec {
  /** Component name (non-empty). */
  name: string;
  /** Whole (unsharded) footprint on one spark (MB). */
  footprintMB: number;
  /** Tensor-parallel size; must be 1 — the addon layer is single-spark. */
  tp: number;
}

/**
 * Group plan plus its single-spark addons (SC7,
 * agent/catalog/memory.js → computeGroupAddonPlan). The TP shard layer is
 * computed first; addons are placed first-fit-decreasing into the sparks'
 * running projected free (each must fit with opts.floorMB still covered on
 * its spark). Addons never evict or make room — an addon that fits nowhere
 * is skipped with a null placement.
 */
export interface GroupAddonPlan {
  /** The TP shard layer the addon math sat on top of. */
  group: GroupResourcePlan;
  /** One entry per input addon, in INPUT order (placement ran FDD). */
  addons: Array<{
    name: string;
    footprintMB: number;
    /** Hosting spark, or null when skipped. */
    placement: { nodeId: string | null; feasible: boolean };
    /** Spark's projected free after this addon (MB); null when skipped. */
    projectedFreeAfterMB: number | null;
  }>;
  /** true when group.fits AND every addon placed. */
  fits: boolean;
}

/**
 * SC3 bootstrap hardcodes (agent/catalog/memory.js → BOOTSTRAP_COMPONENTS):
 * the seed memory estimates shipped before real-world refinement. Decision
 * #2 (docs/IMPLEMENTATION_PLAN.md): the UI is unlocked and shows these as
 * `estimated` until ≥5 history runs replace them with measured averages.
 */
export interface BootstrapComponentEstimate {
  /** Component id (matches agent/catalog/components/*.json id). */
  id: string;
  /** Human name. */
  name: string;
  /** Tensor-parallel size the estimate was measured/estimated at. */
  tp: number;
  /** Per-spark memory estimate (MB). */
  perSparkMB: number;
  /** "measured" | "estimated" — "estimated" marks bootstrap hardcodes. */
  basis: "measured" | "estimated";
  /** Where the number came from (surfaced in the UI). */
  notes: string;
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
  /** GPU temperature (Celsius). null when the sensor reports [N/A] (GB10). */
  temperature: number | null;
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
  /** Sum of ALL compute-apps GPU memory (MB), not capped at 5. Optional: agents before #26 omit it. */
  gpuAllocMB?: number;
  /** true when the GPU draws from the OS memory pool (GB10: nvidia-smi memory.total is N/A). */
  unifiedMemory?: boolean;
  /** Summed draw (W) of every GPU on the host (#33). Optional: older agents omit it. */
  powerDrawTotal?: number;
  /** Number of GPUs seen (#33). */
  gpuCount?: number;
  /** Where the GPU power figure came from (#33); absent when nothing measured it. */
  powerSource?: "nvidia-smi" | "amd-hwmon";
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
  /** Where `draw` came from (#33): a RAPL / thermal / hwmon sensor, or the TDP x usage model. */
  drawSource?: "rapl" | "thermal" | "hwmon" | "estimated";
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
  /** /proc/meminfo Cached (MB): reclaimable page cache, inside availableMB. Optional (#26). */
  cachedMB?: number;
  /** /proc/meminfo SwapTotal (MB). Optional (#26). */
  swapTotalMB?: number;
  /** /proc/meminfo SwapFree (MB). Optional (#26). */
  swapFreeMB?: number;
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
  /** Wireless info if this is a WiFi interface. */
  wireless?: {
    ssid: string | null;
    signalDbm: number | null;
    frequency: string | null;
  } | null;
  /** MAC address if available. */
  mac?: string | null;
  /** Kind classification for UI and filtering (physical | bridge | vm-bridge | wireless | link). */
  kind?: "physical" | "bridge" | "vm-bridge" | "wireless" | "link" | null;
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

// ─── Lanes (S3.1) ─────────────────────────────────────────────────────────
// SC1 terminology: the UI/docs term for a lane is **Component** (see the Stacks
// section below). "Lane" stays the internal/wire name (recipe `.lane` slot,
// NodeAgentSnapshot.lanes, GET /lanes) for compatibility.

/**
 * Lane slot attribute on an "llm" recipe (shared/recipe.schema.json → Recipe.lane).
 * Lanes are LLM serving slots that take turns sharing one GPU pool; guards
 * and lanes are recipe attributes of an enrolled unit, never systems of
 * their own (EVAL-system-enrollment.md §3/§4.3).
 */
export interface RecipeLane {
  /** Lane pool id: ^[a-z0-9][a-z0-9-]{0,31}$ */
  pool: string;
  /** Turn order within the pool (integer >= 0). */
  order: number;
}

/**
 * One lane entry, derived by the agent (agent/catalog/lanes.js deriveLanes):
 * a lane recipe joined with its live container/version state.
 */
export interface LaneEntry {
  /** Recipe name (the lane's identity). */
  recipe: string;
  /** Served model id (live version wins over the recipe value). */
  modelId: string | null;
  /** Port the lane serves on (recipe.port). */
  port: number | null;
  /** Turn order within the pool (from the recipe lane). */
  order: number;
  /** True when a live version/container matches the recipe's port/containerName. */
  running: boolean;
  /** Recipe containerName, when known. */
  containerName: string | null;
  /** "running" | "stopped" (derived from the live match). */
  state: string;
}

/** One lane pool (one shared GPU pool), lanes sorted by order. */
export interface LanePool {
  /** Pool id (recipe lane.pool). */
  id: string;
  /** Lanes in this pool, sorted by order. */
  lanes: LaneEntry[];
}

/**
 * Advisory candidate: a container that looks lane-like but matches no lane
 * recipe. NEVER actionable — a candidate is not a service.
 */
export interface LaneCandidate {
  /** Docker container name. */
  containerName: string;
  /** Image reference. */
  image: string;
  /** Exposed/bound ports ("host:container" or "port" strings, as collected). */
  ports: string[];
  /** Why it looks lane-like (name pattern / lane-recipe port). */
  reason: string;
}

/** Derived lane view (GET /lanes, NodeAgentSnapshot.lanes). */
export interface NodeLanes {
  /** Pools sorted by id. */
  pools: LanePool[];
  /** Advisory candidates (never actionable). */
  candidates: LaneCandidate[];
}

// ─── Stacks (groups of Components) ─────────────────────────────────────────
// NOTE (2026-10-29, SC1-aligned 2026-10-31): Terminology for UI/docs:
// - "Component" = a loadable serving unit (the lane slot on an llm recipe).
//   "Lane" stays the internal/wire name — Recipe.lane, NodeAgentSnapshot.lanes,
//   GET /lanes — kept for compatibility (see the Lanes section above).
// - "Subcomponent" = individual library artifacts (checkpoint, drafter, image, ...).
// - "Stack" = user-defined group of Components that are intended to share the pool.
// Stacks are selected in the browser UI and assigned one of four categories.

export type StackCategory = 'proven' | 'calculated' | 'not_recommended' | 'blocked';

/** UI labels for the four Stack categories (SC1 terminology alignment). */
export const STACK_CATEGORY_LABELS: Record<StackCategory, string> = {
  proven: 'Proven',
  calculated: 'Calculated',
  not_recommended: 'Not recommended',
  blocked: 'Blocked',
};

/**
 * A Stack definition (group of Components).
 * Defined by selecting Components in the UI.
 * Category is computed live (proven history + resource calc).
 */
export interface Stack {
  /** Stable id (uuid or slug). */
  id: string;
  /** Human name, e.g. "Qwen3.8 full stack". */
  name: string;
  /** Component names (recipe names) that belong to this stack. */
  componentNames: string[];
  /** Current computed category. */
  category: StackCategory;
  /** When the category was last (re)computed (ms epoch). */
  lastCalculatedAt?: number;
  /** Optional free-form notes. */
  notes?: string;
  /** For 'proven': history of successful joint runs (no OOM, completed successfully). */
  provenRuns?: Array<{
    timestamp: number;
    success: boolean;
    durationMs?: number;
    notes?: string;
  }>;
}

/** Lightweight definition used when the UI is building a stack (before save). */
export interface StackDraft {
  name: string;
  componentNames: string[];
}

/**
 * SC4: one recorded run used for the proven-category verdict and ETA
 * refinement (agent/catalog/history.js). Recorded per stack membership
 * (componentNames): what actually ran, at what tensor-parallel size, and
 * how long the boot actually took against what was estimated.
 */
export interface ProvenHistoryEntry {
  /** Stable id of the stack this run belongs to (Stack.id). */
  stackId: string;
  /** Stack membership the run was recorded under (sorted Component names). */
  componentNames: string[];
  /** Tensor-parallel size the run actually used (1 = single box). */
  tpSize: number;
  /** Actual boot time in ms (launch → serving). null when not measured. */
  actualBootMs: number | null;
  /** Boot estimate in ms the run was launched against. null when none. */
  etaMs: number | null;
  /** Whether the run succeeded (served without OOM / completed). */
  success: boolean;
  /** Optional free-form notes (OOM, retry, host, engine version, …). */
  notes?: string;
  /** When the run was recorded (ms epoch). */
  timestamp: number;
}

/**
 * SC4: the proven history for one category/stack — all recorded runs for a
 * stack id, oldest first (append order). Consumed by the proven override
 * (any success ⇒ proven) and by SC5+ ETA refinement (boot averages).
 */
export interface CategoryHistory {
  /** Stack id this history belongs to. */
  stackId: string;
  /** Entries in append order (oldest first); may be empty. */
  entries: ProvenHistoryEntry[];
}

/**
 * SC4 storage shape: the on-disk `agent/config/stack-history.json` file
 * (agent/catalog/history.js). Appends only — a rewrite is never required
 * for correctness, and reads are fail-soft like stacks.json.
 */
export interface ProvenHistoryFile {
  /** File-format version. Currently 1. */
  version: 1;
  /** Recorded runs, unique (stackId, timestamp), append order preserved. */
  entries: ProvenHistoryEntry[];
}

/**
 * SC2 storage shape: the on-disk `agent/config/stacks.json` file
 * (produced and consumed by agent/catalog/stacks-catalog.js; imported by
 * the setup menu for merge/export/import). `category` on load is a hint
 * only — the store recomputes it live (stacks.js calculator + history).
 */
export interface StacksFile {
  /** File-format version. Currently 1. */
  version: 1;
  /** Stack definitions, unique by id (merge dedup key). */
  stacks: Stack[];
}

// ─── Library (SC6, on-disk state per node) ─────────────────────────────────
//
// Producer: agent/collectors/library.js (runs on the node that owns the
// disk). Seam: NodeAgentSnapshot.library, additive like lanes/stackHistory.
// Vocabulary (one method, pin claims from the node's validated recipe
// store — imageDigest / modelRevision):
//   "pinned"   artifact matches a pin claim;
//   "unpinned" on disk, no claim governs it (ungoverned cache, not drift);
//   "stray"    on disk inside something a claim governs, but matches none
//              (drift next to the pin);
//   "missing"  a claim whose artifact is NOT on disk (pull finding — only
//              ever emitted for models that DO have pins).

/** One local docker image as reported by the library collector. */
export interface LibraryEngineImage {
  /** Docker Repository, e.g. "lmsysorg/sglang". */
  reference: string;
  /** Tag; "<none>" when dangling. */
  tag: string;
  /** Normalized repo digest (sha256:...). null when docker reported none. */
  repoDigest: string | null;
  /** Image size in bytes. null when docker could not answer (unknown). */
  sizeBytes: number | null;
  /** Docker image id, sha256: stripped, 19 chars. */
  imageId: string;
  /** Engine-relevant by reference match (inference images the Library lists). */
  inferenceEngine: boolean;
  /** Some recipe pin's digest matches this image (a moved tag stays pinned). */
  pinned: boolean;
  /** Recipes claiming that pin. */
  pinnedBy: string[];
}

/** One checkpoint (model revision) found on disk, or a missing-pin finding. */
export interface LibraryCheckpoint {
  /** Model id (org/name from the HF cache dir, or the plain dir name). */
  model: string;
  /** Snapshot hash / commit, or "<dir>" for a plain model directory. */
  revision: string;
  /** Default-ref name ("main") when surfaced through refs, else null. */
  refName: string | null;
  /** Size in bytes. null when du could not answer or nothing is materialized. */
  sizeBytes: number | null;
  /** Pin verdict. "missing" is a pin claim with no artifact on disk. */
  status: "pinned" | "unpinned" | "stray" | "missing";
  /** Recipes pinning this exact revision. */
  pinnedBy: string[];
}

/** One resolved pin claim (what the recipe store says vs what disk has). */
export interface LibraryPinClaim {
  kind: "image" | "model";
  /** Recipe (Component instance) making the claim. */
  recipe: string;
  /** Digest (image) or `model@revision` (model). */
  ref: string;
  /** Artifact present locally. */
  present: boolean;
  /** "pinned" when present, "missing" when the claim is unmet. */
  status: "pinned" | "missing";
}

/**
 * SC6 library report — NodeAgentSnapshot.library. Errors are the raw
 * docker/du/readdir failures behind null fields; they are never swallowed.
 */
export interface LibraryReport {
  /** Report-format version. Currently 1. */
  version: 1;
  /** All local images (inferenceEngine flags the relevant ones). */
  engineImages: LibraryEngineImage[];
  /** Checkpoints on disk + missing-pin findings. */
  checkpoints: LibraryCheckpoint[];
  /** Recipe pin claims, resolved against disk. */
  pins: LibraryPinClaim[];
  /** Raw-source failures; empty when every source answered. */
  errors: string[];
}

// ─── Node agent snapshot (full telemetry) ──────────────────────────────────────────────────────────

/**
 * Full telemetry snapshot for one node, produced by the node agent's
 * /telemetry endpoint. This is the primary data structure the dashboard
 * server polls and the frontend renders.
 */
// ─── Normalized engine metrics (STAT2, #35) ────────────────────────────────
// server/metrics/EngineWindow.js turns each engine's counters into one record
// per rolling window that reads the same for every engine.

/** Where a value came from (Page §3): counter < native < proxy < client. */
export type EngineSourceTier = "counter" | "native" | "proxy" | "client";

export type NormalizedEngineField =
  | "decode_tps"
  | "prefill_tps"
  | "ttft_s"
  | "queue_s"
  | "running"
  | "waiting"
  | "kv_pct"
  | "cache_reuse"
  | "acc_len"
  | "idle_share"
  | "throughput_tps";

export interface NormalizedEngineValue {
  /** null when unmeasured: never 0 for "unknown". */
  value: number | null;
  /** false exactly when value is null. */
  valid: boolean;
  /** Tier of the input; may be set on a null value whose source had nothing to measure. */
  source: EngineSourceTier | null;
  /** Seconds the value spans; 0 for an instantaneous level, null when unmeasured. */
  windowS: number | null;
  /** True when the value only approximates the engine's own measure. */
  approximate: boolean;
  /** Reads behind the value (counter differences: reads in the window; rate means: busy reads). */
  samples: number;
  /** Levels only: the window's peak. */
  peak?: number | null;
}

export interface NormalizedEngineRecord {
  /** Window span in seconds (60 or 300). */
  spanS: number;
  /** Seconds between the window's oldest and newest read. */
  coveredS: number;
  /** Reads in the window. */
  reads: number;
  /** When the window (re)started: first read after an engine change or counter reset (ms epoch). */
  startedAt: number | null;
  /** Times the window started again after an engine change or counter reset. */
  resets: number;
  values: Record<NormalizedEngineField, NormalizedEngineValue>;
}

/** Normalized records keyed by window span in seconds ("60", "300"). */
export type NormalizedEngineWindows = Record<string, NormalizedEngineRecord>;

/** Raw counter names a node agent exports (agent/collectors/llmCounters.js). */
export type AgentEngineCounterKey =
  | "generated"
  | "prompt"
  | "cached"
  | "decoded"
  | "first"
  | "itlSum"
  | "prefillComputed"
  | "prefillSeconds"
  | "queueSum"
  | "queueCount"
  | "ttftSum"
  | "ttftCount"
  | "e2eSum"
  | "e2eCount"
  | "requestsFinished"
  | "preemptions"
  | "specAccepted"
  | "specDrafts"
  | "specDraftTokens"
  | "specVerify"
  | "idleSeconds";

/** STAT3: read time of an engineCounters payload (schema 2). */
export interface AgentEngineCountersMeta {
  /** Payload schema: 2 = STAT3 (schema 1, STAT2, sent no meta). */
  schema: number;
  /** Page the counters came from; "proxy" = metered by the agent's usage relay (STAT4). */
  source: "prometheus" | "json" | "proxy";
  /** Agent monotonic clock (performance.now() ms); only comparable within one bootId. */
  monoMs: number;
  /** Agent wall clock at the read (ms epoch). */
  wallMs: number;
  /** Changes when the agent process restarts. */
  bootId: string;
}

/**
 * One node-agent LLM port probe (agent/collectors/llm.js), attached to the
 * snapshot as `llm`. Only the fields the dashboard reads are typed here.
 */
export interface AgentLlmEntry {
  port: number;
  backend: string | null;
  modelId: string | null;
  kvCacheUsage?: number | null;
  requestsRunning?: number | null;
  requestsWaiting?: number | null;
  /**
   * STAT2 / STAT3: raw cumulative engine counters. Agent 0.3 sends vLLM /
   * SGLang only; agent 0.4+ sends every engine with counters and every key of
   * AgentEngineCounterKey (null when the engine does not publish it).
   */
  engineCounters?: Partial<Record<AgentEngineCounterKey, number | null>> | null;
  /** STAT3 (agent 0.4+): when and how engineCounters were read. */
  engineCountersMeta?: AgentEngineCountersMeta | null;
  /**
   * STAT4 (agent 0.5+): per-request usage the agent's opt-in relay metered
   * for this port, as cumulative counters (same keys). Windowed as the
   * "proxy" source tier; engine counters win per field.
   */
  proxyCounters?: Partial<Record<AgentEngineCounterKey, number | null>> | null;
  proxyCountersMeta?: AgentEngineCountersMeta | null;
  /** STAT4: metered requests in flight through the relay. */
  proxyInFlight?: number | null;
  /** STAT2: added by the dashboard server's fleet poller. */
  normalized?: NormalizedEngineWindows | null;
}

/** STAT4: one metered request through the agent's usage relay. */
export interface AgentRelayRequest {
  wallMs: number;
  client: string;
  path: string | null;
  model: string | null;
  status: number;
  aborted: boolean;
  stream: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  /** No usage in the stream: completion counted from content events. */
  completionEstimated: boolean;
  ttftS: number | null;
  decodeS: number | null;
  /** "engine" (Ollama eval_duration, llama.cpp timings) or "stream" (first → last content event). */
  decodeFrom: "engine" | "stream" | null;
  e2eS: number;
}

/** STAT4: one opt-in usage relay of the node agent (LLM_PROXY). */
export interface AgentUsageRelay {
  listenPort: number | null;
  upstreamPort: number | null;
  counters: Partial<Record<AgentEngineCounterKey, number | null>> | null;
  meta: AgentEngineCountersMeta | null;
  inFlight: number;
  requests: number;
  errors: number;
  estimatedRequests: number;
  clients: { client: string; requests: number; errors: number; prompt: number; generated: number; lastSeenMs: number }[];
  recent: AgentRelayRequest[];
}

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
  /**
   * S1.2 enrollment state (registry-side, injected by the dashboard server —
   * the agent itself never emits it): "pending" from add-until-first-
   * authenticated-poll, then "claimed" (registered-never-seen vs
   * claimed-offline vs online monitoring, EVAL §4.1 gap 2).
   */
  enrollment?: "pending" | "claimed";
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
  /**
   * Derived lane view (S3.1, agent/catalog/lanes.js via snapshot enrichment).
   * Optional: agents older than S3.1 omit the key entirely; enrichment
   * failure surfaces as null. Consumers treat both as "no lanes".
   */
  lanes?: NodeLanes | null;
  /**
   * SC4: proven-history per stack (agent/catalog/history.js via snapshot
   * enrichment), keyed by stackId. Optional: agents older than SC4 omit the
   * key; enrichment failure or an empty history surfaces as null. Consumers
   * (SC5+ ETA calc / UI) treat both as "no history".
   */
  stackHistory?: Record<string, CategoryHistory> | null;
  /**
   * SC6: on-disk library state (agent/collectors/library.js — engine images,
   * checkpoints with pinned/stray/missing verdicts, recipe pins resolved
   * against disk). Optional: agents older than SC6 omit the key; a raw
   * docker/disk failure surfaces inside the report's `errors`, never as a
   * fabricated value. Collectors attach it even when partial (null fields).
   */
  library?: LibraryReport | null;
  /**
   * Raw LLM port probes. Optional: an agent with no LLM ports omits it.
   * STAT2: the dashboard server adds `normalized` to each entry.
   */
  llm?: AgentLlmEntry[];
  /** STAT4: the agent's opt-in usage relays; null / absent when none run. */
  llmProxy?: AgentUsageRelay[] | null;
  /** Last time this snapshot was polled (ms epoch). */
  polledAt: number;
}

// ─── Actions ───────────────────────────────────────────────────────────────
//
// Component-action seam (SC action design, docs/COMPONENTS-DESIGN-PROPOSAL.md §7).
// Dashboard → server → agent payload is ComponentActionRequest (v2). The
// legacy ActionRequest below is v1: still accepted by the agent, and the
// shape v2 downgrades to inside dispatch (v1 → v2 adapters are server-side
// only). New code produces v2 and consumes ComponentActionResult.

/**
 * One action request, sent to the node agent's POST /actions endpoint.
 *
 * @deprecated Superseded by ComponentActionRequest. Field semantics are
 * unchanged for start/stop/restart; `switch` in v1 is split into
 * `start` + `stop` in v2 (see docs/COMPONENTS-DESIGN-PROPOSAL.md §7.2).
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
 * Component-action seam (v2; docs/COMPONENTS-DESIGN-PROPOSAL.md §7).
 * One component action names ONE component definition on ONE target spark.
 * Dashboard (Components/Library tab) → dashboard server route → node agent
 * POST /actions → engine on the port, with the guard/keepalive proxy as the
 * sole LLM traffic path: the proxy front never changes address; a component
 * action only changes what answers behind it.
 */

/** v2 action verbs. v1 `switch` is gone: the old-LLM handoff it discovered
 *  by scanning live state becomes, in v2, either `start` with
 *  `exclusiveWith` (stated intent, take-turn) or a server-orchestrated
 *  stop-then-start. The agent only ever executes one goal-state verb. */
export type ComponentActionType = "start" | "stop" | "restart";

/** Confirmation class for a real (non-dry-run) execution. */
export type ComponentActionConfirm = "none" | "required";

/**
 * One component-action request (dashboard → server → agent).
 *
 * - `start` — materialize componentId (if not already materialized on this
 *   node) and start its recipe. When another component holds the same
 *   exclusive lane pool, `exclusiveWith` names it and the agent performs a
 *   take-turn: stop old → start new → canary (S3.1 lane semantics).
 * - `stop`  — stop the recipe backing componentId. Idempotent: an
 *   already-stopped service is success with canaryState "stopped".
 * - `restart` — stop → start on the same recipe (e.g. context-mode switch
 *   inside one component definition; no re-materialization, no pin change).
 */
export interface ComponentActionRequest {
  /** Seam version. v2 agents require 2; v1 agents ignore this field. */
  version: 2;
  /** Client-generated UUID; idempotency key (replayed id = same result, no re-execution). */
  actionId: string;
  /** Catalog component definition id (agent/catalog/components/<id>.json). */
  componentId: string;
  /** Action verb. */
  type: ComponentActionType;
  /**
   * Target spark: the node whose agent answers this request. The dashboard
   * server routes by this id; the agent rejects a foreign nodeId. For a
   * tp=x group stack the server fans out one request per member; `groupRef`
   * names the group, `nodeId` this member.
   */
  nodeId: string;
  /** tp=x group this action belongs to (null for single-spark actions). */
  groupRef: string | null;
  /**
   * For `start` of an llm kind: component (already materialized here) that
   * must be stopped first because it holds the same exclusive lane pool.
   * null = no handoff; the agent does NOT scan live state to pick a victim
   * — the caller states the intent.
   */
  exclusiveWith: string | null;
  /**
   * Token minted by a prior dry run for this exact (componentId, type,
   * nodeId, exclusiveWith) plan. Required when the plan's confirm class is
   * "required"; the agent refuses token-less execution of confirm-required
   * actions and rejects mismatched/expired tokens (409).
   */
  confirmationToken: string | null;
  /** Dry run: validate + plan + cost, change nothing, never audit. */
  dryRun: boolean;
  /** Start this already-materialized recipe instead of materializing
   *  componentId (provenance override; null = materialize from catalog). */
  recipeName: string | null;
  /** Wall-clock budget ms (canary budget included); null = engine default. */
  timeoutMs: number | null;
  /** Requesting principal ("dashboard:<user>" / "agent:<id>"), audit-only. */
  actor: string | null;
}

/** One step inside a component action. */
export interface ComponentActionStep {
  step: "materialize" | "stop" | "start" | "canary" | "traffic-check";
  status: "success" | "failure" | "skipped";
  message: string;
  durationMs: number | null;
}

/** Proxy-seam evidence collected after the action (the traffic truth check). */
export interface ComponentActionTraffic {
  /** Guard/keepalive proxy answered its status endpoint. */
  proxyReachable: boolean;
  /** Served model ids the proxy reports as answering behind it. */
  servingModels: string[];
}

/**
 * One component-action result (agent → server → dashboard). The canary
 * verdict travels in `canaryState`, never smuggled into `status` (v1's
 * mapping is deprecated with ActionResponse).
 */
export interface ComponentActionResult {
  version: 2;
  /** Matches request. */
  actionId: string;
  componentId: string;
  nodeId: string;
  /** Echo of the verb actually executed. */
  type: ComponentActionType;
  /** Coarse status. "running" = accepted async (e.g. 12-min boot); poll status by actionId. */
  status: "success" | "failure" | "running";
  ok: boolean;
  message: string;
  error: string | null;
  /** Canary verdict for start/take-turn; same state words as VersionInfo.state. */
  canaryState: "ready" | "loading" | "stopped" | "wedged" | null;
  /** Per-step trail in execution order. */
  steps: ComponentActionStep[];
  /** Updated live state of the acted-on component after the action (from /versions); null when unobservable. */
  state: VersionInfo | null;
  /** Proxy traffic-seam evidence after the action; null when the node has no proxy collector. */
  traffic: ComponentActionTraffic | null;
  /** Non-null only when the request was a dry run. */
  plan: ComponentActionPlan | null;
  /** Log tail surfaced on failure (last lines of engine/container logs); null otherwise. */
  logs: string | null;
  durationMs: number | null;
  at: number;
}

/** Dry-run plan: what the agent WOULD do, in order, and what it costs. */
export interface ComponentActionPlan {
  /** Ordered step verbs for the real run (empty when scopeBlocked). */
  willDo: Array<"stop" | "start" | "canary" | "traffic-check">;
  /** Component stopped by the take-turn (null when none). */
  displaces: string | null;
  /** Confirmation class for the real execution. */
  confirm: ComponentActionConfirm;
  /** Token to replay in confirmationToken when confirm === "required" (null when "none"). */
  confirmationToken: string | null;
  /** Downtime estimate ms where NEITHER old nor new LLM answers (0 with no handoff); from boot estimates. */
  estDowntimeMs: number;
  /** Memory delta MB (negative = frees); from materialized footprintMB. */
  memoryDeltaMB: number;
  /** Live requests running against the displaced component (null = unobserved). */
  inflightRequests: number | null;
  /** Copy-on-scope refusal: component's (tp, machineClass) ≠ target's, or
   *  the definition sets `multi_spark.singleSparkOnly` and the target is a
   *  group member; reason string, willDo empty. */
  scopeBlocked: string | null;
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
  /**
   * Lane take-turn context (S3.1): present on switch audit entries when the
   * old and new recipes share one lane pool — the pool they take turns on and
   * the incoming lane's order. Absent (or null) for every other action.
   */
  lane?: RecipeLane | null;
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

// ─── LLM token ledger (FLEET3, issue #38) ────────────────
// GET /api/llm-token-totals?range=… and /history (server/llmtokens/*).

export type LlmTokenRange = "24h" | "7d" | "30d" | "all";

/** generated = output tokens; cached = prompt tokens from the prefix cache; prefill = prompt − cached. */
export interface LlmTokenSplit {
  generated: number;
  cached: number;
  prefill: number;
  /** generated + cached + prefill */
  total: number;
}

export interface LlmTokenModelRow extends LlmTokenSplit {
  model: string;
  /** `nodeId:port` series that served the model in the range. */
  endpoints: string[];
  /** Ledger source tiers that credited tokens: "counter", "native", "proxy"… */
  sources: string[];
}

export interface LlmTokenEndpointRow extends LlmTokenSplit {
  seriesId: string;
  nodeId: string;
  nodeName: string | null;
  port: number;
  backend: string | null;
  models: string[];
  sources: string[];
  lastSeenMs: number | null;
}

export interface LlmTokenTotals extends LlmTokenSplit {
  range: LlmTokenRange;
  resolution: "hour" | "day" | "all";
  fromMs: number;
  toMs: number;
  trackedSinceMs: number;
  endpointCount: number;
  models: LlmTokenModelRow[];
  endpoints: LlmTokenEndpointRow[];
}

export interface LlmTokenHistoryPoint {
  startMs: number;
  generated: number;
  cached: number;
  prefill: number;
}

export interface LlmTokenHistory {
  range: LlmTokenRange;
  resolution: "hour" | "day";
  stepMs: number;
  trackedSinceMs: number;
  points: LlmTokenHistoryPoint[];
}

// ─── Bench results store (BENCH1, server/bench/results) ──────────────────
//
// One BenchResult = one measured cell (a run at one fixed set of
// conditions). Snake_case because the records are a persisted file format
// (config/bench-results.json) shared with imports from other bench tools.
// Timestamps here are ISO-8601 strings. Unknown provenance is null.

export type BenchMetric =
  | "decode_tps_stream"
  | "agg_window_tps"
  | "agg_sum_tps"
  | "prefill_tps"
  | "server_generation_tps"
  | "ttft_p50"
  | "ttft_p95"
  | "tpot_p95"
  | "accuracy_pct"
  | "wh_per_1k_tokens";

/** Page §3 source tiers: counter 1, native 2, proxy 3, client 4; reference = not measured by Herd. */
export type BenchMetricSource = "counter" | "native" | "proxy" | "client" | "reference";

export type BenchOrigin = "herd" | "reference" | "aeon-pod";

export interface BenchMetricRow {
  metric: BenchMetric;
  /** null = not measured (never 0). */
  value: number | null;
  unit: string;
  n: number | null;
  ci_low: number | null;
  ci_high: number | null;
  source: BenchMetricSource;
  tier: 1 | 2 | 3 | 4 | null;
  window_s: number | null;
  approximate: boolean;
  valid: boolean;
  /** Registered definition name, e.g. "herd.decode.agg_window.v1", "mia.agg_sum_per_request.v1". */
  definition: string;
}

export interface BenchRunInfo {
  run_id: string;
  started_at: string;
  completed_at: string | null;
  status: "completed" | "failed" | "cancelled" | "interrupted" | "partial" | null;
  suite: string;
  suite_version: string;
  bench: string;
  bench_version: string;
  origin: BenchOrigin;
  /** Required for non-herd origins. */
  reference_url: string | null;
  imported_from: { file: string; key: string } | null;
}

export interface BenchHostInfo {
  node_id: string | null;
  node_name: string | null;
  /** AEON-style bucket: "Single DGX Spark", "2× DGX Spark", "Single RTX 5090"… */
  hw_bucket: string | null;
  gpu: string | null;
  gpu_count: number | null;
  mem_class: string | null;
  clock_cap_mhz: number | null;
  power_cap_w: number | null;
}

export interface BenchLaneInfo {
  engine: string | null;
  engine_version: string | null;
  image_digest: string | null;
  model_id: string | null;
  weights_hash: string | null;
  quant: string | null;
  recipe_flags: string[] | null;
  spec_decode: string | null;
  kv_dtype: string | null;
  ctx_len: number | null;
  parallel: Record<string, number> | null;
}

/** Must match for two results to be compared. */
export interface BenchConditions {
  concurrency: number | null;
  context_tokens: number | null;
  max_tokens: number | null;
  temperature: number | null;
  thinking: boolean | null;
  prompt_set: string | null;
  client_location: "local" | "network" | null;
}

export interface BenchResult {
  schema_version: 1;
  id: string;
  recorded_at: string;
  run: BenchRunInfo;
  host: BenchHostInfo;
  lane: BenchLaneInfo;
  conditions: BenchConditions;
  settings: Record<string, unknown>;
  metrics: BenchMetricRow[];
  /** Per-item pass/fail vector (enables McNemar between runs). */
  quality: { items: Array<{ id: string; pass: boolean | null }> } | null;
  /** Source object the record was derived from (lossless import). */
  raw: Record<string, unknown> | null;
}

export interface BenchResultsListResponse {
  schema_version: number;
  read_only: boolean;
  total: number;
  results: BenchResult[];
}

export interface BenchResultsFilter {
  run_id?: string;
  bench?: string;
  suite?: string;
  origin?: BenchOrigin;
  node_id?: string;
  hw_bucket?: string;
  model_id?: string;
  engine?: string;
  quant?: string;
  metric?: BenchMetric;
  definition?: string;
  concurrency?: number;
  context_tokens?: number;
  /** ISO date or epoch ms. */
  since?: string | number;
  until?: string | number;
  /** Only results comparable with this result id. */
  like?: string;
  limit?: number;
  offset?: number;
}

export interface BenchCompareRow {
  metric: BenchMetric;
  unit: string;
  baseline: number;
  candidate: number;
  delta: number;
  delta_pct: number | null;
  improved: boolean | null;
  baseline_definition: string;
  candidate_definition: string;
}

export interface BenchCompareResponse {
  baseline: string;
  candidate: string;
  comparable: boolean;
  /** Why the two results cannot be compared at all. */
  reasons: string[];
  rows: BenchCompareRow[];
  /** Metrics present on both sides whose definitions differ. */
  refused: Array<{
    metric: BenchMetric;
    baseline_definition: string;
    candidate_definitions: string[];
    reason: string;
  }>;
  /** Exact McNemar on the paired per-item vectors (null unless both sides carry `quality`). */
  quality: BenchMcNemar | null;
}

/** GET /api/bench-results/references: the published reference registry (BENCH5, #45). */
export interface BenchReferencesResponse {
  loaded: boolean;
  registry_version: number | null;
  retrieved_at: string | null;
  /** Sources deliberately not seeded yet, with why. */
  not_seeded: Array<{ source: string; reason: string }>;
  entries: Array<{
    id: string;
    source: string;
    title: string;
    url: string;
    measured_on: string | null;
    figures: number;
  }>;
  total: number;
  /** Stored records, all `run.origin: "reference"`; never Herd results. */
  results: BenchResult[];
}

/** GET /api/bench-results/:id/references: nearest published figures, same definition group only. */
export interface BenchNearestReferencesResponse {
  id: string;
  origin: BenchOrigin;
  metrics: Array<{
    metric: BenchMetric;
    definition: string;
    value: number | null;
    unit: string;
    references: Array<{
      id: string;
      origin: "reference";
      url: string;
      title: string | null;
      source: string | null;
      value: number;
      unit: string;
      n: number | null;
      definition: string;
      score: number;
      /** What still differs (hardware, suite, conditions, lane): shown beside, never diffed. */
      differences: string[];
    }>;
  }>;
}

/** Exact McNemar between two per-item pass/fail vectors (Quality bench, #42). */
export interface BenchMcNemar {
  /** Items scored in both runs. */
  paired: number;
  both_pass: number;
  both_fail: number;
  /** Passed in the baseline only (regressions). */
  baseline_only: number;
  /** Passed in the candidate only (improvements). */
  candidate_only: number;
  /** Two-sided exact p. */
  p: number;
  /** p ≥ 0.05. */
  within_noise: boolean;
}

// ─── "Upgrade worth it?" (BENCH6, #46) ─────────────────────────────────

/** One run the upgrade view can pick (GET /api/bench-results/upgrade/runs). */
export interface BenchUpgradeRun {
  run_id: string;
  bench: string;
  origin: BenchOrigin;
  suite: string;
  suite_version: string;
  status: string | null;
  started_at: string;
  completed_at: string | null;
  node_id: string | null;
  node_name: string | null;
  hw_bucket: string | null;
  model_id: string | null;
  engine: string | null;
  engine_version: string | null;
  quant: string | null;
  cells: number;
  concurrencies: number[];
  has_energy: boolean;
  has_memory: boolean;
}

export interface BenchUpgradeRunsResponse {
  total: number;
  runs: BenchUpgradeRun[];
}

export type BenchUpgradeVerdictCode = "worth_it" | "within_noise" | "regression" | "refused";

export interface BenchUpgradeThroughputCell {
  cell: string;
  bench: string;
  concurrency: number | null;
  metric: BenchMetric;
  unit: string;
  definition: string;
  baseline: number;
  candidate: number;
  delta_pct: number | null;
  /** ± band in %: measured spread of repeated runs (floored at 3%), or the 15% default. */
  noise_pct: number;
  noise_source: "repeats" | "default";
  measured_noise_pct: number | null;
  /** False for AEON per-category detail cells: shown, not voted. */
  headline: boolean;
  status: "gain" | "loss" | "noise" | "unknown";
  baseline_id: string;
  candidate_id: string;
}

export interface BenchUpgradeQualityCategory {
  cell: string;
  category: string;
  baseline_pct: number | null;
  candidate_pct: number | null;
  /** Percentage points. */
  delta_pp: number | null;
  mcnemar: BenchMcNemar | null;
  status: "better" | "worse" | "noise" | "unpaired";
}

/** Energy drawn by the node over the run window, from the fleet energy tracker. */
export interface BenchUpgradeRunEnergy {
  wh: number;
  window_s: number;
  /** Share of the window covered by power samples (0–1). */
  coverage: number;
  output_tokens: number | null;
  wh_per_1k_tokens: number | null;
  source: string;
  run_id: string;
  /** Stored when the run finished, or read from the tracker now (31-day retention). */
  from: "recorded" | "tracker_now";
}

export interface BenchUpgradeRunMemory {
  total_mb: number | null;
  available_start_mb: number | null;
  available_end_mb: number | null;
  /** Lower of the start and end readings. */
  headroom_mb: number;
  run_id: string;
}

export interface BenchUpgradeSide {
  run_ids: string[];
  benches: string[];
  node_id: string | null;
  node_name: string | null;
  hw_bucket: string | null;
  suite: string;
  suite_version: string;
  started_at: string;
  lane: {
    model_id: string | null;
    engine: string | null;
    engine_version: string | null;
    quant: string | null;
    recipe_flags: string | null;
    spec_decode: string | null;
  };
}

/** GET /api/bench-results/upgrade?baseline=&candidate= */
export interface BenchUpgradeResponse {
  comparable: boolean;
  baseline: BenchUpgradeSide;
  candidate: BenchUpgradeSide;
  verdict: {
    code: BenchUpgradeVerdictCode;
    worth_it: boolean;
    throughput: "gain" | "loss" | "mixed" | "noise" | "none";
    quality: "regression" | "ok" | "not_measured";
    reasons: string[];
  };
  throughput: BenchUpgradeThroughputCell[];
  quality: BenchUpgradeQualityCategory[];
  unpaired: { baseline: string[]; candidate: string[] };
  cost: {
    energy: {
      definition: string;
      baseline: BenchUpgradeRunEnergy | null;
      candidate: BenchUpgradeRunEnergy | null;
      delta_pct: number | null;
    };
    memory: {
      baseline: BenchUpgradeRunMemory | null;
      candidate: BenchUpgradeRunMemory | null;
      delta_mb: number | null;
    };
  };
  /** Nearest published figure (BENCH5) for the candidate's headline cells; shown beside, never diffed. */
  reference: {
    cell: string;
    metric: BenchMetric;
    unit: string;
    candidate: number;
    reference: BenchNearestReferencesResponse["metrics"][number]["references"][number];
  } | null;
  rules: { default_noise_pct: number; quality_alpha: number; worth_it: string };
}

// ─── SC8 downtime/execute flow (server/fleet/downtimeSequencer.js) ────────
//
// "Shutdown sequence to free, then startup (parallel per stack); preview +
// live" (IMPLEMENTATION_PLAN.md SC8). The plan input names what changes; the
// preview derives the ordered sequences; execute walks the preview over the
// existing component-action seam (ComponentActionRequest/Result, §Actions).
// Parallelism is structural: each phase is an array of waves — steps within
// one wave run in parallel (they belong to different stacks), waves run in
// order (one stack's own steps stay sequential in dependency order).

/**
 * One component change inside a stack plan entry. `components` is given in
 * DEPENDENCY ORDER (what must come up first is listed first); the preview
 * derives reverse-dependency order for shutdown. `freesBytes` is the memory
 * the component sustains while stopped (for stop steps); unknown = null/omitted
 * and counts 0 in the projection (honest under-promise). For start/restart it
 * is ignored: a restart's stop half is internal and frees no sustained memory.
 */
export interface StackPlanComponentAction {
  /** Spark this component lives on; must be one of the stack's `nodes`. */
  nodeId: string;
  /** Catalog component id (same grammar buildComponentAction validates). */
  component: string;
  /** Desired verb. stop → shutdown phase; start/restart → startup phase. */
  action: ComponentActionType;
  /** Bytes sustained-freed by this stop; null/omitted = unknown (counts 0). */
  freesBytes?: number | null;
}

/** One stack's plan entry. */
export interface StackPlanEntry {
  /** Stable Stack.id; unique across the plan. */
  stackId: string;
  /** Sparks this stack spans; every component's nodeId must be listed here. */
  nodes: string[];
  /** Component actions in DEPENDENCY ORDER. */
  components: StackPlanComponentAction[];
}

/** Input to buildDowntimePreview. */
export interface StackDowntimePlan {
  stacks: StackPlanEntry[];
  /** Memory the plan must free to be feasible. Default 0. */
  targetFreeBytes?: number;
}

/** One sequenced step inside a DowntimePreview wave. */
export interface DowntimeSequenceStep {
  stackId: string;
  nodeId: string;
  componentId: string;
  /** Verb this step executes. */
  type: ComponentActionType;
  /** Sustained bytes freed (stop steps with known footprint; else null). */
  freesBytes: number | null;
}

/** buildDowntimePreview result: pure, deterministic, network-free. */
export interface DowntimePreview {
  /** Waves of stops, per stack reverse-dependency order; wave i of stack k holds step i. */
  shutdownSequence: DowntimeSequenceStep[][];
  /** Waves of starts/restarts, per stack dependency order. */
  startupSequence: DowntimeSequenceStep[][];
  /** freeBytesProjected >= targetFreeBytes. */
  feasible: boolean;
  /** Sum of shutdown steps' known freesBytes (unknown counts 0). */
  freeBytesProjected: number;
  /** Echo of the plan's target. */
  targetFreeBytes: number;
}

/** One per-step outcome of a live executeDowntimeSequence walk. */
export interface DowntimeStepResult {
  phase: "shutdown" | "startup";
  /** Wave index within the phase. */
  wave: number;
  stackId: string;
  nodeId: string;
  componentId: string;
  type: ComponentActionType;
  /** Server-minted idempotency key; null when the step never dispatched. */
  actionId: string | null;
  ok: boolean;
  /** HTTP status from the proxy seam; null when the step never dispatched. */
  status: number | null;
  /** Failure/skip reason; null on success. */
  error: string | null;
}

/** executeDowntimeSequence report: fail-closed walk over the preview. */
export interface DowntimeExecutionReport {
  /** True only when every step of every wave succeeded. */
  ok: boolean;
  /** Steps actually dispatched (pre-flight failures and skipped siblings never dial). */
  executed: number;
  /** Per-step records in dispatch order. */
  results: DowntimeStepResult[];
  /** Where the walk stopped; null when it completed. */
  stoppedAt: { phase: "shutdown" | "startup"; wave: number } | null;
  /** Present when the infeasible-preview guard refused the run. */
  error?: string;
}
