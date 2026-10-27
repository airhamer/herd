import { useEffect, useState } from "react";
import { fetchMonthlyEnergy } from "../../api/client";
import type { MonthlyEnergy as MonthlyEnergyData } from "../../api/types";

/** kWh, 1 decimal (source values are watt-hours). */
function fmtKwh(wh: number): string {
  return (wh / 1000).toFixed(1);
}

const MONTH_DATE = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/** "2026-10" → "Oct 2026" (UTC). */
function monthLabel(month: string): string {
  const [year, mo] = month.split("-").map(Number);
  return MONTH_DATE.format(new Date(Date.UTC(year, mo - 1, 1)));
}

/**
 * Permanent monthly energy roll-up (estimated, not wall-metered).
 * Mounted under FleetEnergyCard under the same settings toggle; monthly folds
 * hourly on the server, so this fetches once on mount — no polling.
 */
export function MonthlyEnergy() {
  const [data, setData] = useState<MonthlyEnergyData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMonthlyEnergy()
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <p className="rounded bg-warning/10 px-3 py-2 text-xs text-warning" role="status">
        Energy history unavailable: {error}
      </p>
    );
  }
  if (!data) {
    return <p className="text-xs text-muted">Loading monthly energy…</p>;
  }

  const months = data.months;
  if (months.length === 0) {
    return <p className="text-xs text-muted">No closed months yet</p>;
  }

  const totalWh = months.reduce((sum, m) => sum + m.fleetWh, 0);

  return (
    <div className="mt-3 border-t border-border pt-3" aria-label="Monthly fleet energy">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted">Monthly</span>
        <span className="text-[10px] text-muted">
          total {fmtKwh(totalWh)} kWh · estimated, not wall-metered
        </span>
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
            <th className="py-0.5 pr-2 font-medium">Month</th>
            <th className="py-0.5 pr-2 text-right font-normal" style={{ textAlign: "right" }}>kWh</th>
            <th className="py-0.5 font-normal" style={{ textAlign: "right" }}>Nodes</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr
              key={m.month}
              className={m.closed ? "text-text" : "text-accent"}
              title={
                m.closed
                  ? `${m.nodeIds.length} node(s) reported · lifetime ${fmtKwh(m.totalWh)} kWh recorded`
                  : "Current month — still collecting"
              }
            >
              <td className="py-0.5 pr-2">
                {monthLabel(m.month)}
                {!m.closed && <span className="ml-1.5 text-[10px] uppercase tracking-wide">current</span>}
              </td>
              <td className="py-0.5 pr-2 font-tabular" style={{ textAlign: "right" }}>
                {fmtKwh(m.fleetWh)}
              </td>
              <td className="py-0.5 font-tabular" style={{ textAlign: "right" }}>
                {m.nodeIds.length}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
