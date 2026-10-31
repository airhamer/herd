// Per-unit history store: the always-on GPU raw series (dense 8 h + optional
// 7-day minute series) and the opt-in 48 h / 30 d bucketed tiers.
// LIC2 clean-room rewrite from docs/specs/unit-history.md §4.
import fs from "fs";
import { atomicWrite, atomicWriteAsync, quarantineCorrupt } from "../util/atomicWrite.js";
import {
  BUCKET_TIERS,
  HISTORY_RANGES,
  TierColumns,
  accOf,
  accOut,
  isKnownKey,
  isNum,
  isRange,
  parseLlmKey,
  regrid,
} from "./historyTiers.js";

const MIN = 60_000;
const HR = 60 * MIN;
const DAY = 24 * HR;
const FILE_VERSION = 1;
const MAX_CARDS = 16;
/** Trim a raw series only once it is longer than this and a minute past due. */
const TRIM_MIN_LENGTH = 64;
const TRIM_SLACK_MS = MIN;
const SAVE_EVERY_MS = 5 * MIN;

const tenth = (v) => (isNum(v) ? Math.round(v * 10) / 10 : null);
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/** Object text with arbitrary (even "__proto__") keys, from [key, jsonText] pairs. */
function objectText(pairs) {
  return `{${pairs.map(([k, json]) => `${JSON.stringify(k)}:${json}`).join(",")}}`;
}

/**
 * Per-card readings for a multi-GPU host (≥ 2 cards, at most 16), honouring
 * each card's metricAvailability. Single-GPU units return [] — their
 * aggregate is the card.
 */
export function deviceReadings(gpus) {
  if (!Array.isArray(gpus) || gpus.length < 2) return [];
  const out = [];
  for (const card of gpus) {
    if (out.length >= MAX_CARDS) break;
    if (!card || !Number.isInteger(card.index) || card.index < 0) continue;
    const off = card.metricAvailability ?? {};
    const draw = card.power?.draw;
    const limit = card.power?.limit;
    const powerKnown = off.powerDraw !== false && off.powerLimit !== false && isNum(draw) && isNum(limit) && limit > 0;
    out.push({
      index: card.index,
      name: typeof card.name === "string" ? card.name : null,
      usage: off.usage === false || !isNum(card.usage) ? null : card.usage,
      temperature: off.temperature === false || !isNum(card.temperature) ? null : card.temperature,
      powerPct: powerKnown ? Math.min(100, (draw / limit) * 100) : null,
    });
  }
  return out;
}

// ─── GPU raw series ───────────────────────────────────────

function emptyRaw() {
  return { t: [], u: [], c: [], p: [], cards: new Map() };
}

function cardSeries(name, padTo) {
  const pad = () => new Array(padTo).fill(null);
  return { name, u: pad(), c: pad(), p: pad() };
}

/** Remove the first `k` readings of a unit, dropping cards left without usage. */
function shiftRaw(raw, k) {
  if (k <= 0) return false;
  raw.t.splice(0, k);
  raw.u.splice(0, k);
  raw.c.splice(0, k);
  raw.p.splice(0, k);
  for (const [idx, card] of raw.cards) {
    card.u.splice(0, k);
    card.c.splice(0, k);
    card.p.splice(0, k);
    if (card.u.every((v) => v === null)) raw.cards.delete(idx);
  }
  return true;
}

function countBefore(times, cutoff) {
  let k = 0;
  while (k < times.length && times[k] < cutoff) k++;
  return k;
}

/** One retention depth of the GPU raw series (dense or long). */
class RawSeries {
  constructor({ maxAgeMs, minGapMs }) {
    this.maxAgeMs = maxAgeMs;
    this.minGapMs = minGapMs;
    /** id → { t, u, c, p, cards: Map(index → { name, u, c, p }) } */
    this.units = new Map();
    this.revision = 0;
  }

