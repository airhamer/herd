import fs from "node:fs";
import path from "node:path";
import { MonthlyEnergyArchive } from "./FleetEnergyMonthly.js";
import { randomUUID } from "node:crypto";
import { gb10Watts, MAX_HOST_WATTS } from "./powerModel.js";

const FILE_VERSION = 1;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const RETENTION_MS = 31 * DAY_MS;
const MAX_COMPLETED_BUCKETS = 44_640;
const MAX_GAP_MS = 10_000;
const CURRENT_WINDOW_MS = 30_000;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const MAX_RECENT_SAMPLES = 10_000;
// Per-host plausibility bounds for stored minutes. Hosts are no longer all
// GB10 boxes (issue #33), so the ceiling is the generic per-host one and there
// is no floor: an idle baseline can legitimately be configured down to 0 W.
const MAX_NODE_WATTS = MAX_HOST_WATTS;
const MAX_NODE_WH_PER_MINUTE = MAX_NODE_WATTS / 60;
const PERSISTENCE_RELATIVE_TOLERANCE = 1e-9;
const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set(["EINVAL", "ENOTSUP", "EISDIR", "EBADF"]);

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

// Minute buckets intentionally include the bucket crossing a rolling window's
// exact leading edge, limiting approximation error to less than one minute.
function alignedWindowCutoff(atMs, windowMs) {
  return Math.floor((atMs - windowMs) / MINUTE_MS) * MINUTE_MS;
}

function normalizeNodeIds(nodeIds) {
  if (!Array.isArray(nodeIds)) return [];
  return [...new Set(nodeIds.filter((id) => typeof id === "string" && id.trim() !== ""))];
}

function nodeValues(nodeIds, value, fallback = 0) {
  return Object.fromEntries(nodeIds.map((id) => [id, value?.[id] ?? fallback]));
}

function emptyBucket(minuteStartMs, nodeIds) {
  return {
    minuteStartMs,
    nodeWh: nodeValues(nodeIds),
    nodeCoverageMs: nodeValues(nodeIds),
    fleetWattMs: 0,
    fleetCoverageMs: 0,
    outputTokens: 0,
    coveredOutputTokens: 0,
  };
}

function validNonnegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function validNonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validAccountingHighWater(value) {
  return validNonnegative(value) && value <= Number.MAX_SAFE_INTEGER;
}

function exceedsWithFloatingTolerance(value, maximum) {
  const tolerance = PERSISTENCE_RELATIVE_TOLERANCE * Math.max(1, Math.abs(maximum));
  return value > maximum + tolerance;
}

function unaccountedInterval(previous, current, highWaterMs) {
  if (highWaterMs === null) return { previous, current };
  if (current.atMs <= highWaterMs) return null;
  if (previous.atMs >= highWaterMs) return { previous, current };

  const fraction = (highWaterMs - previous.atMs) / (current.atMs - previous.atMs);
  return {
    previous: {
      atMs: highWaterMs,
      watts: previous.watts + (current.watts - previous.watts) * fraction,
    },
    current,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The unit ids a stored bucket carries: every id in scope, plus ids of units
 * that left the fleet while their minutes were still inside the window.
 * null when the two per-unit maps disagree or a scoped id is missing.
 */
function storedBucketIds(stored, nodeIds) {
  if (!isPlainObject(stored?.nodeWh) || !isPlainObject(stored?.nodeCoverageMs)) return null;
  const whKeys = Object.keys(stored.nodeWh);
  const coverageKeys = new Set(Object.keys(stored.nodeCoverageMs));
  if (whKeys.length !== coverageKeys.size || whKeys.some((key) => !coverageKeys.has(key))) return null;
  const keySet = new Set(whKeys);
  if (nodeIds.some((id) => !keySet.has(id))) return null;
  return whKeys;
}

function tokenObservation(snapshots, atMs, nodeIdSet) {
  const heads = snapshots.filter(
    (snapshot) => nodeIdSet.has(snapshot?.id) && snapshot?.role === "head"
  );
  if (heads.length !== 1) return null;

  const head = heads[0];
  const entries = head?.metrics?.llm;
  const ports = head?.llmPorts;
  if (!Array.isArray(entries) || !Array.isArray(ports) || entries.length !== ports.length) {
    return null;
  }
  const availableIndexes = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index]?.available === true) availableIndexes.push(index);
  }
  if (availableIndexes.length !== 1) return null;
  const index = availableIndexes[0];
  const entry = entries[index];
  const port = ports[index];
  if (
    !validNonnegativeSafeInteger(port) ||
    !validNonnegativeSafeInteger(entry.totalOutputTokens)
  ) {
    return null;
  }
  return {
    headId: head.id,
    port,
    totalOutputTokens: entry.totalOutputTokens,
    observedAtMs: atMs,
  };
}

