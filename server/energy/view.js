/**
 * GET /api/fleet-energy response (issue #33): the tracker's canonical
 * snapshot plus the per-host table, coverage and cost the Fleet tab shows.
 */
import { normalizePrice, normalizeCurrency } from "./pricing.js";

export const ENERGY_LABEL = "estimated, not wall-metered";
const DAY_MS = 86_400_000;

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * @param {object} snapshot FleetEnergyTracker#snapshot()
 * @param {{ hosts?: object[], settings?: object }} context
 */
export function buildFleetEnergyView(snapshot, { hosts = [], settings = {} } = {}) {
  const counted = hosts.filter((host) => !host.duplicateOf);
  const reporting = counted.filter((host) => host.reporting);
  const totalWatts = reporting.reduce((sum, host) => sum + (host.watts ?? 0), 0);
  const measuredWatts = reporting.reduce((sum, host) => sum + (host.measuredWatts ?? 0), 0);

  const scopeIds = snapshot.trackedNodeIds ?? [];
  const coverage24h = scopeIds.length
    ? scopeIds.reduce(
        (sum, id) => sum + Math.min(1, (snapshot.nodeCoverage24hMs?.[id] ?? 0) / DAY_MS),
        0
      ) / scopeIds.length
    : 0;

  const pricePerKwh = normalizePrice(settings.electricityPricePerKwh);
  const currency = normalizeCurrency(settings.electricityCurrency);
  const cost =
    pricePerKwh > 0
      ? {
          currency,
          pricePerKwh,
          cost24h: snapshot.energy24hKwh == null ? null : round(snapshot.energy24hKwh * pricePerKwh, 4),
          cost31d: snapshot.energy31dKwh == null ? null : round(snapshot.energy31dKwh * pricePerKwh, 4),
          // What a day at the current draw would cost; null until there is a current draw.
          costPerDayAtCurrent:
            snapshot.currentWatts30s == null
              ? null
              : round((snapshot.currentWatts30s * 24 * pricePerKwh) / 1000, 4),
        }
      : null;

  return {
    ...snapshot,
    label: ENERGY_LABEL,
    hosts,
    coverage: {
      reportingHosts: reporting.length,
      hostsInScope: counted.length,
      percent: counted.length ? round((reporting.length / counted.length) * 100, 1) : 0,
      measuredSharePct: totalWatts > 0 ? round((measuredWatts / totalWatts) * 100, 1) : null,
      coverage24hPct: round(coverage24h * 100, 1),
    },
    cost,
  };
}