  push(id, at, usage, temp, powerPct, devices) {
    let raw = this.units.get(id);
    const lastT = raw && raw.t.length > 0 ? raw.t[raw.t.length - 1] : null;
    if (lastT !== null && at < lastT + this.minGapMs) return false;
    if (!raw) {
      raw = emptyRaw();
      this.units.set(id, raw);
    }
    const before = raw.t.length;
    raw.t.push(at);
    raw.u.push(tenth(usage));
    raw.c.push(tenth(temp));
    raw.p.push(tenth(powerPct));
    const seen = new Set();
    for (const d of devices) {
      let card = raw.cards.get(d.index);
      if (!card) {
        if (raw.cards.size >= MAX_CARDS) continue;
        card = cardSeries(d.name ?? null, before);
        raw.cards.set(d.index, card);
      }
      if (d.name != null) card.name = d.name;
      card.u.push(tenth(d.usage));
      card.c.push(tenth(d.temperature));
      card.p.push(tenth(d.powerPct));
      seen.add(d.index);
    }
    for (const [idx, card] of raw.cards) {
      if (seen.has(idx)) continue;
      card.u.push(null);
      card.c.push(null);
      card.p.push(null);
    }
    const cutoff = at - this.maxAgeMs;
    if (raw.t.length > TRIM_MIN_LENGTH && raw.t[0] < cutoff - TRIM_SLACK_MS) {
      shiftRaw(raw, countBefore(raw.t, cutoff));
    }
    this.revision++;
    return true;
  }

  /** Exact trim at `atMs`; units left empty are forgotten. */
  prune(atMs) {
    const cutoff = atMs - this.maxAgeMs;
    for (const [id, raw] of this.units) {
      if (shiftRaw(raw, countBefore(raw.t, cutoff))) this.revision++;
      if (raw.t.length === 0) {
        this.units.delete(id);
        this.revision++;
      }
    }
  }

  forget(id) {
    if (this.units.delete(id)) this.revision++;
  }

  /** Readings with t ≥ sinceMs in the API shape. */
  since(id, sinceMs) {
    const raw = this.units.get(id);
    if (!raw) return { t: [], u: [], c: [], p: [], gpus: [] };
    const k = countBefore(raw.t, sinceMs);
    const gpus = [];
    for (const index of [...raw.cards.keys()].sort((a, b) => a - b)) {
      const card = raw.cards.get(index);
      const u = card.u.slice(k);
      if (u.every((v) => v === null)) continue;
      gpus.push({ index, name: card.name, u, c: card.c.slice(k), p: card.p.slice(k) });
    }
    return { t: raw.t.slice(k), u: raw.u.slice(k), c: raw.c.slice(k), p: raw.p.slice(k), gpus };
  }

  toText() {
    const pairs = [];
    for (const [id, raw] of this.units) {
      const g = {};
      for (const [index, card] of raw.cards) g[index] = { n: card.name, u: card.u, c: card.c, p: card.p };
      pairs.push([id, JSON.stringify({ t: raw.t, u: raw.u, c: raw.c, p: raw.p, g })]);
    }
    return `{"version":${FILE_VERSION},"sparks":${objectText(pairs)}}`;
  }

  /** Load from parsed file data; readings past the max age at `atMs` are dropped. */
  loadFrom(data, atMs) {
    const sparks = data?.sparks;
    if (!sparks || typeof sparks !== "object") return;
    const cutoff = atMs - this.maxAgeMs;
    const valueAt = (arr, i) => (Array.isArray(arr) && isNum(arr[i]) ? arr[i] : null);
    for (const id of Object.keys(sparks)) {
      const src = sparks[id];
      if (!src || !Array.isArray(src.t)) continue;
      const cards = src.g && typeof src.g === "object" ? src.g : {};
      const raw = emptyRaw();
      const cardIdx = Object.keys(cards)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0)
        .slice(0, MAX_CARDS);
      for (const index of cardIdx) raw.cards.set(index, cardSeries(typeof cards[index]?.n === "string" ? cards[index].n : null, 0));
      let prev = -Infinity;
      src.t.forEach((t, i) => {
        if (!isNum(t) || t < cutoff || t <= prev) return;
        prev = t;
        raw.t.push(t);
        raw.u.push(valueAt(src.u, i));
        raw.c.push(valueAt(src.c, i));
        raw.p.push(valueAt(src.p, i));
        for (const [index, card] of raw.cards) {
          const from = cards[index];
          card.u.push(valueAt(from?.u, i));
          card.c.push(valueAt(from?.c, i));
          card.p.push(valueAt(from?.p, i));
        }
      });
      for (const [index, card] of raw.cards) if (card.u.every((v) => v === null)) raw.cards.delete(index);
      if (raw.t.length > 0) this.units.set(id, raw);
    }
  }
}