function sameTokenSource(left, right) {
  return (
    left?.headId === right?.headId &&
    left?.port === right?.port
  );
}

function writeStateAtomically(filePath, contents, fileSystem) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let temporaryFd = null;
  let directoryFd = null;
  let renamed = false;

  fileSystem.mkdirSync(directory, { recursive: true });
  try {
    temporaryFd = fileSystem.openSync(temporaryPath, "wx", 0o600);
    fileSystem.writeFileSync(temporaryFd, contents, { encoding: "utf8" });
    fileSystem.fchmodSync(temporaryFd, 0o600);
    fileSystem.fsyncSync(temporaryFd);
    fileSystem.closeSync(temporaryFd);
    temporaryFd = null;

    fileSystem.renameSync(temporaryPath, filePath);
    renamed = true;
    fileSystem.chmodSync(filePath, 0o600);
    const finalMode = fileSystem.statSync(filePath).mode & 0o777;
    if (finalMode !== 0o600) {
      throw new Error(`Failed to secure ${filePath}: expected mode 0600, got 0${finalMode.toString(8)}`);
    }

    try {
      directoryFd = fileSystem.openSync(directory, "r");
      fileSystem.fsyncSync(directoryFd);
    } catch (error) {
      if (!UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(error?.code)) throw error;
    } finally {
      if (directoryFd !== null) fileSystem.closeSync(directoryFd);
    }
  } catch (error) {
    if (temporaryFd !== null) {
      try {
        fileSystem.closeSync(temporaryFd);
      } catch {
        // Preserve the original persistence error.
      }
    }
    if (!renamed) {
      try {
        fileSystem.unlinkSync(temporaryPath);
      } catch {
        // The temp may not have been created; never remove the prior target.
      }
    }
    throw error;
  }
}

/**
 * Estimate a node's whole-system draw from raw GPU and CPU telemetry.
 *
 * Callers must explicitly mark combined GPU/CPU telemetry fresh. Liveness alone
 * is insufficient because SparkMonitor can retain stale domain values.
 */
export function estimateNodeWatts(snapshot) {
  if (snapshot?.telemetryFresh !== true) return null;
  // Issue #33: inputs built by server/energy/inputs.js carry a per-host
  // estimate (GB10 formula, or measured GPU + CPU + idle baseline).
  if (Object.prototype.hasOwnProperty.call(snapshot, "power")) {
    const watts = snapshot.power?.watts;
    return validNonnegative(watts) ? clamp(watts, 0, MAX_NODE_WATTS) : null;
  }
  // Bare SparkMonitor snapshot: the GB10 whole-system formula.
  return gb10Watts(snapshot?.metrics?.gpu?.power?.draw, snapshot?.metrics?.cpu?.usage);
}

/**
 * Validate one bucket read back from a 31-day file against `nodeIds` (the node
 * set that file was written for). Returns a clean bucket, or null when any
 * figure is outside what real hardware could have produced. Shared by the
 * normal load and the monthly roll-up of a file from an earlier fleet scope.
 */
function plausibleStoredBucket(stored, minuteStartMs, scopeIds) {
  const ids = storedBucketIds(stored, scopeIds);
  if (!ids) return null;
  const fleetCeilingWatts = MAX_NODE_WATTS * Math.max(1, scopeIds.length);
  const bucket = emptyBucket(minuteStartMs, ids);
  for (const id of ids) {
    const nodeWh = stored?.nodeWh?.[id];
    const nodeCoverageMs = stored?.nodeCoverageMs?.[id];
    if (
      !validNonnegative(nodeWh) ||
      nodeWh > MAX_NODE_WH_PER_MINUTE ||
      !validNonnegative(nodeCoverageMs) ||
      nodeCoverageMs > MINUTE_MS ||
      exceedsWithFloatingTolerance(
        nodeWh,
        (MAX_NODE_WATTS * nodeCoverageMs) / 3_600_000
      )
    ) {
      return null;
    }
    bucket.nodeWh[id] = nodeWh;
    bucket.nodeCoverageMs[id] = nodeCoverageMs;
  }
  if (
    !validNonnegative(stored.fleetWattMs) ||
    stored.fleetWattMs > fleetCeilingWatts * MINUTE_MS ||
    !validNonnegative(stored.fleetCoverageMs) ||
    stored.fleetCoverageMs > MINUTE_MS ||
    exceedsWithFloatingTolerance(
      stored.fleetWattMs,
      fleetCeilingWatts * stored.fleetCoverageMs
    ) ||
    exceedsWithFloatingTolerance(
      stored.fleetWattMs,
      Object.values(bucket.nodeWh).reduce((sum, nodeWh) => sum + nodeWh, 0) *
        3_600_000
    ) ||
    // Full-fleet time cannot exceed any unit that reported in the minute. A
    // unit with no coverage at all may have joined the scope after the minute
    // was written, so it does not bound the old fleet (#33 live re-scope).
    exceedsWithFloatingTolerance(
      stored.fleetCoverageMs,
      Math.max(0, ...Object.values(bucket.nodeCoverageMs))
    ) ||
    Object.values(bucket.nodeCoverageMs).some(
      (coverageMs) =>
        coverageMs > 0 &&
        exceedsWithFloatingTolerance(stored.fleetCoverageMs, coverageMs)
    ) ||
    !validNonnegativeSafeInteger(stored.outputTokens) ||
    (stored.coveredOutputTokens != null &&
      !validNonnegativeSafeInteger(stored.coveredOutputTokens))
  ) {
    return null;
  }
  bucket.fleetWattMs = stored.fleetWattMs;
  bucket.fleetCoverageMs = stored.fleetCoverageMs;
  bucket.outputTokens = stored.outputTokens;
  bucket.coveredOutputTokens = stored.coveredOutputTokens ?? 0;
  return bucket;
}

