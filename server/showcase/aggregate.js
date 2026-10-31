/**
 * Concurrent-window aggregate for Showcase runs (SHOW2, #40). Herd's own
 * implementation (MIT), written from the issue spec.
 *
 * One wave = the streams that ran together (a per-Spark showcase session, or
 * one lane of a fleet session; engine and fleet aggregates pool their lanes'
 * streams). Its aggregate is the same definition DecodeBench uses
 * (herd.decode.agg_window.v1, comparable with sparkDash's agg window and
 * AEON wave_peak_concurrent_window):
 *
 *   aggregate tok/s = Σ decode tokens / (max t_last − min t_first)
 *
 * where decode tokens = completion tokens − 1 per stream (the first token is
 * TTFT, not decode). Streams that never produced a token, errored, were
 * cancelled or are still pending do not count.
 *
 * Peak: the highest value of that same aggregate seen while the wave ran,
 * sampled at most every PEAK_SAMPLE_MS once the window spans at least
 * PEAK_MIN_WINDOW_MS (shorter windows are noise). The final value always
 * counts, so peak ≥ final. Live samples use the live (character-estimated)
 * token counts, so a peak taken from them is flagged `peakEstimated` even
 * when the final counts came from usage.
 *
 * `estimated`: true when any counted stream's tokens came from the ~4
 * chars/token estimate instead of usage.completion_tokens.
 */

export const PEAK_MIN_WINDOW_MS = 1000;
export const PEAK_SAMPLE_MS = 100;
export const CHARS_PER_TOKEN = 4;

const COUNTED = new Set(["streaming", "completed"]);
const num = (v) => typeof v === "number" && Number.isFinite(v);
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @typedef {{ tFirst?: number | null, tLast?: number | null, tokens?: number, estimated?: boolean, status?: string }} WindowStream
 * @typedef {{ tps: number | null, decodeTokens: number, totalTokens: number, windowMs: number, streams: number, estimated: boolean, tFirst: number | null, tLast: number | null }} WindowAggregate
 */

/**
 * @param {Iterable<WindowStream>} streams
 * @returns {WindowAggregate}
 */
export function concurrentWindow(streams) {
  let decodeTokens = 0;
  let totalTokens = 0;
  let minFirst = Infinity;
  let maxLast = -Infinity;
  let n = 0;
  let estimated = false;
  for (const s of streams || []) {
    if (!s || (s.status != null && !COUNTED.has(s.status))) continue;
    const tokens = Number(s.tokens) || 0;
    if (!num(s.tFirst) || !num(s.tLast) || tokens <= 0) continue;
    n += 1;
    totalTokens += tokens;
    decodeTokens += Math.max(0, tokens - 1);
    if (s.tFirst < minFirst) minFirst = s.tFirst;
    if (s.tLast > maxLast) maxLast = s.tLast;
    if (s.estimated) estimated = true;
  }
  const windowMs = n ? Math.max(0, maxLast - minFirst) : 0;
  return {
    tps: windowMs > 0 && decodeTokens > 0 ? round2((decodeTokens / windowMs) * 1000) : null,
    decodeTokens,
    totalTokens,
    windowMs: round2(windowMs),
    streams: n,
    estimated,
    tFirst: n ? minFirst : null,
    tLast: n ? maxLast : null,
  };
}

/** Tracks the peak aggregate of one wave. */
export class AggregatePeak {
  /** @param {{ minWindowMs?: number }} [opts] */
  constructor(opts = {}) {
    this.minWindowMs = opts.minWindowMs ?? PEAK_MIN_WINDOW_MS;
    /** @type {number | null} */
    this.peak = null;
    /** The peak value was computed from estimated token counts. */
    this.estimated = false;
  }

  _take(/** @type {WindowAggregate} */ agg) {
    if (this.peak == null || /** @type {number} */ (agg.tps) > this.peak) {
      this.peak = agg.tps;
      this.estimated = Boolean(agg.estimated);
    }
    return this.peak;
  }

  /** A sample taken while the wave runs; ignored until the window is long enough. */
  observe(/** @type {WindowAggregate} */ agg) {
    if (agg?.tps == null || agg.windowMs < this.minWindowMs) return this.peak;
    return this._take(agg);
  }

  /** The wave's final aggregate always counts (short waves have no other sample). */
  final(/** @type {WindowAggregate} */ agg) {
    if (agg?.tps == null) return this.peak;
    return this._take(agg);
  }
}

/**
 * Public shape for UI / history:
 * `{ tps, peakTps, peakEstimated, estimated, decodeTokens, windowMs, streams }`.
 * @param {WindowAggregate} agg
 * @param {AggregatePeak | null | undefined} peak
 */
export function aggregateView(agg, peak) {
  return {
    tps: agg.tps,
    peakTps: peak?.peak ?? null,
    peakEstimated: peak?.peak != null ? peak.estimated : false,
    estimated: agg.estimated,
    decodeTokens: agg.decodeTokens,
    windowMs: agg.windowMs,
    streams: agg.streams,
  };
}

/**
 * Throttle helper: true when a new sample is due.
 * @param {{ _aggSampledAt?: number }} holder
 * @param {number} now
 */
export function sampleDue(holder, now, everyMs = PEAK_SAMPLE_MS) {
  if (holder._aggSampledAt != null && now - holder._aggSampledAt < everyMs) return false;
  holder._aggSampledAt = now;
  return true;
}
