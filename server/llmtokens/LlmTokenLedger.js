// Fleet-wide LLM token ledger (FLEET3, issue #38). Clean-room from the issue
// spec; no upstream source was used. MIT.
//
// Every engine endpoint is one series, keyed `nodeId:port` (Spark id or agent
// node id). Each sample brings the cumulative generated / prompt / cached
// token counters the engine (or, for engines without counters, the agent's
// STAT4 usage relay) reports. The ledger diffs them against the previous
// sample and credits the deltas to the model running on the endpoint at that
// moment:
//
//   generated  Δ output tokens
//   cached     Δ prompt tokens served from the prefix cache
//   prefill    Δ prompt − Δ cached (prompt tokens the engine computed)
//
// A counter that goes backwards (engine restart), a counter whose source or
// epoch changed (another engine on the port, relay restart), or a gap longer
// than MAX_RESUME_GAP_MS re-seeds that counter without crediting anything.
// Baselines are persisted, so tokens produced while the dashboard was down are
// credited on the first sample after it comes back (within the gap limit).
//
// Storage is bounded: hourly buckets for 72 h, daily (UTC) buckets for 35
// days, all-time totals per series and model, at most MAX_KEYS such keys.
import fs from "fs";
import { atomicWrite, quarantineCorrupt } from "../util/atomicWrite.js";

export const TOKEN_FIELDS = Object.freeze(["generated", "prompt", "cached"]);
export const TOKEN_RANGES = Object.freeze(["24h", "7d", "30d", "all"]);
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const HOURLY_KEEP = 72;
export const DAILY_KEEP = 35;
export const MAX_KEYS = 512;
export const MAX_RESUME_GAP_MS = DAY_MS;
export const OTHER_MODEL = "(other models)";
export const UNKNOWN_MODEL = "unknown";
/** Series id of the fleet-wide overflow key past MAX_KEYS. */
export const OVERFLOW_SERIES = "(other endpoints)";
const OVERFLOW_KEY = `${OVERFLOW_SERIES}|${OTHER_MODEL}`;
const SCHEMA = 1;
const LABEL = "llm-tokens";

const hourStart = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS;
const dayStart = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
const validCount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const emptyTotals = () => ({ generated: 0, cached: 0, prefill: 0 });
const keyOf = (seriesId, model) => `${seriesId}|${model}`;

function addInto(target, add) {
  target.generated += add.generated;
  target.cached += add.cached;
  target.prefill += add.prefill;
  return target;
}

const packTotals = (t) => [t.generated, t.cached, t.prefill];
function unpackTotals(raw) {
  if (!Array.isArray(raw) || raw.length !== 3 || !raw.every(validCount)) return null;
  return { generated: raw[0], cached: raw[1], prefill: raw[2] };
}

/**
 * @typedef {{ value: number, source: string, epoch: string }} TokenFieldSample
 * @typedef {{
 *   seriesId: string, nodeId: string, nodeName?: string|null, port: number,
 *   backend?: string|null, model?: string|null,
 *   fields: Partial<Record<"generated"|"prompt"|"cached", TokenFieldSample|null>>
 * }} TokenObservation
 */

export class LlmTokenLedger {
  /**
   * @param {{ filePath?: string|null, now?: () => number }} [opts]
   */
  constructor({ filePath = null, now = Date.now } = {}) {
    this.filePath = filePath;
    this.now = now;
    this._reset(now());
    this._series = new Map();
    this._dirty = false;
    if (filePath) this._load();
  }

  _reset(sinceMs) {
    this._sinceMs = sinceMs;
    /** key → { seriesId, nodeId, nodeName, port, backend, model, sources:Set } */
    this._keys = new Map();
    /** key → totals */
    this._allTime = new Map();
    /** bucketStartMs → Map<key, totals> */
    this._hourly = new Map();
    this._daily = new Map();
  }

