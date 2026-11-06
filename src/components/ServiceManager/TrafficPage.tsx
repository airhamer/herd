import { useEffect, useState } from "react";
import type {
  LlmTokenEndpointRow,
  LlmTokenTotals,
  TrafficLane,
  TrafficRequestRow,
  TrafficTokenSource,
  TrafficValue,
  TrafficPrerequisites,
  TrafficView,
} from "../../../shared/types";
import { fetchLlmTokenTotals, fetchNodeTraffic } from "../../api/client";
import { timeAgo } from "../../lib/timeAgo";
import { Panel } from "../ui/Panel";

export interface TrafficApi {
  traffic: (nodeId: string) => Promise<TrafficView>;
  totals: () => Promise<LlmTokenTotals>;
}
const DEFAULT_API: TrafficApi = { traffic: fetchNodeTraffic, totals: () => fetchLlmTokenTotals("24h") };

/** 1234 → "1.2k", 5_600_000 → "5.6M"; null → "—" (unmeasured, never 0). */
export function fmtCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtTps(v: TrafficValue): string {
  return v.value == null ? "—" : v.value >= 100 ? v.value.toFixed(0) : v.value.toFixed(1);
}

function fmtSec(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "—";
  return s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`;
}

const SOURCE_STYLE: Record<TrafficTokenSource, string> = {
  engine: "border-success/60 text-success",
  proxy: "border-accent/60 text-accent",
  estimate: "border-warning/60 text-warning",
};
const SOURCE_TITLE: Record<TrafficTokenSource, string> = {
  engine: "token counts from the engine's own counters",
  proxy: "token counts from the usage the agent relay read in each response",
  estimate: "some relay responses had no usage, so completions were counted from stream events",
};

export function SourceBadge({ source }: { source: TrafficTokenSource | null }) {
  if (!source) {
    return (
      <span data-testid="source-badge" className="rounded border border-border px-1 text-[10px] uppercase tracking-wide text-muted" title="this engine publishes no token counters and no relay forwards to it">
        none
      </span>
    );
  }
  return (
    <span data-testid="source-badge" title={SOURCE_TITLE[source]} className={`rounded border px-1 text-[10px] uppercase tracking-wide ${SOURCE_STYLE[source]}`}>
      {source}
    </span>
  );
}

/** Which tier a windowed value came from, as a small superscript. */
function Tier({ v }: { v: TrafficValue }) {
  if (v.value == null || !v.source) return null;
  return <sup className="ml-0.5 text-[9px] text-muted">{v.source}</sup>;
}

function LaneRow({ lane, day }: { lane: TrafficLane; day: LlmTokenEndpointRow | null }) {
  const w60 = lane.windows["60"];
  const w300 = lane.windows["300"];
  return (
    <tr className="border-t border-border" data-testid={`traffic-lane-${lane.port}`}>
      <td className="py-1.5 pr-3">
        <div className="font-medium text-text">{lane.modelId ?? "unknown model"}</div>
        <div className="text-[10px] text-muted">
          :{lane.port} · {lane.backend ?? "?"}
          {lane.proxied && lane.listenPort != null ? ` · relay :${lane.listenPort}` : ""}
        </div>
      </td>
      <td className="pr-3"><SourceBadge source={lane.tokenSource} /></td>
      <td className="pr-3 text-right font-tabular">{fmtCount(lane.requests)}</td>
      <td className={`pr-3 text-right font-tabular ${lane.errors ? "text-danger" : ""}`} title={lane.errors == null ? "errors are only counted through the relay" : undefined}>
        {fmtCount(lane.errors)}
      </td>
      <td className="pr-3 text-right font-tabular">{fmtCount(lane.promptTokens)}</td>
      <td className="pr-3 text-right font-tabular">{fmtCount(lane.cachedTokens)}</td>
      <td className="pr-3 text-right font-tabular">{fmtCount(lane.generatedTokens)}</td>
      <td className="pr-3 text-right font-tabular" data-testid="tps-60">{fmtTps(w60.decodeTps)}<Tier v={w60.decodeTps} /></td>
      <td className="pr-3 text-right font-tabular" data-testid="tps-300">{fmtTps(w300.decodeTps)}<Tier v={w300.decodeTps} /></td>
      <td className="pr-3 text-right font-tabular">{fmtSec(w60.ttftS.value)}<Tier v={w60.ttftS} /></td>
      <td className="text-right font-tabular" title={day ? `24 h: generated ${day.generated}, cached ${day.cached}, prefill ${day.prefill} (${day.sources.join(", ")})` : "no ledger entry for this lane"}>
        {day ? fmtCount(day.total) : "—"}
      </td>
    </tr>
  );
}

function RecentRow({ r }: { r: TrafficRequestRow }) {
  const bad = r.status >= 400 || r.aborted;
  return (
    <tr className="border-t border-border" data-testid="traffic-request">
      <td className="py-1 pr-3 text-muted" title={new Date(r.wallMs).toISOString()}>{timeAgo(r.wallMs)}</td>
      <td className="pr-3 font-mono text-[10px]">{r.client}</td>
      <td className="pr-3">{r.model ?? "—"}</td>
      <td className="pr-3 font-mono text-[10px] text-muted">{r.path ?? "—"}{r.stream ? " · stream" : ""}</td>
      <td className={`pr-3 font-tabular ${bad ? "text-danger" : "text-success"}`}>{r.aborted ? "aborted" : r.status}</td>
      <td className="pr-3 text-right font-tabular">{fmtCount(r.promptTokens)}</td>
      <td className="pr-3 text-right font-tabular">{fmtCount(r.cachedTokens)}</td>
      <td className="pr-3 text-right font-tabular" title={r.completionEstimated ? "estimated from stream events" : undefined}>
        {fmtCount(r.completionTokens)}{r.completionEstimated ? "~" : ""}
      </td>
      <td className="pr-3 text-right font-tabular">{fmtSec(r.ttftS)}</td>
      <td className="text-right font-tabular">{fmtSec(r.e2eS)}</td>
    </tr>
  );
}

const TH = "pb-1 pr-3 text-left text-[10px] font-semibold uppercase tracking-wide text-muted";
const THR = `${TH} text-right`;


function Mark({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <li className="flex gap-2" data-testid={ok ? "prereq-met" : "prereq-missing"}>
      <span aria-hidden="true">{ok ? "☑" : "☐"}</span>
      <span>
        <span className="text-text">{label}</span>
        <span className="text-muted"> — {detail}</span>
      </span>
    </li>
  );
}


export function prereqsFromAgent(agentVersion: string | null | undefined, usageRelayConfigured: boolean): TrafficPrerequisites {
  const parts = String(agentVersion ?? "").trim().match(/^(\d+)\.(\d+)/);
  const major = parts ? Number(parts[1]) : 0;
  const minor = parts ? Number(parts[2]) : 0;
  const atLeast = (maj: number, min: number) => (parts ? major > maj || (major === maj && minor >= min) : false);
  return {
    agentVersion: agentVersion ?? null,
    agentMeetsCounters: atLeast(0, 4),
    agentMeetsRelay: atLeast(0, 5),
    usageRelayConfigured,
  };
}

/** Shared "what it takes" checklist for Traffic and Requests. */
export function TrafficPrereqPanel({
  proxyEnabled,
  prerequisites,
}: {
  proxyEnabled: boolean;
  prerequisites?: TrafficPrerequisites | null;
}) {
  const agentOk = prerequisites?.agentMeetsRelay ?? false;
  const countersOk = prerequisites?.agentMeetsCounters ?? false;
  const relayOk = prerequisites?.usageRelayConfigured ?? proxyEnabled;
  const version = prerequisites?.agentVersion ?? "unknown";
  return (
    <div className="rounded-lg border border-warning/50 bg-surface p-3 text-xs" data-testid="traffic-prereqs">
      <div className="font-medium text-text">What it takes to fill Traffic and Requests</div>
      <ul className="mt-2 space-y-1">
        <Mark
          ok={countersOk}
          label={`Node agent ${version} (need 0.4+ for engine counters, 0.5+ for the usage relay)`}
          detail={countersOk ? "this agent can export engine counters." : "upgrade the node agent; engine lanes may stay unlabeled or empty."}
        />
        <Mark
          ok={agentOk}
          label="Agent 0.5+ usage relay"
          detail={agentOk ? "this agent can run LLM_PROXY." : "the herd usage relay needs agent 0.5 or newer (see docs/usage-relay.md)."}
        />
        <Mark
          ok={relayOk}
          label="LLM_PROXY configured on the node agent"
          detail={
            relayOk
              ? "the herd usage relay is present."
              : "set LLM_PROXY=<listen>-><upstream> on the node agent and point clients at the listen port. The Hasso keepalive/guard proxy on :8081 is not this relay and does not fill Recent requests."
          }
        />
      </ul>
      <p className="mt-2 text-muted">
        Engine tok/s can appear from engine counters without the relay. Per-request rows and error counts need the
        relay. See <code className="font-mono">docs/usage-relay.md</code>.
      </p>
    </div>
  );
}

/**
 * SC5c (#74) Traffic sub-tab for one node: per-lane request and token stats
 * (engine counters, else the opt-in relay), 60 s and 300 s decode tok/s, TTFT,
 * errors, 24 h ledger totals, and a recent-requests table from the relay
 * (metadata only, last 200 in memory). Polls every 5 s.
 */
export function TrafficPage({
  nodeId,
  nodeName,
  api = DEFAULT_API,
  pollMs = 5000,
}: {
  nodeId: string;
  nodeName: string;
  api?: TrafficApi;
  pollMs?: number;
}) {
  const [view, setView] = useState<TrafficView | null>(null);
  const [totals, setTotals] = useState<LlmTokenTotals | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api
        .traffic(nodeId)
        .then((v) => {
          if (!alive) return;
          setView(v);
          setError(null);
        })
        .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
    };
    load();
    api.totals().then((t) => alive && setTotals(t)).catch(() => undefined);
    const t = setInterval(load, pollMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api, nodeId, pollMs]);

  const dayByPort = new Map<number, LlmTokenEndpointRow>();
  for (const e of totals?.endpoints ?? []) if (e.nodeId === nodeId) dayByPort.set(e.port, e);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-page-gap)" }}>
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-text-strong">Traffic</h1>
        <p className="mt-0.5 text-xs text-muted">
          {nodeName} · {nodeId}
          {view?.polledAt ? ` · polled ${timeAgo(view.polledAt)}` : ""}
        </p>
      </header>

      {error && <div className="rounded border border-danger/50 p-2 text-xs text-danger">Traffic unavailable: {error}</div>}

      {view && (!view.proxyEnabled || view.prerequisites) && (
        <div data-testid={!view.proxyEnabled ? "proxy-off-hint" : undefined}>
          <TrafficPrereqPanel proxyEnabled={view.proxyEnabled} prerequisites={view.prerequisites} />
        </div>
      )}

      <Panel title="Lanes" bodyClassName="overflow-x-auto">
        {!view ? (
          <div className="text-sm text-muted">Loading…</div>
        ) : view.lanes.length === 0 ? (
          <div className="text-sm text-muted" data-testid="lanes-empty">This node reports no LLM lanes.</div>
        ) : (
          <table className="w-full text-xs" data-testid="traffic-lanes">
            <thead>
              <tr>
                <th className={TH}>Lane</th>
                <th className={TH}>Tokens</th>
                <th className={THR}>Requests</th>
                <th className={THR}>Errors</th>
                <th className={THR}>Prompt</th>
                <th className={THR}>Cached</th>
                <th className={THR}>Generated</th>
                <th className={THR}>tok/s 60 s</th>
                <th className={THR}>tok/s 300 s</th>
                <th className={THR}>TTFT</th>
                <th className={THR}>24 h tokens</th>
              </tr>
            </thead>
            <tbody>
              {view.lanes.map((l) => (
                <LaneRow key={l.port} lane={l} day={dayByPort.get(l.port) ?? null} />
              ))}
            </tbody>
          </table>
        )}
        {view && view.lanes.length > 0 && (
          <div className="mt-2 text-[10px] text-muted">
            Requests and tokens are lifetime counters since the engine (or relay) started. tok/s is decode throughput, and TTFT is the 60 s mean.
          </div>
        )}
      </Panel>

      <Panel title={`Recent requests${view && view.recent.length ? ` (${view.recent.length} of last ${view.recentMax})` : ""}`} bodyClassName="overflow-x-auto">
        {!view ? (
          <div className="text-sm text-muted">Loading…</div>
        ) : view.recent.length === 0 ? (
          <div className="text-sm text-muted" data-testid="recent-empty">
            {view.proxyEnabled ? "No requests through the relay yet." : "Recent requests need the usage relay (proxy off)."}
          </div>
        ) : (
          <table className="w-full text-xs" data-testid="traffic-recent">
            <thead>
              <tr>
                <th className={TH}>When</th>
                <th className={TH}>Client</th>
                <th className={TH}>Model</th>
                <th className={TH}>Path</th>
                <th className={TH}>Status</th>
                <th className={THR}>Prompt</th>
                <th className={THR}>Cached</th>
                <th className={THR}>Completion</th>
                <th className={THR}>TTFT</th>
                <th className={THR}>Total</th>
              </tr>
            </thead>
            <tbody>
              {view.recent.map((r) => (
                <RecentRow key={`${r.listenPort}|${r.wallMs}|${r.client}|${r.path}|${r.status}|${r.e2eS}`} r={r} />
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

export default TrafficPage;
