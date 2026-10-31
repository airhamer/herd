/**
 * Nearest published reference figures for a stored result (BENCH5, #45).
 *
 * A reference is shown next to a result, never diffed as if Herd had
 * measured it: only figures whose definition sits in the same comparable
 * group as the result's metric are offered, ranked by how close their
 * setup is, each with the list of what still differs.
 */

import { definitionsComparable } from "../results/definitions.js";
import { incomparabilityReasons } from "../results/schema.js";

/** Closeness weights; ties break on id so the order is stable. */
const WEIGHTS = Object.freeze({
  hw_bucket: 4,
  concurrency: 4,
  model_id: 3,
  context_tokens: 1,
  temperature: 1,
  thinking: 1,
  prompt_set: 1,
  client_location: 1,
});

const LANE_DIFF_FIELDS = ["model_id", "quant", "engine", "spec_decode"];

function same(a, b) {
  return a !== null && a !== undefined && a === b;
}

function score(rec, ref) {
  let s = 0;
  if (same(rec.host.hw_bucket, ref.host.hw_bucket)) s += WEIGHTS.hw_bucket;
  if (same(rec.lane.model_id, ref.lane.model_id)) s += WEIGHTS.model_id;
  for (const f of ["concurrency", "context_tokens", "temperature", "thinking", "prompt_set", "client_location"]) {
    if (same(rec.conditions[f], ref.conditions[f])) s += WEIGHTS[f];
  }
  return s;
}

/**
 * @param {any} record     the result to place references beside
 * @param {any[]} candidates store records; only origin "reference" ones are used
 * @param {{ limit?: number }} [opts]
 */
export function nearestReferences(record, candidates, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 3;
  const refs = candidates.filter((c) => c && c.run?.origin === "reference" && c.id !== record.id);
  const metrics = [];
  for (const m of record.metrics) {
    if (!m.valid) continue;
    const matches = [];
    for (const ref of refs) {
      for (const rm of ref.metrics) {
        if (!rm.valid || rm.metric !== m.metric || !definitionsComparable(m.definition, rm.definition)) continue;
        const differences = incomparabilityReasons(record, ref);
        for (const f of LANE_DIFF_FIELDS) {
          if (record.lane[f] !== ref.lane[f]) {
            differences.push(`lane.${f} differs (${record.lane[f] ?? "unknown"} vs ${ref.lane[f] ?? "unknown"})`);
          }
        }
        matches.push({
          id: ref.id,
          origin: ref.run.origin,
          url: ref.run.reference_url,
          title: ref.settings?.reference?.title ?? null,
          source: ref.settings?.reference?.source ?? null,
          value: rm.value,
          unit: rm.unit,
          n: rm.n,
          definition: rm.definition,
          score: score(record, ref),
          differences,
        });
      }
    }
    matches.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    metrics.push({
      metric: m.metric,
      definition: m.definition,
      value: m.value,
      unit: m.unit,
      references: matches.slice(0, limit),
    });
  }
  return { id: record.id, origin: record.run.origin, metrics };
}
