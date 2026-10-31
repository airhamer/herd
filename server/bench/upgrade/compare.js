/**
 * "Upgrade worth it?" comparison of a baseline run and a candidate run
 * (BENCH6, #46), built on the BENCH1 results store.
 *
 * A side is one or more run ids, at most one per bench (e.g. a decode run
 * plus a quality run). Runs are paired by bench; cells (records) inside a
 * pair are paired by the id suffix after the run id (`c4`,
 * `perf.direct.overall.c8`, a quality category, ...). Every paired cell must
 * pass the store's like-for-like rules (hw_bucket, suite + version, every
 * condition) and keep the headline metric's definition group; any mismatch
 * refuses the whole view, with reasons.
 */

import { compareResults, incomparabilityReasons } from "../results/schema.js";
import { definitionsComparable } from "../results/definitions.js";
import { nearestReferences } from "../references/nearest.js";
import { DEFAULT_NOISE_PCT, decideVerdict, noiseBand, qualityCategoryStatus, throughputCellStatus } from "./verdict.js";
import { RUN_ENERGY_DEFINITION, runEnergy } from "./runCost.js";

/** Throughput metric used for a cell's verdict, first one present wins. */
export const HEADLINE_METRICS = Object.freeze(["agg_window_tps", "decode_tps_stream", "agg_sum_tps", "prefill_tps"]);

/** Origins that are runs on hardware Herd can see (references are figures, not runs). */
const RUN_ORIGINS = new Set(["herd", "aeon-pod"]);

const LANE_KEYS = ["model_id", "engine", "engine_version", "image_digest", "weights_hash", "quant", "recipe_flags", "spec_decode", "kv_dtype", "ctx_len"];

/** Benches whose cells are quality categories (McNemar), not throughput. */
// AEON Bench Pod text and agentic runs (BENCH7) carry per-case vectors like QualityBench.
const QUALITY_BENCHES = new Set(["QualityBench", "AEONPodSuite", "AEONPodAgentic"]);

/**
 * Bench a run pairs under. AEON Bench Pod perf runs are the same aeon-perf-v1
 * ladder as DecodeBench's AEON protocol, so they pair with DecodeBench runs
 * (a herd.decode run on the other side is refused on its suite).
 */
const pairBench = (rec) => (rec.run.bench === "AEONPodPerf" ? "DecodeBench" : rec.run.bench);

/** Bench order for picking a side's energy figure. */
const ENERGY_BENCH_ORDER = ["DecodeBench", "Showcase", "PrefillBench", "QualityBench"];

function httpError(status, message) {
  const err = new Error(message);
  /** @type {any} */ (err).status = status;
  return err;
}

/** Split "a,b" / ["a","b"] into unique run ids. */
export function parseRunIds(v) {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
}

function cellOf(rec) {
  const prefix = `${rec.run.run_id}:`;
  return rec.id.startsWith(prefix) ? rec.id.slice(prefix.length) : rec.id;
}

/** AEON per-category cells are detail; the level's overall cell carries the verdict. */
function isHeadlineCell(cell) {
  return !/^perf\.direct\.(?!overall\.)/.test(cell);
}

function sameLane(a, b) {
  return LANE_KEYS.every((k) => a.lane[k] === b.lane[k]) && JSON.stringify(a.lane.parallel) === JSON.stringify(b.lane.parallel);
}

function laneSummary(rec) {
  return {
    model_id: rec.lane.model_id,
    engine: rec.lane.engine,
    engine_version: rec.lane.engine_version,
    quant: rec.lane.quant,
    recipe_flags: rec.lane.recipe_flags,
    spec_decode: rec.lane.spec_decode,
  };
}

function headlineMetric(rec) {
  for (const name of HEADLINE_METRICS) {
    const m = rec.metrics.find((x) => x.valid && x.metric === name);
    if (m) return m;
  }
  return null;
}

/**
 * Collect a side's runs, grouped by bench.
 * @param {any[]} all   every store record
 * @param {string[]} runIds
 * @param {"baseline"|"candidate"} side
 */
function collectSide(all, runIds, side) {
  if (runIds.length === 0) throw httpError(400, `${side}: at least one run id is required`);
  /** @type {Map<string, { runId: string, records: any[] }>} */
  const byBench = new Map();
  for (const runId of runIds) {
    const records = all.filter((r) => r.run.run_id === runId);
    if (records.length === 0) throw httpError(404, `${side}: unknown run ${runId}`);
    if (!RUN_ORIGINS.has(records[0].run.origin)) {
      throw httpError(400, `${side}: ${runId} is a published reference, not a run (it is shown beside the verdict instead)`);
    }
    const bench = pairBench(records[0]);
    if (byBench.has(bench)) throw httpError(400, `${side}: two ${bench} runs (${byBench.get(bench).runId}, ${runId}); pick one per bench`);
    records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    byBench.set(bench, { runId, records });
  }
  return byBench;
}

