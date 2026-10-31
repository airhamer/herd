import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cancelDecodeBench, getDecodeBench, listDecodeBench, startDecodeBench } from "../../api/client";
import type {
  DecodeBenchJob,
  DecodeBenchScope,
  HassoBatteryDefaults,
  HassoBatteryRun,
  HassoPart,
  LlmBenchTarget,
} from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";
import { formatLlmBaseUrl } from "../../shared/llmTarget.js";
import { formatDuration } from "./QualityBenchDialog";

/** Hasso battery v1 conditions; the server's defaults win when present. */
export const HASSO_FALLBACK: HassoBatteryDefaults = {
  suite: "hasso-battery-v1",
  suiteVersion: "1",
  batteryVersion: 1,
  parts: ["bench", "matrix"],
  runsPerProbe: 2,
  benchProbes: [
    { key: "code", name: "code (greedy, deterministic)", temperature: 0, maxTokens: 1200, inMedian: true },
    { key: "reasoning", name: "reasoning (greedy, deterministic)", temperature: 0, maxTokens: 1200, inMedian: true },
    { key: "math_peak", name: "math peak (temp 0.6, like SGLang's eval setting)", temperature: 0.6, maxTokens: 2048, inMedian: false },
    { key: "prose", name: "free prose (greedy, worst-case, excluded from median)", temperature: 0, maxTokens: 800, inMedian: false },
  ],
  matrixProbes: [
    { key: "math_en", name: "math (EN, eval-style)", lang: "EN" },
    { key: "code_en", name: "code (EN)", lang: "EN" },
    { key: "code_de", name: "code (DE)", lang: "DE" },
    { key: "tech_fr", name: "technical explain (FR)", lang: "FR" },
    { key: "reasoning_fr", name: "reasoning (FR)", lang: "FR" },
    { key: "prose_en", name: "free prose (EN)", lang: "EN" },
    { key: "prose_fr", name: "free prose (FR)", lang: "FR" },
    { key: "prose_de", name: "free prose (DE)", lang: "DE" },
  ],
  matrixMaxTokens: [80, 680],
  minDeltaTokens: 50,
  minDeltaS: 2,
  requests: 25,
};

const PART_LABEL: Record<HassoPart, string> = { bench: "bench.sh", matrix: "bench-matrix.sh" };

/** Requests a run sends: probes × runs for bench.sh; warm-up + 2 per workload for the matrix. */
export function hassoRequests(parts: HassoPart[], d: HassoBatteryDefaults = HASSO_FALLBACK): number {
  let n = 0;
  if (parts.includes("bench")) n += d.benchProbes.length * d.runsPerProbe;
  if (parts.includes("matrix")) n += 1 + d.matrixProbes.length * 2;
  return n;
}

const isHasso = (j: DecodeBenchJob | null | undefined): j is DecodeBenchJob =>
  !!j && j.config?.protocol === "hasso-battery-v1";