  /** Apply one sample of every endpoint. Returns the credited fleet totals. */
  observe(observations, atMs = this.now()) {
    const credited = emptyTotals();
    for (const obs of Array.isArray(observations) ? observations : []) {
      if (!obs || typeof obs.seriesId !== "string" || !obs.fields) continue;
      const add = this._observeOne(obs, atMs);
      if (add) addInto(credited, add);
    }
    this._prune(atMs);
    return credited;
  }

  _observeOne(obs, atMs) {
    const prev = this._series.get(obs.seriesId);
    const resumable =
      prev != null && atMs >= prev.lastSeenMs && atMs - prev.lastSeenMs <= MAX_RESUME_GAP_MS;
    const deltas = { generated: 0, prompt: 0, cached: 0 };
    const sources = new Set();
    const fields = {};
    for (const name of TOKEN_FIELDS) {
      const cur = obs.fields[name];
      if (!cur || !validCount(cur.value)) {
        fields[name] = null; // gone: re-seed when it comes back
        continue;
      }
      const base = resumable ? prev.fields[name] : null;
      if (base && base.epoch === cur.epoch && cur.value >= base.value) {
        deltas[name] = cur.value - base.value;
        if (deltas[name] > 0) sources.add(String(cur.source ?? "counter"));
      }
      fields[name] = { value: cur.value, epoch: String(cur.epoch ?? "") };
    }
    const model = typeof obs.model === "string" && obs.model ? obs.model : UNKNOWN_MODEL;
    this._series.set(obs.seriesId, {
      nodeId: obs.nodeId,
      nodeName: obs.nodeName ?? null,
      port: obs.port,
      backend: obs.backend ?? null,
      model,
      lastSeenMs: atMs,
      fields,
    });
    this._dirty = true;

    const add = {
      generated: deltas.generated,
      cached: deltas.cached,
      prefill: Math.max(0, deltas.prompt - deltas.cached),
    };
    if (add.generated === 0 && add.cached === 0 && add.prefill === 0) return null;
    this._credit(obs, model, add, sources, atMs);
    return add;
  }

  _credit(obs, model, add, sources, atMs) {
    let key = keyOf(obs.seriesId, model);
    let overflow = false;
    if (!this._keys.has(key) && this._keys.size >= MAX_KEYS) {
      // Bound the key space: everything past the cap lands in one fleet-wide key.
      overflow = true;
      model = OTHER_MODEL;
      key = OVERFLOW_KEY;
    }
    let meta = this._keys.get(key);
    if (!meta) {
      meta = overflow
        ? { seriesId: OVERFLOW_SERIES, nodeId: OVERFLOW_SERIES, port: 0, model, sources: new Set() }
        : { seriesId: obs.seriesId, nodeId: obs.nodeId, port: obs.port, model, sources: new Set() };
      this._keys.set(key, meta);
    }
    if (!overflow) {
      meta.nodeName = obs.nodeName ?? meta.nodeName ?? null;
      meta.backend = obs.backend ?? meta.backend ?? null;
    }
    meta.lastMs = atMs;
    for (const s of sources) meta.sources.add(s);

    addInto(this._bucket(this._allTime, key), add);
    addInto(this._bucket(this._tier(this._hourly, hourStart(atMs)), key), add);
    addInto(this._bucket(this._tier(this._daily, dayStart(atMs)), key), add);
  }

  _tier(tier, startMs) {
    let m = tier.get(startMs);
    if (!m) tier.set(startMs, (m = new Map()));
    return m;
  }

  _bucket(map, key) {
    let t = map.get(key);
    if (!t) map.set(key, (t = emptyTotals()));
    return t;
  }

  _prune(atMs) {
    const hourCut = hourStart(atMs) - (HOURLY_KEEP - 1) * HOUR_MS;
    const dayCut = dayStart(atMs) - (DAILY_KEEP - 1) * DAY_MS;
    for (const start of this._hourly.keys()) if (start < hourCut) this._hourly.delete(start);
    for (const start of this._daily.keys()) if (start < dayCut) this._daily.delete(start);
    for (const [id, s] of this._series) {
      if (atMs - s.lastSeenMs > DAILY_KEEP * DAY_MS) this._series.delete(id);
    }
  }

