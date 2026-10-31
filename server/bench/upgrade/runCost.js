/**
 * Run cost for the "Upgrade worth it?" view (BENCH6, #46): energy drawn by
 * the benched node during the run window (from the fleet energy tracker) per
 * 1,000 output tokens, and the unified-memory headroom around the run.
 */

/** Definition of the run-window energy figure (see results/definitions.js). */
export const RUN_ENERGY_DEFINITION = "herd.energy.node_tracker_run.v1";

/** Below this share of the run window covered by power samples, no Wh/1k figure is stored. */
export const MIN_ENERGY_COVERAGE = 0.5;

const pos = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Output tokens a run produced: DecodeBench waves (raw.wave), AEON ladder
 * levels (overall cells: tokens per wall second × wall seconds). Prefill and
 * quality runs report no usable decode volume, so null.
 * @param {any[]} records  records of one run
 */
export function runOutputTokens(records) {
  let total = 0;
  let seen = false;
  for (const r of records) {
    let n = null;
    if (pos(r?.raw?.wave?.totalCompletionTokens)) n = r.raw.wave.totalCompletionTokens;
    else if (r?.settings?.scope === "overall" && pos(r.settings.tokens_per_wall_s) && pos(r.settings.cell_wall_s)) {
      n = Math.round(r.settings.tokens_per_wall_s * r.settings.cell_wall_s);
    }
    if (n !== null) {
      total += n;
      seen = true;
    }
  }
  return seen ? total : null;
}

/** Run window [start, end] in epoch ms from a run's records, or null. */
export function runWindow(records) {
  const run = records[0]?.run;
  const start = Date.parse(run?.started_at ?? "");
  const end = Date.parse(run?.completed_at ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { startMs: start, endMs: end };
}

/**
 * Energy of a run from a tracker read over its window.
 * @param {any[]} records  records of one run (same node)
 * @param {((nodeId: string, startMs: number, endMs: number) => any) | null} energyWindow
 * @returns {{ wh: number, window_s: number, coverage: number, output_tokens: number|null, wh_per_1k_tokens: number|null, source: string } | null}
 */
export function runEnergy(records, energyWindow) {
  if (typeof energyWindow !== "function" || records.length === 0) return null;
  const nodeId = records[0]?.host?.node_id;
  const win = runWindow(records);
  if (!nodeId || !win) return null;
  let read = null;
  try {
    read = energyWindow(nodeId, win.startMs, win.endMs);
  } catch {
    read = null;
  }
  if (!read || !(read.wh >= 0) || !(read.coverage > 0)) return null;
  const tokens = runOutputTokens(records);
  const whPer1k =
    tokens && read.coverage >= MIN_ENERGY_COVERAGE && read.wh > 0
      ? round(read.wh / read.coverage / (tokens / 1000), 4)
      : null;
  return {
    wh: round(read.wh, 4),
    window_s: Math.round(win.endMs - win.startMs) / 1000,
    coverage: round(read.coverage, 3),
    output_tokens: tokens,
    wh_per_1k_tokens: whPer1k,
    source: "fleet-energy-tracker",
  };
}

/** Metric row for a run energy figure (null when there is no Wh/1k value). */
export function energyMetricRow(energy) {
  if (!energy || !pos(energy.wh_per_1k_tokens)) return null;
  return {
    metric: "wh_per_1k_tokens",
    definition: RUN_ENERGY_DEFINITION,
    source: "native",
    value: energy.wh_per_1k_tokens,
    n: null,
    window_s: energy.window_s,
    approximate: true,
  };
}

/**
 * Memory headroom around a run: the lower of the available memory read at
 * start and at end (MB). Two readings, not a minimum over the run.
 * @param {{ available_mb: number, total_mb: number } | null} start
 * @param {{ available_mb: number, total_mb: number } | null} end
 */
export function memoryHeadroom(start, end) {
  const s = pos(start?.available_mb) ? start.available_mb : null;
  const e = pos(end?.available_mb) ? end.available_mb : null;
  if (s === null && e === null) return null;
  const total = pos(start?.total_mb) ? start.total_mb : pos(end?.total_mb) ? end.total_mb : null;
  return {
    total_mb: total,
    available_start_mb: s,
    available_end_mb: e,
    headroom_mb: Math.min(...[s, e].filter((v) => v !== null)),
  };
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
