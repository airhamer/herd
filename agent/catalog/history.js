/**
 * history.js — SC4: proven-history storage and queries for stack categories.
 *
 * Build on SC2 (stacks-catalog.js): the stack data model stores definitions;
 * this module stores what actually happened — recorded runs of a stack
 * (category, TP size, actual boot vs. ETA, success, notes, timestamp).
 * Two consumers, same data:
 *
 * - Proven category (SC2 seam): a stack is `proven` when its history holds a
 *   successful run of that membership. stacks-catalog.js already keeps the
 *   proven verdict as history ("proven is history, not definition"); this is
 *   where that history lives. StackStore's `isProven` calc input comes from
 *   `hasProven(stackId)`.
 * - ETA refinement (SC5+): `recentProven()` returns the entries averages
 *   come from. Decision here: averages are deliberately NOT computed in this
 *   layer — storage and query only, per the SC4 method. A later slice
 *   (bootstrap/ETA calc) decides windowing and weighting; premature
 *   averaging here would bake in a policy the UI slice may reject.
 *
 * Storage: `agent/config/stack-history.json` (gitignored runtime file, like
 * stacks.json) holding `{ version: 1, entries: ProvenHistoryEntry[] }`
 * (shared/types.ts → ProvenHistoryFile). Append-only: `append` loads, adds,
 * and persists; nothing rewrites existing entries. Cap keeps the last N
 * (oldest dropped) — the file is a rolling operational log, not an archive.
 *
 * Fail-soft like stacks-catalog: a corrupt runtime file degrades to empty
 * with a reported error and never re-bootstraps or overwrites; a bad entry
 * is rejected at append time (validateHistoryEntry) so the file stays valid.
 *
 * Note: agent/catalog/stack-history.js is the earlier prototype of this idea
 * (keyed by component-set, no TP/boot fields, not wired anywhere). This
 * module supersedes it with the SC4 contract keyed by stack id; the
 * prototype stays untouched for reference (delete when nothing references
 * it — it currently has no importers).
 */

import fs from "fs";
import path from "path";

/** Runtime storage file (gitignored, like stacks.json). */
export const DEFAULT_HISTORY_PATH =
  process.env.STACK_HISTORY_PATH || "agent/config/stack-history.json";

/** Rolling cap on stored entries (oldest dropped on append). */
export const MAX_HISTORY_ENTRIES = 500;

/** File-format version. */
export const HISTORY_FILE_VERSION = 1;

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * Validate one ProvenHistoryEntry (shape: shared/types.ts).
 * @returns {string[]} human-readable errors; empty when valid.
 */
export function validateHistoryEntry(e) {
  const errors = [];
  if (!e || typeof e !== "object" || Array.isArray(e)) {
    return ["history entry must be an object"];
  }
  if (!isNonEmptyString(e.stackId)) {
    errors.push("entry.stackId must be a non-empty string");
  }
  if (!Array.isArray(e.componentNames) || e.componentNames.length === 0) {
    errors.push("entry.componentNames must be a non-empty array");
  } else if (e.componentNames.some((c) => !isNonEmptyString(c))) {
    errors.push("entry.componentNames must contain only non-empty strings");
  }
  if (!Number.isInteger(e.tpSize) || e.tpSize < 1) {
    errors.push(`entry.tpSize must be an integer >= 1 (got ${JSON.stringify(e.tpSize)})`);
  }
  if (!(e.actualBootMs === null || (Number.isInteger(e.actualBootMs) && e.actualBootMs >= 0))) {
    errors.push("entry.actualBootMs must be null or a non-negative integer");
  }
  if (!(e.etaMs === null || (Number.isInteger(e.etaMs) && e.etaMs >= 0))) {
    errors.push("entry.etaMs must be null or a non-negative integer");
  }
  if (typeof e.success !== "boolean") {
    errors.push("entry.success must be a boolean");
  }
  if (e.notes !== undefined && typeof e.notes !== "string") {
    errors.push("entry.notes must be a string when present");
  }
  if (!Number.isInteger(e.timestamp) || e.timestamp < 0) {
    errors.push("entry.timestamp must be a non-negative integer (ms epoch)");
  }
  return errors;
}

/**
 * Validate a whole history file: `{ version: 1, entries }`.
 * @returns {string[]} errors; empty when valid.
 */
export function validateHistoryFile(data) {
  const errors = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return ["history file must be an object"];
  }
  if (data.version !== HISTORY_FILE_VERSION) {
    errors.push(`history file version must be ${HISTORY_FILE_VERSION} (got ${JSON.stringify(data.version)})`);
  }
  if (!Array.isArray(data.entries)) {
    errors.push("history file entries must be an array");
    return errors;
  }
  const seen = new Set();
  data.entries.forEach((e, i) => {
    for (const err of validateHistoryEntry(e)) errors.push(`entries[${i}]: ${err}`);
    const key = e && `${e.stackId}|${e.timestamp}`;
    if (key && seen.has(key)) errors.push(`entries[${i}]: duplicate (stackId, timestamp)`);
    if (key) seen.add(key);
  });
  return errors;
}

