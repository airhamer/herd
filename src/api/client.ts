import type {
  AbandonPlanResponse,
  AlertChannel,
  AlertsConfig,
  AlertsConfigUpdate,
  AlertsResponse,
  AlertTestResult,
  DecodeBenchJob,
  DecodeBenchListResponse,
  FleetEnergy,
  MonthlyEnergy,
  FleetPlanResponse,
  FleetSnapshot,
  GpuHistoryResponse,
  GuardResult,
  MemoryServiceResult,
  FleetUpdatesResponse,
  HermesBatchUpdateResponse,
  HermesUpdatesResponse,
  LlmMetrics,
  LlmDailyResponse,
  MetricsHistoryRange,
  MetricsHistoryResponse,
  SavePlanResponse,
  ScheduleUpdateRequest,
  Settings,
  ShowcaseListResponse,
  ShowcaseSessionState,
  ShowcaseStartRequest,
  ShowcaseStartResponse,
  SparkConfig,
  SparkTestResponse,
  StartDecodeBenchRequest,
  PrefillBenchJob,
  PrefillBenchListResponse,
  StartPrefillBenchRequest,
  UpdateActionResponse,
} from "./types";

const BASE = "";
const TOKEN = (typeof localStorage !== "undefined" && localStorage.getItem("sparkdashToken")) || "";

function authHeaders(): Record<string, string> {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}

/**
 * Error thrown by apiFetch for a non-ok response. `status` carries the HTTP
 * status code so callers can branch on it (e.g. the 409 wave-lock on
 * single-node update triggers). Message text is unchanged for callers that
 * only read `message`.
 */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// ─── Generic fetch wrapper ────────────────────────────────