export class FleetEnergyTracker {
  constructor({
    nodeIds = [],
    filePath = null,
    now = () => Date.now(),
    load = true,
    flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    fileSystem = fs,
    writeState = writeStateAtomically,
    monthlyFilePath = null,
    monthly = null,
  } = {}) {
    this.nodeIds = Object.freeze(normalizeNodeIds(nodeIds));
    this._nodeIdSet = new Set(this.nodeIds);
    this.filePath = filePath;
    this._now = typeof now === "function" ? now : () => Date.now();
    this._setInterval = setIntervalFn;
    this._clearInterval = clearIntervalFn;
    this._fs = fileSystem;
    this._writeState = writeState;
    this._buckets = new Map();
    this._bucketsOrdered = true;
    this._latestBucketStart = null;
    this._nodeBaselines = new Map();
    this._fleetBaseline = null;
    this._integrationHighWaterMs = null;
    this._tokenCounter = null;
    this._tokenNeedsRebase = false;
    /** Recent per-tick sums over the units that reported, for "current W". */
    this._recentSamples = [];
    this._latestFreshNodeCount = 0;
    this._latestRecordAt = null;
    this._currentNodeIds = [...this.nodeIds];
    this._dirty = false;
    // First minute in which output tokens were observed; persisted so the monthly
    // history pairs tokens only with energy from the period they were counted in.
    this._tokenEpochMs = null;
    this._archivedUpToMinute = null;
    this._flushTimer = null;

    // Long-run history (docs/specs/monthly-energy.md); memory-only without a path.
    this.monthly = monthly || new MonthlyEnergyArchive({ filePath: monthlyFilePath, now: this._now, fileSystem });

    if (load) this._load();
    // Back-fill from whatever the window already holds (first start after an upgrade).
    this._archiveFinishedMinutes(this._now());

    const requestedFlushMs = Number.isFinite(flushIntervalMs) && flushIntervalMs > 0
      ? flushIntervalMs
      : DEFAULT_FLUSH_INTERVAL_MS;
    this.flushIntervalMs = Math.min(requestedFlushMs, DEFAULT_FLUSH_INTERVAL_MS);
    if (this.filePath && typeof this._setInterval === "function") {
      this._flushTimer = this._setInterval(() => {
        try {
          this.flush();
        } catch (error) {
          console.error(`[FleetEnergyTracker] persist error: ${error.message}`);
        }
      }, this.flushIntervalMs);
      this._flushTimer?.unref?.();
    }
  }

  _time(atMs) {
    return atMs === undefined ? this._now() : atMs;
  }

  /**
   * Re-scope the tracker to the fleet's current units (issue #33: Sparks and
   * agent nodes come and go at runtime, so no restart is needed any more).
   * New units start at zero; units that left keep their minutes in the window
   * (they still count toward the 24 h / 31 d totals) until those age out.
   * Returns true when the scope changed.
   */
  setNodeIds(nextNodeIds) {
    const normalized = normalizeNodeIds(nextNodeIds);
    this._currentNodeIds = normalized;
    const unchanged =
      normalized.length === this.nodeIds.length &&
      normalized.every((id) => this._nodeIdSet.has(id));
    if (unchanged) return false;
    this.nodeIds = Object.freeze(normalized);
    this._nodeIdSet = new Set(normalized);
    for (const bucket of this._buckets.values()) {
      for (const id of normalized) {
        if (!(id in bucket.nodeWh)) {
          bucket.nodeWh[id] = 0;
          bucket.nodeCoverageMs[id] = 0;
        }
      }
    }
    for (const id of [...this._nodeBaselines.keys()]) {
      if (!this._nodeIdSet.has(id)) this._nodeBaselines.delete(id);
    }
    // A different unit set is a different full-fleet sum: no ramp across it.
    this._fleetBaseline = null;
    this._recentSamples = [];
    this._latestFreshNodeCount = 0;
    this._dirty = true;
    return true;
  }

