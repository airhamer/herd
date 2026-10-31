import type { NodeAgentSnapshot } from "../../../shared/types";
import { gib } from "../../lib/memoryPool";
import { aggregateMetrics } from "../../lib/groupAggregate";
import { MemoryPoolBar } from "../ui/MemoryPoolBar";
import { MetricBar } from "../ui/MetricBar";

export interface GroupCardMember {
  snapshot: NodeAgentSnapshot;
  /** TP rank in the group (0 = head). */
  rank: number | null;
}

export interface GroupCardProps {
  /** Group id (e.g. "tp2"). */
  groupId: string;
  /** Display name (defaults to the id). */
  name?: string;
  /** Members, head first. */
  members: GroupCardMember[];
  /** Who holds the GPU part, across the group (gpuHolderLabel). */
  holder: string;
  /** Opens the group detail view (each member's own bars). Click, double-click or Enter. */
  onOpen?: (groupId: string) => void;
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/**
 * One spark-group card in the fleet overview (SC5d, #75; builds on SC9).
 * The group replaces its members' cards: one bar per metric for the whole
 * group (memory = the Hasso pool over the summed members; GPU/CPU bars
 * aggregated the same way, see lib/groupAggregate), plus the member list.
 * Drilling in opens the group detail view with each member's own bars.
 */
export function GroupCard({ groupId, name, members, holder, onOpen }: GroupCardProps) {
  const label = name || groupId;
  const memberCount = members.length;
  const onlineCount = members.filter((m) => m.snapshot.online).length;
  const anyOnline = onlineCount > 0;
  const agg = aggregateMetrics(members.filter((m) => m.snapshot.online).map((m) => m.snapshot));
  const { pool, gpu, cpu } = agg;
  const open = onOpen ? () => onOpen(groupId) : undefined;

  // The group's components: LLM services across members, one row per model,
  // with the members it runs on (a TP=x component spans the group).
  const components = new Map<string, { label: string; engine: string; running: boolean; nodes: string[] }>();
  for (const m of members) {
    for (const svc of m.snapshot.services ?? []) {
      if (svc.kind !== "llm") continue;
      const key = svc.modelId ?? svc.name;
      const c = components.get(key) ?? { label: key, engine: svc.engine, running: false, nodes: [] };
      c.running ||= svc.status === "running";
      if (!c.nodes.includes(m.snapshot.nodeId)) c.nodes.push(m.snapshot.nodeId);
      components.set(key, c);
    }
  }

  return (
    <div
      aria-label={`Fleet group ${label}`}
      data-testid="group-card"
      data-group-id={groupId}
      className={`overview-card flex flex-col ${open ? "cursor-pointer transition-colors hover:border-accent/60" : ""}`}
      role={open ? "button" : undefined}
      tabIndex={open ? 0 : undefined}
      title={open ? "Open the group: each member's own bars" : undefined}
      onClick={open}
      onKeyDown={
        open
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open();
              }
            }
          : undefined
      }
      style={{
        padding: "var(--density-card-pad)",
        gap: "var(--density-card-gap)",
        ...(anyOnline ? {} : { opacity: 0.6 }),
      }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${anyOnline ? "bg-success dot-glow-success" : "bg-danger"}`}
        />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-strong" title={groupId}>
          {label}
        </span>
        <span
          className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
          title={`Tensor-parallel group of ${memberCount} spark${memberCount === 1 ? "" : "s"} (TP = GPUs in the group)`}
        >
          TP{memberCount} group
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted" data-testid="group-card-online">
          {onlineCount}/{memberCount} online
        </span>
      </div>

      {/* Member list (head first) */}
      <ul className="flex flex-wrap gap-1.5" data-testid="group-card-members">
        {members.map((m) => (
          <li
            key={m.snapshot.nodeId}
            className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] font-tabular text-muted"
            title={`${m.snapshot.nodeName} · ${m.snapshot.online ? "online" : "offline"}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${m.snapshot.online ? "bg-success" : "bg-danger"}`} aria-hidden="true" />
            <span className="text-text">{m.snapshot.nodeId}</span>
            {m.rank === 0 ? <span className="text-accent">head</span> : m.rank != null ? <span>rank {m.rank}</span> : null}
          </li>
        ))}
      </ul>

      {!anyOnline || agg.reporting === 0 ? (
        <div className="flex h-[60px] items-center justify-center">
          <span className="text-[13px] text-muted">{anyOnline ? "Waiting for metrics…" : "Group offline"}</span>
        </div>
      ) : (
        <div className="flex flex-col gap-3.5" data-testid="group-card-bars">
          {pool && (
            <div data-testid="group-card-memory">
              <MemoryPoolBar pool={pool} holder={holder} />
            </div>
          )}
          {gpu && !gpu.unified && gpu.vramTotalMB > 0 && (
            <MetricBar
              label="VRAM (group)"
              value={gpu.vramUsedMB}
              max={gpu.vramTotalMB}
              caption={`${formatMb(gpu.vramUsedMB).replace(/ (GB|MB)$/, "")} / ${formatMb(gpu.vramTotalMB)}`}
            />
          )}
          {gpu && (
            <MetricBar
              label="GPU (hottest)"
              value={gpu.temperatureMax ?? 0}
              max={100}
              caption={gpu.temperatureMax != null ? `${gpu.temperatureMax}°C` : "—"}
            />
          )}
          {gpu && <MetricBar label="Usage (group)" value={gpu.usage} max={100} caption={`${gpu.usage}%`} />}
          {cpu && (
            <MetricBar
              label="CPU (group)"
              value={cpu.usage}
              max={100}
              caption={`${cpu.usage}%${cpu.temperatureMax != null ? ` · ${cpu.temperatureMax}°C max` : ""}`}
            />
          )}
        </div>
      )}

      <div className="border-t border-border pt-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">Components</div>
        {components.size === 0 ? (
          <div className="text-[11px] text-muted" data-testid="group-card-components-empty">
            No LLM services
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5" data-testid="group-card-components">
            {[...components.values()].map((c) => (
              <li key={c.label} className="flex items-center gap-1.5 text-[11px]">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.running ? "bg-success" : "bg-muted"}`} aria-hidden="true" />
                <span className={`min-w-0 flex-1 truncate ${c.running ? "font-medium text-text" : "text-muted"}`}>{c.label}</span>
                <span className="shrink-0 font-tabular text-[10px] text-muted">
                  {c.engine} · {c.nodes.length === memberCount ? `TP${memberCount}` : c.nodes.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {pool && (
        <div className="flex min-w-0 flex-col gap-0.5 border-t border-border pt-2">
          <span className="text-[10px] tracking-wide text-muted">Group memory</span>
          <span className="font-tabular truncate text-[13px] font-semibold text-text" data-testid="group-card-total">
            {gib(pool.totalMB)} GiB total · {gib(pool.inUseMB)} in use · {gib(pool.availableMB)} available
          </span>
          {gpu && (
            <span className="font-tabular text-[11px] text-muted" data-testid="group-card-power">
              GPU power {gpu.powerDraw}W / {gpu.powerLimit}W
            </span>
          )}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-2 text-[10px] uppercase tracking-wide text-muted">
        <span>{open ? "Open for member details" : "Spark group"}</span>
        <span className="font-tabular">{groupId}</span>
      </div>
    </div>
  );
}
