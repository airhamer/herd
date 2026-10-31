/**
 * Runs the upgrade view can pick from: store records grouped by run id
 * (BENCH6, #46). Published references are not runs and are left out.
 */

const RUN_ORIGINS = new Set(["herd", "aeon-pod"]);
export const MAX_RUNS = 500;

/**
 * @param {{ byId: Map<string, any> }} store
 * @param {{ node_id?: string, hw_bucket?: string, bench?: string, limit?: number }} [filter]
 */
export function listUpgradeRuns(store, filter = {}) {
  /** @type {Map<string, any>} */
  const runs = new Map();
  for (const r of store.byId.values()) {
    if (!RUN_ORIGINS.has(r.run.origin)) continue;
    if (filter.node_id && r.host.node_id !== filter.node_id) continue;
    if (filter.hw_bucket && r.host.hw_bucket !== filter.hw_bucket) continue;
    if (filter.bench && r.run.bench !== filter.bench) continue;
    let run = runs.get(r.run.run_id);
    if (!run) {
      run = {
        run_id: r.run.run_id,
        bench: r.run.bench,
        origin: r.run.origin,
        suite: r.run.suite,
        suite_version: r.run.suite_version,
        status: r.run.status,
        started_at: r.run.started_at,
        completed_at: r.run.completed_at,
        node_id: r.host.node_id,
        node_name: r.host.node_name,
        hw_bucket: r.host.hw_bucket,
        model_id: r.lane.model_id,
        engine: r.lane.engine,
        engine_version: r.lane.engine_version,
        quant: r.lane.quant,
        cells: 0,
        concurrencies: [],
        has_energy: false,
        has_memory: false,
      };
      runs.set(r.run.run_id, run);
    }
    run.cells += 1;
    const c = r.conditions.concurrency;
    if (Number.isInteger(c) && !run.concurrencies.includes(c)) run.concurrencies.push(c);
    if (r.settings?.run_energy || r.metrics.some((m) => m.valid && m.metric === "wh_per_1k_tokens")) run.has_energy = true;
    if (r.settings?.run_memory) run.has_memory = true;
  }
  const limit = Number.isInteger(filter.limit) && filter.limit > 0 ? Math.min(filter.limit, MAX_RUNS) : 200;
  const list = [...runs.values()]
    .map((r) => ({ ...r, concurrencies: r.concurrencies.sort((a, b) => a - b) }))
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || (a.run_id < b.run_id ? -1 : 1));
  return { total: list.length, runs: list.slice(0, limit) };
}
