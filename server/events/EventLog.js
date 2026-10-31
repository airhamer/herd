// Fleet event log: a bounded, newest-wins list of human-readable events
// (alert deliveries, node and service transitions, actions, benchmarks),
// kept in memory and mirrored to a JSON file. docs/specs/alerts.md §9 and
// issue #32. Clean-room implementation (LIC1, FLEET1).
import fs from "fs";
import { atomicWrite, quarantineCorrupt } from "../util/atomicWrite.js";

const DEFAULT_MAX = 200;
const KNOWN_SEVERITIES = ["info", "warn", "error", "success"];
/** The same event for the same unit again within this window is dropped. */
const REPEAT_WINDOW_MS = 5_000;
/** Writes are batched: at most one file write per this interval. */
const SAVE_DELAY_MS = 1_500;
/** Above this many remembered repeat keys, stale ones are swept. */
const REPEAT_KEYS_SWEEP_AT = 500;

const looksStored = (e) => e && Number.isInteger(e.id) && Number.isFinite(e.ts) && typeof e.message === "string";

export class EventLog {
  /**
   * @param {{ file?: string|null, max?: number, now?: () => number }} [options]
   *   `file` null keeps the log in memory only.
   */
  constructor({ file = null, max = DEFAULT_MAX, now = Date.now } = {}) {
    this.file = file;
    this.max = Math.max(1, Math.floor(max) || DEFAULT_MAX);
    this._now = now;
    /** Stored events, oldest at index 0. */
    this._items = [];
    this._idCounter = 1;
    this._listeners = new Set();
    this._saveTimer = null;
    this._unsaved = false;
    /** repeat key → when it was last accepted */
    this._seenAt = new Map();
    /** unit id ("" for none) → repeat key of the latest event accepted for it */
    this._latestKey = new Map();
    this._readFile();
  }

  _readFile() {
    if (!this.file) return;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (err) {
      if (err instanceof SyntaxError) quarantineCorrupt(this.file, "EventLog", err);
      return;
    }
    const kept = (Array.isArray(doc?.events) ? doc.events : []).filter(looksStored);
    this._items = kept.slice(Math.max(0, kept.length - this.max));
    let highest = 0;
    for (const e of kept) if (e.id > highest) highest = e.id;
    const savedNext = Number.isInteger(doc?.nextId) ? doc.nextId : 1;
    this._idCounter = Math.max(savedNext, highest + 1);
  }

  /** True when this event repeats the unit's latest one inside the window. */
  _isRepeat(repeatKey, unitKey, at) {
    if (this._latestKey.get(unitKey) !== repeatKey) return false;
    const previous = this._seenAt.get(repeatKey);
    return previous !== undefined && at >= previous && at - previous < REPEAT_WINDOW_MS;
  }

  _noteAccepted(repeatKey, unitKey, at) {
    this._seenAt.set(repeatKey, at);
    this._latestKey.set(unitKey, repeatKey);
    if (this._seenAt.size <= REPEAT_KEYS_SWEEP_AT) return;
    for (const [key, seen] of this._seenAt) {
      if (at - seen >= REPEAT_WINDOW_MS) this._seenAt.delete(key);
    }
  }

  /**
   * Add an event. Needs a string `type` and `message`; anything else, or a
   * quick repeat, returns null. Never throws.
   * @param {{ type: string, message: string, severity?: string, sparkId?: string|null, sparkName?: string|null, data?: unknown }} input
   */
  record(input) {
    if (!input || typeof input.type !== "string" || typeof input.message !== "string") return null;
    try {
      const at = this._now();
      const sparkId = input.sparkId ?? null;
      const unitKey = sparkId ?? "";
      const repeatKey = [input.type, unitKey, input.message].join("\u0000");
      if (this._isRepeat(repeatKey, unitKey, at)) return null;
      this._noteAccepted(repeatKey, unitKey, at);

      const event = {
        id: this._idCounter,
        ts: at,
        type: input.type,
        severity: KNOWN_SEVERITIES.includes(input.severity) ? input.severity : "info",
        sparkId,
        sparkName: input.sparkName ?? null,
        message: input.message,
      };
      this._idCounter += 1;
      if (input.data !== undefined) event.data = input.data;

      this._items.push(event);
      const overflow = this._items.length - this.max;
      if (overflow > 0) this._items.splice(0, overflow);
      this._queueSave();
      this._notify(event);
      return event;
    } catch (err) {
      console.error("[EventLog] record failed:", err?.message);
      return null;
    }
  }

  _notify(event) {
    for (const listener of [...this._listeners]) {
      try {
        listener(event);
      } catch {
        // a listener's failure is its own problem
      }
    }
  }

  /**
   * Newest first. `sparkId` narrows to one unit; `sinceId` / `beforeId` page
   * by id (exclusive); `limit` is clamped to 1…max (default 50).
   * `types` keeps events whose type equals an entry or starts with an entry
   * that ends in "." (so "gpu." matches every gpu.* type); `severities`
   * keeps only those severities. Empty arrays mean no filter.
   */
  list({ limit = 50, sparkId, sinceId, beforeId, types, severities } = {}) {
    const typeList = Array.isArray(types) && types.length > 0 ? types : null;
    const sevList = Array.isArray(severities) && severities.length > 0 ? severities : null;
    const typeMatches = (t) =>
      typeList.some((want) => (want.endsWith(".") ? t.startsWith(want) : t === want));
    const wanted = Math.min(this.max, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50));
    const out = [];
    for (let i = this._items.length - 1; i >= 0 && out.length < wanted; i -= 1) {
      const e = this._items[i];
      if (sparkId && e.sparkId !== sparkId) continue;
      if (Number.isFinite(sinceId) && e.id <= sinceId) continue;
      if (Number.isFinite(beforeId) && e.id >= beforeId) continue;
      if (typeList && !typeMatches(e.type)) continue;
      if (sevList && !sevList.includes(e.severity)) continue;
      out.push(e);
    }
    return out;
  }

  /**
   * Remove everything, or only events at least `olderThanMs` old. Ids are
   * never reused afterwards. Returns how many were removed.
   */
  clear({ olderThanMs } = {}) {
    try {
      const countBefore = this._items.length;
      if (Number.isFinite(olderThanMs) && olderThanMs > 0) {
        const keepFrom = this._now() - olderThanMs;
        this._items = this._items.filter((e) => e.ts >= keepFrom);
      } else {
        this._items = [];
      }
      const removed = countBefore - this._items.length;
      if (removed === 0) return 0;
      this._seenAt.clear();
      this._latestKey.clear();
      this._unsaved = true;
      this.flush();
      return removed;
    } catch (err) {
      console.error("[EventLog] clear failed:", err?.message);
      return 0;
    }
  }

  /** Id of the oldest event still held, or null. */
  oldestId() {
    return this._items[0]?.id ?? null;
  }

  /** Id of the newest event held, or null. */
  newestId() {
    return this._items[this._items.length - 1]?.id ?? null;
  }

  /** How many events are held. */
  size() {
    return this._items.length;
  }

  /** Call `fn(event)` for every new event; returns an unsubscribe function. */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _queueSave() {
    if (!this.file) return;
    this._unsaved = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this._saveTimer.unref?.();
  }

  /** Write now if anything changed (also used at shutdown). */
  flush() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (!this.file || !this._unsaved) return;
    try {
      atomicWrite(this.file, JSON.stringify({ nextId: this._idCounter, events: this._items }), 0o644);
      this._unsaved = false;
    } catch (err) {
      console.error("[EventLog] persist failed:", err?.message);
    }
  }
}

export default EventLog;
