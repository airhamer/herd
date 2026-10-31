/**
 * Glue between the bench managers and the results store: remembers the
 * provenance captured when a run starts and writes the finished run's
 * records when the manager reports it.
 */

import { fromDecodeJob, fromFleetShowcaseSession, fromPrefillJob, fromQualityJob, fromShowcaseSession } from "./adapters.js";
import { makeMetricRow } from "./schema.js";
import { energyMetricRow, memoryHeadroom, runEnergy } from "../upgrade/runCost.js";

const ADAPTERS = {
  DecodeBench: { convert: fromDecodeJob, idOf: (o) => o?.benchId },
  PrefillBench: { convert: fromPrefillJob, idOf: (o) => o?.benchId },
  Showcase: { convert: fromShowcaseSession, idOf: (o) => o?.sessionId },
  // SHOW1: one record per lane; provenance is { lanes: { [laneId]: Provenance } }.
  FleetShowcase: { convert: fromFleetShowcaseSession, idOf: (o) => o?.sessionId },
  QualityBench: { convert: fromQualityJob, idOf: (o) => o?.benchId },
};

const MAX_PENDING = 200;

/**
 * Optional run-cost hooks (BENCH6): `energyWindow(nodeId, startMs, endMs)`
 * reads the fleet energy tracker for the run window; `memoryNow(nodeId)`
 * returns `{ available_mb, total_mb }` and is read at start and at finish.
 * Their results land in `settings.run_energy` / `settings.run_memory` of
 * every record of the run, plus a `wh_per_1k_tokens` row when the run's
 * output tokens are known.
 * @param {{
 *   store: import("./store.js").BenchResultsStore,
 *   log?: (msg: string) => void,
 *   energyWindow?: ((nodeId: string, startMs: number, endMs: number) => any) | null,
 *   memoryNow?: ((nodeId: string) => ({ available_mb: number, total_mb: number } | null)) | null,
 * }} deps
 */
export function createResultsRecorder({ store, log = (m) => console.warn(m), energyWindow = null, memoryNow = null }) {
  const readMemory = (nodeId) => {
    if (typeof memoryNow !== "function" || !nodeId) return null;
    try {
      return memoryNow(nodeId) ?? null;
    } catch {
      return null;
    }
  };

  /** @type {Map<string, any>} */
  const pending = new Map();

  return {
    /**
     * @param {"DecodeBench"|"PrefillBench"|"Showcase"|"FleetShowcase"|"QualityBench"} bench
     * @param {string} id  benchId / sessionId
     * @param {any} provenance  describeProvenance(...) result
     */
    noteStart(bench, id, provenance) {
      if (!id) return;
      pending.set(`${bench}:${id}`, { provenance, memoryStart: readMemory(provenance?.host?.node_id) });
      while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
    },

    /**
     * @param {"DecodeBench"|"PrefillBench"|"Showcase"|"FleetShowcase"|"QualityBench"} bench
     * @param {any} finished  public job / session record
     * @returns {{ added: number, updated: number, rejected: any[] } | null}
     */
    record(bench, finished) {
      const adapter = ADAPTERS[bench];
      if (!adapter) return null;
      const key = `${bench}:${adapter.idOf(finished)}`;
      const started = pending.get(key);
      pending.delete(key);
      const records = adapter.convert(finished, { provenance: started?.provenance });
      if (records.length === 0) return null;
      attachRunCost(records, {
        energy: runEnergy(records, energyWindow),
        memory: memoryHeadroom(started?.memoryStart ?? null, readMemory(records[0].host.node_id)),
      });
      const res = store.upsertMany(records);
      for (const r of res.rejected) log(`[bench-results] rejected ${r.id}: ${r.errors.join("; ")}`);
      return res;
    },

    /** @param {"DecodeBench"|"PrefillBench"|"Showcase"|"FleetShowcase"|"QualityBench"} bench */
    sinkFor(bench) {
      return (finished) => this.record(bench, finished);
    },

    pendingCount() {
      return pending.size;
    },
  };
}

/** Same run-level cost on every record of the run (records are per cell). */
function attachRunCost(records, { energy, memory }) {
  const row = energyMetricRow(energy);
  for (const r of records) {
    if (energy) r.settings.run_energy = energy;
    if (memory) r.settings.run_memory = memory;
    if (row && !r.metrics.some((m) => m.definition === row.definition)) r.metrics.push(makeMetricRow(row));
  }
}