  /** Kept for callers from before #33; membership changes no longer need a restart. */
  invalidateMembership(currentNodeIds) {
    this.setNodeIds(currentNodeIds);
    return false;
  }

  _bucket(minuteStartMs) {
    let bucket = this._buckets.get(minuteStartMs);
    if (!bucket) {
      bucket = emptyBucket(minuteStartMs, this.nodeIds);
      this._buckets.set(minuteStartMs, bucket);
      if (this._latestBucketStart !== null && minuteStartMs < this._latestBucketStart) {
        this._bucketsOrdered = false;
      }
      this._latestBucketStart = Math.max(this._latestBucketStart ?? minuteStartMs, minuteStartMs);
    }
    return bucket;
  }

  _splitInterval(startMs, endMs, startWatts, endWatts, addSegment) {
    const totalMs = endMs - startMs;
    let segmentStart = startMs;
    while (segmentStart < endMs) {
      const minuteStartMs = Math.floor(segmentStart / MINUTE_MS) * MINUTE_MS;
      const segmentEnd = Math.min(endMs, minuteStartMs + MINUTE_MS);
      const startFraction = (segmentStart - startMs) / totalMs;
      const endFraction = (segmentEnd - startMs) / totalMs;
      const segmentStartWatts = startWatts + (endWatts - startWatts) * startFraction;
      const segmentEndWatts = startWatts + (endWatts - startWatts) * endFraction;
      addSegment(
        this._bucket(minuteStartMs),
        segmentEnd - segmentStart,
        (segmentStartWatts + segmentEndWatts) / 2
      );
      segmentStart = segmentEnd;
    }
  }

  _integrateNode(id, previous, current) {
    this._splitInterval(
      previous.atMs,
      current.atMs,
      previous.watts,
      current.watts,
      (bucket, durationMs, averageWatts) => {
        bucket.nodeWh[id] += (averageWatts * durationMs) / 3_600_000;
        bucket.nodeCoverageMs[id] += durationMs;
      }
    );
  }

  _integrateFleet(previous, current) {
    this._splitInterval(
      previous.atMs,
      current.atMs,
      previous.watts,
      current.watts,
      (bucket, durationMs, averageWatts) => {
        bucket.fleetWattMs += averageWatts * durationMs;
        bucket.fleetCoverageMs += durationMs;
      }
    );
  }

  _recordTokens(snapshots, atMs, hasFullFleetInterval) {
    const observation = tokenObservation(snapshots, atMs, this._nodeIdSet);
    if (!observation) return;
    this._tokenEpochMs ??= atMs - (atMs % MINUTE_MS);

    const previous = this._tokenCounter;
    const gapMs = previous ? atMs - previous.observedAtMs : null;
    const rebase =
      !previous ||
      this._tokenNeedsRebase ||
      !sameTokenSource(previous, observation) ||
      observation.totalOutputTokens < previous.totalOutputTokens ||
      gapMs < 0 ||
      gapMs > MAX_GAP_MS;

    if (!rebase && observation.totalOutputTokens > previous.totalOutputTokens) {
      const delta = observation.totalOutputTokens - previous.totalOutputTokens;
      const minuteStartMs = Math.floor(atMs / MINUTE_MS) * MINUTE_MS;
      const bucket = this._bucket(minuteStartMs);
      const nextTotal = bucket.outputTokens + delta;
      if (Number.isSafeInteger(nextTotal)) bucket.outputTokens = nextTotal;
      if (hasFullFleetInterval) {
        const nextCovered = bucket.coveredOutputTokens + delta;
        if (Number.isSafeInteger(nextCovered)) bucket.coveredOutputTokens = nextCovered;
      }
    }
    this._tokenCounter = observation;
    this._tokenNeedsRebase = false;
    this._dirty = true;
  }

  _pruneRecentSamples(atMs) {
    const cutoff = atMs - CURRENT_WINDOW_MS;
    this._recentSamples = this._recentSamples.filter(
      (sample) => sample.atMs >= cutoff && sample.atMs <= atMs
    );
    if (this._recentSamples.length > MAX_RECENT_SAMPLES) {
      this._recentSamples = this._recentSamples.slice(-MAX_RECENT_SAMPLES);
    }
  }