/**
 * One value per run of `metric` (comparable definition) among like-for-like
 * records on the same lane. The other side's run is never a repeat: lanes
 * often carry no engine version or digest, and counting the candidate as a
 * repeat of the baseline would widen the band by the very change measured.
 */
function repeatValues(all, rec, metric, otherRunId) {
  const perRun = new Map();
  for (const r of all) {
    if (!RUN_ORIGINS.has(r.run.origin) || pairBench(r) !== pairBench(rec) || r.run.run_id === otherRunId) continue;
    if (incomparabilityReasons(rec, r).length || !sameLane(rec, r)) continue;
    if (cellOf(r) !== cellOf(rec)) continue;
    const m = r.metrics.find((x) => x.valid && x.metric === metric.metric && definitionsComparable(x.definition, metric.definition));
    if (m && !perRun.has(r.run.run_id)) perRun.set(r.run.run_id, m.value);
  }
  return [...perRun.values()];
}

function sideEnergy(byBench, energyWindow) {
  for (const bench of ENERGY_BENCH_ORDER) {
    const entry = byBench.get(bench);
    if (!entry) continue;
    const stored = entry.records.find((r) => r.settings?.run_energy)?.settings.run_energy ?? null;
    const energy = stored ?? runEnergy(entry.records, energyWindow);
    if (energy) return { ...energy, run_id: entry.runId, from: stored ? "recorded" : "tracker_now" };
  }
  return null;
}

function sideMemory(byBench) {
  for (const { runId, records } of byBench.values()) {
    const mem = records.find((r) => r.settings?.run_memory)?.settings.run_memory;
    if (mem) return { ...mem, run_id: runId };
  }
  return null;
}

function pctDelta(base, cand, digits = 2) {
  if (typeof base !== "number" || typeof cand !== "number" || base === 0) return null;
  const f = 10 ** digits;
  return Math.round(((cand - base) / Math.abs(base)) * 100 * f) / f;
}

/**
 * @param {{ byId: Map<string, any> }} store
 * @param {{ baseline: string | string[], candidate: string | string[] }} query
 * @param {{ energyWindow?: ((nodeId: string, startMs: number, endMs: number) => any) | null }} [deps]
 */
