/**
 * FleetShowcasePage — the Prompt Showcase fanned out across the fleet
 * (SHOW1, #39). Pick any mix of SSH-Spark ports and node-agent engines, run
 * the same prompts on all of them at once, and compare client tok/s, server
 * tok/s and TTFT per lane. Route: /fleet/showcase.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelFleetShowcase,
  clearFleetShowcaseHistory,
  getFleetShowcase,
  getFleetShowcaseTargets,
  listFleetShowcase,
  startFleetShowcase,
} from "../../api/client";
import type {
  FleetShowcaseHistorySummary,
  FleetShowcaseLaneState,
  FleetShowcaseSessionState,
  FleetShowcaseTarget,
} from "../../api/types";
import { BoltIcon } from "../ui/icons";
import { FleetShowcaseGrid } from "./FleetShowcaseGrid";
import { TerminalCard } from "./TerminalCard";
import { PROMPT_TYPES, pickShowcasePrompts, type ShowcasePromptType } from "./showcasePrompts";

export const FLEET_POLL_MS = 300;
const DEFAULT_TERMINALS = 2;
const TERMINAL_COUNTS = [1, 2, 3, 4, 6, 8];
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_TEMPERATURE = 0.7;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Fold one poll into the local session: full text replaces, appends extend.
 * Exported for tests.
 */
export function mergeFleetSession(
  prev: FleetShowcaseSessionState | null,
  next: FleetShowcaseSessionState
): FleetShowcaseSessionState {
  const same = prev && prev.sessionId === next.sessionId ? prev : null;
  const prevLanes = new Map((same?.lanes || []).map((l) => [l.laneId, l]));
  return {
    ...next,
    lanes: next.lanes.map((lane) => {
      const before = prevLanes.get(lane.laneId);
      const prevStreams = new Map((before?.streams || []).map((s) => [s.streamId, s]));
      return {
        ...lane,
        streams: lane.streams.map((s) => {
          const old = prevStreams.get(s.streamId);
          const full = typeof s.content === "string" || s.resetContent || !old;
          const content = full ? s.content ?? "" : (old?.content ?? "") + (s.contentAppend ?? "");
          const reasoning = full
            ? s.reasoning ?? ""
            : (old?.reasoning ?? "") + (s.reasoningAppend ?? "");
          return { ...s, content, reasoning, contentAppend: undefined, reasoningAppend: undefined };
        }),
      };
    }),
  };
}

function groupTargets(targets: FleetShowcaseTarget[]) {
  const groups = new Map<string, { key: string; title: string; kind: string; items: FleetShowcaseTarget[] }>();
  for (const t of targets) {
    const key = `${t.kind}:${t.nodeId}`;
    if (!groups.has(key)) groups.set(key, { key, title: t.nodeName, kind: t.kind, items: [] });
    groups.get(key)!.items.push(t);
  }
  return [...groups.values()];
}

/** Runs archived before SHOW2 have no server aggregates: fall back to the sum of lanes. */
function legacyFleetTps(lanes: FleetShowcaseLaneState[]) {
  return lanes.reduce((n, l) => n + (l.clientTps && l.clientTps > 0 ? l.clientTps : 0), 0);
}

const EST_TITLE =
  "Some token counts are estimated at ~4 chars/token (live counts, or an engine that sent no usage)";

function fmtAgg(v: number | null | undefined) {
  return typeof v === "number" && v > 0 ? v.toFixed(0) : "—";
}