function fmt(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(digits);
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** bench.sh: each probe's two runs, its median, and whether it counts toward the greedy median. */
export function HassoBenchTable({ bench }: { bench: NonNullable<HassoBatteryRun["bench"]> }) {
  return (
    <table className="quality-table aeon-table" data-testid="hasso-bench-table">
      <thead>
        <tr>
          <th scope="col">Probe</th>
          <th scope="col" className="num">Temp</th>
          <th scope="col" className="num">Max tok</th>
          <th scope="col" className="num">Run 1</th>
          <th scope="col" className="num">Run 2</th>
          <th scope="col" className="num">Median</th>
          <th scope="col">Greedy median</th>
        </tr>
      </thead>
      <tbody>
        {bench.probes.map((p) => (
          <tr key={p.key}>
            <th scope="row" title={p.name}>
              {p.key}
            </th>
            <td className="num">{p.temperature}</td>
            <td className="num">{p.maxTokens}</td>
            {[0, 1].map((i) => {
              const r = p.runs[i];
              return (
                <td key={i} className="num">
                  {!r ? "…" : r.tps == null ? "not timed" : fmt(r.tps)}
                </td>
              );
            })}
            <td className="num">{fmt(p.median)}</td>
            <td>{p.inMedian ? "in" : p.key === "prose" ? "excluded (worst case)" : "excluded"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** bench-matrix.sh: two-call delta per workload; refused samples show why, never a number. */
export function HassoMatrixTable({ matrix }: { matrix: NonNullable<HassoBatteryRun["matrix"]> }) {
  return (
    <table className="quality-table aeon-table" data-testid="hasso-matrix-table">
      <thead>
        <tr>
          <th scope="col">Workload (battery v{matrix.batteryVersion})</th>
          <th scope="col" className="num">80 tok</th>
          <th scope="col" className="num">680 tok</th>
          <th scope="col" className="num">Δtok</th>
          <th scope="col" className="num">Δt</th>
          <th scope="col" className="num">tok/s</th>
        </tr>
      </thead>
      <tbody>
        {matrix.probes.map((p) => (
          <tr key={p.key}>
            <th scope="row">{p.name}</th>
            <td className="num">
              {p.short.tokens} · {fmt(p.short.wallS, 2)} s
            </td>
            <td className="num">
              {p.long.tokens} · {fmt(p.long.wallS, 2)} s
            </td>
            <td className="num">{p.deltaTokens}</td>
            <td className="num">{fmt(p.deltaS, 2)} s</td>
            <td
              className={`num${p.reliable ? " aeon-table__agg" : " quality-errored"}`}
              title={p.reason ?? undefined}
            >
              {p.reliable ? fmt(p.tps) : "refused"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface HassoBatteryDialogProps {
  open: boolean;
  onClose: () => void;
  /** Spark id, or agent node id when scope is "node". */
  targetId: string;
  scope: DecodeBenchScope;
  port: number;
  modelId: string | null;
  remoteTarget?: LlmBenchTarget | null;
  title?: string | null;
}

/**
 * Hasso battery v1 (BENCH4): bench.sh's streamed probes and greedy median,
 * then bench-matrix.sh's two-call delta over the frozen 8-workload battery.
 * Runs DecodeBench with protocol "hasso-battery-v1".
 */
export function HassoBatteryDialog({
  open,
  onClose,
  targetId,
  scope,
  port,
  modelId,
  remoteTarget = null,
  title = null,
}: HassoBatteryDialogProps) {
  const [defaults, setDefaults] = useState<HassoBatteryDefaults>(HASSO_FALLBACK);
  const [parts, setParts] = useState<HassoPart[]>([...HASSO_FALLBACK.parts]);
  const [job, setJob] = useState<DecodeBenchJob | null>(null);
  const [history, setHistory] = useState<DecodeBenchJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startLockRef = useRef(false);
  const benchPort = remoteTarget?.port ?? port;
  const { mounted, visible } = useModalPresence(open);
  const isRunning = job?.status === "running";

  const stopPoll = useCallback(() => {
    if (pollRef.current != null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refreshHistory = useCallback(() => {
    return listDecodeBench(targetId, benchPort, scope).then((data) => {
      if (data.defaults?.hasso) setDefaults(data.defaults.hasso);
      setHistory((data.history || []).filter(isHasso));
      return data;
    });
  }, [targetId, benchPort, scope]);

  const startPolling = useCallback(
    (benchId: string) => {
      stopPoll();
      pollRef.current = setInterval(() => {
        void getDecodeBench(targetId, benchId, scope)
          .then((j) => {
            setJob(j);
            if (j.status !== "running") {
              stopPoll();
              void refreshHistory().catch(() => undefined);
            }
          })
          .catch((err: Error) => {
            setError(err.message);
            stopPoll();
          });
      }, 1000);
    },
    [targetId, scope, stopPoll, refreshHistory]
  );

  useEffect(() => {
    if (!open) {
      stopPoll();
      return;
    }
    let cancelled = false;
    setError(null);
    setLoading(true);
    refreshHistory()
      .then((data) => {
        if (cancelled) return;
        if (isHasso(data.active)) {
          setJob(data.active);
          if (data.active.status === "running") startPolling(data.active.benchId);
          return;
        }
        setJob((data.history || []).find(isHasso) || null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      stopPoll();
    };
  }, [open, refreshHistory, startPolling, stopPoll]);

  useEffect(() => {
    if (!open || isRunning || starting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, isRunning, starting, onClose]);

  const toggle = (p: HassoPart) => {
    setParts((prev) => {
      if (prev.includes(p)) return prev.length === 1 ? prev : prev.filter((x) => x !== p);
      return defaults.parts.filter((x) => x === p || prev.includes(x));
    });
  };

  const handleStart = async () => {
    if (startLockRef.current) return;
    startLockRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const started = await startDecodeBench(
        targetId,
        {
          protocol: "hasso-battery-v1",
          port: benchPort,
          concurrencies: [1],
          parts,
          modelId: modelId || undefined,
          ...(remoteTarget ? { host: remoteTarget.host, tls: remoteTarget.tls } : {}),
        },
        scope
      );
      setJob(started);
      setConfiguring(false);
      startPolling(started.benchId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      startLockRef.current = false;
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!job || job.status !== "running") return;
    try {
      setJob(await cancelDecodeBench(targetId, job.benchId, scope));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!mounted) return null;

  const showConfig = !loading && !isRunning && (configuring || !job);
  const hasso = job?.hasso ?? null;
  const done = job?.progress.requestsDone ?? 0;
  const total = job?.progress.requestsTotal ?? job?.config.requests ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const refused = hasso?.matrix?.probes.filter((p) => !p.reliable).length ?? 0;
  const subtitle = `${remoteTarget ? formatLlmBaseUrl(remoteTarget) : `${title ? `${title} · ` : ""}Port ${benchPort}`}${
    modelId ? ` · ${modelId}` : ""
  }`;

  const dialog = (
    <div className={`bench-overlay${visible ? " is-open" : ""}`} role="presentation">
      <button
        type="button"
        className="bench-overlay__scrim"
        aria-label="Close dialog"
        onClick={() => {
          if (!isRunning) onClose();
        }}
      />
      <div className="bench-sheet quality-sheet aeon-sheet hasso-sheet" role="dialog" aria-modal="true" aria-labelledby="hasso-battery-title">
        <header className="bench-sheet__header">
          <div className="bench-sheet__header-text">
            <h2 id="hasso-battery-title" className="bench-sheet__title">
              Hasso battery v{defaults.batteryVersion}
            </h2>
            <p className="bench-sheet__subtitle">{subtitle}</p>
          </div>
          <button type="button" className="bench-sheet__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="bench-sheet__body">
          {loading && <p className="bench-sheet__hint">Loading runs…</p>}

          {showConfig && (
            <section className="bench-sheet__section">
              <div className="bench-field">
                <div className="bench-field__head">
                  <h3 className="bench-sheet__section-title">Parts</h3>
                  <p className="bench-sheet__hint">
                    <strong>bench.sh</strong>: {defaults.benchProbes.length} streamed probes × {defaults.runsPerProbe} runs,
                    single stream; greedy median of code + reasoning (math at temperature 0.6 and free prose reported,
                    never in the median). <strong>bench-matrix.sh</strong>: frozen battery v{defaults.batteryVersion},{" "}
                    {defaults.matrixProbes.length} workloads in EN/FR/DE, greedy, one discarded warm-up, then{" "}
                    {defaults.matrixMaxTokens[0]} vs {defaults.matrixMaxTokens[1]} max tokens per workload — decode net
                    of prefill. Samples with Δtok &lt; {defaults.minDeltaTokens} or Δt &lt; {defaults.minDeltaS} s are
                    refused.
                  </p>
                </div>
                <div className="bench-conc-grid" role="group" aria-label="Hasso battery parts">
                  {defaults.parts.map((p) => {
                    const on = parts.includes(p);
                    return (
                      <button
                        key={p}
                        type="button"
                        aria-pressed={on}
                        disabled={starting}
                        onClick={() => toggle(p)}
                        className={`bench-conc-btn${on ? " is-on" : ""}`}
                      >
                        {PART_LABEL[p]}
                      </button>
                    );
                  })}
                </div>
              </div>
              <p className="bench-sheet__hint" data-testid="hasso-request-count">
                {hassoRequests(parts, defaults)} requests · single stream
              </p>
            </section>
          )}

          {error && <p className="bench-sheet__error">{error}</p>}

          {job && isRunning && (
            <section className="bench-sheet__section">
              <div className="bench-progress">
                <div className="bench-progress__row">
                  <span className="bench-progress__status">{job.progress.message || "Running"}</span>
                  <span className="bench-progress__meta">
                    {done}/{total} · {formatDuration(job.durationMs)}
                  </span>
                </div>
                <div className="bench-progress__track">
                  <div className="bench-progress__fill" style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
              </div>
            </section>
          )}

          {job && !showConfig && hasso && (hasso.bench || hasso.matrix) && (
            <section className="bench-sheet__section">
              {!isRunning && (
                <div className="bench-status-row">
                  <span className={`bench-status-pill bench-status-pill--${job.status}`}>
                    {job.status.charAt(0).toUpperCase() + job.status.slice(1)}
                  </span>
                  <span className="bench-status-meta">
                    {formatWhen(job.startedAt)}
                    {job.config.modelId ? ` · ${job.config.modelId}` : ""} · {formatDuration(job.durationMs)}
                  </span>
                </div>
              )}
              {job.error ? <p className="bench-sheet__error">{job.error}</p> : null}
              {hasso.bench && (
                <>
                  <h3 className="bench-sheet__section-title">
                    bench.sh · greedy median{" "}
                    <span className="hasso-headline" data-testid="hasso-greedy-median">
                      {fmt(hasso.bench.greedyMedian)} tok/s
                    </span>
                    {hasso.bench.untimed ? (
                      <span className="bench-sheet__hint"> ({hasso.bench.untimed} run(s) not timed, left out)</span>
                    ) : null}
                  </h3>
                  <HassoBenchTable bench={hasso.bench} />
                </>
              )}
              {hasso.matrix && (
                <>
                  <h3 className="bench-sheet__section-title">
                    bench-matrix.sh · decode net of prefill
                    {refused ? <span className="bench-sheet__hint"> ({refused} unreliable sample(s) refused)</span> : null}
                  </h3>
                  <HassoMatrixTable matrix={hasso.matrix} />
                </>
              )}
              <p className="bench-legend">
                <strong>Greedy median</strong> — <code>hasso.single_stream_greedy_median.v1</code>: per streamed run
                (out − 1) ÷ (last token − first token), median of the timed code + reasoning runs. Probes —{" "}
                <code>hasso.bench_probe_median.v1</code>. <strong>Matrix</strong> —{" "}
                <code>hasso.matrix_two_call_delta.v1</code>: (tokens₆₈₀ − tokens₈₀) ÷ (wall₆₈₀ − wall₈₀), not streamed;
                a refused sample is stored without a value. Rows: <code>hasso.bench.*</code>,{" "}
                <code>hasso.matrix.*</code>, suite <code>hasso-battery-v1</code> v1.
              </p>
            </section>
          )}

          {!isRunning && history.length > 0 && (
            <section className="bench-sheet__section">
              <h3 className="bench-sheet__section-title">Runs</h3>
              <ul className="quality-runs">
                {history.map((h) => (
                  <li key={h.benchId}>
                    <button
                      type="button"
                      className={`quality-run${job?.benchId === h.benchId && !showConfig ? " is-on" : ""}`}
                      onClick={() => {
                        setConfiguring(false);
                        setJob(h);
                      }}
                    >
                      <span>{formatWhen(h.startedAt)}</span>
                      <span className="quality-run__model">{h.config.modelId || "unknown model"}</span>
                      <span className="quality-run__cats">
                        {(h.config.parts ?? []).map((p) => PART_LABEL[p]).join(" + ")}
                      </span>
                      <strong>{fmt(h.hasso?.bench?.greedyMedian)} tok/s</strong>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <footer className="bench-sheet__footer">
          {isRunning ? (
            <button type="button" className="bench-btn bench-btn--ghost" onClick={() => void handleCancel()}>
              Cancel
            </button>
          ) : showConfig ? (
            <>
              <button
                type="button"
                className="bench-btn bench-btn--ghost"
                onClick={() => (job ? setConfiguring(false) : onClose())}
              >
                {job ? "Back" : "Close"}
              </button>
              <button
                type="button"
                className="bench-btn bench-btn--primary"
                onClick={() => void handleStart()}
                disabled={starting || parts.length === 0}
              >
                {starting ? "Starting…" : "Run battery"}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="bench-btn bench-btn--ghost" onClick={() => setConfiguring(true)}>
                New run
              </button>
              <button type="button" className="bench-btn bench-btn--primary" onClick={onClose}>
                Done
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
