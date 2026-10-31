import type { SparkSnapshot } from "../../api/types";
import { gib, gpuHolderLabel, isUnifiedSpark, memoryPool, poolClassGB, SWAP_SHOWN_MB } from "../../lib/memoryPool";
import { MemoryPoolReservoir, poolSegments, SWAP_HATCH, TONE_CLASS } from "../ui/MemoryPoolBar";
import { Panel } from "../ui/Panel";
import { MemoryIcon } from "../ui/icons";

/**
 * The full unified-memory panel on a Spark's page (issue #26), after Hasso's
 * cockpit (hasso5703/dgx-spark-qwen38 dashboard/static/js/now.js renderPool):
 * what the box is, the big in-use number, who holds the GPU side, the
 * available memory and its headroom above the floor, the reservoir bar and the
 * full legend.
 */
export function UnifiedMemoryPanel({ spark, className }: { spark: SparkSnapshot; className?: string }) {
  const um = spark.metrics.unifiedMemory;
  // Only a positively identified DGX Spark (GB10): never on a discrete-GPU or CPU-only host.
  const pool =
    isUnifiedSpark(spark) && um
      ? memoryPool({
          totalMB: um.total,
          availableMB: um.available,
          cachedMB: um.cached,
          swapTotalMB: um.swapTotal,
          swapFreeMB: um.swapFree,
          gpuMB: um.gpuUsed,
          unified: true,
        })
      : null;
  if (!pool) return null;

  const models = (spark.metrics.llm ?? []).filter((l) => l.available).map((l) => l.modelId);
  const holder = gpuHolderLabel(models, spark.metrics.gpu?.processes?.[0]?.name);
  const namedModel = models.some((m) => typeof m === "string" && m.trim() !== "");
  const cls = poolClassGB(pool.totalMB, spark.hardware?.totalMemoryGB);
  const device = spark.hardware?.device?.trim();
  const title = device
    ? `Unified memory of this ${device}${cls ? `, ${cls} GB` : ""}, shared by CPU and GPU`
    : "Unified memory, shared by CPU and GPU";
  const sub =
    pool.gpuMB <= 0
      ? "Nothing holds the GPU side of the pool."
      : namedModel
        ? `${holder} holds its weights and its KV pool: ${gib(pool.gpuMB)} GiB on the GPU side of the pool.`
        : `${holder} holds ${gib(pool.gpuMB)} GiB on the GPU side of the pool.`;
  const floorGiB = (pool.floorMB / 1024).toFixed(0);
  const segments = poolSegments(pool, holder);

  return (
    <Panel title="Unified memory" icon={<MemoryIcon />} className={`panel-unified-memory ${className ?? ""}`} bodyClassName="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2" data-testid="unified-memory-panel">
        <div className="min-w-0">
          <div className="text-xs text-muted" data-testid="unified-memory-title">{title}</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-tabular text-4xl font-bold leading-none tracking-tight text-text-strong" data-testid="unified-memory-used">
              {gib(pool.inUseMB)}
            </span>
            <span className="text-sm text-muted">of {gib(pool.totalMB)} GiB in use</span>
          </div>
          <p className="mt-1.5 text-xs text-muted" data-testid="unified-memory-sub">{sub}</p>
        </div>
        <div className="flex flex-col items-end text-right" data-testid="unified-memory-free">
          <span className={`font-tabular text-4xl font-bold leading-none tracking-tight ${TONE_CLASS[pool.tone]}`} data-testid="unified-memory-available">
            {gib(pool.availableMB)}
          </span>
          <span className="mt-1.5 text-xs text-muted" data-testid="unified-memory-floor-text">
            {pool.aboveFloorMB > 0
              ? `GiB available, ${gib(pool.aboveFloorMB)} above the ${floorGiB} GiB floor`
              : `GiB available: under the ${floorGiB} GiB floor`}
          </span>
        </div>
      </div>

      <MemoryPoolReservoir pool={pool} holder={holder} />

      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted" data-testid="unified-memory-legend">
        {segments.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${p.key === "free" ? "border border-success/60" : p.className}`}
              style={p.style}
              aria-hidden="true"
            />
            <span>{p.key === "gpu" ? `${p.label}, GPU allocations` : p.label}</span>
            <b className="font-tabular text-text">{gib(p.mb)} GiB</b>
          </li>
        ))}
        {pool.swapUsedMB > SWAP_SHOWN_MB && (
          <li className="flex items-center gap-1.5" data-testid="unified-memory-swap">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SWAP_HATCH }} aria-hidden="true" />
            <span>Swap in use</span>
            <b className="font-tabular text-text">{gib(pool.swapUsedMB)} GiB</b>
          </li>
        )}
      </ul>
    </Panel>
  );
}