// ─── The store ────────────────────────────────────────────

export class UnitHistory {
  /**
   * @param {object} [o]
   * @param {string|null} [o.file] dense GPU file (null: memory only)
   * @param {string|null} [o.tiersFile] bucketed tiers file (null: memory only)
   * @param {string|null} [o.longFile] long GPU file; omit for no long series, null for memory only
   */
  constructor(o = {}) {
    this.file = o.file ?? null;
    this.tiersFile = o.tiersFile ?? null;
    this.longFile = o.longFile ?? null;
    this.now = o.now ?? Date.now;
    this.tiersEnabled = o.tiersEnabled ?? (() => true);
    this.writeSync = o.writeSync ?? atomicWrite;
    this.writeAsync = o.writeAsync ?? atomicWriteAsync;
    this.readFileSync = o.readFileSync ?? ((f) => fs.readFileSync(f, "utf8"));
    this.yieldFn = o.yieldFn ?? nextTurn;
    this.logError = o.logError ?? ((msg, err) => console.error(`[UnitHistory] ${msg}:`, err?.message ?? err));

    this.dense = new RawSeries({ maxAgeMs: o.maxAgeMs ?? 8 * HR, minGapMs: o.minGapMs ?? 1500 });
    this.long =
      o.longFile === undefined
        ? null
        : new RawSeries({ maxAgeMs: o.longMaxAgeMs ?? 7 * DAY, minGapMs: o.longMinGapMs ?? MIN });

    /** id → { tiers: TierColumns[], llmPorts: number[] | null } */
    this.units = new Map();
    this.present = null;
    this.tiersRevision = 0;
    this.tiersLoaded = false;

    /** file → revision last written successfully */
    this.written = new Map();
    this.generation = 0;
    this.pendingSave = null;
    this.timer = null;

    const at = this.now();
    this._loadRaw(this.dense, this.file, at);
    if (this.long) this._loadRaw(this.long, this.longFile, at);
    this._markWritten();
  }

  _markWritten() {
    for (const t of this._targets()) this.written.set(t.file, t.revision());
  }

  _readJson(file, label) {
    let text;
    try {
      text = this.readFileSync(file);
    } catch (err) {
      if (err?.code !== "ENOENT") this.logError(`cannot read ${file}`, err);
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      quarantineCorrupt(file, label, err);
      return null;
    }
  }

  _loadRaw(series, file, atMs) {
    if (!file) return;
    const data = this._readJson(file, "UnitHistory");
    if (data) series.loadFrom(data, atMs);
  }

  // ── GPU raw series ──

  get maxWindowMs() {
    return this.long ? this.long.maxAgeMs : this.dense.maxAgeMs;
  }

  /** Add one GPU reading; true when the dense or the long series kept it. */
  record(id, at, usage, temperature, powerPct, devices = []) {
    if (!isNum(at)) return false;
    const cards = Array.isArray(devices) ? devices.filter((d) => d && Number.isInteger(d.index) && d.index >= 0) : [];
    const anyValue =
      [usage, temperature, powerPct].some(isNum) ||
      cards.some((d) => isNum(d.usage) || isNum(d.temperature) || isNum(d.powerPct));
    if (!anyValue) return false;
    const inDense = this.dense.push(id, at, usage, temperature, powerPct, cards);
    const inLong = this.long ? this.long.push(id, at, usage, temperature, powerPct, cards) : false;
    return inDense || inLong;
  }

  get(id, sinceMs = 0) {
    return this.dense.since(id, sinceMs);
  }

  window(id, windowMs, atMs = this.now()) {
    const series = this.long && windowMs > this.dense.maxAgeMs ? this.long : this.dense;
    return series.since(id, atMs - windowMs);
  }

  _prune(atMs = this.now()) {
    this.dense.prune(atMs);
    this.long?.prune(atMs);
  }

