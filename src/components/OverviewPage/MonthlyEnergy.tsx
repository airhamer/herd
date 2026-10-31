import { useEffect, useState } from "react";
import { fetchMonthlyEnergy } from "../../api/client";
import type { MonthlyEnergy as MonthlyEnergyResponse, MonthlyEnergyMonth } from "../../api/types";

// Long-run monthly energy table under the fleet energy card.
// Behaviour: docs/specs/monthly-energy.md (herd LIC1 clean-room rewrite).

type LoadState =
  | { phase: "loading" }
  | { phase: "failed"; message: string }
  | { phase: "ready"; history: MonthlyEnergyResponse };

const kwh = (wh: number) => (wh / 1000).toFixed(1);

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-08" → "Aug 2026"; anything unexpected is shown as-is. */
function labelFor(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  const name = match ? MONTH_NAMES[Number(match[2]) - 1] : undefined;
  return match && name ? `${name} ${match[1]}` : key;
}

function MonthRow({ month }: { month: MonthlyEnergyMonth }) {
  const running = !month.closed;
  const hint = running
    ? "This month is still being recorded"
    : `${month.nodeIds.length} node(s) · ${kwh(month.totalWh)} kWh summed per node`;
  return (
    <tr className={running ? "text-accent" : "text-text"} title={hint}>
      <th scope="row" className="py-0.5 pr-2 text-left font-normal">
        {labelFor(month.month)}
        {running ? <em className="ml-1.5 text-[10px] not-italic uppercase tracking-wide">current</em> : null}
      </th>
      <td className="py-0.5 pr-2 text-right font-tabular">{kwh(month.fleetWh)}</td>
      <td className="py-0.5 text-right font-tabular">{month.nodeIds.length}</td>
    </tr>
  );
}

/** Fetched once on mount; months only change slowly, so there is no polling. */
export function MonthlyEnergy() {
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    let live = true;
    (async () => {
      let next: LoadState;
      try {
        next = { phase: "ready", history: await fetchMonthlyEnergy() };
      } catch (err) {
        next = { phase: "failed", message: err instanceof Error ? err.message : String(err) };
      }
      if (live) setState(next);
    })();
    return () => {
      live = false;
    };
  }, []);

  if (state.phase === "failed") {
    return (
      <p role="status" className="rounded bg-warning/10 px-3 py-2 text-xs text-warning">
        {`Energy history unavailable: ${state.message}`}
      </p>
    );
  }
  if (state.phase === "loading") return <p className="text-xs text-muted">Loading monthly energy…</p>;

  const { months } = state.history;
  if (months.length === 0) return <p className="text-xs text-muted">No closed months yet</p>;

  let sumWh = 0;
  for (const month of months) sumWh += month.fleetWh;

  return (
    <section aria-label="Monthly fleet energy" className="mt-3 border-t border-border pt-3">
      <table className="w-full border-collapse text-xs">
        <caption className="mb-1.5 text-left text-[10px] text-muted">
          <span className="uppercase tracking-wide">Monthly</span>
          {` · total ${kwh(sumWh)} kWh · estimated, not wall-metered`}
        </caption>
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-muted">
            <th scope="col" className="py-0.5 pr-2 text-left font-medium">Month</th>
            <th scope="col" className="py-0.5 pr-2 text-right font-normal">kWh</th>
            <th scope="col" className="py-0.5 text-right font-normal">Nodes</th>
          </tr>
        </thead>
        <tbody>
          {months.map((month) => (
            <MonthRow key={month.month} month={month} />
          ))}
        </tbody>
      </table>
    </section>
  );
}
