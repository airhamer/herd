import type { CSSProperties } from "react";
import { gib, poolScaleGiB, SWAP_SHOWN_MB, type MemoryPool } from "../../lib/memoryPool";

/**
 * Hasso-style unified-memory bars (issue #26): one pool split into parts that
 * add up — the model's GPU allocations, system and apps, reclaimable page
 * cache, free — with the floor hatched at the right end, the available headroom
 * above that floor, and swap when it is in use. The math is memoryPool().
 *
 * - MemoryPoolBar: compact, for the Fleet and Sparks cards.
 * - MemoryPoolReservoir: the tall bar with in-segment labels, 16 GiB ticks,
 *   GiB scale and a swap strip, for the spark detail panel.
 */

export const SWAP_HATCH =
  "repeating-linear-gradient(135deg, var(--color-warning) 0 2px, transparent 2px 4px)";
const FREE_HATCH =
  "repeating-linear-gradient(135deg, color-mix(in srgb, var(--color-success) 22%, transparent) 0 6px, color-mix(in srgb, var(--color-success) 8%, transparent) 6px 12px)";
const FLOOR_HATCH =
  "repeating-linear-gradient(135deg, color-mix(in srgb, var(--color-danger) 35%, transparent) 0 3px, transparent 3px 6px)";

export const TONE_CLASS: Record<MemoryPool["tone"], string> = {
  ok: "text-success",
  low: "text-warning",
  crit: "text-danger",
};

export function pct(part: number, total: number): string {
  return `${total > 0 ? Math.max(0, Math.min(100, (part / total) * 100)).toFixed(2) : 0}%`;
}

export interface PoolSegment {
  key: "gpu" | "other" | "cache" | "free";
  /** Legend label. */
  label: string;
  /** Short in-bar label (Hasso: "flash 176B 99 GiB", "cache 11 GiB"). */
  short: string;
  mb: number;
  className: string;
  style?: CSSProperties;
}

/** The pool's segments in Hasso's order; the GPU one only on a unified pool. */
export function poolSegments(pool: MemoryPool, holder: string): PoolSegment[] {
  const whole = (mb: number) => `${Math.round(mb / 1024)} GiB`;
  return [
    ...(pool.unified
      ? [{ key: "gpu" as const, label: holder, short: `${holder} ${whole(pool.gpuMB)}`, mb: pool.gpuMB, className: "bg-accent text-black" }]
      : []),
    { key: "other", label: "System and apps", short: `system ${whole(pool.otherMB)}`, mb: pool.otherMB, className: "bg-muted-strong text-surface" },
    { key: "cache", label: "Page cache", short: `cache ${whole(pool.cacheMB)}`, mb: pool.cacheMB, className: "bg-muted/60 text-text-strong" },
    { key: "free", label: "Free", short: `free ${whole(pool.freeMB)}`, mb: pool.freeMB, className: "text-success", style: { background: FREE_HATCH } },
  ];
}

export function poolSummary(pool: MemoryPool, holder: string): string {
  return (
    `${gib(pool.inUseMB)} of ${gib(pool.totalMB)} GiB in use` +
    (pool.unified && pool.gpuMB > 0 ? `; ${holder} holds ${gib(pool.gpuMB)} GiB on the GPU side` : "") +
    `; ${gib(pool.availableMB)} GiB available`
  );
}

function floorTitle(pool: MemoryPool): string {
  return `The floor: under ${(pool.floorMB / 1024).toFixed(0)} GiB available a Spark risks an OOM livelock`;
}

export function MemoryPoolBar({ pool, holder }: { pool: MemoryPool; holder: string }) {
  const floorGiB = (pool.floorMB / 1024).toFixed(0);
  const parts = poolSegments(pool, holder);
  const showSwap = pool.swapUsedMB > SWAP_SHOWN_MB;
  const summary = poolSummary(pool, holder);

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
              style={{ ...p.style, width: pct(p.mb, pool.totalMB) }}
              title={`${p.label}: ${gib(p.mb)} GiB`}
            />
          ) : null,
        )}
        <div
          data-testid="memory-pool-floor"
          className="absolute inset-y-0 right-0 border-l-2 border-danger"
          style={{ width: pct(pool.floorMB, pool.totalMB), background: FLOOR_HATCH }}
          title={floorTitle(pool)}
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
              className={`h-2 w-2 shrink-0 rounded-sm ${p.key === "free" ? "border border-success/60" : p.className}`}
              style={p.style}
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

/**
 * The tall bar for the detail panel: segments sized by share of the total with
 * their label inside when the segment is wider than 9% (Hasso), a tick every
 * 16 GiB, the hatched floor at the right end, a GiB scale under it, and — when
 * swap is in use — a swap strip on the same scale (swap lives outside RAM, so
 * it gets its own track rather than a share of the pool).
 */
export function MemoryPoolReservoir({ pool, holder }: { pool: MemoryPool; holder: string }) {
  const parts = poolSegments(pool, holder);
  const tick = pct(16 * 1024, pool.totalMB);
  const showSwap = pool.swapUsedMB > SWAP_SHOWN_MB;
  return (
    <div data-testid="memory-reservoir">
      <div
        className="relative flex h-16 w-full overflow-hidden rounded-xl border border-border bg-surface-elevated"
        role="img"
        aria-label={`Unified memory: ${poolSummary(pool, holder)}`}
      >
        {parts.map((p) => {
          const share = pool.totalMB > 0 ? (p.mb / pool.totalMB) * 100 : 0;
          return p.mb > 0 ? (
            <div
              key={p.key}
              data-testid={`memory-reservoir-seg-${p.key}`}
              className={`relative flex h-full shrink-0 items-end overflow-hidden whitespace-nowrap px-2 pb-1.5 text-[11px] font-medium ${p.className}`}
              style={{ ...p.style, width: pct(p.mb, pool.totalMB) }}
              title={`${p.label}: ${gib(p.mb)} GiB`}
            >
              {share > 9 ? <span data-testid={`memory-reservoir-label-${p.key}`}>{p.short}</span> : null}
            </div>
          ) : null;
        })}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background: `repeating-linear-gradient(90deg, transparent 0, transparent calc(${tick} - 1px), color-mix(in srgb, var(--color-text) 14%, transparent) calc(${tick} - 1px), color-mix(in srgb, var(--color-text) 14%, transparent) ${tick})`,
          }}
        />
        <div
          data-testid="memory-reservoir-floor"
          className="absolute inset-y-0 right-0 border-l-2 border-danger"
          style={{ width: pct(pool.floorMB, pool.totalMB), background: FLOOR_HATCH }}
          title={floorTitle(pool)}
        />
      </div>
      <div className="relative mt-1 h-4 text-[11px] text-muted font-tabular" aria-hidden="true" data-testid="memory-reservoir-scale">
        {poolScaleGiB(pool.totalMB).map((g) => (
          <span key={g} className="absolute" style={{ left: pct(g * 1024, pool.totalMB), transform: g === 0 ? undefined : "translateX(-50%)" }}>
            {g === 0 ? "0" : `${g} GiB`}
          </span>
        ))}
        <span className="absolute right-0">{gib(pool.totalMB)} GiB</span>
      </div>
      {showSwap && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-warning" data-testid="memory-reservoir-swap">
          <span className="w-10 shrink-0">Swap</span>
          <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-border">
            <div className="h-full" style={{ width: pct(pool.swapUsedMB, pool.totalMB), background: SWAP_HATCH }} />
          </div>
          <span className="font-tabular">{gib(pool.swapUsedMB)} GiB</span>
        </div>
      )}
    </div>
  );
}