/**
 * File-backed proven-history store. Append-only writes; queries answer from
 * the in-memory list loaded at load().
 */
export class HistoryStore {
  /**
   * @param {string} historyPath runtime file
   * @param {{ maxEntries?: number }} [opts] rolling cap override
   */
  constructor(historyPath = DEFAULT_HISTORY_PATH, opts = {}) {
    this.historyPath = historyPath;
    this.maxEntries =
      Number.isInteger(opts.maxEntries) && opts.maxEntries > 0
        ? opts.maxEntries
        : MAX_HISTORY_ENTRIES;
    this.entries = [];
    this.errors = [];
    this.writable = true;
  }

  /**
   * Load the file. Absent → empty (no bootstrap: history is observed, not
   * predefined). Corrupt → empty with a reported error (never overwrite).
   * Invalid individual entries are dropped with a reported error (fail-soft,
   * like StackStore.load). Returns this.
   */
  load() {
    this.errors = [];
    let data = null;
    try {
      if (fs.existsSync(this.historyPath)) {
        data = JSON.parse(fs.readFileSync(this.historyPath, "utf8"));
      } else {
        this.entries = [];
        return this;
      }
    } catch (e) {
      this.errors.push(`history file unreadable: ${e.message}`);
      this.entries = [];
      return this;
    }
    const fileErrs = validateHistoryFile(data);
    if (fileErrs.length && !Array.isArray(data?.entries)) {
      this.errors.push(...fileErrs);
      this.entries = [];
      return this;
    }
    this.errors.push(...fileErrs.filter((e) => !e.startsWith("entries[")));
    const good = [];
    const seen = new Set();
    for (const e of data.entries) {
      const errs = validateHistoryEntry(e);
      if (errs.length) {
        this.errors.push(`dropped entry "${e?.stackId ?? "<invalid>"}@${e?.timestamp}": ${errs.join("; ")}`);
        continue;
      }
      const key = `${e.stackId}|${e.timestamp}`;
      if (seen.has(key)) {
        this.errors.push(`dropped duplicate entry "${key}"`);
        continue;
      }
      seen.add(key);
      good.push(e);
    }
    this.entries = good;
    return this;
  }

  /**
   * Record one run. Validates (throws on invalid input — callers own their
   * data), appends, applies the rolling cap, persists.
   * @param {object} entry shared/types.ts → ProvenHistoryEntry
   * @returns {object} a copy of the stored entry
   */
  append(entry) {
    const errs = validateHistoryEntry(entry);
    if (errs.length) throw new Error(errs.join("; "));
    if (this.entries.some((e) => e.stackId === entry.stackId && e.timestamp === entry.timestamp)) {
      throw new Error(`duplicate history entry "${entry.stackId}|${entry.timestamp}"`);
    }
    this.entries.push({ ...entry });
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
    this.save();
    return { ...entry };
  }

  /**
   * One stack's history (shared/types.ts → CategoryHistory), append order.
   * @returns {{ stackId: string, entries: object[] }}
   */
  historyFor(stackId) {
    return {
      stackId,
      entries: this.entries.filter((e) => e.stackId === stackId).map((e) => ({ ...e })),
    };
  }

  /**
   * Histories for every stack that has entries (stackId in first-seen order).
   * @returns {Record<string, { stackId: string, entries: object[] }>} keyed by stackId
   */
  allHistories() {
    const out = {};
    for (const e of this.entries) {
      if (!out[e.stackId]) out[e.stackId] = { stackId: e.stackId, entries: [] };
      out[e.stackId].entries.push({ ...e });
    }
    return out;
  }

  /**
   * Proven verdict for a stack: at least one successful run of this
   * membership. This is the input for StackStore's proven override.
   */
  hasProven(stackId) {
    return this.entries.some((e) => e.stackId === stackId && e.success);
  }

  /**
   * Recent successful runs across all stacks, newest first — the rows SC5+
   * ETA averaging consumes. No averaging here (storage/query first, per
   * method; the averaging decision lives with the consumer).
   * @param {number} limit max rows
   * @returns {object[]} ProvenHistoryEntry copies
   */
  recentProven(limit = 20) {
    return this.entries
      .filter((e) => e.success)
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp || a.stackId.localeCompare(b.stackId))
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  /** All entries (shallow copies, append order). */
  list() {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Export the current file shape. */
  export() {
    return { version: HISTORY_FILE_VERSION, entries: this.list() };
  }

  save() {
    if (!this.writable) return;
    const dir = path.dirname(this.historyPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.historyPath, JSON.stringify(this.export(), null, 2) + "\n");
  }
}

export function createHistoryStore(historyPath, opts) {
  return new HistoryStore(historyPath, opts);
}

export default {
  DEFAULT_HISTORY_PATH,
  MAX_HISTORY_ENTRIES,
  HISTORY_FILE_VERSION,
  validateHistoryEntry,
  validateHistoryFile,
  HistoryStore,
  createHistoryStore,
};