  _pruneBuckets(atMs) {
    if (!this._bucketsOrdered) {
      this._buckets = new Map(
        [...this._buckets.entries()].sort(([left], [right]) => left - right)
      );
      this._bucketsOrdered = true;
      this._latestBucketStart = [...this._buckets.keys()].at(-1) ?? null;
    }
    const cutoff = alignedWindowCutoff(atMs, RETENTION_MS);
    let changed = false;
    for (const minuteStartMs of this._buckets.keys()) {
      if (minuteStartMs >= cutoff) break;
      this._buckets.delete(minuteStartMs);
      changed = true;
    }

    const maximum = MAX_COMPLETED_BUCKETS + 1;
    while (this._buckets.size > maximum) {
      const oldest = this._buckets.keys().next().value;
      this._buckets.delete(oldest);
      changed = true;
    }
    if (this._buckets.size === 0) this._latestBucketStart = null;
    if (changed) this._dirty = true;
  }

  _prune(atMs) {
    this._pruneRecentSamples(atMs);
    this._pruneBuckets(atMs);
  }

  record(snapshots, atMs = undefined) {
    const timestamp = this._time(atMs);
    if (!Array.isArray(snapshots) || !Number.isFinite(timestamp)) return false;
    if (this._latestRecordAt !== null && timestamp === this._latestRecordAt) return false;
    if (this._latestRecordAt !== null && timestamp < this._latestRecordAt) {
      this._tokenNeedsRebase = true;
      this._nodeBaselines.clear();
      this._fleetBaseline = null;
      this._recentSamples = [];
      this._latestFreshNodeCount = 0;
    }

    const byId = new Map();
    for (const snapshot of snapshots) {
      if (this._nodeIdSet.has(snapshot?.id)) byId.set(snapshot.id, snapshot);
    }

    const validNodes = new Map();
    const integrationHighWaterAtStart = this._integrationHighWaterMs;
    let integratedAtTimestamp = false;
    for (const id of this.nodeIds) {
      const watts = estimateNodeWatts(byId.get(id));
      if (watts === null) {
        this._nodeBaselines.delete(id);
        continue;
      }

      validNodes.set(id, watts);
      const previous = this._nodeBaselines.get(id);
      const gapMs = previous ? timestamp - previous.atMs : null;
      const interval =
        previous && gapMs > 0 && gapMs <= MAX_GAP_MS
          ? unaccountedInterval(
              previous,
              { atMs: timestamp, watts },
              integrationHighWaterAtStart
            )
          : null;
      if (interval) {
        this._integrateNode(id, interval.previous, interval.current);
        integratedAtTimestamp = true;
      }
      this._nodeBaselines.set(id, { atMs: timestamp, watts });
    }

    let hasFullFleetInterval = false;
    if (this.nodeIds.length > 0 && validNodes.size === this.nodeIds.length) {
      const fleetWatts = [...validNodes.values()].reduce((sum, watts) => sum + watts, 0);
      const previous = this._fleetBaseline;
      const gapMs = previous ? timestamp - previous.atMs : null;
      const interval =
        previous && gapMs > 0 && gapMs <= MAX_GAP_MS
          ? unaccountedInterval(
              previous,
              { atMs: timestamp, watts: fleetWatts },
              integrationHighWaterAtStart
            )
          : null;
      if (interval) {
        this._integrateFleet(interval.previous, interval.current);
        hasFullFleetInterval = true;
        integratedAtTimestamp = true;
      }
      this._fleetBaseline = { atMs: timestamp, watts: fleetWatts };
    } else {
      this._fleetBaseline = null;
    }
    if (validNodes.size > 0) {
      // "Current W" sums whichever units reported this tick; the card shows
      // how many that was. Only samples over the same unit set are averaged.
      this._recentSamples.push({
        atMs: timestamp,
        watts: [...validNodes.values()].reduce((sum, watts) => sum + watts, 0),
        units: [...validNodes.keys()].sort().join("\u0000"),
      });
    }

    if (integratedAtTimestamp && validAccountingHighWater(timestamp)) {
      this._integrationHighWaterMs = Math.max(
        this._integrationHighWaterMs ?? timestamp,
        timestamp
      );
    }

    this._recordTokens(snapshots, timestamp, hasFullFleetInterval);
    this._latestFreshNodeCount = validNodes.size;
    this._latestRecordAt = timestamp;
    this._dirty = true;
    this._prune(timestamp);
    this._archiveFinishedMinutes(timestamp);
    return true;
  }

