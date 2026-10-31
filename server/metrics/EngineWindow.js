/**
 * Windowed, normalized engine metrics (STAT2, #35).
 *
 * One EngineWindow keeps the last `spanS` seconds of one engine's reads and
 * turns them into one normalized record that reads the same for every engine:
 *
 *   decode_tps, prefill_tps, ttft_s, queue_s, running, waiting, kv_pct,
 *   cache_reuse, acc_len, idle_share, throughput_tps
 *
 * Each value carries { value, valid, source, windowS, approximate, samples }.
 * A value the window cannot measure is null with valid: false, never 0.
 *
 * Counter values are the difference of the window's oldest and newest read,
 * so idle time never dilutes a speed and a request is counted once. The
 * window design (keep one read at or before the window start, start again
 * when the engine changes or a counter goes backwards) and the decode,
 * prefill, queue, TTFT, accept-length, idle-share and throughput formulas
 * follow hasso5703's dashboard (`Window` and `stats` in engine_metrics.py),
 * adapted from the Python. Herd sends no canary of its own, so the canary
 * bookkeeping is not carried over.
 *
 *   Source: github.com/hasso5703/dgx-spark-qwen38, dashboard/engine_metrics.py
 *
 *
 *   MIT License
 *
 *   Copyright (c) 2026 hasso5703
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 *
 * The fallbacks for engines without those counters (busy-time-weighted mean
 * of the per-poll rates, instantaneous levels with a window peak) are herd's.
 */

/** Spans every probe keeps, in seconds. 300 s is Hasso's Window(300). */
export const ENGINE_WINDOW_SPANS_S = Object.freeze([60, 300]);

/**
 * Cumulative counters a window differences. Any may be null (engine does not
 * publish it); a formula that needs a null counter yields null.
 *   generated        output tokens
 *   prompt / cached  prompt tokens, and those served from cache
 *   decoded / first  tokens the inter-token sum timed, and first tokens it did
 *                    not (vLLM: generation_tokens_total and the TTFT count,
 *                    its ITL count being steps; SGLang: ITL count, first = 0)
 *   itlSum           inter-token latency seconds
 *   prefillComputed / prefillSeconds   computed prompt tokens and prefill stopwatch
 *   queueSum / queueCount              queue time histogram
 *   ttftSum / ttftCount                time to first token histogram
 *   specAccepted / specDrafts          vLLM speculative decoding
 *   specVerify                         SGLang speculative verify calls
 *   idleSeconds                        SGLang scheduler idle seconds
 */
export const ENGINE_COUNTER_NAMES = Object.freeze([
  "generated",
  "prompt",
  "cached",
  "decoded",
  "first",
  "itlSum",
  "prefillComputed",
  "prefillSeconds",
  "queueSum",
  "queueCount",
  "ttftSum",
  "ttftCount",
  "specAccepted",
  "specDrafts",
  "specVerify",
  "idleSeconds",
]);

export const NORMALIZED_FIELDS = Object.freeze([
  "decode_tps",
  "prefill_tps",
  "ttft_s",
  "queue_s",
  "running",
  "waiting",
  "kv_pct",
  "cache_reuse",
  "acc_len",
  "idle_share",
  "throughput_tps",
]);

/**
 * @typedef {"counter"|"native"|"proxy"|"client"} SourceTier
 * @typedef {{
 *   value: number|null, valid: boolean, source: SourceTier|null,
 *   windowS: number|null, approximate: boolean, samples: number, peak?: number|null
 * }} NormalizedValue
 * @typedef {{
 *   t: number,
 *   key: string,
 *   counters?: Record<string, number|null|undefined> | null,
 *   counterSource?: SourceTier | null,
 *   rates?: { decodeTps?: number|null, prefillTps?: number|null, ttftS?: number|null },
 *   rateSources?: { decodeTps?: SourceTier|null, prefillTps?: SourceTier|null, ttftS?: SourceTier|null },
 *   levels?: { running?: number|null, waiting?: number|null, kvPct?: number|null },
 *   levelSources?: { running?: SourceTier|null, waiting?: SourceTier|null, kvPct?: SourceTier|null },
 * }} EngineSample
 * @typedef {{
 *   spanS: number, coveredS: number, reads: number, startedAt: number|null,
 *   resets: number, values: Record<string, NormalizedValue>
 * }} NormalizedRecord
 */