async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  // Only set Content-Type for requests that actually carry a body. Setting it
  // on GET/DELETE was a no-op but could trigger an unnecessary CORS preflight
  // (OPTIONS) in some proxy setups.
  const headers: Record<string, string> = {};
  if (opts?.body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { ...headers, ...authHeaders(), ...(opts?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(body.error || `HTTP ${res.status}`, res.status);
  }
  return res.json();
}

// ─── Sparks CRUD ─────────────────────────────────────────
export function fetchSparks(): Promise<{ sparks: SparkConfig[] }> {
  return apiFetch("/api/sparks");
}

export function fetchFleetEnergy(): Promise<FleetEnergy> {
  return apiFetch("/api/fleet-energy");
}

/** Permanent monthly energy roll-up (monthly folds hourly; fetched once, no polling). */
export function fetchMonthlyEnergy(): Promise<MonthlyEnergy> {
  return apiFetch("/api/fleet-energy/monthly");
}

/** Latest metrics snapshot for one Spark (includes per-port LLM modelId). */
export function fetchSparkMetrics(id: string): Promise<{
  metrics?: { llm?: LlmMetrics[] };
}> {
  return apiFetch(`/api/sparks/${id}/metrics`);
}

/** Daily busy tok/s rollups for one Spark LLM port. */
export function fetchLlmDaily(
  id: string,
  port: number,
  days = 14
): Promise<LlmDailyResponse> {
  const q = new URLSearchParams({ port: String(port), days: String(days) });
  return apiFetch(`/api/sparks/${encodeURIComponent(id)}/llm/daily?${q.toString()}`);
}

export function addSpark(config: SparkConfig): Promise<{ success: boolean; spark: SparkConfig }> {
  return apiFetch("/api/sparks", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

export function updateSpark(
  id: string,
  patch: Partial<SparkConfig>
): Promise<{ success: boolean; spark: SparkConfig }> {
  return apiFetch(`/api/sparks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteSpark(id: string): Promise<{ success: boolean; removed: SparkConfig }> {
  return apiFetch(`/api/sparks/${id}`, { method: "DELETE" });
}

/** Persist tab bar order (array of spark ids). */
export function reorderSparks(
  order: string[]
): Promise<{ success: boolean; sparks: SparkConfig[] }> {
  return apiFetch("/api/sparks/order", {
    method: "PUT",
    body: JSON.stringify({ order }),
  });
}

/** Save SSH password only (works while the host is offline). */
export function setSparkPassword(
  id: string,
  password: string
): Promise<{ success: boolean; spark: SparkConfig; hasPassword: boolean }> {
  return apiFetch(`/api/sparks/${id}/password`, {
    method: "PUT",
    body: JSON.stringify({ password }),
  });
}

// ─── Test connectivity ────────────────────────────────────
/** Test a registered Spark by id */
export function testSpark(id: string): Promise<SparkTestResponse> {
  return apiFetch(`/api/sparks/${id}/test`, { method: "POST" });
}

/** Ephemeral test — does not persist a Spark or start a monitor */
export function testSparkConfig(config: Omit<SparkConfig, "id"> & { id?: string }): Promise<SparkTestResponse> {
  return apiFetch("/api/sparks/test", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

/** Cancel a ComfyUI job (interrupt running and/or remove from queue). */
export function cancelComfyJob(
  sparkId: string,
  promptId: string
): Promise<{ success: boolean; ok?: boolean; method?: string; message?: string }> {
  return apiFetch(`/api/sparks/${encodeURIComponent(sparkId)}/comfy/cancel`, {
    method: "POST",
    body: JSON.stringify({ promptId }),
  });
}

// ─── Disabled storage devices ─────────────────────────────
export function updateDisabledDevices(
  id: string,
  disabledDevices: string[]
): Promise<{ success: boolean; disabledDevices: string[] }> {
  return apiFetch(`/api/sparks/${id}/disabled-devices`, {
    method: "PUT",
    body: JSON.stringify({ disabledDevices }),
  });
}

// ─── Disabled network interfaces ──────────────────────────
export function updateDisabledInterfaces(
  id: string,
  disabledInterfaces: string[]
): Promise<{ success: boolean; disabledInterfaces: string[] }> {
  return apiFetch(`/api/sparks/${id}/disabled-interfaces`, {
    method: "PUT",
    body: JSON.stringify({ disabledInterfaces }),
  });
}

// ─── Manual metric refresh ────────────────────────────────
export function refreshSparkMetric(
  id: string,
  domain: string
): Promise<{ success: boolean; domain: string }> {
  return apiFetch(`/api/sparks/${id}/refresh/${domain}`, { method: "POST" });
}

// ─── LLM decode benchmark ─────────────────────────────
/** Start an async decode bench (returns 202 job). */
export function startDecodeBench(
  id: string,
  body: StartDecodeBenchRequest
): Promise<DecodeBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/bench`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getDecodeBench(
  id: string,
  benchId: string
): Promise<DecodeBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/bench/${benchId}`);
}

export function listDecodeBench(
  id: string,
  port?: number
): Promise<DecodeBenchListResponse> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
  return apiFetch(`/api/sparks/${id}/llm/bench${q}`);
}

export function cancelDecodeBench(
  id: string,
  benchId: string
): Promise<DecodeBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/bench/${benchId}`, {
    method: "DELETE",
  });
}

/** Clear finished benchmark history for a Spark (optionally one LLM port). */
export function clearDecodeBenchHistory(
  id: string,
  port?: number
): Promise<{ success: boolean }> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
  return apiFetch(`/api/sparks/${id}/llm/bench${q}`, { method: "DELETE" });
}

// ─── LLM prefill benchmark ────────────────────────────
export function startPrefillBench(
  id: string,
  body: StartPrefillBenchRequest
): Promise<PrefillBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getPrefillBench(
  id: string,
  benchId: string
): Promise<PrefillBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench/${benchId}`);
}

export function listPrefillBench(
  id: string,
  port?: number
): Promise<PrefillBenchListResponse> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench${q}`);
}