  /**
   * Hand finished minutes to the monthly history. The archive itself decides
   * what is final and what it already has; this only avoids re-offering the
   * whole window more than once per wall-clock minute.
   */
  _archiveFinishedMinutes(atMs) {
    if (!this.monthly || !Number.isFinite(atMs)) return;
    // Minutes become final 10 s after they end, so key the check on that edge.
    const minute = Math.floor((atMs - 10_000) / MINUTE_MS);
    if (minute === this._archivedUpToMinute) return;
    this._archivedUpToMinute = minute;
    this.monthly.foldBuckets(this._buckets.values(), { nowMs: atMs, trackedSinceMs: this._tokenEpochMs });
  }

  /** GET /api/fleet-energy/monthly. Writing happens on the regular flush. */
  monthlySnapshot(atMs = undefined) {
    const at = this._time(atMs);
    const valid = Number.isFinite(at);
    if (valid) this._archiveFinishedMinutes(at);
    return this.monthly.snapshot(valid ? at : 0);
  }

  /** Delete archived months: `{ month: "YYYY-MM" }` or `{ all: true }`. Never touches the 31-day window. */
  clearMonthly(options) {
    return this.monthly.clear(options);
  }

  _window(atMs, windowMs) {
    const cutoff = alignedWindowCutoff(atMs, windowMs);
    const nodeWh = nodeValues(this.nodeIds);
    const nodeCoverageMs = nodeValues(this.nodeIds);
    let formerUnitsWh = 0;
    let fleetCoverageMs = 0;
    let fleetWattMs = 0;
    let outputTokens = 0;
    let coveredOutputTokens = 0;

    for (const bucket of this._buckets.values()) {
      if (bucket.minuteStartMs < cutoff || bucket.minuteStartMs > atMs) continue;
      for (const [id, wh] of Object.entries(bucket.nodeWh)) {
        if (this._nodeIdSet.has(id)) {
          nodeWh[id] += wh;
          nodeCoverageMs[id] += bucket.nodeCoverageMs[id];
        } else {
          // A unit that has since left the fleet still used this energy.
          formerUnitsWh += wh;
        }
      }
      fleetCoverageMs += bucket.fleetCoverageMs;
      fleetWattMs += bucket.fleetWattMs;
      outputTokens += bucket.outputTokens;
      coveredOutputTokens += bucket.coveredOutputTokens;
    }

    const energyWh =
      Object.values(nodeWh).reduce((sum, value) => sum + value, 0) + formerUnitsWh;
    const hasObservedEnergy =
      formerUnitsWh > 0 || Object.values(nodeCoverageMs).some((coverageMs) => coverageMs > 0);
    return {
      energyWh,
      hasObservedEnergy,
      nodeCoverageMs,
      fleetCoverageMs,
      fleetEnergyWh: fleetWattMs / 3_600_000,
      outputTokens,
      coveredOutputTokens,
    };
  }

  _hourly(atMs) {
    const graphEnd = Math.floor(atMs / MINUTE_MS) * MINUTE_MS;
    const graphStart = graphEnd - DAY_MS;
    // Per hour: each unit's mean draw over the time it reported, summed over
    // the units that reported at all. Units with gaps do not drag the bar
    // down; units that never reported in that hour are simply not in it.
    const hours = Array.from({ length: 24 }, () => new Map());
    for (const bucket of this._buckets.values()) {
      if (bucket.minuteStartMs < graphStart || bucket.minuteStartMs >= graphEnd) continue;
      const units = hours[Math.floor((bucket.minuteStartMs - graphStart) / HOUR_MS)];
      for (const [id, wh] of Object.entries(bucket.nodeWh)) {
        const coverageMs = bucket.nodeCoverageMs[id];
        if (!(coverageMs > 0)) continue;
        const unit = units.get(id) ?? { wh: 0, coverageMs: 0 };
        unit.wh += wh;
        unit.coverageMs += coverageMs;
        units.set(id, unit);
      }
    }

    return hours.map((units) => {
      if (units.size === 0) return null;
      let watts = 0;
      for (const { wh, coverageMs } of units.values()) watts += (wh * 3_600_000) / coverageMs;
      return watts;
    });
  }