/** @param {unknown} v */
function fin(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** @param {number|null} v @param {number} [digits] */
function round(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * @param {number|null} value
 * @param {SourceTier|null|undefined} source
 * @param {number|null} windowS
 * @param {boolean} approximate
 * @param {number} samples
 * @returns {NormalizedValue}
 */
function val(value, source, windowS, approximate, samples) {
  const v = fin(value);
  return {
    value: v,
    valid: v != null,
    source: source ?? null,
    windowS,
    approximate: v != null && approximate,
    samples: v != null ? samples : 0,
  };
}

/** @returns {NormalizedValue} */
function unmeasured() {
  return { value: null, valid: false, source: null, windowS: null, approximate: false, samples: 0 };
}

/** Empty record: every value unmeasured. @param {number} spanS @returns {NormalizedRecord} */
export function emptyNormalizedRecord(spanS) {
  /** @type {Record<string, NormalizedValue>} */
  const values = {};
  for (const f of NORMALIZED_FIELDS) values[f] = unmeasured();
  return { spanS, coveredS: 0, reads: 0, startedAt: null, resets: 0, values };
}

/** Sliding window over one engine's reads. */
export class EngineWindow {
  /** @param {number} [spanS] */
  constructor(spanS = 300) {
    if (!(spanS > 0)) throw new RangeError("EngineWindow: spanS must be > 0");
    this.spanS = spanS;
    /** @type {string|null} */
    this.key = null;
    /** @type {EngineSample[]} */
    this.samples = [];
    /** Last non-null value of each counter, for reset detection across gaps. */
    /** @type {Record<string, number>} */
    this._lastKnown = {};
    /** @type {number|null} */
    this.startedAt = null;
    /** Times the window started again (engine change or counter reset), after the first. */
    this.resets = 0;
  }

  /** Forget every read. */
  clear() {
    this.key = null;
    this.samples = [];
    this._lastKnown = {};
    this.startedAt = null;
  }

  /** @param {EngineSample} s @param {boolean} counted */
  _restart(s, counted) {
    if (counted) this.resets += 1;
    this.key = s.key;
    this.samples = [];
    this._lastKnown = {};
    this.startedAt = s.t;
  }

  /**
   * Add one read. Starts the window again when the engine changed or any
   * counter went backwards (engine restart / counter reset), so a difference
   * never spans two engine lifetimes.
   * @param {EngineSample} s
   * @returns {{ reset: boolean }}
   */
  add(s) {
    if (!s || !Number.isFinite(s.t)) return { reset: false };
    const last = this.samples[this.samples.length - 1];
    if (last && s.t <= last.t) return { reset: false }; // out of order / duplicate
    let reset = false;
    if (this.key === null) {
      this._restart(s, false);
    } else if (s.key !== this.key || this._wentBack(s.counters)) {
      this._restart(s, true);
      reset = true;
    }
    this.samples.push(s);
    for (const name of ENGINE_COUNTER_NAMES) {
      const v = fin(s.counters?.[name]);
      if (v != null) this._lastKnown[name] = v;
    }
    const start = s.t - this.spanS * 1000;
    // Keep one read at or before the window start: the difference starts there.
    while (this.samples.length > 2 && this.samples[1].t <= start) this.samples.shift();
    return { reset };
  }

  /** @param {EngineSample["counters"]} counters */
  _wentBack(counters) {
    if (!counters) return false;
    for (const name of ENGINE_COUNTER_NAMES) {
      const v = fin(counters[name]);
      const p = this._lastKnown[name];
      if (v != null && p != null && v < p) return true;
    }
    return false;
  }

  /** @returns {NormalizedRecord} */
  record() {
    const out = emptyNormalizedRecord(this.spanS);
    const n = this.samples.length;
    out.reads = n;
    out.startedAt = this.startedAt;
    out.resets = this.resets;
    if (n === 0) return out;
    const a = this.samples[0];
    const b = this.samples[n - 1];
    const coveredS = (b.t - a.t) / 1000;
    out.coveredS = round(coveredS, 1) ?? 0;
    const windowS = round(Math.min(this.spanS, coveredS), 1);
    const v = out.values;

    // ── Counter differences (need two reads) ──
    /** @param {string} name */
    const d = (name) => {
      if (n < 2) return null;
      const x = fin(a.counters?.[name]);
      const y = fin(b.counters?.[name]);
      return x == null || y == null ? null : y - x;
    };
    const src = b.counterSource ?? "counter";
    const ctr = (value, digits) => val(round(value, digits), src, windowS, false, n);
    const has = (name) => d(name) != null;

    // Decode (Hasso): (Δdecoded − Δfirst) / Δitl_sum.
    if (has("decoded") && has("itlSum") && has("first")) {
      const net = d("decoded") - d("first");
      v.decode_tps = ctr(d("itlSum") > 0 && net > 0 ? net / d("itlSum") : null, 2);
    } else {
      v.decode_tps = this._rateMean("decodeTps", windowS);
    }
    // Prefill (Hasso): Δprefill_computed / Δprefill_seconds.
    if (has("prefillComputed") && has("prefillSeconds")) {
      const pc = d("prefillComputed");
      const fwd = d("prefillSeconds");
      v.prefill_tps = ctr(pc > 0 && fwd > 0 ? pc / fwd : null, 2);
    } else {
      v.prefill_tps = this._rateMean("prefillTps", windowS);
    }
    // TTFT: Δsum / Δcount, else the engine's per-poll TTFT.
    if (has("ttftSum") && has("ttftCount")) {
      v.ttft_s = ctr(d("ttftCount") > 0 ? d("ttftSum") / d("ttftCount") : null, 4);
    } else {
      v.ttft_s = this._rateMean("ttftS", windowS, 4);
    }
    // Queue: Δsum / Δcount.
    if (has("queueSum") && has("queueCount")) {
      v.queue_s = ctr(d("queueCount") > 0 ? d("queueSum") / d("queueCount") : null, 4);
    }
    // Cache reuse: Δcached / Δprompt.
    if (has("prompt") && has("cached")) {
      const p = d("prompt");
      v.cache_reuse = ctr(p > 0 ? Math.min(1, Math.max(0, d("cached") / p)) : null, 4);
    }
    // Accept length: vLLM 1 + Δaccepted / Δdrafts; SGLang Δgenerated / Δverify.
    if (has("specDrafts") && has("specAccepted")) {
      v.acc_len = ctr(d("specDrafts") > 0 ? 1 + d("specAccepted") / d("specDrafts") : null, 3);
    } else if (has("specVerify") && has("generated")) {
      v.acc_len = ctr(d("specVerify") > 0 ? d("generated") / d("specVerify") : null, 3);
    }
    // Idle share: only when both ends carry the idle counter.
    if (has("idleSeconds") && coveredS > 0) {
      v.idle_share = ctr(Math.min(1, Math.max(0, d("idleSeconds") / coveredS)), 4);
    }
    // Throughput: Δgenerated over the covered span, idle included. Idle reads 0.
    if (has("generated") && coveredS > 0) {
      v.throughput_tps = ctr(Math.max(0, d("generated")) / coveredS, 2);
    }

    // ── Levels: the newest read, with the window's peak ──
    v.running = this._level("running", 0);
    v.waiting = this._level("waiting", 0);
    v.kv_pct = this._level("kvPct", 1);
    return out;
  }

  /**
   * Busy-time-weighted mean of a per-poll rate: each read's rate covers the
   * interval since the previous read; reads at 0 (idle) are left out, so idle
   * does not dilute the speed. Approximate: a poll interval mixes phases.
   * @param {"decodeTps"|"prefillTps"|"ttftS"} name
   * @param {number|null} windowS
   * @param {number} [digits]
   * @returns {NormalizedValue}
   */
  _rateMean(name, windowS, digits = 2) {
    const s = this.samples;
    let sum = 0;
    let dt = 0;
    let used = 0;
    /** @type {SourceTier|null} */
    let source = null;
    for (let i = 1; i < s.length; i++) {
      const r = fin(s[i].rates?.[name]);
      const srcI = s[i].rateSources?.[name] ?? null;
      if (r != null && srcI) source = srcI;
      if (r == null || r <= 0) continue;
      const w = (s[i].t - s[i - 1].t) / 1000;
      if (!(w > 0)) continue;
      sum += r * w;
      dt += w;
      used += 1;
    }
    if (used === 0) {
      const out = unmeasured();
      out.source = source;
      return out;
    }
    return val(round(sum / dt, digits), source, windowS, true, used);
  }

  /**
   * @param {"running"|"waiting"|"kvPct"} name
   * @param {number} digits
   * @returns {NormalizedValue}
   */
  _level(name, digits) {
    const s = this.samples;
    const last = s[s.length - 1];
    const cur = fin(last?.levels?.[name]);
    if (cur == null) return unmeasured();
    let peak = cur;
    let n = 0;
    for (const x of s) {
      const lv = fin(x.levels?.[name]);
      if (lv == null) continue;
      n += 1;
      if (lv > peak) peak = lv;
    }
    // windowS 0: an instantaneous read. The peak covers the window.
    const out = val(round(cur, digits), last.levelSources?.[name] ?? null, 0, false, 1);
    out.peak = round(peak, digits);
    out.samples = n;
    return out;
  }
}

/** One EngineWindow per span, fed together. */
export class EngineWindows {
  /** @param {readonly number[]} [spansS] */
  constructor(spansS = ENGINE_WINDOW_SPANS_S) {
    /** @type {Map<number, EngineWindow>} */
    this.windows = new Map(spansS.map((s) => [s, new EngineWindow(s)]));
  }

  /** @param {EngineSample} s */
  add(s) {
    let reset = false;
    for (const w of this.windows.values()) reset = w.add(s).reset || reset;
    return { reset };
  }

  clear() {
    for (const w of this.windows.values()) w.clear();
  }

  /** @returns {Record<string, NormalizedRecord>} keyed by span seconds */
  records() {
    /** @type {Record<string, NormalizedRecord>} */
    const out = {};
    for (const [span, w] of this.windows) out[String(span)] = w.record();
    return out;
  }
}
