// Bucketed unit history: series names, tiers, query ranges and the per-tier
// column store. LIC2 clean-room rewrite from docs/specs/unit-history.md §3.

const MIN = 60_000;
const HR = 60 * MIN;
const DAY = 24 * HR;

/** Finest first; `name` is the tier's key in metrics-history.json. */
export const BUCKET_TIERS = Object.freeze([
  Object.freeze({ name: "1m", stepMs: MIN, retentionMs: 2 * DAY }),
  Object.freeze({ name: "15m", stepMs: 15 * MIN, retentionMs: 30 * DAY }),
]);

/**
 * Query ranges → the tier that answers and the step of the returned grid.
 * Every range stays at or below 500 points per series, and its step is a
 * whole multiple of its tier's step, so the grid never shifts between polls.
 */
export const HISTORY_RANGES = Object.freeze({
  "1h": Object.freeze({ spanMs: HR, tier: 0, stepMs: MIN }),
  "6h": Object.freeze({ spanMs: 6 * HR, tier: 0, stepMs: MIN }),
  "24h": Object.freeze({ spanMs: DAY, tier: 0, stepMs: 3 * MIN }),
  "7d": Object.freeze({ spanMs: 7 * DAY, tier: 1, stepMs: 30 * MIN }),
  "30d": Object.freeze({ spanMs: 30 * DAY, tier: 1, stepMs: 90 * MIN }),
});

export const RANGE_NAMES = Object.freeze(Object.keys(HISTORY_RANGES));

/** True for an own range name only ("__proto__", "toString" … are not ranges). */
export const isRange = (name) => typeof name === "string" && Object.hasOwn(HISTORY_RANGES, name);

/** Per-unit series: % / °C / W / MB / bytes per second. */
export const UNIT_SERIES = Object.freeze([
  "gpuUtil",
  "gpuTemp",
  "gpuPower",
  "memUsedMB",
  "memFreeMB",
  "cpuUtil",
  "cpuTemp",
  "ramUsedMB",
  "netRx",
  "netTx",
]);

/** Per LLM endpoint: tokens/s and the KV pool fill (0–1). */
export const LLM_SERIES = Object.freeze(["genTps", "prefillTps", "kvUsage"]);

const unitSeriesSet = new Set(UNIT_SERIES);
const llmSeriesSet = new Set(LLM_SERIES);
const LLM_KEY = /^llm:(\d{1,5}):([A-Za-z]+)$/;

/** Count kept per bucket on the wire / on disk (it is stored as uint16). */
export const COUNT_CAP = 65_535;

export const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function llmKey(port, name) {
  return `llm:${port}:${name}`;
}

/** `{ port, name }` for a well-formed LLM key, else null. */
export function parseLlmKey(key) {
  const m = typeof key === "string" ? LLM_KEY.exec(key) : null;
  if (!m || !llmSeriesSet.has(m[2])) return null;
  return { port: Number(m[1]), name: m[2] };
}

export function isKnownKey(key) {
  return unitSeriesSet.has(key) || parseLlmKey(key) !== null;
}

/** Only free memory keeps its low point (headroom is about the minimum). */
export const tracksMin = (key) => key === "memFreeMB";

/** Rounding for transport and storage: integers from 100, cents from 1, 4 places below. */
export function wireRound(v) {
  const mag = Math.abs(v);
  if (mag >= 100) return Math.round(v);
  const places = mag >= 1 ? 100 : 10_000;
  return Math.round(v * places) / places;
}

// ─── Accumulators: { sum, max, min, n } ───────────────────

export const accOf = (v) => ({ sum: v, max: v, min: v, n: 1 });

/** Weighted merge; returns a new accumulator (neither argument is changed). */
export function accMerge(a, b) {
  if (!a) return { ...b };
  if (!b) return { ...a };
  return { sum: a.sum + b.sum, max: Math.max(a.max, b.max), min: Math.min(a.min, b.min), n: a.n + b.n };
}

/** `{ avg, max, min? }` for the API. */
export function accOut(key, acc) {
  const out = { avg: wireRound(acc.sum / acc.n), max: wireRound(acc.max) };
  if (tracksMin(key)) out.min = wireRound(acc.min);
  return out;
}

/** Group [{ t, accs: Map }] (ascending) onto an epoch-aligned grid of `stepMs`. */
export function regrid(rows, stepMs) {
  const out = [];
  for (const row of rows) {
    const g = row.t - (row.t % stepMs);
    let cell = out[out.length - 1];
    if (!cell || cell.t !== g) {
      cell = { t: g, accs: new Map() };
      out.push(cell);
    }
    for (const [key, acc] of row.accs) cell.accs.set(key, accMerge(cell.accs.get(key), acc));
  }
  return out;
}

// ─── Column store for one tier of one unit ────────────────

/**
 * Bucket rows in ascending time, with one column group per series. Rows
 * arrive almost always in order, so appending is the fast path; a clock that
 * stepped back merges into (or inserts) the row for its time. Rows older than
 * the retention are cut from the front.
 */
export class TierColumns {
  constructor(tier) {
    this.tier = tier;
    /** Bucket starts, ascending. */
    this.t = [];
    /** key → { sum[], max[], min[]|null, n[] } parallel to `t`. */
    this.cols = new Map();
  }

  get size() {
    return this.t.length;
  }

  _column(key) {
    let col = this.cols.get(key);
    if (!col) {
      const len = this.t.length;
      col = {
        sum: new Array(len).fill(0),
        max: new Array(len).fill(0),
        min: tracksMin(key) ? new Array(len).fill(0) : null,
        n: new Array(len).fill(0),
      };
      this.cols.set(key, col);
    }
    return col;
  }

