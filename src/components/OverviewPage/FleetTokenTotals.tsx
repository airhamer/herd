import { useEffect, useState } from "react";
import { fetchLlmTokenHistory, fetchLlmTokenTotals } from "../../api/client";
import type { LlmTokenEndpointRow, LlmTokenHistory, LlmTokenRange, LlmTokenTotals } from "../../api/types";
import { formatShare, formatTokens } from "../../shared/tokenFormat";

// LLM token totals card on the Fleet tab (FLEET3, issue #38): fleet-wide
// generated / cached / prefill tokens from the server's token ledger, with a
// per-model table, range chips and a per-endpoint details view.

const RANGES: { id: LlmTokenRange; label: string }[] = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "all", label: "All" },
];

const SEGMENTS = [
  { key: "generated", label: "Generated", className: "bg-accent" },
  { key: "cached", label: "Cached", className: "bg-success" },
  { key: "prefill", label: "Prefill", className: "bg-muted" },
] as const;

const SOURCE_LABEL: Record<string, string> = {
  counter: "engine counters",
  native: "engine stats",
  proxy: "proxy",
};

function sourceText(sources: string[]): string {
  return sources.length ? sources.map((s) => SOURCE_LABEL[s] ?? s).join(" + ") : "—";
}

function sinceText(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function SplitBar({ data }: { data: LlmTokenTotals }) {
  return (
    <div>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-border/40"
        role="img"
        aria-label={`Generated ${formatTokens(data.generated)}, cached ${formatTokens(data.cached)}, prefill ${formatTokens(data.prefill)}`}
        data-testid="fleet-tokens-split"
      >
        {SEGMENTS.map((seg) => {
          const value = data[seg.key];
          if (!(data.total > 0) || value <= 0) return null;
          return <span key={seg.key} className={seg.className} style={{ width: `${(value / data.total) * 100}%` }} title={`${seg.label} ${formatTokens(value)}`} />;
        })}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted">
        {SEGMENTS.map((seg) => (
          <span key={seg.key} className="inline-flex items-center gap-1">
            <span className={`inline-block h-2 w-2 rounded-full ${seg.className}`} />
            {seg.label}
            <strong className="font-tabular font-semibold text-text">{formatTokens(data[seg.key])}</strong>
            <span>{formatShare(data[seg.key], data.total)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function HistoryBars({ history }: { history: LlmTokenHistory }) {
  const max = Math.max(1, ...history.points.map((p) => p.generated));
  const fmt = (ms: number) =>
    history.resolution === "hour"
      ? new Date(ms).toLocaleTimeString("en-US", { hour: "numeric" })
      : new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <div className="mt-2 flex h-10 items-end gap-px" aria-label={`Generated tokens per ${history.resolution}`} data-testid="fleet-tokens-history">
      {history.points.map((p) => (
        <span
          key={p.startMs}
          className="min-w-0 flex-1 bg-accent/60"
          style={{ height: p.generated > 0 ? `${Math.max(4, (p.generated / max) * 100)}%` : 0 }}
          title={`${fmt(p.startMs)}: ${formatTokens(p.generated)} generated`}
        />
      ))}
    </div>
  );
}

function EndpointRow({ row }: { row: LlmTokenEndpointRow }) {
  return (
    <tr className="text-text" data-testid={`fleet-tokens-endpoint-${row.seriesId}`}>
      <th scope="row" className="py-0.5 pr-2 text-left font-normal">
        {row.nodeName ?? row.nodeId}
        <span className="text-muted">:{row.port}</span>
      </th>
      <td className="py-0.5 pr-2 text-left text-muted">{row.backend ?? "—"}</td>
      <td className="max-w-[14rem] truncate py-0.5 pr-2 text-left" title={row.models.join(", ")}>{row.models.join(", ")}</td>
      <td className="py-0.5 pr-2 text-left text-[10px] text-muted">{sourceText(row.sources)}</td>
      <td className="py-0.5 text-right font-tabular">{formatTokens(row.generated)}</td>
    </tr>
  );
}

export function FleetTokenTotals({ refreshMs = 30_000 }: { refreshMs?: number } = {}) {
  const [range, setRange] = useState<LlmTokenRange>("24h");
  const [data, setData] = useState<LlmTokenTotals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [history, setHistory] = useState<LlmTokenHistory | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchLlmTokenTotals(range)
        .then((next) => { if (!cancelled) { setData(next); setError(null); } })
        .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    void load();
    const timer = window.setInterval(load, refreshMs);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [range, refreshMs]);

  useEffect(() => {
    if (!details) return;
    let cancelled = false;
    fetchLlmTokenHistory(range)
      .then((next) => { if (!cancelled) setHistory(next); })
      .catch(() => { if (!cancelled) setHistory(null); });
    return () => { cancelled = true; };
  }, [details, range, data?.toMs]);

  const shown = data && data.range === range ? data : null;
  const empty = shown && shown.total === 0;
  const since = sinceText(shown?.trackedSinceMs);
  const subtitle = shown
    ? [
        `${shown.endpointCount} endpoint${shown.endpointCount === 1 ? "" : "s"}`,
        shown.range === "all" && since ? `since ${since}` : null,
      ].filter(Boolean).join(" · ")
    : null;

  return (
    <section className="panel p-4" aria-labelledby="fleet-tokens-title" data-testid="fleet-tokens-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="fleet-tokens-title" className="text-sm font-semibold text-text-strong">LLM token totals</h2>
          {subtitle ? <p className="text-[10px] text-muted" data-testid="fleet-tokens-subtitle">{subtitle}</p> : null}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Token range">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={r.id === range}
              onClick={() => setRange(r.id)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                r.id === range ? "border-accent bg-accent-soft text-text-strong" : "border-border text-muted hover:text-text"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="mt-3 rounded bg-warning/10 px-3 py-2 text-xs text-warning" role="status">Token totals unavailable: {error}</p>
      ) : !shown ? (
        <p className="mt-3 text-xs text-muted" role="status">Loading token totals…</p>
      ) : null}

      {shown ? (
        <>
          <div className="mt-3 flex items-baseline gap-2">
            <strong className="font-tabular text-2xl font-semibold text-text-strong" data-testid="fleet-tokens-generated">
              {formatTokens(shown.generated)}
            </strong>
            <span className="text-xs text-muted">generated tokens</span>
          </div>
          {empty ? (
            <p className="mt-2 text-xs text-muted" role="status">
              No tokens counted in this range yet. Sparks need LLM monitoring on; agent nodes need engine counters (agent 0.4+) or the usage relay (agent 0.5+).
            </p>
          ) : (
            <>
              <div className="mt-3"><SplitBar data={shown} /></div>
              <table className="mt-3 w-full border-collapse text-xs" aria-label="Tokens per model">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-muted">
                    <th scope="col" className="py-0.5 pr-2 text-left font-medium">Model</th>
                    <th scope="col" className="py-0.5 pr-2 text-right font-normal">Cached</th>
                    <th scope="col" className="py-0.5 pr-2 text-right font-normal">Prefill</th>
                    <th scope="col" className="py-0.5 text-right font-normal">Gen</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.models.map((m) => (
                    <tr key={m.model} className="text-text" data-testid={`fleet-tokens-model-${m.model}`}>
                      <th scope="row" className="max-w-[16rem] truncate py-0.5 pr-2 text-left font-normal" title={m.model}>
                        {m.model}
                        {m.sources.includes("proxy") ? <em className="ml-1.5 text-[10px] not-italic text-muted">(proxy)</em> : null}
                      </th>
                      <td className="py-0.5 pr-2 text-right font-tabular">{formatTokens(m.cached)}</td>
                      <td className="py-0.5 pr-2 text-right font-tabular">{formatTokens(m.prefill)}</td>
                      <td className="py-0.5 text-right font-tabular">{formatTokens(m.generated)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border font-semibold text-text-strong" data-testid="fleet-tokens-total-row">
                    <th scope="row" className="py-0.5 pr-2 text-left">Total</th>
                    <td className="py-0.5 pr-2 text-right font-tabular">{formatTokens(shown.cached)}</td>
                    <td className="py-0.5 pr-2 text-right font-tabular">{formatTokens(shown.prefill)}</td>
                    <td className="py-0.5 text-right font-tabular">{formatTokens(shown.generated)}</td>
                  </tr>
                </tfoot>
              </table>
            </>
          )}
          <button
            type="button"
            className="mt-3 text-[11px] text-muted underline-offset-2 hover:text-text hover:underline"
            aria-expanded={details}
            onClick={() => setDetails((d) => !d)}
          >
            {details ? "Hide details" : "Details"}
          </button>
          {details ? (
            <div data-testid="fleet-tokens-details">
              {history ? <HistoryBars history={history} /> : null}
              <table className="mt-2 w-full border-collapse text-xs" aria-label="Tokens per endpoint">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wide text-muted">
                    <th scope="col" className="py-0.5 pr-2 text-left font-medium">Endpoint</th>
                    <th scope="col" className="py-0.5 pr-2 text-left font-normal">Engine</th>
                    <th scope="col" className="py-0.5 pr-2 text-left font-normal">Models</th>
                    <th scope="col" className="py-0.5 pr-2 text-left font-normal">Source</th>
                    <th scope="col" className="py-0.5 text-right font-normal">Gen</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.endpoints.map((row) => <EndpointRow key={row.seriesId} row={row} />)}
                </tbody>
              </table>
              <p className="mt-2 text-[10px] text-muted">
                Cached = prompt tokens served from the prefix cache; prefill = prompt tokens computed. Sampled every 15 s from engine counters, or the agent usage relay where an engine has none.
                {since ? ` Counting since ${since}.` : ""}
              </p>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
