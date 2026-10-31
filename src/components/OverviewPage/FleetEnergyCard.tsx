import { useEffect, useState, type ReactNode } from "react";
import { fetchFleetEnergy } from "../../api/client";
import type { FleetEnergy, FleetEnergyHost } from "../../api/types";

// Fleet energy card on the Fleet tab (issue #33): SSH Sparks and agent nodes
// in one table, per-host power estimates, coverage and a cost estimate.

function number(value: number | null | undefined, digits = 2): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

/** Currency amount; falls back to "1.23 XYZ" for codes Intl does not know. */
export function formatMoney(amount: number | null | undefined, currency: string): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  const digits = Math.abs(amount) < 10 ? 2 : 0;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${amount.toFixed(digits)} ${currency}`;
  }
}

const KIND_LABEL: Record<FleetEnergyHost["kind"], string> = { spark: "Spark", host: "SSH host", node: "Agent node" };

function sourcesFor(host: FleetEnergyHost): string {
  if (host.duplicateOf) return `counted under ${host.duplicateOf}`;
  if (host.model == null) return "—";
  if (host.model === "gb10") return "GB10 model (nvidia-smi GPU + CPU load)";
  const parts: string[] = [];
  if (host.gpuSource) {
    parts.push(host.gpuCount && host.gpuCount > 1 ? `${host.gpuSource} ×${host.gpuCount}` : host.gpuSource);
  }
  if (host.cpuSource) parts.push(host.cpuSource === "estimated" ? "CPU est." : host.cpuSource);
  if (host.baselineWatts != null) parts.push(`+${number(host.baselineWatts, 0)} W idle`);
  return parts.length ? parts.join(" · ") : "no power telemetry";
}

function HostRow({ host }: { host: FleetEnergyHost }) {
  const status = host.duplicateOf
    ? `same machine as ${host.duplicateOf}`
    : host.reporting
      ? null
      : host.online
        ? "no power telemetry"
        : "offline";
  return (
    <tr className={host.reporting && !host.duplicateOf ? "text-text" : "text-muted"} data-testid={`energy-host-${host.id}`}>
      <th scope="row" className="py-0.5 pr-2 text-left font-normal">
        {host.name}
        {status ? <em className="ml-1.5 text-[10px] not-italic text-muted">({status})</em> : null}
      </th>
      <td className="py-0.5 pr-2 text-left">{KIND_LABEL[host.kind] ?? host.kind}</td>
      <td className="py-0.5 pr-2 text-right font-tabular">{host.reporting && !host.duplicateOf ? number(host.watts, 0) : "—"}</td>
      <td className="py-0.5 text-left text-[10px] text-muted">{sourcesFor(host)}</td>
    </tr>
  );
}

export function FleetEnergyCard({ children }: { children?: ReactNode } = {}) {
  const [data, setData] = useState<FleetEnergy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => fetchFleetEnergy()
      .then((next) => { if (!cancelled) { setData(next); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const coverage = data?.coverage;
  const hosts = data?.hosts ?? [];
  const cost = data?.cost ?? null;
  const showEfficiency = data?.whPerOutputToken24h != null && (data?.outputTokens24h ?? 0) > 0;
  const state = error
    ? `Energy telemetry unavailable: ${error}`
    : !data
      ? "Loading fleet energy…"
      : coverage && coverage.hostsInScope > 0 && coverage.reportingHosts === 0
        ? "No host is reporting power right now."
        : coverage && coverage.reportingHosts < coverage.hostsInScope
          ? `Partial coverage: ${coverage.reportingHosts}/${coverage.hostsInScope} hosts reporting power.`
          : data.energy24hKwh == null
            ? "Warming up — no energy recorded yet."
            : null;
  const label = data?.label ?? "estimated, not wall-metered";
  const subtitle = [
    `${label.charAt(0).toUpperCase()}${label.slice(1)}`,
    coverage ? `coverage ${number(coverage.percent, 0)}% (${coverage.reportingHosts}/${coverage.hostsInScope} hosts)` : null,
    coverage?.measuredSharePct != null ? `${number(coverage.measuredSharePct, 0)}% from sensors` : null,
    coverage ? `24h ${number(coverage.coverage24hPct, 0)}%` : null,
  ].filter(Boolean).join(" · ");

  return (
    <section className="panel p-4" aria-labelledby="fleet-energy-title" data-testid="fleet-energy-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="fleet-energy-title" className="text-sm font-semibold text-text-strong">Fleet energy</h2>
          <p className="text-[10px] text-muted" data-testid="fleet-energy-label">{subtitle}</p>
        </div>
        {cost ? (
          <span className="text-[10px] text-muted">
            {formatMoney(cost.pricePerKwh, cost.currency)}/kWh
          </span>
        ) : null}
      </div>
      {state && <p className="mt-3 rounded bg-warning/10 px-3 py-2 text-xs text-warning" role="status">{state}</p>}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div><div className="text-[10px] text-muted">Current</div><strong className="font-tabular text-sm" data-testid="fleet-energy-current">{number(data?.currentWatts30s, 0)} W</strong></div>
        <div><div className="text-[10px] text-muted">24 hours</div><strong className="font-tabular text-sm">{number(data?.energy24hKwh)} kWh</strong></div>
        <div><div className="text-[10px] text-muted">31 days</div><strong className="font-tabular text-sm">{number(data?.energy31dKwh)} kWh</strong></div>
        {cost ? (
          <div data-testid="fleet-energy-cost">
            <div className="text-[10px] text-muted">Cost (est.)</div>
            <strong className="font-tabular text-sm">{formatMoney(cost.cost31d, cost.currency)}</strong>
            <span className="ml-1 text-[10px] text-muted">31 d · {formatMoney(cost.costPerDayAtCurrent, cost.currency)}/day now</span>
          </div>
        ) : null}
        {showEfficiency ? (
          <div data-testid="fleet-energy-efficiency"><div className="text-[10px] text-muted">Efficiency (24 h)</div><strong className="font-tabular text-sm">{number(data?.whPerOutputToken24h, 4)} Wh/token</strong></div>
        ) : null}
      </div>
      <div className="mt-3 flex h-12 items-end gap-px" aria-label="Hourly estimated watts for the last 24 hours, with gaps shown empty">
        {(data?.hourlyWatts24h ?? Array(24).fill(null)).map((watts, index, values) => {
          const max = Math.max(1, ...values.filter((value): value is number => value != null));
          return <span key={index} className="min-w-0 flex-1 bg-accent/60" style={{ height: watts == null ? 0 : `${Math.max(4, (watts / max) * 100)}%` }} title={watts == null ? "No power reported" : `${watts.toFixed(0)} W`} />;
        })}
      </div>
      {hosts.length > 0 ? (
        <table className="mt-3 w-full border-collapse text-xs" aria-label="Per-host power">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-muted">
              <th scope="col" className="py-0.5 pr-2 text-left font-medium">Host</th>
              <th scope="col" className="py-0.5 pr-2 text-left font-normal">Kind</th>
              <th scope="col" className="py-0.5 pr-2 text-right font-normal">W</th>
              <th scope="col" className="py-0.5 text-left font-normal">Source</th>
            </tr>
          </thead>
          <tbody>
            {hosts.map((host) => <HostRow key={host.id} host={host} />)}
          </tbody>
        </table>
      ) : null}
      {children}
    </section>
  );
}
