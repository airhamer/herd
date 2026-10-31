/**
 * Permanent monthly energy history.
 *
 * The 31-day tracker window is pruned and is set aside when fleet membership
 * changes; this archive keeps a compact per-UTC-month total of every finished
 * minute so long-run figures survive both. Clean-room implementation written
 * from docs/specs/monthly-energy.md (herd LIC1).
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../util/atomicWrite.js";

const ARCHIVE_VERSION = 1;
const ONE_MINUTE = 60_000;
const ONE_DAY = 86_400_000;
/** A minute is only final once it ended this long ago (late samples may still land). */
const SETTLE_MS = 10_000;
const WATT_MS_PER_WH = 3_600_000;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isAmount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const amountOr0 = (v) => (isAmount(v) ? v : 0);

/** "YYYY-MM" of the UTC month containing `ms`. */
export function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** [start, end) of a "YYYY-MM" UTC month, or null when the key is malformed. */
export function monthRange(key) {
  const m = typeof key === "string" ? MONTH_PATTERN.exec(key) : null;
  if (!m) return null;
  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  return [Date.UTC(year, monthIndex, 1), Date.UTC(year, monthIndex + 1, 1)];
}

function blankMonth() {
  return { nodes: {}, fleetWh: 0, fleetCoverageMs: 0, outputTokens: 0, coveredOutputTokens: 0, tokenFleetWh: 0 };
}

/** Rebuild one stored month, keeping only well-formed numbers. */
function reviveMonth(stored) {
  const month = blankMonth();
  if (!stored || typeof stored !== "object") return month;
  for (const [id, node] of Object.entries(stored.nodes ?? {})) {
    if (!id || !node || typeof node !== "object") continue;
    month.nodes[id] = { wh: amountOr0(node.wh), coverageMs: amountOr0(node.coverageMs) };
  }
  month.fleetWh = amountOr0(stored.fleetWh);
  month.fleetCoverageMs = amountOr0(stored.fleetCoverageMs);
  month.outputTokens = amountOr0(stored.outputTokens);
  month.coveredOutputTokens = amountOr0(stored.coveredOutputTokens);
  month.tokenFleetWh = amountOr0(stored.tokenFleetWh);
  return month;
}

/** Node ids with a usable reading in this bucket (an empty list means "nothing measured"). */
function measuredNodes(bucket) {
  const wh = bucket?.nodeWh;
  if (!wh || typeof wh !== "object") return [];
  return Object.keys(wh).filter((id) => isAmount(wh[id]));
}

export class MonthlyEnergyArchive {
  constructor({ filePath = null, now = () => Date.now(), fileSystem = fs } = {}) {
    this.filePath = filePath;
    this._clock = typeof now === "function" ? now : () => Date.now();
    this._fs = fileSystem;
    /** @type {Map<string, ReturnType<typeof blankMonth>>} */
    this._byMonth = new Map();
    /** Minutes starting before this instant are already in the totals. */
    this.foldedThroughMs = 0;
    this._changed = false;
    this._readFile();
  }

  _readFile() {
    if (!this.filePath) return;
    let text;
    try {
      text = this._fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") console.warn(`[MonthlyEnergy] cannot read ${this.filePath}: ${error.message}`);
      return;
    }
    let doc = null;
    try {
      doc = JSON.parse(text);
    } catch {
      doc = null;
    }
    if (!doc || doc.version !== ARCHIVE_VERSION || typeof doc.months !== "object" || doc.months === null) {
      this._setAside();
      return;
    }
    for (const [key, stored] of Object.entries(doc.months)) {
      if (monthRange(key)) this._byMonth.set(key, reviveMonth(stored));
    }
    if (isCount(doc.foldedThroughMs)) this.foldedThroughMs = doc.foldedThroughMs;
    // A watermark written while the clock ran far ahead would hide real minutes forever.
    const current = this._clock();
    if (Number.isFinite(current) && this.foldedThroughMs > current + ONE_DAY) {
      this.foldedThroughMs = Math.floor(current / ONE_MINUTE) * ONE_MINUTE;
      this._changed = true;
    }
  }

  /** Keep an unparseable file for inspection instead of overwriting it. */
  _setAside() {
    const { dir, name, ext } = path.parse(this.filePath);
    const target = path.join(dir, `${name}.unreadable-${Math.floor(this._clock())}${ext || ".json"}`);
    try {
      this._fs.renameSync(this.filePath, target);
      console.warn(`[MonthlyEnergy] ${this.filePath} was unreadable; kept as ${target}`);
    } catch (error) {
      console.warn(`[MonthlyEnergy] ${this.filePath} is unreadable and could not be moved: ${error.message}`);
    }
  }