  snapshot(atMs = undefined) {
    const timestamp = this._time(atMs);
    const safeTimestamp = Number.isFinite(timestamp)
      ? timestamp
      : Number.isFinite(this._latestRecordAt)
        ? this._latestRecordAt
        : 0;
    this._prune(safeTimestamp);
    const last24h = this._window(safeTimestamp, DAY_MS);
    const last31d = this._window(safeTimestamp, RETENTION_MS);
    const latestUnits = this._recentSamples.at(-1)?.units;
    const currentSamples = this._recentSamples.filter((sample) => sample.units === latestUnits);
    const sampleCount = currentSamples.length;
    const currentWatts30s = sampleCount > 0
      ? currentSamples.reduce((sum, sample) => sum + sample.watts, 0) / sampleCount
      : null;
    const latestRecordAgeMs =
      this._latestRecordAt === null ? null : safeTimestamp - this._latestRecordAt;
    const freshNodeCount =
      latestRecordAgeMs !== null && latestRecordAgeMs >= 0 && latestRecordAgeMs <= MAX_GAP_MS
        ? this._latestFreshNodeCount
        : 0;

    return {
      estimated: true,
      // Membership changes re-scope live since #33; both stay false.
      membershipChanged: false,
      restartRequired: false,
      trackedNodeIds: [...this.nodeIds],
      currentNodeIds: [...this._currentNodeIds],
      freshNodeCount,
      currentWatts30s: freshNodeCount > 0 ? currentWatts30s : null,
      energy24hKwh: last24h.hasObservedEnergy ? last24h.energyWh / 1000 : null,
      energy31dKwh: last31d.hasObservedEnergy ? last31d.energyWh / 1000 : null,
      whPerOutputToken24h:
        last24h.fleetEnergyWh > 0 && last24h.coveredOutputTokens > 0
          ? last24h.fleetEnergyWh / last24h.coveredOutputTokens
          : null,
      outputTokens24h: last24h.outputTokens,
      coverage24hMs: last24h.fleetCoverageMs,
      coverage31dMs: last31d.fleetCoverageMs,
      nodeCoverage24hMs: last24h.nodeCoverageMs,
      nodeCoverage31dMs: last31d.nodeCoverageMs,
      hourlyWatts24h: this._hourly(safeTimestamp),
    };
  }

  _load() {
    if (!this.filePath) return;
    try {
      const raw = JSON.parse(this._fs.readFileSync(this.filePath, "utf8"));
      const legacyNodeIds = !Object.prototype.hasOwnProperty.call(raw || {}, "nodeIds");
      if (raw?.version !== FILE_VERSION || !Array.isArray(raw.buckets)) return;
      const outOfScope =
        !legacyNodeIds &&
        (!Array.isArray(raw.nodeIds) ||
          raw.nodeIds.length !== this.nodeIds.length ||
          raw.nodeIds.some((id) => !this._nodeIdSet.has(id)));
      if (outOfScope) {
        // A different fleet wrote this file: archive what it holds, then move it aside.
        this._retireForeignScopeFile(raw);
        return;
      }

      const candidates = [...raw.buckets].sort(
        (left, right) => (left?.minuteStartMs ?? Infinity) - (right?.minuteStartMs ?? Infinity)
      );
      const seenMinuteStarts = new Set();
      let rejectedBucket = false;
      for (const candidate of candidates) {
        const minuteStartMs = candidate?.minuteStartMs;
        if (
          !validNonnegativeSafeInteger(minuteStartMs) ||
          minuteStartMs % MINUTE_MS !== 0 ||
          seenMinuteStarts.has(minuteStartMs)
        ) {
          rejectedBucket = true;
          continue;
        }
        seenMinuteStarts.add(minuteStartMs);
        const bucket = plausibleStoredBucket(candidate, minuteStartMs, this.nodeIds);
        if (!bucket) {
          rejectedBucket = true;
          continue;
        }
        this._buckets.set(minuteStartMs, bucket);
      }
      this._bucketsOrdered = true;
      this._latestBucketStart = [...this._buckets.keys()].at(-1) ?? null;

      let latestCoveredBucket = null;
      for (const bucket of this._buckets.values()) {
        const hasCoverage =
          bucket.fleetCoverageMs > 0 ||
          this.nodeIds.some((id) => bucket.nodeCoverageMs[id] > 0);
        if (hasCoverage) latestCoveredBucket = bucket;
      }
      const latestCoveredMinuteStart = latestCoveredBucket?.minuteStartMs ?? null;
      const creditedCoverageMs = latestCoveredBucket
        ? Math.max(
            latestCoveredBucket.fleetCoverageMs,
            ...Object.values(latestCoveredBucket.nodeCoverageMs)
          )
        : null;
      const hasPersistedHighWater = Object.prototype.hasOwnProperty.call(
        raw,
        "integrationHighWaterMs"
      );
      const persistedHighWater = raw.integrationHighWaterMs;
      const validPersistedHighWater =
        latestCoveredMinuteStart !== null &&
        validNonnegativeSafeInteger(persistedHighWater) &&
        persistedHighWater >= latestCoveredMinuteStart + creditedCoverageMs &&
        persistedHighWater <= latestCoveredMinuteStart + MINUTE_MS;
      let repairedHighWater = false;
      if (validPersistedHighWater) {
        this._integrationHighWaterMs = persistedHighWater;
      } else if (latestCoveredMinuteStart !== null) {
        this._integrationHighWaterMs = Math.min(
          latestCoveredMinuteStart + MINUTE_MS,
          Number.MAX_SAFE_INTEGER
        );
        repairedHighWater = true;
      } else {
        this._integrationHighWaterMs = null;
        repairedHighWater = hasPersistedHighWater && persistedHighWater !== null;
      }

      const tokenCounter = raw.tokenCounter;
      if (
        this._nodeIdSet.has(tokenCounter?.headId) &&
        validNonnegativeSafeInteger(tokenCounter?.port) &&
        validNonnegativeSafeInteger(tokenCounter?.totalOutputTokens) &&
        Number.isFinite(tokenCounter?.observedAtMs)
      ) {
        this._tokenCounter = {
          headId: tokenCounter.headId,
          port: tokenCounter.port,
          totalOutputTokens: tokenCounter.totalOutputTokens,
          observedAtMs: tokenCounter.observedAtMs,
        };
        this._tokenNeedsRebase = true;
      }
      if (validNonnegativeSafeInteger(raw.tokensTrackedSinceMs)) this._tokenEpochMs = raw.tokensTrackedSinceMs;
      this._dirty = legacyNodeIds || rejectedBucket || repairedHighWater;
      const now = this._now();
      if (Number.isFinite(now)) this._prune(now);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      console.warn(`[FleetEnergyTracker] unable to load ${this.filePath}: ${error.message}`);
    }
  }