export function cancelPrefillBench(
  id: string,
  benchId: string
): Promise<PrefillBenchJob> {
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench/${benchId}`, {
    method: "DELETE",
  });
}

export function clearPrefillBenchHistory(
  id: string,
  port?: number
): Promise<{ success: boolean }> {
  const q =
    port != null && Number.isInteger(port) ? `?port=${encodeURIComponent(port)}` : "";
  return apiFetch(`/api/sparks/${id}/llm/prefill-bench${q}`, { method: "DELETE" });
}

// ─── LLM Prompt Showcase ──────────────────────────────
/** Start a concurrent prompt showcase (returns 202 session). */
export function startShowcase(
  id: string,
  body: ShowcaseStartRequest
): Promise<ShowcaseStartResponse> {
  return apiFetch(`/api/sparks/${id}/llm/showcase`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Active session + finished history summaries. */
export function listShowcase(id: string): Promise<ShowcaseListResponse> {
  return apiFetch(`/api/sparks/${id}/llm/showcase`);
}

export function getShowcase(
  id: string,
  sessionId: string,
  opts?: { since?: number }
): Promise<ShowcaseSessionState> {
  const q =
    opts?.since != null && Number.isFinite(opts.since)
      ? `?since=${encodeURIComponent(String(opts.since))}`
      : "";
  return apiFetch(`/api/sparks/${id}/llm/showcase/${sessionId}${q}`);
}

export function cancelShowcase(
  id: string,
  sessionId: string
): Promise<ShowcaseSessionState> {
  return apiFetch(`/api/sparks/${id}/llm/showcase/${sessionId}`, {
    method: "DELETE",
  });
}

/** Clear finished showcase history for a Spark. */
export function clearShowcaseHistory(
  id: string
): Promise<{ success: boolean }> {
  return apiFetch(`/api/sparks/${id}/llm/showcase`, { method: "DELETE" });
}

// ─── LLM probe ports (per Spark) ─────────────────────────
/** Replace all LLM ports for a Spark (hot update). */
export function updateLlmPorts(
  id: string,
  llmPorts: number[]
): Promise<{ success: boolean; llmPorts: number[] }> {
  return apiFetch(`/api/sparks/${id}/llm-ports`, {
    method: "PUT",
    body: JSON.stringify({ llmPorts }),
  });
}

/** Add a single LLM port to a Spark (hot update). */
export function addLlmPort(
  id: string,
  port: number
): Promise<{ success: boolean; llmPorts: number[] }> {
  return apiFetch(`/api/sparks/${id}/llm-ports`, {
    method: "POST",
    body: JSON.stringify({ port }),
  });
}

/** Remove an LLM port from a Spark (hot update). */
export function removeLlmPort(
  id: string,
  port: number
): Promise<{ success: boolean; llmPorts: number[] }> {
  return apiFetch(`/api/sparks/${id}/llm-ports/${port}`, {
    method: "DELETE",
  });
}

/** Backward-compat: replace all ports via the legacy single-port endpoint. */
export function updateLlmPort(
  id: string,
  llmPort: number
): Promise<{ success: boolean; llmPort: number; llmPorts: number[] }> {
  return apiFetch(`/api/sparks/${id}/llm-port`, {
    method: "PUT",
    body: JSON.stringify({ llmPort }),
  });
}

/**
 * Set or clear an optional LLM API key for one port.
 * Pass apiKey "" to clear. Key is stored encrypted server-side and never returned.
 */
export function setLlmApiKey(
  id: string,
  port: number,
  apiKey: string
): Promise<{
  success: boolean;
  hasApiKey: boolean;
  llmApiKeyPorts: number[];
}> {
  return apiFetch(`/api/sparks/${id}/llm-ports/${port}/api-key`, {
    method: "PUT",
    body: JSON.stringify({ apiKey }),
  });
}

// ─── Hermes Agent ────────────────────────────────────
/** One-click `hermes update` via SSH on the Spark (background job; 202 when started). */
export function updateHermes(id: string): Promise<{ success: boolean; reason?: string }> {
  return apiFetch(`/api/sparks/${id}/hermes/update`, { method: "POST" });
}

/** Run `hermes update` on every Spark with Hermes Agent monitoring enabled. */
export function updateAllHermes(): Promise<HermesBatchUpdateResponse> {
  return apiFetch("/api/sparks/hermes/update-all", { method: "POST" });
}

/** Force an immediate `hermes update --check` on the Spark. */
export function checkHermes(id: string): Promise<{ success: boolean }> {
  return apiFetch(`/api/sparks/${id}/hermes/check`, { method: "POST" });
}

// ─── Power management ────────────────────────────────────
export interface PowerResult {
  success: boolean;
  message?: string;
  output?: string;
  mac?: string;
  broadcast?: string;
  error?: string;
}

export interface BatchPowerResult {
  success: boolean;
  results: {
    id: string;
    ok: boolean;
    error?: string;
    skipped?: boolean;
    mac?: string;
    broadcast?: string;
  }[];
}

/** Gracefully shut down a single Spark (host script: spark-shutdown). */
export function shutdownSpark(id: string): Promise<PowerResult> {
  return apiFetch(`/api/sparks/${id}/shutdown`, { method: "POST" });
}

/** Send a Wake-on-LAN magic packet to a single Spark. */
export function wakeSpark(id: string): Promise<PowerResult> {
  return apiFetch(`/api/sparks/${id}/wake`, { method: "POST" });
}

/** Shut down Sparks that are currently online. */
export function shutdownAllSparks(): Promise<BatchPowerResult> {
  return apiFetch("/api/sparks/shutdown-all", { method: "POST" });
}

/** Send WoL to all registered Sparks that have a MAC configured. */
export function wakeAllSparks(): Promise<BatchPowerResult> {
  return apiFetch("/api/sparks/wake-all", { method: "POST" });
}

// ─── Hermes update preview ───────────────────────────────
/** Per-Spark update preview (release + pending commits + resolved view). */
export function fetchHermesUpdates(id: string): Promise<HermesUpdatesResponse> {
  return apiFetch(`/api/sparks/${encodeURIComponent(id)}/hermes/updates`);
}

// ─── Global settings ──────────────────────────────────────
export function fetchSettings(): Promise<Settings> {
  return apiFetch("/api/settings");
}

export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return apiFetch("/api/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

// ─── Alert notifications ─────────────────────────────
export function fetchAlerts(): Promise<AlertsResponse> {
  return apiFetch("/api/alerts");
}

export function fetchAlertsConfig(): Promise<AlertsConfig> {
  return apiFetch("/api/alerts/config");
}

export function updateAlertsConfig(update: AlertsConfigUpdate): Promise<AlertsConfig> {
  return apiFetch("/api/alerts/config", {
    method: "PUT",
    body: JSON.stringify(update),
  });
}

/**
 * Send one test message. With `channel`, the unsaved draft is tested (a masked
 * URL resolves against `channelId` on the server).
 */
export function testAlertChannel(channelId: string | undefined, channel?: AlertChannel): Promise<AlertTestResult> {
  return apiFetch("/api/alerts/test", {
    method: "POST",
    body: JSON.stringify({ channelId, channel }),
  });
}

// ─── Fleet (node-agent) ─────────────────────────────────
/** Aggregated fleet snapshot: nodes + topology + requests + memory. */
export function fetchFleet(): Promise<FleetSnapshot> {
  return apiFetch("/api/fleet");
}

/** One service action proxied to a node's agent (POST /actions). */
export interface NodeActionRequest {
  type: "start" | "stop" | "restart" | "switch";
  serviceName: string;
  modelId?: string | null;
}

export interface NodeActionResponse {
  ok: boolean;
  status?: string;
  message?: string;
  error?: string;
}

export function sendNodeAction(
  nodeId: string,
  body: NodeActionRequest
): Promise<NodeActionResponse> {
  return apiFetch(`/api/fleet/nodes/${encodeURIComponent(nodeId)}/actions`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** One RoCE/transport link as stored in the node registry. */
export interface NodeLink {
  from: string;
  to: string;
  fromIf?: string | null;
  toIf?: string | null;
  speedMbps: number | null;
  transport: "roce" | "tcp";
  up: boolean;
}

/** One node record in config/nodes.json (the fleet registry). */
export interface NodeRecord {
  id: string;
  name: string;
  endpoint: string;
  lanIp: string;
  role: "head" | "worker" | "standalone";
  rank: number | null;
  groupId: string | null;
  headId: string | null;
  links: NodeLink[];
  agentPort: number;
  isLocal: boolean;
  /**
   * S1.2 enrollment state. "pending" until the node's first authenticated
   * poll or claim-token presentation flips it to "claimed"; legacy records
   * omit the key (read as claimed).
   */
  status?: "pending" | "claimed";
  /**
   * One-time enrollment claim token (S1.2), present while status is
   * "pending"; minted server-side on add, consumed by the claim endpoint.
   */
  claimToken?: string;
}

/** List all registered fleet nodes. */
export function fetchFleetNodes(): Promise<{ nodes: NodeRecord[] }> {
  return apiFetch("/api/fleet/nodes");
}

/** Add a fleet node (persisted to config/nodes.json). */
export function addFleetNode(node: NodeRecord): Promise<{ success: boolean; node: NodeRecord }> {
  return apiFetch("/api/fleet/nodes", {
    method: "POST",
    body: JSON.stringify(node),
  });
}

/** Update a fleet node by id. */
export function updateFleetNode(
  id: string,
  patch: Partial<NodeRecord>
): Promise<{ success: boolean; node: NodeRecord }> {
  return apiFetch(`/api/fleet/nodes/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

/** Remove a fleet node by id. */
export function deleteFleetNode(
  id: string
): Promise<{ success: boolean; removed: NodeRecord }> {
  return apiFetch(`/api/fleet/nodes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ─── Fleet updates (docs/SPEC-UPDATES.md §6.1) ────────
/** Fleet-wide updates view: one NodeUpdatesView per registered node. */
export function fetchFleetUpdates(): Promise<FleetUpdatesResponse> {
  return apiFetch("/api/fleet/updates");
}

/**
 * Trigger an immediate DGX update on one node. Rejects with ApiError status
 * 409 while any fleet wave is open (the §6.2 trigger guard).
 */
export function triggerUpdateNow(nodeId: string): Promise<UpdateActionResponse> {
  return apiFetch(`/api/fleet/nodes/${encodeURIComponent(nodeId)}/updates/now`, {
    method: "POST",
  });
}

/**
 * Schedule this node's single pending update ({ kind, at|cron, mirrorCron }).
 * `at` is epoch-ms; `cron` a 5-field expression. The agent owns the
 * one-pending-per-node rule; the resulting schedule list arrives via the
 * refreshed fleet-updates view, not this response body.
 */
export function scheduleUpdate(
  nodeId: string,
  body: ScheduleUpdateRequest
): Promise<UpdateActionResponse> {
  return apiFetch(`/api/fleet/nodes/${encodeURIComponent(nodeId)}/updates/schedule`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Cancel a node's pending schedule by id. */
export function cancelSchedule(
  nodeId: string,
  scheduleId: string
): Promise<UpdateActionResponse> {
  return apiFetch(
    `/api/fleet/nodes/${encodeURIComponent(nodeId)}/updates/schedule/${encodeURIComponent(scheduleId)}`,
    { method: "DELETE" }
  );
}

/**
 * Store the fleet plan: ordered waves of node ids. The server accepts
 * [[nodeId,…], …] groups and normalizes them to { nodeIds, reason } entries.
 */
export function saveUpdatePlan(groups: string[][]): Promise<SavePlanResponse> {
  return apiFetch("/api/fleet/updates/plan", {
    method: "POST",
    body: JSON.stringify({ groups }),
  });
}

/** Current plan (null = none) + live wave states. */
export function fetchUpdatePlan(): Promise<FleetPlanResponse> {
  return apiFetch("/api/fleet/updates/plan");
}

/** Abandon the plan. Rejects with ApiError status 409 while a wave is in flight. */
export function abandonUpdatePlan(): Promise<AbandonPlanResponse> {
  return apiFetch("/api/fleet/updates/plan", { method: "DELETE" });
}

// ─── Unit history (S2.3a routes; names mirrored exactly) ──

/** The 48 h / 30 d bucketed unit history (`{ enabled: false }` while the server setting is off). */
export function getUnitHistory(sparkId: string, range: MetricsHistoryRange): Promise<MetricsHistoryResponse> {
  return apiFetch<MetricsHistoryResponse>(`/api/sparks/${encodeURIComponent(sparkId)}/history?range=${range}`);
}

/** The dense GPU raw series (parallel arrays, newest last); default window server-side. */
export function getGpuHistory(sparkId: string, windowMs?: number): Promise<GpuHistoryResponse> {
  return apiFetch<GpuHistoryResponse>(
    `/api/sparks/${encodeURIComponent(sparkId)}/gpu-history${windowMs != null ? `?windowMs=${windowMs}` : ""}`,
  );
}

// ─── Guard proxy (S4.1b) ──────────────────────────────────

/** Fleet-level guard-proxy status; `guards: []` means nothing is configured. */
export function fetchGuard(): Promise<{ guards: GuardResult[] }> {
  return apiFetch("/api/guard");
}

// ─── Memory health (S5.1b) ─────────────────────────────────

/** Fleet-level AI-memory service health; `services: []` means nothing is configured. */
export function fetchMemoryHealth(): Promise<{ services: MemoryServiceResult[] }> {
  return apiFetch("/api/memory-health");
}
