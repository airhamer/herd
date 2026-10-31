/**
 * FleetShowcaseGrid — one tile per lane of a fleet Prompt Showcase (SHOW1, #39).
 * Client tok/s, server tok/s (or "client only") and TTFT side by side so the
 * whole fleet reads at a glance, above the per-lane terminals.
 */
import type { FleetShowcaseLaneState } from "../../api/types";

function fmtTps(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v.toFixed(v >= 100 ? 0 : 1) : "—";
}

function fmtMs(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

const VIA_LABEL: Record<string, string> = {
  direct: "direct",
  lan: "LAN",
  "ssh-tunnel": "SSH tunnel",
  local: "local",
};

/** Token-count badge; `estimated` (SHOW2) wins so live and no-usage counts are always flagged. */
export function tokenSourceBadge(
  lane: Pick<FleetShowcaseLaneState, "tokenSource" | "estimated">
): { text: string; title: string; estimated: boolean } | null {
  const src = lane.tokenSource;
  if (src === "mixed")
    return { text: "≈ mixed", title: "Some streams reported usage, others were estimated (~4 chars/token)", estimated: true };
  if (src === "estimate" || (lane.estimated && src !== "usage"))
    return {
      text: "≈ est.",
      title:
        src === "estimate"
          ? "No usage from the engine: tokens estimated at ~4 chars/token"
          : "Live token counts are estimated at ~4 chars/token until the engine reports usage",
      estimated: true,
    };
  if (src === "usage") return { text: "usage", title: "Token counts from the engine's usage field", estimated: false };
  return null;
}

export interface FleetShowcaseGridProps {
  lanes: FleetShowcaseLaneState[];
  /** Highlights a tile and scrolls its terminals into view. */
  onSelectLane?: (laneId: string) => void;
}

export function FleetShowcaseGrid({ lanes, onSelectLane }: FleetShowcaseGridProps) {
  if (!lanes.length) return null;
  return (
    <div className="fleet-showcase-tiles" data-testid="fleet-showcase-tiles">
      {lanes.map((lane) => {
        const badge = tokenSourceBadge(lane);
        const engine = lane.serverEngine || lane.backend || "unknown engine";
        const via = lane.via ? VIA_LABEL[lane.via] || lane.via : null;
        return (
          <button
            type="button"
            key={lane.laneId}
            className={`fleet-showcase-tile fleet-showcase-tile--${lane.status}`}
            data-testid={`fleet-showcase-tile-${lane.laneId}`}
            onClick={() => onSelectLane?.(lane.laneId)}
            title={lane.error || lane.statusText || lane.modelId || lane.laneId}
          >
            <div className="fleet-showcase-tile__head">
              <span className="fleet-showcase-tile__node">
                {lane.nodeName}
                <span className="fleet-showcase-tile__kind">{lane.kind === "spark" ? "Spark" : "agent"}</span>
              </span>
              <span className={`fleet-showcase-tile__status fleet-showcase-tile__status--${lane.status}`}>
                {lane.status}
              </span>
            </div>
            <div className="fleet-showcase-tile__model" title={lane.modelId || undefined}>
              {lane.modelId || "model unknown"}
            </div>
            <div className="fleet-showcase-tile__sub">
              <span>{engine}</span>
              <span>
                · {lane.host || "?"}:{lane.port}
              </span>
              {via ? <span>· {via}</span> : null}
            </div>
            <div className="fleet-showcase-tile__hero">
              <span className="fleet-showcase-tile__hero-value font-tabular" data-testid="tile-client-tps">
                {fmtTps(lane.clientTps)}
              </span>
              <span className="fleet-showcase-tile__hero-unit" title="Concurrent window: Σ decode tokens / (last token − first token)">
                tok/s aggregate
              </span>
              {badge ? (
                <span
                  className={`fleet-showcase-tile__badge${badge.estimated ? " fleet-showcase-tile__badge--est" : ""}`}
                  title={badge.title}
                  data-testid="tile-token-badge"
                >
                  {badge.text}
                </span>
              ) : null}
            </div>
            {lane.clientTpsPeak != null && lane.clientTpsPeak > 0 ? (
              <div className="fleet-showcase-tile__peak font-tabular" data-testid="tile-peak">
                peak {lane.aggregate?.peakEstimated ? "≈" : ""}
                {fmtTps(lane.clientTpsPeak)} tok/s
              </div>
            ) : null}
            <dl className="fleet-showcase-tile__stats">
              <div>
                <dt>Server</dt>
                <dd className="font-tabular" data-testid="tile-server-tps">
                  {lane.serverCounters ? (
                    lane.serverTps != null ? (
                      `${fmtTps(lane.serverTps)} tok/s`
                    ) : (
                      "—"
                    )
                  ) : (
                    <span className="fleet-showcase-tile__muted" title="This engine exposes no generation counter">
                      client only
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt>TTFT p50</dt>
                <dd className="font-tabular" data-testid="tile-ttft">
                  {fmtMs(lane.ttftP50Ms)}
                </dd>
              </div>
              <div>
                <dt>Per stream</dt>
                <dd className="font-tabular">{fmtTps(lane.streamTpsMean)}</dd>
              </div>
              <div>
                <dt>Prefill</dt>
                <dd className="font-tabular">{fmtTps(lane.prefillTps)}</dd>
              </div>
              <div>
                <dt>Streams</dt>
                <dd className="font-tabular">
                  {lane.streamsDone}/{lane.streamCount}
                </dd>
              </div>
              <div>
                <dt>Tokens</dt>
                <dd className="font-tabular">{lane.totalTokens > 0 ? lane.totalTokens.toLocaleString() : "—"}</dd>
              </div>
            </dl>
            {lane.error ? <div className="fleet-showcase-tile__error">{lane.error}</div> : null}
            {!lane.error && lane.statusText && lane.status !== "completed" ? (
              <div className="fleet-showcase-tile__note">{lane.statusText}</div>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
