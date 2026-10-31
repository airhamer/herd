/**
 * Bench results store: a versioned JSON file of result records with
 * migrations, validation on every write, filtered listing and
 * like-with-like comparison.
 *
 * File: BENCH_RESULTS_PATH || config/bench-results.json
 *   { "format": "herd.bench-results", "schema_version": 1, "results": [...] }
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWrite } from "../../util/atomicWrite.js";
import {
  SCHEMA_VERSION,
  validateResult,
  compareResults,
  comparabilityKey,
} from "./schema.js";
import { fromLegacyHistory } from "./adapters.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(__dirname, "..", "..", "..", "config");

export const DEFAULT_RESULTS_PATH =
  process.env.BENCH_RESULTS_PATH || path.join(CONFIG_DIR, "bench-results.json");

export const FILE_FORMAT = "herd.bench-results";
export const DEFAULT_MAX_RESULTS = 20000;
export const MAX_LIST_LIMIT = 1000;

export class BenchResultValidationError extends Error {
  /** @param {string[]} errors */
  constructor(errors) {
    super(`Invalid bench result: ${errors.join("; ")}`);
    this.errors = errors;
    this.status = 400;
  }
}

/**
 * Migrations keyed by the version they upgrade FROM. Each takes the parsed
 * file document and returns the document at version + 1.
 *
 * v0 → v1: pre-release files were a bare array of records without a
 * per-record schema_version and with metric rows lacking `tier`/`valid`.
 * @type {Record<number, (doc: any) => any>}
 */
export const MIGRATIONS = {
  0: (doc) => {
    const results = Array.isArray(doc) ? doc : Array.isArray(doc?.results) ? doc.results : [];
    return {
      format: FILE_FORMAT,
      schema_version: 1,
      results: results.map((r) => ({
        ...r,
        schema_version: 1,
        metrics: Array.isArray(r?.metrics)
          ? r.metrics.map((m) => ({
              ...m,
              tier: m.tier ?? TIER_V1[m.source] ?? null,
              valid: m.valid ?? (typeof m.value === "number" && Number.isFinite(m.value)),
              approximate: m.approximate ?? false,
              window_s: m.window_s ?? null,
            }))
          : r?.metrics,
      })),
    };
  },
};

const TIER_V1 = { counter: 1, native: 2, proxy: 3, client: 4, reference: null };

/** Version of a parsed file document (bare array = 0). */
export function documentVersion(doc) {
  if (Array.isArray(doc)) return 0;
  if (doc && typeof doc === "object" && Number.isInteger(doc.schema_version)) return doc.schema_version;
  return 0;
}

/**
 * Bring a parsed document up to SCHEMA_VERSION.
 * @returns {{ doc: any, from: number, migrated: boolean }}
 */
export function migrateDocument(doc) {
  const from = documentVersion(doc);
  if (from > SCHEMA_VERSION) {
    const err = new Error(
      `bench results file is schema_version ${from}; this Herd understands up to ${SCHEMA_VERSION}`
    );
    err.code = "FUTURE_VERSION";
    throw err;
  }
  let cur = doc;
  for (let v = from; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`no migration from bench results schema_version ${v}`);
    cur = step(cur);
  }
  return { doc: cur, from, migrated: from !== SCHEMA_VERSION };
}

