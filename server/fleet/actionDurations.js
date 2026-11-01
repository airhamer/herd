/**
 * actionDurations.js — SC5b (issue #73): real start/stop durations of
 * component actions, the ETA history the downtime preview reads, and the
 * in-memory list of actions running right now.
 *
 * Storage: config/component-durations.json (gitignored) holds
 * `{ version: 1, entries: [{ componentId, nodeId, type, ms, success, at }] }`.
 * The newest MAX_ENTRIES are kept. Failed runs are logged but never used for
 * ETAs (decision #5).
 *
 * ETA (decisions #1 and #4), per component and verb:
 * - With 5 or more successful runs, the median of the last 5 (source "history").
 * - Otherwise a flat bootstrap: start 120 s, stop 20 s, restart 140 s
 *   (source "estimate").
 *
 * Fail-soft like the other config stores: an unreadable file degrades to
 * empty history with a reported error, and a write failure only costs
 * persistence.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_DURATIONS_PATH =
  process.env.COMPONENT_DURATIONS_PATH || path.join(ROOT, "config", "component-durations.json");

export const MAX_ENTRIES = 1000;
/** Successful runs needed before history replaces the bootstrap estimate. */
export const HISTORY_MIN_RUNS = 5;
/** Decision #1: flat bootstrap ETAs, flagged "estimate". */
export const BOOTSTRAP_ETA_MS = { start: 120_000, stop: 20_000, restart: 140_000 };

const VERBS = new Set(["start", "stop", "restart"]);

/** Median of a non-empty number list. */
export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * ETA for one verb on one component from a list of entries.
 * @returns {{ ms: number, source: "history" | "estimate", runs: number }}
 *   `runs` = successful runs on record for this component and verb.
 */
export function etaFrom(entries, componentId, type) {
  const ok = entries.filter((e) => e.componentId === componentId && e.type === type && e.success === true);
  if (ok.length >= HISTORY_MIN_RUNS) {
    return { ms: median(ok.slice(-HISTORY_MIN_RUNS).map((e) => e.ms)), source: "history", runs: ok.length };
  }
  return { ms: BOOTSTRAP_ETA_MS[type] ?? BOOTSTRAP_ETA_MS.start, source: "estimate", runs: ok.length };
}

/**
 * @param {{ path?: string, now?: () => number }} [opts]
 */
export function createDurationStore(opts = {}) {
  const file = opts.path || DEFAULT_DURATIONS_PATH;
  const now = opts.now ?? (() => Date.now());
  const errors = [];
  let entries = [];
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      entries = Array.isArray(data?.entries) ? data.entries.filter(validEntry) : [];
    }
  } catch (err) {
    errors.push(`durations file unreadable: ${err.message}`);
  }
  /** key → { componentId, nodeId, type, startedAt, etaMs } */
  const running = new Map();

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2) + "\n");
      fs.renameSync(tmp, file);
    } catch (err) {
      errors.push(`durations file not writable: ${err.message}`);
    }
  }

  return {
    errors,
    /** Append one finished run. Returns the stored entry, or null when it is invalid. */
    record({ componentId, nodeId, type, ms, success }) {
      const e = { componentId, nodeId, type, ms: Math.max(0, Math.round(ms)), success: success === true, at: now() };
      if (!validEntry(e)) return null;
      entries.push(e);
      if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
      save();
      return e;
    },
    eta(componentId, type) {
      return etaFrom(entries, componentId, type);
    },
    list() {
      return entries.map((e) => ({ ...e }));
    },
    /** Mark an action as running (the live view). Returns its key. */
    begin({ componentId, nodeId, type }) {
      const startedAt = now();
      const key = `${nodeId}|${componentId}|${type}|${startedAt}|${running.size}`;
      running.set(key, { componentId, nodeId, type, startedAt, etaMs: etaFrom(entries, componentId, type).ms });
      return key;
    },
    /** Finish a running action and record its duration. */
    end(key, success) {
      const r = running.get(key);
      if (!r) return null;
      running.delete(key);
      return this.record({ ...r, ms: now() - r.startedAt, success });
    },
    /** Actions running right now, with elapsed time. */
    live() {
      const t = now();
      return [...running.values()].map((r) => ({ ...r, elapsedMs: t - r.startedAt }));
    },
  };
}

function validEntry(e) {
  return (
    e &&
    typeof e.componentId === "string" &&
    e.componentId !== "" &&
    typeof e.nodeId === "string" &&
    VERBS.has(e.type) &&
    Number.isFinite(e.ms) &&
    e.ms >= 0 &&
    typeof e.success === "boolean"
  );
}

export default { createDurationStore, etaFrom, median, BOOTSTRAP_ETA_MS, HISTORY_MIN_RUNS, DEFAULT_DURATIONS_PATH };
