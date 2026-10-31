// Feeds UnitHistory from the live monitors and serves its two routes.
// LIC2 clean-room rewrite from docs/specs/unit-history.md §5.
import { collectionWasSuccessful } from "../collectors/SystemCollector.js";
import { deviceReadings } from "./UnitHistory.js";
import { extractSample } from "./historySample.js";
import { RANGE_NAMES, isRange } from "./historyTiers.js";

export const HISTORY_SAMPLE_INTERVAL_MS = 2_000;
export const MIN_STALE_WINDOW_MS = 15_000;
const DEFAULT_GPU_WINDOW_MS = 8 * 60 * 60_000;
const MIN_GPU_WINDOW_MS = 60_000;
const RANGE_ERROR = `range must be one of: ${RANGE_NAMES.join(", ")}`;

/** How old a domain's last good collection may be: 3 poll intervals, ≥ 15 s. */
export function staleWindowMs(monitor, domain) {
  const interval = monitor?.pollIntervalMs?.(domain);
  return Number.isFinite(interval) ? Math.max(MIN_STALE_WINDOW_MS, interval * 3) : MIN_STALE_WINDOW_MS;
}

/** `(domain) => boolean`: did this monitor collect real data recently enough? */
export function monitorFreshness(monitor, atMs) {
  return (domain) => {
    if (!monitor || !monitor.collectionOk(domain)) return false;
    const last = monitor.lastCollectedAt(domain);
    return Number.isFinite(last) && atMs - last <= staleWindowMs(monitor, domain);
  };
}

/** One GPU raw reading from a snapshot whose GPU collection succeeded. */
export function recordGpuSample(store, snap, atMs) {
  const gpu = snap?.metrics?.gpu;
  if (snap?.online !== true || !gpu || !collectionWasSuccessful(gpu)) return false;
  const off = gpu.metricAvailability ?? {};
  const draw = gpu.power?.draw;
  const limit = gpu.power?.limit;
  const powerPct =
    off.powerDraw !== false && off.powerLimit !== false && Number.isFinite(draw) && Number.isFinite(limit) && limit > 0
      ? Math.min(100, (draw / limit) * 100)
      : null;
  return store.record(
    snap.id,
    atMs,
    off.usage === false ? null : gpu.usage,
    off.temperature === false ? null : gpu.temperature,
    powerPct,
    deviceReadings(gpu.gpus)
  );
}

export function registerUnitHistoryRoutes(app, { store, hasUnit, isEnabled, now = Date.now }) {
  const notFound = (res) => res.status(404).json({ error: "Spark not found" });

  app.get("/api/sparks/:id/gpu-history", (req, res) => {
    if (!hasUnit(req.params.id)) return notFound(res);
    const asked = Number(req.query.windowMs) || DEFAULT_GPU_WINDOW_MS;
    const windowMs = Math.min(store.maxWindowMs, Math.max(MIN_GPU_WINDOW_MS, asked));
    res.json(store.window(req.params.id, windowMs, now()));
  });

  app.get("/api/sparks/:id/history", (req, res) => {
    if (!hasUnit(req.params.id)) return notFound(res);
    const range = req.query.range === undefined ? "1h" : req.query.range;
    if (!isRange(range)) return res.status(400).json({ error: RANGE_ERROR });
    if (!isEnabled()) return res.json({ enabled: false });
    res.json({ enabled: true, ...store.query(req.params.id, range, now()) });
  });
}

/**
 * Samples every unit every 2 s: the GPU raw series always, the bucketed
 * tiers only while `isEnabled()` (asked on every tick).
 */
export function createUnitHistoryRuntime({
  store,
  orderedSnapshots,
  monitors,
  isEnabled = () => false,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logError = (msg, err) => console.error(`[UnitHistory] ${msg}:`, err?.message ?? err),
}) {
  let timer = null;
  let stopped = false;

  function sample() {
    if (stopped) return;
    try {
      const at = now();
      const snaps = orderedSnapshots();
      for (const snap of snaps) {
        try {
          recordGpuSample(store, snap, at);
        } catch {
          /* one bad snapshot must not stop the others */
        }
      }
      if (!isEnabled()) return;
      const units = snaps.map((snap) => ({
        id: snap.id,
        llmPorts: snap.llmPorts,
        values: extractSample(snap, monitorFreshness(monitors.get(snap.id), at)),
      }));
      store.recordSample(units, at);
    } catch (err) {
      logError("sampling failed", err);
    }
  }

  function start() {
    if (stopped) return false;
    if (timer) return true;
    timer = setIntervalFn(sample, HISTORY_SAMPLE_INTERVAL_MS);
    timer?.unref?.();
    store.start();
    return true;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearIntervalFn(timer);
    timer = null;
    try {
      store.stop();
    } catch (err) {
      logError("final save failed", err);
    }
  }

  return { sample, start, stop };
}
