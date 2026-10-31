import type { MemoryPool } from "../../lib/memoryPool";
import { gib } from "../../lib/memoryPool";
import { MemoryPoolBar } from "../ui/MemoryPoolBar";

export interface GroupCardProps {
  /** Group id (e.g. "tp2-glm"). */
  groupId: string;
  /** Members designated into the group (TP size). */
  memberCount: number;
  /** Members currently online. */
  onlineCount: number;
  /** Memory aggregated across the group's members (groupMemory). */
  pool: MemoryPool | null;
  /** Who holds the GPU part, across the group (gpuHolderLabel). */
  holder: string;
}

/**
 * One TP-group card in the fleet overview (SC9): group-level facts only —
 * the group id, its TP size, online members as a count, and the group's
 * aggregated unified memory rendered with the Hasso pool bar (#26 display).
 * Individual members are NOT listed here; they live on their own node
 * pages and node cards.
 */
export function GroupCard({ groupId, memberCount, onlineCount, pool, holder }: GroupCardProps) {
  const anyOnline = onlineCount > 0;
  return (
    <div
      aria-label={`Fleet group ${groupId}`}
      data-testid="group-card"
      data-group-id={groupId}
      className="overview-card flex flex-col"
      style={{
        padding: "var(--density-card-pad)",
        gap: "var(--density-card-gap)",
        ...(anyOnline ? {} : { opacity: 0.6 }),
      }}
    >
      {/* Header: group-level identity only */}
      <div className="flex items-center gap-2.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${anyOnline ? "bg-success dot-glow-success" : "bg-danger"}`}
        />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-text-strong" title={groupId}>
          {groupId}
        </span>
        <span
          className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
          title={`Tensor-parallel group of ${memberCount} spark${memberCount === 1 ? "" : "s"}`}
        >
          TP{memberCount} group
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted" data-testid="group-card-online">
          {onlineCount}/{memberCount} online
        </span>
      </div>

      {/* Aggregated group memory — Hasso pool bar over the summed members */}
      {pool ? (
        <div data-testid="group-card-memory">
          <MemoryPoolBar pool={pool} holder={holder} />
        </div>
      ) : (
        <div className="flex h-[60px] items-center justify-center">
          <span className="text-[13px] text-muted">
            {anyOnline ? "Waiting for metrics…" : "Group offline"}
          </span>
        </div>
      )}

      {pool && (
        <div className="flex min-w-0 flex-col gap-0.5 border-t border-border pt-2">
          <span className="text-[10px] tracking-wide text-muted">Group memory</span>
          <span className="font-tabular truncate text-[13px] font-semibold text-text" data-testid="group-card-total">
            {gib(pool.totalMB)} GiB total · {gib(pool.inUseMB)} in use · {gib(pool.availableMB)} available
          </span>
        </div>
      )}
    </div>
  );
}
