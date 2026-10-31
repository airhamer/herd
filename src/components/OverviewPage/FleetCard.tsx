import type {
  ContainerInfo,
  CpuMetrics,
  GpuMetrics,
  MemMetrics,
  MemoryBudget,
  NodeRole,
  RequestStats,
  ServiceInstance,
  TopologyInfo,
  VersionInfo,
} from "../../../shared/types";
import { MetricBar } from "../ui/MetricBar";
import { MemoryPoolBar } from "../ui/MemoryPoolBar";
import { gpuHolderLabel, isUnifiedGpu, memBudgetStat, memoryPool } from "../../lib/memoryPool";
import { useNodeUpdateDisplay } from "../Updates/FleetUpdatesContext";

export interface FleetCardProps {
  nodeId: string;
  nodeName: string;
  lanIp: string;
  role: NodeRole;
  rank: number | null;
  groupId: string | null;
  online: boolean;
  /**
   * S1.2 enrollment state (registry-side, server-injected): "pending" shows
   * a pending chip until the node's first authenticated poll claims it.
   */
  enrollment?: "pending" | "claimed";
  gpu: GpuMetrics | null;
  cpu: CpuMetrics | null;
  mem: MemMetrics | null;
  containers: ContainerInfo[];
  services: ServiceInstance[];
  versions: VersionInfo[];
  requests: RequestStats | null;
  topology: TopologyInfo | null;
  memory: MemoryBudget | null;
  polledAt: number;
  /** When set, the card is clickable and opens the node detail view. */
  onSelect?: (nodeId: string) => void;
}

/**
 * Human "x ago" label for a ms-epoch timestamp. Buckets: <10s "just now",
 * <60s seconds, <60m minutes, <24h hours, else days.
 */