  /** Buckets (or all-time totals) a range covers, and where it starts. */
  _window(range, atMs) {
    if (range === "24h") {
      const from = hourStart(atMs) - 23 * HOUR_MS;
      return { from, resolution: "hour", tier: this._hourly };
    }
    if (range === "7d" || range === "30d") {
      const days = range === "7d" ? 7 : 30;
      const from = dayStart(atMs) - (days - 1) * DAY_MS;
      return { from, resolution: "day", tier: this._daily };
    }
    return { from: this._sinceMs, resolution: "all", tier: null };
  }

  _sumByKey(range, atMs) {
    const { from, resolution, tier } = this._window(range, atMs);
    if (!tier) return { from, resolution, byKey: this._allTime };
    const byKey = new Map();
    for (const [start, bucket] of tier) {
      if (start < from || start > atMs) continue;
      for (const [key, t] of bucket) addInto(this._bucket(byKey, key), t);
    }
    return { from, resolution, byKey };
  }

  /**
   * Fleet totals, per model and per endpoint, for "24h" | "7d" | "30d" | "all".
   * 24h is the current hour and the 23 before it; 7d / 30d are UTC calendar
   * days including today.
   */
  totals(range = "24h", atMs = this.now()) {
    if (!TOKEN_RANGES.includes(range)) throw new RangeError(`unknown range ${range}`);
    const { from, resolution, byKey } = this._sumByKey(range, atMs);
    const fleet = emptyTotals();
    const models = new Map();
    const endpoints = new Map();
    for (const [key, t] of byKey) {
      const meta = this._keys.get(key);
      if (!meta || t.generated + t.cached + t.prefill === 0) continue;
      addInto(fleet, t);
      let m = models.get(meta.model);
      if (!m) models.set(meta.model, (m = { model: meta.model, ...emptyTotals(), endpoints: new Set(), sources: new Set() }));
      addInto(m, t);
      m.endpoints.add(meta.seriesId);
      for (const s of meta.sources) m.sources.add(s);
      let e = endpoints.get(meta.seriesId);
      if (!e) {
        const live = this._series.get(meta.seriesId);
        endpoints.set(meta.seriesId, (e = {
          seriesId: meta.seriesId,
          nodeId: meta.nodeId,
          nodeName: live?.nodeName ?? meta.nodeName ?? null,
          port: meta.port,
          backend: live?.backend ?? meta.backend ?? null,
          ...emptyTotals(),
          models: new Set(),
          sources: new Set(),
          lastSeenMs: live?.lastSeenMs ?? meta.lastMs ?? null,
        }));
      }
      addInto(e, t);
      e.models.add(meta.model);
      for (const s of meta.sources) e.sources.add(s);
    }
    const withTotal = (o) => ({ ...o, total: o.generated + o.cached + o.prefill });
    const byGenerated = (a, b) => b.generated - a.generated || b.total - a.total;
    return {
      range,
      resolution,
      fromMs: from,
      toMs: atMs,
      trackedSinceMs: this._sinceMs,
      ...withTotal(fleet),
      endpointCount: endpoints.size,
      models: [...models.values()]
        .map((m) => withTotal({ ...m, endpoints: [...m.endpoints].sort(), sources: [...m.sources].sort() }))
        .sort(byGenerated),
      endpoints: [...endpoints.values()]
        .map((e) => withTotal({ ...e, models: [...e.models].sort(), sources: [...e.sources].sort() }))
        .sort(byGenerated),
    };
  }