export function upgradeCompare(store, query, deps = {}) {
  const all = [...store.byId.values()];
  const baseIds = parseRunIds(query.baseline);
  const candIds = parseRunIds(query.candidate);
  const shared = baseIds.filter((id) => candIds.includes(id));
  if (shared.length) throw httpError(400, `the same run cannot be baseline and candidate (${shared.join(", ")})`);
  const base = collectSide(all, baseIds, "baseline");
  const cand = collectSide(all, candIds, "candidate");

  const refused = [];
  const throughput = [];
  const quality = [];
  const unpaired = { baseline: [], candidate: [] };

  for (const bench of new Set([...base.keys(), ...cand.keys()])) {
    const b = base.get(bench);
    const c = cand.get(bench);
    if (!b || !c) {
      refused.push(`${bench} run only on the ${b ? "baseline" : "candidate"} side; pick one on both sides or drop it`);
      continue;
    }
    // Run-level definition first (hw bucket, suite, suite version): one reason, not one per cell.
    const head = incomparabilityReasons(
      { ...b.records[0], conditions: {} },
      { ...c.records[0], conditions: {} }
    );
    if (head.length) {
      refused.push(...head.map((r) => `${bench}: ${r}`));
      continue;
    }
    const candByCell = new Map(c.records.map((r) => [cellOf(r), r]));
    const seen = new Set();
    for (const br of b.records) {
      const cell = cellOf(br);
      const cr = candByCell.get(cell);
      if (!cr) {
        unpaired.baseline.push(`${bench}:${cell}`);
        continue;
      }
      seen.add(cell);
      const cmp = compareResults(br, cr);
      if (!cmp.comparable) {
        refused.push(...cmp.reasons.map((r) => `${bench} ${cell}: ${r}`));
        continue;
      }
      if (QUALITY_BENCHES.has(bench)) {
        const row = cmp.rows.find((x) => x.metric === "accuracy_pct") ?? null;
        for (const x of cmp.refused) refused.push(`${bench} ${cell}: ${x.metric} ${x.reason} (${x.baseline_definition} vs ${x.candidate_definitions.join(", ")})`);
        const status = qualityCategoryStatus(cmp.quality);
        quality.push({
          cell,
          category: br.settings?.category ?? cell,
          baseline_pct: row?.baseline ?? null,
          candidate_pct: row?.candidate ?? null,
          delta_pp: row ? row.delta : null,
          mcnemar: cmp.quality,
          status,
        });
        continue;
      }
      const bm = headlineMetric(br);
      if (!bm) continue;
      const cm = cr.metrics.find((x) => x.valid && x.metric === bm.metric);
      if (!cm) {
        unpaired.candidate.push(`${bench}:${cell} (no ${bm.metric})`);
        continue;
      }
      if (!definitionsComparable(bm.definition, cm.definition)) {
        refused.push(`${bench} ${cell}: ${bm.metric} definitions are not comparable (${bm.definition} vs ${cm.definition})`);
        continue;
      }
      const band = noiseBand(repeatValues(all, br, bm, c.runId), repeatValues(all, cr, cm, b.runId));
      const deltaPct = pctDelta(bm.value, cm.value);
      throughput.push({
        cell,
        bench,
        concurrency: br.conditions.concurrency,
        metric: bm.metric,
        unit: bm.unit,
        definition: bm.definition,
        baseline: bm.value,
        candidate: cm.value,
        delta_pct: deltaPct,
        noise_pct: band.pct,
        noise_source: band.source,
        measured_noise_pct: band.measured_pct,
        headline: isHeadlineCell(cell),
        status: throughputCellStatus(deltaPct, band.pct),
        baseline_id: br.id,
        candidate_id: cr.id,
      });
    }
    for (const cr of c.records) if (!seen.has(cellOf(cr))) unpaired.candidate.push(`${bench}:${cellOf(cr)}`);
  }

  const comparable = refused.length === 0;
  const verdict = decideVerdict({ refused, throughput, quality });

  const be = sideEnergy(base, deps.energyWindow ?? null);
  const ce = sideEnergy(cand, deps.energyWindow ?? null);
  const bm = sideMemory(base);
  const cm = sideMemory(cand);
  const cost = {
    energy: {
      definition: RUN_ENERGY_DEFINITION,
      baseline: be,
      candidate: ce,
      delta_pct: pctDelta(be?.wh_per_1k_tokens, ce?.wh_per_1k_tokens),
    },
    memory: {
      baseline: bm,
      candidate: cm,
      delta_mb: typeof bm?.headroom_mb === "number" && typeof cm?.headroom_mb === "number" ? cm.headroom_mb - bm.headroom_mb : null,
    },
  };

  const first = (side) => [...side.values()][0].records[0];
  return {
    comparable,
    baseline: describeSide(base, first(base)),
    candidate: describeSide(cand, first(cand)),
    verdict,
    throughput: comparable ? throughput : [],
    quality: comparable ? quality : [],
    unpaired,
    cost,
    reference: comparable ? nearestReference(all, throughput) : null,
    rules: {
      default_noise_pct: DEFAULT_NOISE_PCT,
      quality_alpha: 0.05,
      worth_it: "throughput gain outside the noise band and no quality category regressing at McNemar p < 0.05",
    },
  };
}

function describeSide(byBench, rec) {
  return {
    run_ids: [...byBench.values()].map((x) => x.runId),
    benches: [...byBench.keys()],
    node_id: rec.host.node_id,
    node_name: rec.host.node_name,
    hw_bucket: rec.host.hw_bucket,
    suite: rec.run.suite,
    suite_version: rec.run.suite_version,
    started_at: rec.run.started_at,
    lane: laneSummary(rec),
  };
}

/**
 * Nearest published figure (BENCH5) for the candidate's voting cells. Any
 * throughput metric of those cells may match (published figures rarely use
 * Herd's headline definition): best score wins, then the cell's own headline
 * metric, then HEADLINE_METRICS order, then cell id.
 */
function nearestReference(all, throughput) {
  let best = null;
  const rank = (c) => [-c.reference.score, c.metric === c.headline ? 0 : 1, HEADLINE_METRICS.indexOf(c.metric), c.cell];
  const before = (a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] < rb[i];
    return false;
  };
  for (const row of throughput) {
    if (!row.headline) continue;
    const rec = all.find((r) => r.id === row.candidate_id);
    if (!rec) continue;
    const near = nearestReferences(rec, all, { limit: 1 });
    for (const m of near.metrics) {
      if (!HEADLINE_METRICS.includes(m.metric)) continue;
      const ref = m.references?.[0];
      if (!ref) continue;
      const c = { cell: row.cell, metric: m.metric, headline: row.metric, unit: m.unit ?? ref.unit, candidate: m.value, reference: ref };
      if (!best || before(c, best)) best = c;
    }
  }
  if (!best) return null;
  const { headline, ...out } = best;
  return out;
}