  remove(id) {
    this.dense.forget(id);
    this.long?.forget(id);
    if (this.units.delete(id)) this.tiersRevision++;
  }

  // ── Bucketed tiers ──

  _ensureTiers() {
    if (this.tiersLoaded) return;
    this.tiersLoaded = true;
    if (!this.tiersFile) return;
    const data = this._readJson(this.tiersFile, "UnitHistory");
    if (data === null) return;
    const units = data?.units;
    if (data?.version !== FILE_VERSION || !units || typeof units !== "object" || Array.isArray(units)) {
      quarantineCorrupt(this.tiersFile, "UnitHistory", new Error("unsupported metrics history file"));
      return;
    }
    const at = this.now();
    for (const id of Object.keys(units)) {
      const tiers = BUCKET_TIERS.map((tier) => TierColumns.fromFileForm(tier, units[id]?.[tier.name], at));
      if (tiers.some((t) => t.size > 0)) this.units.set(id, { tiers, llmPorts: null });
    }
  }

  _unit(id) {
    let unit = this.units.get(id);
    if (!unit) {
      unit = { tiers: BUCKET_TIERS.map((tier) => new TierColumns(tier)), llmPorts: null };
      this.units.set(id, unit);
    }
    return unit;
  }

  /**
   * One fleet-wide sample: `units` is every unit, `{ id, llmPorts?, values }`.
   * Units missing from the list (and LLM ports a unit stopped listing) are
   * dropped at the next save.
   */
  recordSample(units, atMs = this.now()) {
    this._ensureTiers();
    const ids = new Set();
    for (const entry of Array.isArray(units) ? units : []) {
      if (!entry || entry.id == null) continue;
      const id = String(entry.id);
      ids.add(id);
      const unit = this._unit(id);
      if (Array.isArray(entry.llmPorts)) {
        const ports = entry.llmPorts.filter(Number.isInteger);
        if (unit.llmPorts === null || ports.join() !== unit.llmPorts.join()) {
          unit.llmPorts = ports;
          this.tiersRevision++;
        }
      }
      let added = false;
      for (const [key, v] of Object.entries(entry.values ?? {})) {
        if (!isNum(v) || !isKnownKey(key)) continue;
        for (const tier of unit.tiers) tier.add(atMs, key, accOf(v));
        added = true;
      }
      for (const tier of unit.tiers) tier.cut(atMs - tier.tier.retentionMs);
      if (added) this.tiersRevision++;
    }
    const same = this.present && this.present.size === ids.size && [...ids].every((id) => this.present.has(id));
    if (!same) {
      this.present = ids;
      this.tiersRevision++;
    }
  }

  _portListed(unit, key) {
    const llm = parseLlmKey(key);
    return !llm || unit.llmPorts === null || unit.llmPorts.includes(llm.port);
  }

  /** Bucketed history of one unit for a named range (open bucket included). */
  query(id, range, atMs = this.now()) {
    if (!isRange(range)) throw new Error(`unknown range: ${range}`);
    this._ensureTiers();
    const spec = HISTORY_RANGES[range];
    const from = atMs - spec.spanMs;
    const result = { range, stepMs: spec.stepMs, from, to: atMs, points: [], llm: [] };
    const unit = this.units.get(id);
    if (!unit) return result;
    const perPort = new Map();
    for (const { t, accs } of regrid(unit.tiers[spec.tier].rowsSince(from), spec.stepMs)) {
      const point = { t };
      let unitValues = 0;
      for (const [key, acc] of accs) {
        const llm = parseLlmKey(key);
        if (!llm) {
          point[key] = accOut(key, acc);
          unitValues++;
          continue;
        }
        if (!this._portListed(unit, key)) continue;
        let byT = perPort.get(llm.port);
        if (!byT) perPort.set(llm.port, (byT = new Map()));
        let lp = byT.get(t);
        if (!lp) byT.set(t, (lp = { t }));
        lp[llm.name] = accOut(key, acc);
      }
      if (unitValues > 0) result.points.push(point);
    }
    result.llm = [...perPort.keys()]
      .sort((a, b) => a - b)
      .map((port) => ({ port, points: [...perPort.get(port).values()] }));
    return result;
  }