function toTime(v) {
  if (v === null || v === undefined || v === "") return null;
  if (/^\d+$/.test(String(v).trim())) return Number(v);
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

function intOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

export class BenchResultsStore {
  /**
   * @param {{ path?: string, maxResults?: number, log?: (msg: string) => void }} [opts]
   */
  constructor(opts = {}) {
    this.path = opts.path || DEFAULT_RESULTS_PATH;
    this.maxResults = opts.maxResults || DEFAULT_MAX_RESULTS;
    this.log = opts.log || ((msg) => console.warn(msg));
    /** @type {Map<string, any>} */
    this.byId = new Map();
    /** true when the on-disk file is from a newer Herd; writes are refused. */
    this.readOnly = false;
    this.loadInfo = { from: SCHEMA_VERSION, migrated: false };
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.path)) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.path, "utf8"));
    } catch (err) {
      const aside = `${this.path}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.path, aside);
      } catch {
        /* ignore */
      }
      this.log(`[bench-results] unreadable ${this.path} (${err.message}); moved to ${aside}`);
      return;
    }
    let migrated;
    try {
      migrated = migrateDocument(parsed);
    } catch (err) {
      this.readOnly = err.code === "FUTURE_VERSION";
      this.log(`[bench-results] ${err.message}; store is read-only`);
      const results = Array.isArray(parsed?.results) ? parsed.results : [];
      for (const r of results) if (r && typeof r.id === "string") this.byId.set(r.id, r);
      return;
    }
    this.loadInfo = { from: migrated.from, migrated: migrated.migrated };
    let dropped = 0;
    for (const r of migrated.doc.results || []) {
      const { ok } = validateResult(r);
      if (ok) this.byId.set(r.id, r);
      else dropped++;
    }
    if (dropped) this.log(`[bench-results] skipped ${dropped} invalid record(s) in ${this.path}`);
    if (migrated.migrated) {
      try {
        fs.copyFileSync(this.path, `${this.path}.v${migrated.from}.bak`);
      } catch {
        /* ignore */
      }
      this._save();
    }
  }

  _assertWritable() {
    if (this.readOnly) {
      const err = new Error("bench results store is read-only (file written by a newer Herd)");
      err.status = 409;
      throw err;
    }
  }

  _save() {
    this._assertWritable();
    const doc = {
      format: FILE_FORMAT,
      schema_version: SCHEMA_VERSION,
      results: [...this.byId.values()],
    };
    atomicWrite(this.path, JSON.stringify(doc, null, 2) + "\n", 0o644);
  }

  _enforceCap() {
    if (this.byId.size <= this.maxResults) return;
    const oldestFirst = [...this.byId.values()].sort(
      (a, b) => Date.parse(a.run.started_at) - Date.parse(b.run.started_at)
    );
    for (const r of oldestFirst.slice(0, this.byId.size - this.maxResults)) this.byId.delete(r.id);
  }

  get size() {
    return this.byId.size;
  }

  _put(record) {
    const { ok, errors } = validateResult(record);
    if (!ok) throw new BenchResultValidationError(errors);
    const prev = this.byId.get(record.id);
    const stored = prev ? { ...record, recorded_at: prev.recorded_at } : record;
    this.byId.set(record.id, stored);
    return { id: record.id, created: !prev };
  }

  /**
   * Insert or replace one record (by id). Throws BenchResultValidationError.
   * @param {any} record
   */
  upsert(record) {
    this._assertWritable();
    const res = this._put(record);
    this._enforceCap();
    this._save();
    return res;
  }

  /**
   * Insert or replace many records with one write. Invalid ones are
   * reported, not thrown.
   * @param {any[]} records
   * @param {{ skipExisting?: boolean }} [opts]
   */
  upsertMany(records, opts = {}) {
    this._assertWritable();
    const out = { added: 0, updated: 0, skipped: 0, rejected: /** @type {any[]} */ ([]) };
    for (const rec of records) {
      if (opts.skipExisting && rec && this.byId.has(rec.id)) {
        out.skipped++;
        continue;
      }
      try {
        const { created } = this._put(rec);
        if (created) out.added++;
        else out.updated++;
      } catch (err) {
        out.rejected.push({ id: rec?.id ?? null, errors: err.errors || [err.message] });
      }
    }
    if (out.added || out.updated) {
      this._enforceCap();
      this._save();
    }
    return out;
  }

  /** @param {string} id */
  get(id) {
    return this.byId.get(id) || null;
  }

  /**
   * Remove one record, or all records of a run.
   * @param {{ id?: string, runId?: string }} sel
   */
  remove(sel) {
    let removed = 0;
    for (const r of [...this.byId.values()]) {
      if ((sel.id && r.id === sel.id) || (sel.runId && r.run.run_id === sel.runId)) {
        this.byId.delete(r.id);
        removed++;
      }
    }
    if (removed) this._save();
    return removed;
  }

  /**
   * Filtered listing, newest run first.
   * @param {Record<string, any>} [filter]
   * @returns {{ total: number, results: any[], errors?: string[] }}
   */
  list(filter = {}) {
    const errors = [];
    const since = toTime(filter.since);
    const until = toTime(filter.until);
    if (filter.since && since === null) errors.push("since must be an ISO date or epoch ms");
    if (filter.until && until === null) errors.push("until must be an ISO date or epoch ms");
    const concurrency = intOrNull(filter.concurrency);
    const contextTokens = intOrNull(filter.context_tokens);
    if (Number.isNaN(concurrency)) errors.push("concurrency must be an integer");
    if (Number.isNaN(contextTokens)) errors.push("context_tokens must be an integer");
    let likeKey = null;
    if (filter.like) {
      const ref = this.get(String(filter.like));
      if (!ref) errors.push(`like: no result ${filter.like}`);
      else likeKey = comparabilityKey(ref);
    }
    const limitRaw = filter.limit === undefined || filter.limit === "" ? 100 : Number(filter.limit);
    const offsetRaw = filter.offset === undefined || filter.offset === "" ? 0 : Number(filter.offset);
    if (!Number.isInteger(limitRaw) || limitRaw < 1) errors.push("limit must be a positive integer");
    if (!Number.isInteger(offsetRaw) || offsetRaw < 0) errors.push("offset must be a non-negative integer");
    if (errors.length) return { total: 0, results: [], errors };

    const eq = (want, have) => want === undefined || want === null || want === "" || String(want) === String(have);
    const matches = [...this.byId.values()].filter((r) => {
      if (!eq(filter.run_id, r.run.run_id)) return false;
      if (!eq(filter.bench, r.run.bench)) return false;
      if (!eq(filter.suite, r.run.suite)) return false;
      if (!eq(filter.origin, r.run.origin)) return false;
      if (!eq(filter.node_id, r.host.node_id)) return false;
      if (!eq(filter.hw_bucket, r.host.hw_bucket)) return false;
      if (!eq(filter.model_id, r.lane.model_id)) return false;
      if (!eq(filter.engine, r.lane.engine)) return false;
      if (!eq(filter.quant, r.lane.quant)) return false;
      if (concurrency !== null && r.conditions.concurrency !== concurrency) return false;
      if (contextTokens !== null && r.conditions.context_tokens !== contextTokens) return false;
      if (filter.metric && !r.metrics.some((m) => m.valid && m.metric === filter.metric)) return false;
      if (filter.definition && !r.metrics.some((m) => m.valid && m.definition === filter.definition)) return false;
      const t = Date.parse(r.run.started_at);
      if (since !== null && t < since) return false;
      if (until !== null && t > until) return false;
      if (likeKey !== null && comparabilityKey(r) !== likeKey) return false;
      return true;
    });
    matches.sort(
      (a, b) =>
        Date.parse(b.run.started_at) - Date.parse(a.run.started_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    const limit = Math.min(limitRaw, MAX_LIST_LIMIT);
    return { total: matches.length, results: matches.slice(offsetRaw, offsetRaw + limit) };
  }

  /**
   * Like-with-like comparison of two stored results.
   * @param {string} baselineId
   * @param {string} candidateId
   */
  compare(baselineId, candidateId) {
    const baseline = this.get(baselineId);
    const candidate = this.get(candidateId);
    if (!baseline || !candidate) {
      const err = new Error(`unknown result id: ${!baseline ? baselineId : candidateId}`);
      err.status = 404;
      throw err;
    }
    return { baseline: baseline.id, candidate: candidate.id, ...compareResults(baseline, candidate) };
  }

  /**
   * One-time, idempotent import of the legacy per-bench history files.
   * Records already in the store (same id) are left untouched.
   * @param {{ decode?: string, prefill?: string, showcase?: string }} paths
   */
  importLegacyHistories(paths) {
    const summary = {};
    const sources = [
      ["DecodeBench", paths.decode],
      ["PrefillBench", paths.prefill],
      ["Showcase", paths.showcase],
    ];
    for (const [bench, file] of sources) {
      if (!file || !fs.existsSync(file)) {
        summary[bench] = { file: file || null, found: false };
        continue;
      }
      let data;
      try {
        data = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (err) {
        summary[bench] = { file, found: true, error: err.message };
        continue;
      }
      const records = fromLegacyHistory(bench, data, path.basename(file));
      summary[bench] = { file, found: true, ...this.upsertMany(records, { skipExisting: true }) };
    }
    return summary;
  }
}
