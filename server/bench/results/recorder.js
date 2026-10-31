/**
 * Glue between the bench managers and the results store: remembers the
 * provenance captured when a run starts and writes the finished run's
 * records when the manager reports it.
 */

import { fromDecodeJob, fromFleetShowcaseSession, fromPrefillJob, fromShowcaseSession } from "./adapters.js";

const ADAPTERS = {
  DecodeBench: { convert: fromDecodeJob, idOf: (o) => o?.benchId },
  PrefillBench: { convert: fromPrefillJob, idOf: (o) => o?.benchId },
  Showcase: { convert: fromShowcaseSession, idOf: (o) => o?.sessionId },
  // SHOW1: one record per lane; provenance is { lanes: { [laneId]: Provenance } }.
  FleetShowcase: { convert: fromFleetShowcaseSession, idOf: (o) => o?.sessionId },
};

const MAX_PENDING = 200;

/**
 * @param {{ store: import("./store.js").BenchResultsStore, log?: (msg: string) => void }} deps
 */
export function createResultsRecorder({ store, log = (m) => console.warn(m) }) {
  /** @type {Map<string, any>} */
  const pending = new Map();

  return {
    /**
     * @param {"DecodeBench"|"PrefillBench"|"Showcase"|"FleetShowcase"} bench
     * @param {string} id  benchId / sessionId
     * @param {any} provenance  describeProvenance(...) result
     */
    noteStart(bench, id, provenance) {
      if (!id) return;
      pending.set(`${bench}:${id}`, provenance);
      while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
    },

    /**
     * @param {"DecodeBench"|"PrefillBench"|"Showcase"|"FleetShowcase"} bench
     * @param {any} finished  public job / session record
     * @returns {{ added: number, updated: number, rejected: any[] } | null}
     */
    record(bench, finished) {
      const adapter = ADAPTERS[bench];
      if (!adapter) return null;
      const key = `${bench}:${adapter.idOf(finished)}`;
      const provenance = pending.get(key);
      pending.delete(key);
      const records = adapter.convert(finished, { provenance });
      if (records.length === 0) return null;
      const res = store.upsertMany(records);
      for (const r of res.rejected) log(`[bench-results] rejected ${r.id}: ${r.errors.join("; ")}`);
      return res;
    },

    /** @param {"DecodeBench"|"PrefillBench"|"Showcase"|"FleetShowcase"} bench */
    sinkFor(bench) {
      return (finished) => this.record(bench, finished);
    },

    pendingCount() {
      return pending.size;
    },
  };
}
