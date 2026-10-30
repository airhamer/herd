import { gib, SWAP_SHOWN_MB, type MemoryPool } from "../../lib/memoryPool";

/**
 * Hasso-style unified-memory bar (issue #26): one pool split into parts that
 * add up — the model's GPU allocations, system and apps, reclaimable page
 * cache, free — with the floor marked at the right end, the available headroom
 * above that floor, and swap when it is in use.
 *
 * Compact variant for the Fleet and Sparks cards; the math is memoryPool().
 */

const SWAP_HATCH =
  "repeating-linear-gradient(135deg, var(--color-warning) 0 2px, transparent 2px 4px)";

const TONE_CLASS: Record<MemoryPool["tone"], string> = {
  ok: "text-success",
  low: "text-warning",
  crit: "text-danger",
};

function pct(part: number, total: number): string {
  return `${total > 0 ? Math.max(0, Math.min(100, (part / total) * 100)).toFixed(2) : 0}%`;
}

interface Part {
  key: "gpu" | "other" | "cache" | "free";
  label: string;
  mb: number;
  className: string;
}

export function MemoryPoolBar({ pool, holder }: { pool: MemoryPool; holder: string }) {
  const floorGiB = (pool.floorMB / 1024).toFixed(0);
  const parts: Part[] = [
    ...(pool.unified
      ? [{ key: "gpu" as const, label: holder, mb: pool.gpuMB, className: "bg-accent" }]
      : []),
    { key: "other", label: "System and apps", mb: pool.otherMB, className: "bg-muted-strong" },
    { key: "cache", label: "Page cache", mb: pool.cacheMB, className: "bg-muted/45" },
    { key: "free", label: "Free", mb: pool.freeMB, className: "bg-transparent" },
  ];
  const showSwap = pool.swapUsedMB > SWAP_SHOWN_MB;
  const summary =
    `${gib(pool.inUseMB)} of ${gib(pool.totalMB)} GiB in use` +
    (pool.unified && pool.gpuMB > 0 ? `; ${holder} holds ${gib(pool.gpuMB)} GiB on the GPU side` : "") +
    `; ${gib(pool.availableMB)} GiB available`;

  return (
    <div className="space-y-1" data-testid="memory-pool">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted">{pool.unified ? "Unified memory" : "Memory"}</span>
        <span className="font-tabular text-sm text-text">
          <span className="font-semibold text-text-strong" data-testid="memory-pool-used">
            {gib(pool.inUseMB)}
          </span>
          {` / ${gib(pool.totalMB)} GiB in use`}
        </span>
      </div>

      <div
        className="relative flex h-2 w-full overflow-hidden rounded-full bg-border"
        role="img"
        aria-label={summary}
        title={summary}
      >
        {parts.map((p) =>
          p.mb > 0 ? (
            <div
              key={p.key}
              data-testid={`memory-pool-seg-${p.key}`}
              className={`h-full shrink-0 ${p.className}`}
              style={{ width: pct(p.mb, pool.totalMB) }}
              title={`${p.label}: ${gib(p.mb)} GiB`}
            />
          ) : null,
        )}
        <div
          data-testid="memory-pool-floor"
          className="absolute inset-y-0 right-0 border-l-2 border-danger bg-danger/15"
          style={{ width: pct(pool.floorMB, pool.totalMB) }}
          title={`The floor: under ${floorGiB} GiB available a Spark risks an OOM livelock`}
        />
      </div>

      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className={`font-tabular ${TONE_CLASS[pool.tone]}`} data-testid="memory-pool-available">
          <span className="font-semibold">{gib(pool.availableMB)}</span> GiB available
        </span>
        <span className="font-tabular text-muted" data-testid="memory-pool-floor-text">
          {pool.aboveFloorMB > 0
            ? `${gib(pool.aboveFloorMB)} above the ${floorGiB} GiB floor`
            : `under the ${floorGiB} GiB floor`}
        </span>
      </div>

      <ul className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10px] text-muted" data-testid="memory-pool-legend">
        {parts.map((p) => (
          <li key={p.key} className="flex min-w-0 items-center gap-1">
            <span
              className={`h-2 w-2 shrink-0 rounded-sm ${p.key === "free" ? "border border-border-strong" : p.className}`}
              aria-hidden="true"
            />
            <span className={`truncate ${p.key === "gpu" ? "max-w-[10rem] text-text" : ""}`} title={p.label}>
              {p.label}
            </span>
            <span className="font-tabular">{gib(p.mb)}</span>
          </li>
        ))}
        {showSwap && (
          <li className="flex items-center gap-1 text-warning" data-testid="memory-pool-swap">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: SWAP_HATCH }} aria-hidden="true" />
            <span>Swap in use</span>
            <span className="font-tabular">{gib(pool.swapUsedMB)}</span>
          </li>
        )}
      </ul>
    </div>
  );
}