export function formatAgo(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function roleBadgeText(role: NodeRole): string {
  return role === "head" ? "Head" : role === "worker" ? "Worker" : "Standalone";
}

/** Sort rank: live work first, then starting, then stuck, then idle. */
const STATUS_RANK: Record<ServiceInstance["status"], number> = {
  running: 0,
  loading: 1,
  wedged: 2,
  stopped: 3,
  unknown: 4,
};

function modelDot(status: ServiceInstance["status"]): string {
  switch (status) {
    case "running":
      return "bg-success";
    case "loading":
      return "bg-warning";
    case "wedged":
      return "bg-danger";
    default:
      return "bg-border";
  }
}

function roleBadgeTitle(role: NodeRole, groupId: string | null, rank: number | null): string {
  if (role === "head") return groupId ? `Cluster head · group ${groupId}` : "Cluster head";
  if (role === "worker")
    return rank != null ? `Distributed LLM worker · rank ${rank}${groupId ? ` · ${groupId}` : ""}` : "Distributed LLM worker";
  return "Standalone node";
}

function MiniStat({
  label,
  value,
  tone = "default",
  title,
  testId,
}: {
  label: string;
  value: string;
  tone?: "default" | "accent" | "warning" | "danger" | "success";
  title?: string;
  testId?: string;
}) {
  const toneClass =
    tone === "danger"
      ? "text-danger"
      : tone === "warning"
        ? "text-warning"
        : tone === "accent"
          ? "text-accent"
          : tone === "success"
            ? "text-success"
            : "text-text";
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[10px] tracking-wide text-muted">{label}</span>
      <span className={`font-tabular truncate text-[13px] font-semibold ${toneClass}`} title={title} data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

/**
 * One fleet card in the fleet overview grid — one per node.
 * Header (name/role/status), GPU/CPU/VRAM/mem bars, container/service/request
 * counts, memory budget, and last-poll age.
 */
export function FleetCard(props: FleetCardProps) {
  const {
    nodeId,
    nodeName,
    lanIp,
    role,
    rank,
    groupId,
    online,
    enrollment,
    gpu,
    cpu,
    mem,
    containers,
    services,
    versions,
    requests,
    memory,
    polledAt,
    onSelect,
  } = props;

  /** SPEC §6.3: single "DGX update available" badge from view.display. */
  const { displayByNode, openUpdates } = useNodeUpdateDisplay(nodeId);
  const updateAvailable = displayByNode.get(nodeId) === "available";

  const usage = gpu?.usage ?? 0;
  const temp = gpu?.temperature ?? 0;
  const usageBarColor = usage > 85 ? "bg-danger" : usage > 60 ? "bg-warning" : "bg-accent";
  const tempBarColor = temp > 85 ? "bg-danger" : temp > 65 ? "bg-warning" : temp > 40 ? "bg-accent" : "bg-success";
  const vramUsed = gpu?.vramUsedMB ?? 0;
  const vramTotal = gpu?.vramTotalMB ?? 0;
  const vramPct = gpu?.vramPercentage ?? (vramTotal > 0 ? Math.round((vramUsed / vramTotal) * 100) : 0);
  const vramBarColor = vramPct > 85 ? "bg-danger" : vramPct > 60 ? "bg-warning" : "bg-accent";

  const cpuUsage = cpu?.usage ?? 0;
  const cpuTemp = cpu?.temperature ?? 0;

  const memUsed = mem?.usedMB ?? 0;
  const memTotal = mem?.totalMB ?? 0;

  // Issue #26: one pool split Hasso-style. On a GB10 the GPU draws from this
  // same pool, so it replaces the separate VRAM and Mem bars (which measured
  // the same 128 GB twice); a discrete GPU keeps its own VRAM bar.
  const unified = isUnifiedGpu(gpu, memTotal);
  const pool = mem
    ? memoryPool({
        totalMB: mem.totalMB,
        availableMB: mem.availableMB,
        cachedMB: mem.cachedMB,
        swapTotalMB: mem.swapTotalMB,
        swapFreeMB: mem.swapFreeMB,
        gpuMB: gpu?.gpuAllocMB ?? (gpu?.processes ?? []).reduce((n, p) => n + (p.vramMB || 0), 0),
        unified,
      })
    : null;
  // Mem Budget reads off the same pool as the bar (#26), not memory.freeMB.
  const memBudget = memory ? memBudgetStat(pool, memory) : null;

  const runningContainers = containers.filter((c) => c.status === "running").length;
  const stoppedContainers = containers.length - runningContainers;

  const activeServices = services.filter((s) => s.active).length;
  const runningServices = services.filter((s) => s.status === "running").length;

  /** Models on this node: one LLM service = one lane; several may coexist. */
  const llmServices = services
    .filter((s) => s.kind === "llm")
    .slice()
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.port - b.port);
  const versionByName = new Map(versions.map((v) => [v.serviceName, v]));
  const gpuHolder = gpuHolderLabel(
    llmServices.filter((s) => s.status === "running").map((s) => s.modelId),
    gpu?.processes?.[0]?.name,
  );

  const reqs = requests?.stats ?? [];
  const queued = reqs.reduce((n, r) => n + r.queued, 0);
  const running = reqs.reduce((n, r) => n + r.running, 0);
  const finished = reqs.reduce((n, r) => n + r.finished, 0);

  return (
    <div
      aria-label={`Fleet node ${nodeName}`}
      className={`overview-card flex flex-col ${
        onSelect ? "cursor-pointer transition-colors hover:border-accent/60" : ""
      }`}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect ? () => onSelect(nodeId) : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(nodeId);
              }
            }
          : undefined
      }
      style={{
        padding: "var(--density-card-pad)",
        gap: "var(--density-card-gap)",
        ...(online ? {} : { opacity: 0.6 }),
      }}
    >
      {/* Card header */}
      <div className="flex items-center gap-2.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-success dot-glow-success" : "bg-danger"}`}
        />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-strong" title={nodeId}>
          {nodeName}
        </span>
        <span
          className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
          title={roleBadgeTitle(role, groupId, rank)}
        >
          {roleBadgeText(role)}
        </span>
        {updateAvailable && (
          <button
            type="button"
            data-testid="update-badge"
            onClick={(e) => {
              e.stopPropagation();
              openUpdates();
            }}
            className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning hover:bg-warning/25"
            title="DGX update available — open the Updates page"
          >
            DGX update available
          </button>
        )}
        <span
          className={`text-[10px] uppercase tracking-wide ${enrollment === "pending" ? "text-warning" : "text-muted"}`}
          data-testid="fleet-card-status"
          title={enrollment === "pending" ? "Registered, never polled — present the claim token or let the first poll claim it" : undefined}
        >
          {enrollment === "pending" ? "pending" : online ? "online" : "offline"}
        </span>
      </div>

      <div className="text-[10px] font-tabular text-muted">
        {lanIp}
        {rank != null ? ` · rank ${rank}` : ""}
        {groupId ? ` · ${groupId}` : ""}
      </div>

      {!online || (!gpu && !cpu && !mem) ? (
        <div className="flex h-[120px] items-center justify-center">
          <span className="text-[13px] text-muted">
            {online ? "Waiting for metrics…" : "Host unreachable"}
          </span>
        </div>
      ) : (
        <>
          {/* Headline bars */}
          <div className="flex flex-col gap-3.5">
            {pool ? (
              <MemoryPoolBar pool={pool} holder={gpuHolder} />
            ) : mem ? (
              <MetricBar
                label="Mem"
                value={memUsed}
                max={memTotal}
                caption={memTotal > 0 ? `${formatMb(memUsed).replace(/ (GB|MB)$/, "")} / ${formatMb(memTotal)}` : "—"}
              />
            ) : null}
            {!(pool && unified) && (
              <MetricBar
                label="VRAM"
                value={vramUsed}
                max={vramTotal}
                color={vramBarColor}
                caption={vramTotal > 0 ? `${formatMb(vramUsed).replace(/ (GB|MB)$/, "")} / ${formatMb(vramTotal)}` : "—"}
              />
            )}
            <MetricBar
              label="GPU"
              value={temp}
              max={100}
              color={tempBarColor}
              caption={`${temp}°C`}
            />
            <MetricBar label="Usage" value={usage} max={100} color={usageBarColor} caption={`${usage}%`} />
          </div>

          {/* Models — one row per LLM service (coexisting lanes), live ones first */}
          <div className="mt-4 border-t border-border pt-3.5">
            <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted">Models</div>
            {llmServices.length === 0 ? (
              <div className="text-[11px] text-muted" data-testid="fleet-card-models-empty">
                No LLM services
              </div>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="fleet-card-models">
                {llmServices.map((s) => {
                  const v = versionByName.get(s.name);
                  const title =
                    `${s.name} \u00b7 ${s.status}${s.modelId ? ` \u00b7 ${s.modelId}` : ""}` +
                    `${v?.modelPath ? ` \u00b7 ${v.modelPath}` : ""}${v?.quantization ? ` \u00b7 ${v.quantization}` : ""}` +
                    ` \u00b7 ${s.engine}${(v?.engineVersion ?? s.engineVersion) ? ` ${(v?.engineVersion ?? s.engineVersion)}` : ""} \u00b7 :${s.port}`;
                  return (
                    <li key={`${s.name}:${s.port}`} className="flex items-center gap-1.5 text-[11px]" title={title}>
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${modelDot(s.status)}`}
                        aria-hidden="true"
                      />
                      <span
                        className={`min-w-0 flex-1 truncate ${
                          s.status === "running" ? "font-medium text-text" : "text-muted"
                        }`}
                      >
                        {s.modelId ?? s.name}
                        {v?.quantization ? ` (${v.quantization})` : ""}
                      </span>
                      {(s.status === "loading" || s.status === "wedged") && (
                        <span className={`shrink-0 text-[10px] ${s.status === "wedged" ? "text-danger" : "text-warning"}`}>
                          {s.status}
                        </span>
                      )}
                      {s.active && s.status === "running" && (
                        <span className="shrink-0 rounded bg-accent/15 px-1 text-[9px] uppercase tracking-wide text-accent">
                          active
                        </span>
                      )}
                      <span className="shrink-0 font-tabular text-[10px] text-muted">
                        {s.engine} · :{s.port}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Secondary stats */}
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-border pt-3.5">
            <MiniStat label="GPU Power" value={`${gpu?.powerDraw ?? 0}W / ${gpu?.powerLimit ?? 0}W`} />
            <MiniStat
              label="CPU"
              value={`${cpuUsage}% · ${cpuTemp}°C`}
              tone={cpuTemp > 95 ? "danger" : cpuTemp > 85 ? "warning" : "default"}
              title="CPU usage · temperature"
            />
            <MiniStat
              label="Containers"
              value={`${containers.length} (${runningContainers} running)`}
              title={
                containers.length > 0
                  ? containers.map((c) => `${c.name} [${c.status}]${c.ports && c.ports.length ? " ports:" + c.ports.join(",") : ""}`).join("\n")
                  : "No containers"
              }
            />
            <MiniStat
              label="Services"
              value={`${services.length} (${runningServices} active)`}
              title={
                services.length > 0
                  ? services.map((s) => `${s.name} [${s.status}]${s.active ? " · active" : ""}`).join("\n")
                  : "No services"
              }
            />
            <MiniStat
              label="Requests"
              value={`q${queued} · r${running} · f${finished}`}
              title="queued · running · finished"
            />
            {memory && memBudget && (
              <MiniStat label="Mem Budget" testId="fleet-card-mem-budget" value={memBudget.value} tone={memBudget.tone} title={memBudget.title} />
            )}
            {memory?.needMakeRoom && (
              <div
                className="col-span-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] font-medium text-danger"
                title={
                  memory.makeRoom.length > 0
                    ? `Stop to free memory: ${memory.makeRoom.map((m) => `${m.serviceName} (${formatMb(m.freesMB)})`).join(", ")}`
                    : "Free memory below target — a make-room plan is needed"
                }
              >
                Make room needed
                {memory.makeRoom.length > 0
                  ? ` — stop: ${memory.makeRoom.map((m) => m.serviceName).join(", ")}`
                  : ""}
              </div>
            )}
          </div>
        </>
      )}

      {/* Footer: last poll */}
      <div className="flex items-center justify-between border-t border-border pt-2 text-[10px] uppercase tracking-wide text-muted">
        <span data-testid="fleet-card-polledat">Polled {formatAgo(polledAt)}</span>
        <span className="font-tabular">{nodeId}</span>
      </div>
    </div>
  );
}