  _monthFor(key) {
    let month = this._byMonth.get(key);
    if (!month) {
      month = blankMonth();
      this._byMonth.set(key, month);
    }
    return month;
  }

  /**
   * Add every finished, not-yet-counted minute. Returns how many minutes were added.
   * `trackedSinceMs` marks when output tokens started being counted; only fleet
   * energy from then on is paired with tokens for the Wh/token figure.
   */
  foldBuckets(buckets, { nowMs = this._clock(), trackedSinceMs = null } = {}) {
    const ceiling = Math.min(nowMs - SETTLE_MS, this._clock() + ONE_DAY);
    const ready = [];
    for (const bucket of buckets ?? []) {
      const start = bucket?.minuteStartMs;
      if (!isCount(start) || start < this.foldedThroughMs) continue;
      if (start + ONE_MINUTE > ceiling) continue;
      ready.push(bucket);
    }
    ready.sort((a, b) => a.minuteStartMs - b.minuteStartMs);

    let added = 0;
    for (const bucket of ready) {
      const start = bucket.minuteStartMs;
      if (start < this.foldedThroughMs) continue; // duplicate minute in the input
      this.foldedThroughMs = start + ONE_MINUTE;
      this._changed = true;
      const nodeIds = measuredNodes(bucket);
      if (nodeIds.length === 0) continue;
      const month = this._monthFor(monthKey(start));
      for (const id of nodeIds) {
        const slot = (month.nodes[id] ??= { wh: 0, coverageMs: 0 });
        slot.wh += bucket.nodeWh[id];
        slot.coverageMs += amountOr0(bucket.nodeCoverageMs?.[id]);
      }
      const fleetWh = amountOr0(bucket.fleetWattMs) / WATT_MS_PER_WH;
      month.fleetWh += fleetWh;
      month.fleetCoverageMs += amountOr0(bucket.fleetCoverageMs);
      month.outputTokens += amountOr0(bucket.outputTokens);
      month.coveredOutputTokens += amountOr0(bucket.coveredOutputTokens);
      if (trackedSinceMs === null || trackedSinceMs === undefined || start >= trackedSinceMs) {
        month.tokenFleetWh += fleetWh;
      }
      added += 1;
    }
    return added;
  }

  /** The public document served by GET /api/fleet-energy/monthly. */
  snapshot(atMs = this._clock()) {
    const months = [...this._byMonth.keys()].sort().map((key) => {
      const data = this._byMonth.get(key);
      const [startMs, endMs] = monthRange(key);
      const nodeIds = Object.keys(data.nodes).sort();
      const nodes = {};
      let totalWh = 0;
      for (const id of nodeIds) {
        nodes[id] = { wh: data.nodes[id].wh, coverageMs: data.nodes[id].coverageMs };
        totalWh += data.nodes[id].wh;
      }
      return {
        month: key,
        startMs,
        endMs,
        closed: endMs <= atMs,
        nodeIds,
        nodes,
        totalWh,
        fleetWh: data.fleetWh,
        fleetCoverageMs: data.fleetCoverageMs,
        outputTokens: data.outputTokens,
        coveredOutputTokens: data.coveredOutputTokens,
        whPerOutputToken: data.coveredOutputTokens > 0 ? data.tokenFleetWh / data.coveredOutputTokens : null,
      };
    });
    return { estimated: true, generatedAt: atMs, foldedThroughMs: this.foldedThroughMs, months };
  }

  /** Remove one month (`{ month }`) or everything (`{ all: true }`). The watermark stays. */
  clear({ month, all } = {}) {
    let removed = 0;
    if (all === true) {
      removed = this._byMonth.size;
      this._byMonth.clear();
    } else if (typeof month === "string" && this._byMonth.delete(month)) {
      removed = 1;
    }
    if (removed > 0) {
      this._changed = true;
      this.flush();
    }
    return removed;
  }

  /** Persist when something changed. Returns true when a file was written. */
  flush() {
    if (!this.filePath || !this._changed) return false;
    const months = {};
    for (const key of [...this._byMonth.keys()].sort()) months[key] = this._byMonth.get(key);
    const doc = { version: ARCHIVE_VERSION, savedAt: this._clock(), foldedThroughMs: this.foldedThroughMs, months };
    atomicWrite(this.filePath, `${JSON.stringify(doc)}\n`, 0o600);
    this._changed = false;
    return true;
  }
}

export default MonthlyEnergyArchive;
