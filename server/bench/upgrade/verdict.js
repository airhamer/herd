/**
 * "Upgrade worth it?" verdict rules (BENCH6, #46). Pure functions so the
 * three acceptance cases (gain inside noise, significant regression, clean
 * win) are tested without a store.
 *
 * Worth it only when the throughput gain is outside the noise band and no
 * quality category regresses significantly (McNemar p < 0.05).
 */

import { NOISE_P } from "../results/mcnemar.js";

/**
 * Noise band used when there are no repeated runs to measure one: about 15%
 * single-stream run-to-run spread on one DGX Spark (MiaAI-Lab note cited in #46).
 */
export const DEFAULT_NOISE_PCT = 15;

/** Floor under a measured band: two near-identical repeats are not proof of a 0% band. */
export const MIN_NOISE_PCT = 3;

/** Spread of repeated values as (max − min) / mean, in %. Null with fewer than two values. */
export function spreadPct(values) {
  const v = (values || []).filter((x) => typeof x === "number" && Number.isFinite(x));
  if (v.length < 2) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  if (!(mean > 0)) return null;
  return round(((Math.max(...v) - Math.min(...v)) / mean) * 100, 2);
}

/**
 * Noise band for one cell from the repeated runs on each side.
 * @param {number[]} baselineRepeats  one value per run (baseline lane, same cell)
 * @param {number[]} candidateRepeats one value per run (candidate lane, same cell)
 * @returns {{ pct: number, source: "repeats" | "default", measured_pct: number | null }}
 */
export function noiseBand(baselineRepeats, candidateRepeats) {
  const spreads = [spreadPct(baselineRepeats), spreadPct(candidateRepeats)].filter((s) => s !== null);
  if (spreads.length === 0) return { pct: DEFAULT_NOISE_PCT, source: "default", measured_pct: null };
  const measured = Math.max(...spreads);
  return { pct: Math.max(measured, MIN_NOISE_PCT), source: "repeats", measured_pct: measured };
}

/**
 * Cell status for a higher-is-better throughput Δ%.
 * @param {number | null} deltaPct
 * @param {number} noisePct
 * @returns {"gain" | "loss" | "noise" | "unknown"}
 */
export function throughputCellStatus(deltaPct, noisePct) {
  if (typeof deltaPct !== "number" || !Number.isFinite(deltaPct)) return "unknown";
  if (deltaPct > noisePct) return "gain";
  if (deltaPct < -noisePct) return "loss";
  return "noise";
}

/**
 * @param {{ status: string, headline?: boolean }[]} cells
 * @returns {"gain" | "loss" | "mixed" | "noise" | "none"}
 */
export function throughputStatus(cells) {
  const used = cells.filter((c) => c.headline !== false && c.status !== "unknown");
  if (used.length === 0) return "none";
  const gains = used.filter((c) => c.status === "gain").length;
  const losses = used.filter((c) => c.status === "loss").length;
  if (gains && losses) return "mixed";
  if (gains) return "gain";
  if (losses) return "loss";
  return "noise";
}

/**
 * Quality category status from a McNemar result (results/mcnemar.js).
 * @param {{ p: number|null, baseline_only: number, candidate_only: number } | null} mcnemar
 * @returns {"better" | "worse" | "noise" | "unpaired"}
 */
export function qualityCategoryStatus(mcnemar) {
  if (!mcnemar || typeof mcnemar.p !== "number") return "unpaired";
  if (mcnemar.p >= NOISE_P) return "noise";
  return mcnemar.candidate_only > mcnemar.baseline_only ? "better" : "worse";
}

/**
 * @param {{ status: string }[]} categories
 * @returns {"regression" | "ok" | "not_measured"}
 */
export function qualityStatus(categories) {
  const scored = categories.filter((c) => c.status !== "unpaired");
  if (scored.length === 0) return "not_measured";
  return scored.some((c) => c.status === "worse") ? "regression" : "ok";
}

/**
 * @param {object} args
 * @param {string[]} args.refused   reasons the comparison is refused (empty when like-for-like)
 * @param {{ cell: string, status: string, delta_pct: number|null, noise_pct: number, headline?: boolean }[]} args.throughput
 * @param {{ cell: string, status: string, mcnemar?: any }[]} args.quality
 * @returns {{ code: "worth_it" | "within_noise" | "regression" | "refused", worth_it: boolean, throughput: string, quality: string, reasons: string[] }}
 */
export function decideVerdict({ refused = [], throughput = [], quality = [] }) {
  const tStatus = throughputStatus(throughput);
  const qStatus = qualityStatus(quality);
  const out = (code, reasons) => ({ code, worth_it: code === "worth_it", throughput: tStatus, quality: qStatus, reasons });

  if (refused.length) return out("refused", [...refused]);
  if (tStatus === "none" && qStatus === "not_measured") {
    return out("refused", ["no like-for-like throughput cell or quality category to compare"]);
  }

  const reasons = [];
  const headline = throughput.filter((c) => c.headline !== false);
  const worse = quality.filter((c) => c.status === "worse");
  for (const c of worse) {
    reasons.push(`quality ${c.cell} regresses significantly (McNemar p = ${fmtP(c.mcnemar?.p)})`);
  }
  for (const c of headline.filter((x) => x.status === "loss")) {
    reasons.push(`throughput ${c.cell} ${fmtPct(c.delta_pct)} is outside the ±${c.noise_pct}% noise band`);
  }
  if (reasons.length) return out("regression", reasons);

  if (tStatus === "gain") {
    for (const c of headline.filter((x) => x.status === "gain")) {
      reasons.push(`throughput ${c.cell} ${fmtPct(c.delta_pct)} is outside the ±${c.noise_pct}% noise band`);
    }
    reasons.push(
      qStatus === "not_measured"
        ? "quality not measured on both sides: run the quality bench to rule out a regression"
        : "no quality category regresses significantly"
    );
    return out("worth_it", reasons);
  }

  if (tStatus === "none") reasons.push("no throughput cell compared");
  else reasons.push("every throughput change is inside its noise band");
  if (qStatus === "ok") reasons.push("no quality category regresses significantly");
  return out("within_noise", reasons);
}

function fmtPct(v) {
  return typeof v === "number" ? `${v > 0 ? "+" : ""}${v}%` : "n/a";
}

function fmtP(p) {
  return typeof p === "number" ? (p < 0.001 ? "<0.001" : p.toFixed(3)) : "n/a";
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