  /** Index of the row for bucket start `start`, creating it if needed. */
  _row(start) {
    const t = this.t;
    const last = t.length - 1;
    if (last >= 0 && t[last] === start) return last;
    let at = t.length;
    if (last >= 0 && t[last] > start) {
      let lo = 0;
      let hi = last;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (t[mid] < start) lo = mid + 1;
        else hi = mid;
      }
      if (t[lo] === start) return lo;
      at = lo;
    }
    t.splice(at, 0, start);
    for (const col of this.cols.values()) {
      col.sum.splice(at, 0, 0);
      col.max.splice(at, 0, 0);
      col.min?.splice(at, 0, 0);
      col.n.splice(at, 0, 0);
    }
    return at;
  }

  /** Fold an accumulator into the bucket that contains `atMs`. */
  add(atMs, key, acc) {
    const step = this.tier.stepMs;
    const i = this._row(atMs - (atMs % step));
    const col = this._column(key);
    if (col.n[i] > 0) {
      col.sum[i] += acc.sum;
      col.max[i] = Math.max(col.max[i], acc.max);
      if (col.min) col.min[i] = Math.min(col.min[i], acc.min);
      col.n[i] += acc.n;
    } else {
      col.sum[i] = acc.sum;
      col.max[i] = acc.max;
      if (col.min) col.min[i] = acc.min;
      col.n[i] = acc.n;
    }
  }

  /** Drop rows that start before `cutoffMs`; true when something went. */
  cut(cutoffMs) {
    let k = 0;
    while (k < this.t.length && this.t[k] < cutoffMs) k++;
    if (k === 0) return false;
    this.t.splice(0, k);
    for (const col of this.cols.values()) {
      col.sum.splice(0, k);
      col.max.splice(0, k);
      col.min?.splice(0, k);
      col.n.splice(0, k);
    }
    return true;
  }

  /** Remove series for which `drop(key)` is true; true when any went. */
  dropSeries(drop) {
    let changed = false;
    for (const key of [...this.cols.keys()]) {
      if (drop(key)) {
        this.cols.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  /** Rows with t ≥ fromMs as [{ t, accs: Map(key → acc) }]; empty rows skipped. */
  rowsSince(fromMs) {
    const out = [];
    for (let i = 0; i < this.t.length; i++) {
      if (this.t[i] < fromMs) continue;
      const accs = new Map();
      for (const [key, col] of this.cols) {
        const n = col.n[i];
        if (n > 0) accs.set(key, { sum: col.sum[i], max: col.max[i], min: col.min ? col.min[i] : col.sum[i] / n, n });
      }
      if (accs.size > 0) out.push({ t: this.t[i], accs });
    }
    return out;
  }

  /**
   * File form of the rows with t ≥ fromMs: `{ t: [], series: { key: { avg,
   * max, min?, n } } }`, columns parallel to t, null/0 for empty cells, keys
   * sorted, series without any data left out. null when nothing to keep.
   */
  toFileForm(fromMs) {
    const idx = [];
    for (let i = 0; i < this.t.length; i++) if (this.t[i] >= fromMs) idx.push(i);
    const series = {};
    for (const key of [...this.cols.keys()].sort()) {
      const col = this.cols.get(key);
      if (!idx.some((i) => col.n[i] > 0)) continue;
      const avg = [];
      const max = [];
      const min = col.min ? [] : null;
      const n = [];
      for (const i of idx) {
        const count = col.n[i];
        avg.push(count > 0 ? wireRound(col.sum[i] / count) : null);
        max.push(count > 0 ? wireRound(col.max[i]) : null);
        if (min) min.push(count > 0 ? wireRound(col.min[i]) : null);
        n.push(Math.min(COUNT_CAP, count));
      }
      series[key] = min ? { avg, max, min, n } : { avg, max, n };
    }
    if (Object.keys(series).length === 0) return null;
    // Rows where no series has data are noise in the file.
    const keep = idx.map((i) => [...this.cols.values()].some((c) => c.n[i] > 0));
    if (keep.every(Boolean)) return { t: idx.map((i) => this.t[i]), series };
    const pick = (arr) => arr.filter((_, j) => keep[j]);
    for (const s of Object.values(series)) {
      for (const field of Object.keys(s)) s[field] = pick(s[field]);
    }
    return { t: pick(idx.map((i) => this.t[i])), series };
  }

  /**
   * Rebuild from the file form, keeping rows inside the retention at `atMs`
   * and aligned to the tier step, and cells with a positive integer count
   * and finite avg/max. Unknown keys are ignored.
   */
  static fromFileForm(tier, form, atMs) {
    const cols = new TierColumns(tier);
    if (!form || typeof form !== "object" || !Array.isArray(form.t)) return cols;
    const series = form.series && typeof form.series === "object" ? form.series : {};
    const oldest = atMs - tier.retentionMs;
    form.t.forEach((t, j) => {
      if (!isNum(t) || t < oldest || t % tier.stepMs !== 0) return;
      for (const key of Object.keys(series)) {
        if (!isKnownKey(key)) continue;
        const s = series[key];
        const n = s?.n?.[j];
        const avg = s?.avg?.[j];
        const max = s?.max?.[j];
        if (!Number.isInteger(n) || n <= 0 || !isNum(avg) || !isNum(max)) continue;
        const low = tracksMin(key) && isNum(s.min?.[j]) ? s.min[j] : avg;
        cols.add(t, key, { sum: avg * n, max, min: low, n });
      }
    });
    return cols;
  }
}