  /** Drop units no longer in the fleet and series of ports no longer listed. */
  _dropDeparted() {
    for (const [id, unit] of this.units) {
      if (this.present && !this.present.has(id)) {
        this.units.delete(id);
        continue;
      }
      for (const tier of unit.tiers) tier.dropSeries((key) => !this._portListed(unit, key));
    }
  }

  _unitFileText(unit, atMs) {
    const body = {};
    for (const tier of unit.tiers) {
      const form = tier.toFileForm(atMs - tier.tier.retentionMs);
      if (form) body[tier.tier.name] = form;
    }
    return Object.keys(body).length > 0 ? JSON.stringify(body) : null;
  }

  _tiersText(atMs, unitTexts) {
    return `{"version":${FILE_VERSION},"savedAt":${atMs},"units":${objectText(unitTexts)}}`;
  }

  _tiersTextSync(atMs) {
    this._dropDeparted();
    const pairs = [];
    for (const [id, unit] of this.units) {
      const text = this._unitFileText(unit, atMs);
      if (text) pairs.push([id, text]);
    }
    return this._tiersText(atMs, pairs);
  }

  async _tiersTextAsync(atMs) {
    this._dropDeparted();
    const pairs = [];
    for (const [id, unit] of [...this.units]) {
      await this.yieldFn();
      const text = this._unitFileText(unit, atMs);
      if (text) pairs.push([id, text]);
    }
    return this._tiersText(atMs, pairs);
  }

  /** The tiers file content as an object (tests and diagnostics). */
  serializeTiers(atMs = this.now()) {
    this._ensureTiers();
    return JSON.parse(this._tiersTextSync(atMs));
  }

  // ── Persistence ──

  /** Files this store writes, each with its revision and how to render it. */
  _targets() {
    const out = [];
    if (this.file) {
      out.push({ file: this.file, revision: () => this.dense.revision, text: () => this.dense.toText() });
    }
    if (this.long && this.longFile) {
      out.push({ file: this.longFile, revision: () => this.long.revision, text: () => this.long.toText() });
    }
    if (this.tiersFile) {
      out.push({
        file: this.tiersFile,
        tiers: true,
        revision: () => this.tiersRevision,
        text: () => this._tiersTextSync(this.now()),
        textAsync: () => this._tiersTextAsync(this.now()),
      });
    }
    return out;
  }

  _dirty(target) {
    if (target.tiers && (!this.tiersLoaded || !this.tiersEnabled())) return false;
    return this.written.get(target.file) !== target.revision();
  }

  /** Write every changed file without blocking; concurrent callers share one save. */
  save() {
    if (!this.pendingSave) {
      this.pendingSave = this._saveAll().finally(() => {
        this.pendingSave = null;
      });
    }
    return this.pendingSave;
  }

  async _saveAll() {
    const generation = this.generation;
    const shouldCommit = () => this.generation === generation;
    this._prune();
    for (const target of this._targets()) {
      if (!this._dirty(target)) continue;
      const revision = target.revision();
      try {
        const text = target.textAsync ? await target.textAsync() : target.text();
        if (!shouldCommit()) return;
        if (await this.writeAsync(target.file, text, 0o600, { shouldCommit })) {
          this.written.set(target.file, revision);
        }
      } catch (err) {
        this.logError(`failed to save ${target.file}`, err);
      }
    }
  }

  /** Synchronous write of every changed file; true when something was written. */
  flush() {
    this.generation++;
    this._prune();
    let wrote = false;
    for (const target of this._targets()) {
      if (!this._dirty(target)) continue;
      const revision = target.revision();
      try {
        this.writeSync(target.file, target.text(), 0o600);
        this.written.set(target.file, revision);
        wrote = true;
      } catch (err) {
        this.logError(`failed to write ${target.file}`, err);
      }
    }
    return wrote;
  }

  start() {
    if (this.timer || this._targets().length === 0) return;
    this.timer = setInterval(() => {
      this.save().catch((err) => this.logError("periodic save failed", err));
    }, SAVE_EVERY_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.flush();
  }
}

export default UnitHistory;