export function FleetShowcasePage() {
  const [targets, setTargets] = useState<FleetShowcaseTarget[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [promptType, setPromptType] = useState<ShowcasePromptType>("mixed");
  const [terminals, setTerminals] = useState(DEFAULT_TERMINALS);
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS);
  const [temperature, setTemperature] = useState(DEFAULT_TEMPERATURE);
  const [thinking, setThinking] = useState(false);
  const [session, setSession] = useState<FleetShowcaseSessionState | null>(null);
  const [history, setHistory] = useState<FleetShowcaseHistorySummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [focusLane, setFocusLane] = useState<string | null>(null);

  const sessionRef = useRef<string | null>(null);
  const revRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const running = session?.status === "running" && !session.fromHistory;

  const stopPolling = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const data = await listFleetShowcase();
      setHistory(data.history || []);
      return data;
    } catch (err) {
      setError(errText(err));
      return null;
    }
  }, []);

  const pollLoop = useCallback(
    (sid: string) => {
      stopPolling();
      timerRef.current = setTimeout(async () => {
        if (sessionRef.current !== sid) return;
        try {
          const data = await getFleetShowcase(sid, { since: revRef.current ?? undefined });
          if (sessionRef.current !== sid) return;
          revRef.current = data.rev;
          setSession((prev) => mergeFleetSession(prev, data));
          if (data.status === "running" && !data.fromHistory) pollLoop(sid);
          else void refreshHistory();
        } catch (err) {
          setError(errText(err));
        }
      }, FLEET_POLL_MS);
    },
    [stopPolling, refreshHistory]
  );

  const follow = useCallback(
    (sid: string) => {
      sessionRef.current = sid;
      revRef.current = null;
      pollLoop(sid);
    },
    [pollLoop]
  );

  // Initial load: targets, history, and re-attach to a run already in flight.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await getFleetShowcaseTargets();
        if (!alive) return;
        setTargets(res.targets);
        setSelected(new Set(res.targets.filter((t) => t.available).map((t) => t.laneId)));
      } catch (err) {
        if (alive) setError(errText(err));
      } finally {
        if (alive) setTargetsLoading(false);
      }
      const list = await refreshHistory();
      if (alive && list?.active?.status === "running") follow(list.active.sessionId);
    })();
    return () => {
      alive = false;
      sessionRef.current = null;
      stopPolling();
    };
  }, [follow, refreshHistory, stopPolling]);

  const groups = useMemo(() => groupTargets(targets), [targets]);
  const chosen = targets.filter((t) => selected.has(t.laneId));
  const kinds = new Set(chosen.map((t) => t.kind));
  const canRun = chosen.length > 0 && !running && !starting;

  const toggle = (laneId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(laneId)) next.delete(laneId);
      else next.add(laneId);
      return next;
    });

  const handleRun = async () => {
    if (!canRun) return;
    setError(null);
    setStarting(true);
    try {
      const prompts = pickShowcasePrompts(promptType, terminals);
      const res = await startFleetShowcase({
        laneIds: chosen.map((t) => t.laneId),
        prompts,
        maxTokens,
        temperature,
        thinking,
        promptType,
      });
      setSession(null);
      follow(res.sessionId);
    } catch (err) {
      setError(errText(err));
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    const sid = sessionRef.current;
    if (!sid) return;
    try {
      const data = await cancelFleetShowcase(sid);
      setSession((prev) => mergeFleetSession(prev, data));
    } catch (err) {
      setError(errText(err));
    }
  };

  const openHistory = async (sid: string) => {
    stopPolling();
    sessionRef.current = sid;
    try {
      const data = await getFleetShowcase(sid);
      setSession(mergeFleetSession(null, data));
    } catch (err) {
      setError(errText(err));
    }
  };

  const handleClear = async () => {
    try {
      await clearFleetShowcaseHistory();
      await refreshHistory();
    } catch (err) {
      setError(errText(err));
    }
  };

  const selectLane = (laneId: string) => {
    setFocusLane(laneId);
    document.getElementById(`fleet-lane-${laneId}`)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  const lanes = session?.lanes || [];
  const fleetAgg = session?.aggregates?.fleet ?? null;
  const engineAggs = session?.aggregates?.engines ?? [];
  const totalTps = fleetAgg ? fleetAgg.tps ?? 0 : legacyFleetTps(lanes);
  const fleetEstimated = fleetAgg ? fleetAgg.estimated : lanes.some((l) => l.estimated || l.tokenSource === "estimate" || l.tokenSource === "mixed");

  return (
    <div className="showcase-page fleet-showcase-page">
      <div className="showcase-config">
        <div className="showcase-config__bar">
          <div className="showcase-config__title">
            <a href="/fleet" className="logo-pill showcase-brand" title="Back to the fleet">
              <BoltIcon className="showcase-brand__bolt" />
              <span>H.E.R.D.</span>
            </a>
            <div className="showcase-config__subtitle">
              <span className="showcase-config__name">Fleet</span>
              <span className="showcase-config__meta">
                <span className="showcase-config__meta-label">Prompt Showcase</span>
                <span>
                  · {chosen.length} lane{chosen.length === 1 ? "" : "s"} selected
                  {kinds.size === 2 ? " · Sparks + agents" : ""}
                </span>
              </span>
            </div>
          </div>
          <div className="showcase-config__controls">
            <label className="showcase-field">
              <span className="showcase-field__label">Prompts</span>
              <select
                value={promptType}
                disabled={running}
                onChange={(e) => setPromptType(e.target.value as ShowcasePromptType)}
              >
                {PROMPT_TYPES.map((p) => (
                  <option key={p.id} value={p.id} title={p.hint}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="showcase-field">
              <span className="showcase-field__label">Terminals / lane</span>
              <select value={terminals} disabled={running} onChange={(e) => setTerminals(Number(e.target.value))}>
                {TERMINAL_COUNTS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="showcase-field">
              <span className="showcase-field__label">Max tokens</span>
              <input
                type="number"
                min={64}
                max={2048}
                step={64}
                value={maxTokens}
                disabled={running}
                onChange={(e) => setMaxTokens(Math.max(64, Math.min(2048, Number(e.target.value) || 64)))}
              />
            </label>
            <label className="showcase-field">
              <span className="showcase-field__label">Temp</span>
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                disabled={running}
                onChange={(e) => setTemperature(Math.max(0, Math.min(2, Number(e.target.value) || 0)))}
              />
            </label>
            <label className="showcase-check">
              <input type="checkbox" checked={thinking} disabled={running} onChange={(e) => setThinking(e.target.checked)} />
              <span>Thinking</span>
            </label>
            <div className="showcase-config__actions">
              <button
                type="button"
                className="showcase-btn showcase-btn--primary"
                disabled={!canRun}
                onClick={() => void handleRun()}
              >
                {starting ? "Starting…" : "Run on fleet"}
              </button>
              {running && (
                <button type="button" className="showcase-btn showcase-btn--danger" onClick={() => void handleStop()}>
                  Stop
                </button>
              )}
              <button
                type="button"
                className={`showcase-btn showcase-btn--ghost${historyOpen ? " is-active" : ""}`}
                onClick={() => setHistoryOpen((o) => !o)}
              >
                History{history.length ? ` (${history.length})` : ""}
              </button>
            </div>
          </div>
        </div>

        <div className="fleet-showcase-picker" data-testid="fleet-showcase-picker">
          {targetsLoading ? (
            <span className="fleet-showcase-picker__empty">Loading lanes…</span>
          ) : !groups.length ? (
            <span className="fleet-showcase-picker__empty">
              No LLM endpoints found. Add LLM ports to a Spark, or run an engine on an agent node.
            </span>
          ) : (
            groups.map((g) => (
              <div key={g.key} className="fleet-showcase-picker__group">
                <span className="fleet-showcase-picker__node">
                  {g.title}
                  <span className="fleet-showcase-tile__kind">{g.kind === "spark" ? "Spark" : "agent"}</span>
                </span>
                {g.items.map((t) => (
                  <label
                    key={t.laneId}
                    className={`fleet-showcase-chip${selected.has(t.laneId) ? " is-on" : ""}${t.available ? "" : " is-off"}`}
                    title={`${t.host || "?"}:${t.port} · ${t.backend || "engine?"}${t.serverCounters ? "" : " · client timing only"}${t.available ? "" : " · not responding"}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(t.laneId)}
                      disabled={running}
                      onChange={() => toggle(t.laneId)}
                      aria-label={`${t.nodeName} port ${t.port}`}
                    />
                    <span className="font-tabular">:{t.port}</span>
                    <span className="fleet-showcase-chip__model">{t.modelId || t.backend || "unknown"}</span>
                    {!t.serverCounters ? <span className="fleet-showcase-chip__tag">client only</span> : null}
                  </label>
                ))}
              </div>
            ))
          )}
        </div>

        {historyOpen && (
          <div className="showcase-history">
            <div className="showcase-history__head">
              <span className="showcase-history__title">Past fleet runs</span>
              <div className="showcase-history__head-actions">
                <button type="button" className="showcase-btn showcase-btn--ghost" onClick={() => void refreshHistory()}>
                  Refresh
                </button>
                <button
                  type="button"
                  className="showcase-btn showcase-btn--ghost"
                  disabled={!history.length || running}
                  onClick={() => void handleClear()}
                >
                  Clear
                </button>
              </div>
            </div>
            {!history.length ? (
              <p className="showcase-history__empty">No fleet runs yet. Each finished run also writes one bench row per lane.</p>
            ) : (
              <ul className="showcase-history__list">
                {history.map((row) => (
                  <li key={row.sessionId} className="showcase-history__item">
                    <button
                      type="button"
                      className="showcase-history__main"
                      disabled={running}
                      onClick={() => void openHistory(row.sessionId)}
                    >
                      <span className="showcase-history__when">
                        {row.startedAt ? new Date(row.startedAt).toLocaleString() : "—"}
                      </span>
                      <span className="showcase-history__meta">
                        <span className={`showcase-history__status showcase-history__status--${row.status}`}>
                          {row.status}
                        </span>
                        <span>· {row.laneCount} lanes</span>
                        <span>· {row.streamsPerLane} term/lane</span>
                        {row.promptType ? <span>· {row.promptType}</span> : null}
                        {row.fleetTps != null && row.fleetTps > 0 ? (
                          <span data-testid="fleet-history-agg" title={row.fleetEstimated ? EST_TITLE : "Fleet concurrent-window aggregate"}>
                            · fleet {row.fleetEstimated ? "≈ " : ""}
                            {row.fleetTps.toFixed(0)} tok/s
                          </span>
                        ) : null}
                      </span>
                      <span className="showcase-history__model">
                        {row.lanes
                          .map(
                            (l) =>
                              `${l.nodeName}:${l.port} ${l.clientTps ? `${l.estimated ? "≈" : ""}${l.clientTps.toFixed(0)} tok/s` : "—"}`
                          )
                          .join(" · ")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error ? <p className="showcase-config__error">{error}</p> : null}
      </div>

      <div className="fleet-showcase-body">
        {lanes.length > 0 && (
          <div className="showcase-metrics" aria-live="polite">
            <div
              className="showcase-metrics__hero"
              data-testid="fleet-aggregate"
              title={
                fleetAgg
                  ? "Fleet concurrent window: Σ decode tokens of every lane / (last token − first token) (DecodeBench definition)"
                  : "Sum of lane client tok/s (run recorded before the concurrent-window aggregate)"
              }
            >
              <span className="showcase-metrics__label">
                Fleet
                {fleetEstimated && totalTps > 0 ? (
                  <span className="showcase-metrics__est" data-testid="fleet-aggregate-estimated" title={EST_TITLE}>
                    ≈ est.
                  </span>
                ) : null}
              </span>
              <span className="showcase-metrics__hero-value font-tabular">
                {totalTps > 0 ? totalTps.toFixed(0) : "—"}
                <span className="showcase-metrics__hero-unit">tok/s</span>
              </span>
              {fleetAgg?.peakTps != null && fleetAgg.peakTps > 0 ? (
                <span
                  className="showcase-metrics__sub"
                  data-testid="fleet-aggregate-peak"
                  title={fleetAgg.peakEstimated ? "Peak from live token counts estimated at ~4 chars/token" : "Highest fleet aggregate during the run"}
                >
                  peak {fleetAgg.peakEstimated ? "≈" : ""}
                  {fleetAgg.peakTps.toFixed(0)}
                </span>
              ) : null}
            </div>
            {engineAggs.length > 1
              ? engineAggs.map((e) => (
                  <div
                    key={e.engine}
                    className="showcase-metrics__item"
                    data-testid={`fleet-engine-agg-${e.engine}`}
                    title={`${e.engine}: concurrent window over ${e.laneIds.length} lane${e.laneIds.length === 1 ? "" : "s"}${e.estimated ? ` · ${EST_TITLE}` : ""}`}
                  >
                    <span className="showcase-metrics__label">
                      {e.engine}
                      {e.estimated && e.tps ? <span className="showcase-metrics__est">≈ est.</span> : null}
                    </span>
                    <span className="showcase-metrics__value font-tabular">
                      {fmtAgg(e.tps)}
                      <span className="showcase-metrics__unit"> tok/s</span>
                    </span>
                    {e.peakTps != null && e.peakTps > 0 ? (
                      <span className="showcase-metrics__sub">
                        peak {e.peakEstimated ? "≈" : ""}
                        {e.peakTps.toFixed(0)}
                      </span>
                    ) : null}
                  </div>
                ))
              : null}
            <span className="showcase-metrics__sep" aria-hidden>
              ·
            </span>
            <div className="showcase-metrics__item">
              <span className="showcase-metrics__label">Lanes</span>
              <span className="showcase-metrics__value font-tabular">
                {lanes.filter((l) => l.status === "completed").length}/{lanes.length}
              </span>
            </div>
            <span className="showcase-metrics__sep" aria-hidden>
              ·
            </span>
            <div className="showcase-metrics__item">
              <span className="showcase-metrics__label">Session</span>
              <span className="showcase-metrics__value">
                {session?.status}
                {session?.fromHistory ? " · history" : ""}
              </span>
            </div>
          </div>
        )}

        <FleetShowcaseGrid lanes={lanes} onSelectLane={selectLane} />

        {lanes.map((lane) => (
          <section
            key={lane.laneId}
            id={`fleet-lane-${lane.laneId}`}
            className={`fleet-showcase-lane${focusLane === lane.laneId ? " is-focused" : ""}`}
          >
            <h2 className="fleet-showcase-lane__title">
              {lane.nodeName}:{lane.port}
              <span className="fleet-showcase-lane__model">{lane.modelId || ""}</span>
            </h2>
            <div className="fleet-showcase-lane__terms">
              {lane.streams.map((s) => (
                <TerminalCard
                  key={s.streamId}
                  label={s.label}
                  status={s.status}
                  liveTokPerSec={s.liveTokPerSec}
                  peakTokPerSec={s.peakTokPerSec ?? s.liveTokPerSec}
                  content={s.content ?? ""}
                  reasoning={s.reasoning ?? ""}
                  error={s.error}
                  meta={s.ttftMs ? `TTFT ${Math.round(s.ttftMs)} ms` : null}
                  badge={(s.estimated ?? s.tokenSource === "estimate") && s.tokenCount > 0 ? "est." : null}
                  badgeTitle="Token count estimated at ~4 chars/token (live, or the engine sent no usage)"
                />
              ))}
            </div>
          </section>
        ))}

        {!lanes.length && !targetsLoading && (
          <p className="fleet-showcase-empty">
            Pick lanes above and press <strong>Run on fleet</strong>. Every lane gets the same prompts; tiles compare client
            tok/s (from the streams), server tok/s (engine counter, where it has one) and TTFT.
          </p>
        )}
      </div>
    </div>
  );
}
