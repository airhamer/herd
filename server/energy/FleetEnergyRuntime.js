import { monthRange } from "./FleetEnergyMonthly.js";

const MAX_POWER_TELEMETRY_AGE_MS = 10_000;
const ENERGY_SAMPLE_INTERVAL_MS = 2_000;

function hasFreshTimestamp(timestamp, atMs) {
  if (!Number.isFinite(timestamp) || !Number.isFinite(atMs)) return false;
  const ageMs = atMs - timestamp;
  return ageMs >= 0 && ageMs <= MAX_POWER_TELEMETRY_AGE_MS;
}

function isDefaultGpuResult(gpu) {
  return (
    gpu?.temperature === 0 &&
    gpu?.usage === 0 &&
    gpu?.power?.draw === 0 &&
    gpu?.vram?.total === 0
  );
}

function isDefaultCpuResult(cpu) {
  return (
    cpu?.usage === 0 &&
    cpu?.temperature === 0 &&
    cpu?.draw === 0 &&
    cpu?.tdp === 0
  );
}

function wasCollectionSuccessful(monitor, domain) {
  return monitor?._metricCollectionSuccessful?.[domain] === true;
}

/** Determine whether a normal SparkMonitor snapshot has current usable power telemetry. */
export function hasFreshPowerTelemetry(snapshot, monitor, atMs) {
  const gpu = snapshot?.metrics?.gpu;
  const cpu = snapshot?.metrics?.cpu;
  return (
    snapshot?.online === true &&
    wasCollectionSuccessful(monitor, "gpu") &&
    wasCollectionSuccessful(monitor, "cpu") &&
    hasFreshTimestamp(monitor?._lastUpdate?.gpu, atMs) &&
    hasFreshTimestamp(monitor?._lastUpdate?.cpu, atMs) &&
    !isDefaultGpuResult(gpu) &&
    !isDefaultCpuResult(cpu) &&
    Number.isFinite(gpu?.power?.draw) &&
    Number.isFinite(cpu?.usage)
  );
}

/**
 * Record one independent energy sample. Only the shallow clones passed to the
 * tracker receive telemetryFresh; normal REST and WebSocket snapshots remain unchanged.
 */
export function runFleetEnergySamplerTick({
  tracker,
  orderedSnapshots,
  monitors,
  now = Date.now,
}) {
  const atMs = now();
  const snapshots = orderedSnapshots();
  const trackerInputs = snapshots.map((snapshot) => ({
    ...snapshot,
    telemetryFresh: hasFreshPowerTelemetry(
      snapshot,
      monitors?.get?.(snapshot?.id),
      atMs
    ),
  }));
  return tracker.record(trackerInputs, atMs);
}

/** Build the read-only Express handler around the tracker's canonical contract. */
export function createFleetEnergyHandler(tracker) {
  return (_req, res) => res.json(tracker.snapshot());
}

const WIPE_CONFIRMATION = "delete-all-history";

/**
 * Decide what a DELETE on the monthly history asks for. Exactly one form is
 * accepted: `month=YYYY-MM`, or `all=true` with `confirm=delete-all-history`.
 * Returns `{ target }` or `{ problem }` (a 400 message).
 */
function monthlyDeleteRequest(query = {}) {
  const { month, all, confirm } = query;
  const wantsAll = all !== undefined;
  const wantsMonth = month !== undefined;
  if (wantsAll && !wantsMonth && all === "true") {
    return confirm === WIPE_CONFIRMATION
      ? { target: { all: true } }
      : { problem: `wiping the whole monthly history requires confirm=${WIPE_CONFIRMATION}` };
  }
  if (wantsMonth && !wantsAll && typeof month === "string" && monthRange(month) !== null) {
    return { target: { month } };
  }
  return { problem: `give month=YYYY-MM, or all=true&confirm=${WIPE_CONFIRMATION}` };
}

/**
 * Fleet-energy HTTP surface: the 31-day window is read-only; the monthly
 * history (docs/specs/monthly-energy.md) can be read and, explicitly, pruned.
 */
export function registerFleetEnergyRoute(app, tracker) {
  app.get("/api/fleet-energy/monthly", (_req, res) => {
    res.json(tracker.monthlySnapshot());
  });
  app.delete("/api/fleet-energy/monthly", (req, res) => {
    const { target, problem } = monthlyDeleteRequest(req.query ?? {});
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }
    res.json({ removed: tracker.clearMonthly(target) });
  });
  return app.get("/api/fleet-energy", createFleetEnergyHandler(tracker));
}

/** Preserve startup ordering without coupling the sampler to server or WS state. */
export function startFleetEnergyCollection({ startAllMonitors, energyRuntime }) {
  startAllMonitors();
  return energyRuntime.start();
}

/** Build the graceful server-close callback from the persistence outcome. */
export function createFleetEnergyExitHandler(
  energyPersistenceSucceeded,
  exit = process.exit
) {
  return () => exit(energyPersistenceSucceeded ? 0 : 1);
}

/** Own the independent sampling timer and the tracker's one-time close lifecycle. */
export function createFleetEnergyRuntime({
  tracker,
  orderedSnapshots,
  monitors,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logError = console.error,
}) {
  let started = false;
  let stopped = false;
  let timer = null;
  let stopResult = false;

  const reportError = (message, error) => {
    try {
      logError(message, error);
    } catch {
      // Logging must never prevent shutdown from continuing.
    }
  };

  const sample = () => {
    if (stopped) return;
    try {
      runFleetEnergySamplerTick({ tracker, orderedSnapshots, monitors, now });
    } catch (error) {
      reportError("fleet energy sample error", error);
    }
  };

  return {
    start() {
      if (started || stopped) return false;
      started = true;
      sample();
      timer = setIntervalFn(sample, ENERGY_SAMPLE_INTERVAL_MS);
      return true;
    },

    stop() {
      if (stopped) return stopResult;
      stopped = true;
      if (timer !== null) {
        try {
          clearIntervalFn(timer);
        } catch (error) {
          reportError("fleet energy timer shutdown error", error);
        }
        timer = null;
      }
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          tracker.close();
          stopResult = true;
          break;
        } catch (error) {
          reportError(`fleet energy shutdown error (attempt ${attempt}/2)`, error);
        }
      }
      return stopResult;
    },
  };
}