  /**
   * The 31-day file on disk was written for another node set. Its minutes are
   * checked against that file's own node list (same rules as a normal load),
   * the believable ones go into the monthly history, and the file is renamed
   * to `<name>.scope-<savedAt><ext>` so it never re-enters this window.
   */
  _retireForeignScopeFile(raw) {
    if (!this.filePath) return;
    const fileNodeIds = normalizeNodeIds(raw?.nodeIds);
    const accepted = new Map();
    if (fileNodeIds.length > 0 && Array.isArray(raw?.buckets)) {
      for (const candidate of raw.buckets) {
        const start = candidate?.minuteStartMs;
        if (!validNonnegativeSafeInteger(start) || start % MINUTE_MS !== 0 || accepted.has(start)) continue;
        const clean = plausibleStoredBucket(candidate, start, fileNodeIds);
        // The first copy of a minute decides, believable or not.
        accepted.set(start, clean);
      }
    }
    try {
      const believable = [...accepted.values()].filter(Boolean);
      const epoch = validNonnegativeSafeInteger(raw?.tokensTrackedSinceMs) ? raw.tokensTrackedSinceMs : null;
      this.monthly?.foldBuckets(believable, { nowMs: this._now(), trackedSinceMs: epoch });
      this.monthly?.flush();
    } catch (error) {
      console.warn(`[FleetEnergyTracker] monthly roll-up of ${this.filePath} failed: ${error.message}`);
    }
    const { dir, name, ext } = path.parse(this.filePath);
    const savedAt = validNonnegativeSafeInteger(raw?.savedAt) ? raw.savedAt : Math.floor(this._now());
    const retiredPath = path.join(dir, `${name}.scope-${savedAt}${ext}`);
    try {
      if (!this._fs.existsSync(retiredPath)) this._fs.renameSync(this.filePath, retiredPath);
    } catch (error) {
      console.warn(`[FleetEnergyTracker] could not move ${this.filePath} aside: ${error.message}`);
    }
  }

  flush() {
    try {
      this._archiveFinishedMinutes(this._now());
      this.monthly?.flush();
    } catch (error) {
      console.error(`[FleetEnergyTracker] monthly history not saved: ${error.message}`);
    }
    if (!this.filePath || !this._dirty) return false;
    const now = this._now();
    if (Number.isFinite(now)) this._prune(now);
    const buckets = [...this._buckets.values()].sort(
      (left, right) => left.minuteStartMs - right.minuteStartMs
    );
    const state = {
      version: FILE_VERSION,
      nodeIds: this.nodeIds,
      savedAt: now,
      integrationHighWaterMs:
        this._integrationHighWaterMs === null
          ? null
          : Math.ceil(this._integrationHighWaterMs),
      tokensTrackedSinceMs: this._tokenEpochMs,
      tokenCounter: this._tokenCounter,
      buckets,
    };
    this._writeState(this.filePath, `${JSON.stringify(state)}\n`, this._fs);
    this._dirty = false;
    return true;
  }

  close() {
    if (this._flushTimer !== null) {
      this._clearInterval?.(this._flushTimer);
      this._flushTimer = null;
    }
    return this.flush();
  }
}

export default FleetEnergyTracker;