  /** Per-bucket fleet totals: hourly for 24h, daily otherwise (all = the 35 retained days). */
  history(range = "24h", atMs = this.now()) {
    if (!TOKEN_RANGES.includes(range)) throw new RangeError(`unknown range ${range}`);
    const hourly = range === "24h";
    const step = hourly ? HOUR_MS : DAY_MS;
    const count = hourly ? 24 : range === "7d" ? 7 : range === "30d" ? 30 : DAILY_KEEP;
    const last = hourly ? hourStart(atMs) : dayStart(atMs);
    const tier = hourly ? this._hourly : this._daily;
    const points = [];
    for (let i = count - 1; i >= 0; i -= 1) {
      const startMs = last - i * step;
      const sum = emptyTotals();
      for (const t of tier.get(startMs)?.values() ?? []) addInto(sum, t);
      points.push({ startMs, ...sum });
    }
    return { range, resolution: hourly ? "hour" : "day", stepMs: step, trackedSinceMs: this._sinceMs, points };
  }

  /** Forget every total (baselines stay, so nothing is credited twice). */
  clear(atMs = this.now()) {
    this._reset(atMs);
    this._dirty = true;
    this.save();
  }

  // ── persistence ──────────────────────────────────────────

  toJSON() {
    const tierOut = (tier) =>
      Object.fromEntries([...tier].map(([start, m]) => [start, Object.fromEntries([...m].map(([k, t]) => [k, packTotals(t)]))]));
    return {
      schema: SCHEMA,
      sinceMs: this._sinceMs,
      series: Object.fromEntries(this._series),
      keys: Object.fromEntries([...this._keys].map(([k, m]) => [k, { ...m, sources: [...m.sources] }])),
      allTime: Object.fromEntries([...this._allTime].map(([k, t]) => [k, packTotals(t)])),
      hourly: tierOut(this._hourly),
      daily: tierOut(this._daily),
    };
  }

  _load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (err) {
      if (err?.code === "ENOENT") return;
      quarantineCorrupt(this.filePath, LABEL, err);
      return;
    }
    if (!raw || raw.schema !== SCHEMA) {
      quarantineCorrupt(this.filePath, LABEL, new Error("unknown schema"));
      return;
    }
    if (validCount(raw.sinceMs)) this._sinceMs = raw.sinceMs;
    for (const [k, m] of Object.entries(raw.keys ?? {})) {
      if (!m || typeof m.seriesId !== "string" || typeof m.model !== "string") continue;
      if (this._keys.size >= MAX_KEYS + 1) break;
      this._keys.set(k, { ...m, sources: new Set(Array.isArray(m.sources) ? m.sources.map(String) : []) });
    }
    for (const [k, packed] of Object.entries(raw.allTime ?? {})) {
      const t = unpackTotals(packed);
      if (t && this._keys.has(k)) this._allTime.set(k, t);
    }
    const tierIn = (src, tier) => {
      for (const [start, bucket] of Object.entries(src ?? {})) {
        const startMs = Number(start);
        if (!Number.isSafeInteger(startMs)) continue;
        for (const [k, packed] of Object.entries(bucket ?? {})) {
          const t = unpackTotals(packed);
          if (t && this._keys.has(k)) this._tier(tier, startMs).set(k, t);
        }
      }
    };
    tierIn(raw.hourly, this._hourly);
    tierIn(raw.daily, this._daily);
    for (const [id, s] of Object.entries(raw.series ?? {})) {
      if (!s || !validCount(s.lastSeenMs) || !s.fields) continue;
      const fields = {};
      for (const name of TOKEN_FIELDS) {
        const f = s.fields[name];
        fields[name] = f && validCount(f.value) ? { value: f.value, epoch: String(f.epoch ?? "") } : null;
      }
      this._series.set(id, { ...s, fields });
    }
    this._prune(this.now());
  }

  /** Write the ledger if it changed. Returns false when the write failed. */
  save() {
    if (!this.filePath || !this._dirty) return true;
    try {
      atomicWrite(this.filePath, JSON.stringify(this.toJSON()));
      this._dirty = false;
      return true;
    } catch (err) {
      console.error(`[${LABEL}] ${err?.message ?? err}`);
      return false;
    }
  }
}
