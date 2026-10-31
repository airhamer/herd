/**
 * Exact McNemar test between two runs' per-item pass/fail vectors (#42).
 *
 * Only items scored (pass true/false) in both runs are paired. With
 * b = passed in A only and c = passed in B only, the two-sided exact p is
 * min(1, 2 × P(X ≤ min(b, c))) for X ~ Binomial(b + c, ½). No discordant
 * pairs gives p = 1. p ≥ 0.05 reads as "within noise".
 */

export const NOISE_P = 0.05;

/** ln(k!) for k = 0..n, cached and grown on demand. */
const LOG_FACT = [0];
function logFact(n) {
  for (let k = LOG_FACT.length; k <= n; k++) LOG_FACT[k] = LOG_FACT[k - 1] + Math.log(k);
  return LOG_FACT[n];
}

/**
 * Two-sided exact McNemar p-value.
 * @param {number} b  discordant pairs passing only in the baseline
 * @param {number} c  discordant pairs passing only in the candidate
 */
export function mcnemarExactP(b, c) {
  if (!Number.isInteger(b) || !Number.isInteger(c) || b < 0 || c < 0) {
    throw new TypeError("b and c must be non-negative integers");
  }
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  const lnHalfN = n * Math.log(0.5);
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    tail += Math.exp(logFact(n) - logFact(i) - logFact(n - i) + lnHalfN);
  }
  return Math.min(1, 2 * tail);
}

/**
 * Pair two item vectors by id and run the test.
 * @param {Array<{ id: string, pass: boolean | null }>} baseline
 * @param {Array<{ id: string, pass: boolean | null }>} candidate
 */
export function mcnemarCompare(baseline, candidate) {
  const cand = new Map();
  for (const it of candidate || []) if (it && typeof it.pass === "boolean") cand.set(it.id, it.pass);
  let paired = 0;
  let bothPass = 0;
  let bothFail = 0;
  let b = 0;
  let c = 0;
  for (const it of baseline || []) {
    if (!it || typeof it.pass !== "boolean" || !cand.has(it.id)) continue;
    const other = cand.get(it.id);
    paired += 1;
    if (it.pass && other) bothPass += 1;
    else if (!it.pass && !other) bothFail += 1;
    else if (it.pass) b += 1;
    else c += 1;
  }
  const p = mcnemarExactP(b, c);
  return {
    paired,
    both_pass: bothPass,
    both_fail: bothFail,
    baseline_only: b,
    candidate_only: c,
    // 4 significant digits: tiny p stays visible instead of rounding to 0.
    p: Number(p.toPrecision(4)),
    within_noise: p >= NOISE_P,
  };
}
