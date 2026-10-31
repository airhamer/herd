import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  cancelQualityBench,
  compareQualityBench,
  getQualityBench,
  listQualityBench,
  startQualityBench,
} from "../../api/client";
import type {
  LlmBenchTarget,
  QualityBenchJob,
  QualityCategoryKey,
  QualityCategoryScore,
  QualityCompareResponse,
  QualityMcNemar,
  QualityRunSummary,
} from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";
import {
  QUALITY_CATEGORIES,
  QUALITY_CONCURRENCY_OPTIONS,
  QUALITY_DEFAULT_CATEGORIES,
  QUALITY_DEFAULT_CONCURRENCY,
  qualityRequestCount,
} from "../../shared/qualityBench.js";
import { formatLlmBaseUrl } from "../../shared/llmTarget.js";

interface QualityBenchDialogProps {
  open: boolean;
  onClose: () => void;
  sparkId: string;
  llmPort: number;
  modelId: string | null;
  remoteTarget?: LlmBenchTarget | null;
}

function useEscape(onClose: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, enabled]);
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

function formatPct(v: number | null | undefined): string {
  return v == null ? "—" : `${v.toFixed(1)}%`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** "within noise" / "better" / "worse" for a McNemar result. */
export function mcnemarVerdict(m: QualityMcNemar | null | undefined): "noise" | "better" | "worse" | null {
  if (!m || m.paired === 0) return null;
  if (m.within_noise) return "noise";
  return m.candidate_only > m.baseline_only ? "better" : "worse";
}

export function formatP(p: number): string {
  if (p >= 0.01) return p.toFixed(2);
  if (p >= 0.001) return p.toFixed(3);
  return "<0.001";
}

function McNemarBadge({ m }: { m: QualityMcNemar | null | undefined }) {
  const v = mcnemarVerdict(m);
  if (!m || !v) return <span className="quality-badge">—</span>;
  const text = v === "noise" ? "within noise" : v === "better" ? "significant ↑" : "significant ↓";
  return (
    <span
      className={`quality-badge quality-badge--${v}`}
      title={`McNemar exact p = ${m.p} · ${m.paired} paired items · ${m.candidate_only} newly passed, ${m.baseline_only} newly failed`}
    >
      p {formatP(m.p)} · {text}
    </span>
  );
}

function statusLabel(status: string | null): string {
  if (!status) return "Unknown";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function runLabel(r: QualityRunSummary): string {
  return `${formatWhen(r.startedAt)} · ${r.modelId || "unknown model"} · ${formatPct(r.overall)}`;
}

/** A finished job before it shows up in the store (no store or still writing). */
function summaryFromJob(job: QualityBenchJob): QualityRunSummary {
  return {
    benchId: job.benchId,
    runId: `quality:${job.benchId}`,
    status: job.summary.itemsErrored > 0 && job.status === "completed" ? "partial" : job.status,
    startedAt: new Date(job.startedAt).toISOString(),
    completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null,
    modelId: job.config.modelId,
    engine: null,
    hwBucket: null,
    concurrency: job.config.concurrency,
    categories: job.summary.categories,
    overall: job.summary.overall,
    itemsScored: job.summary.itemsScored,
    itemsErrored: job.summary.itemsErrored,
    passed: job.summary.passed,
    durationMs: job.durationMs,
    suiteVersion: job.config.suiteVersion,
  };
}

function CategoryTable({
  categories,
  compare,
}: {
  categories: QualityCategoryScore[];
  compare: QualityCompareResponse | null;
}) {
  return (
    <table className="quality-table">
      <thead>
        <tr>
          <th scope="col">Category</th>
          <th scope="col" className="num">Score</th>
          <th scope="col" className="num">Passed</th>
          {compare && <th scope="col" className="num">Baseline</th>}
          {compare && <th scope="col" className="num">Δ</th>}
          {compare && <th scope="col">McNemar</th>}
        </tr>
      </thead>
      <tbody>
        {categories.map((c) => {
          const cmp = compare?.categories.find((x) => x.key === c.key) ?? null;
          return (
            <tr key={c.key}>
              <th scope="row">{c.label}</th>
              <td className="num">
                <strong>{formatPct(c.accuracy)}</strong>
              </td>
              <td className="num" title={c.errored ? `${c.errored} request(s) failed and were not scored` : undefined}>
                {c.passed}/{c.scored}
                {c.errored ? <span className="quality-errored"> ({c.errored} err)</span> : null}
              </td>
              {compare && <td className="num">{cmp ? formatPct(cmp.baseline) : "—"}</td>}
              {compare && (
                <td className={`num quality-delta${cmp?.delta != null && cmp.delta !== 0 ? (cmp.delta > 0 ? " is-up" : " is-down") : ""}`}>
                  {cmp?.delta != null ? `${cmp.delta > 0 ? "+" : ""}${cmp.delta.toFixed(1)}` : "—"}
                </td>
              )}
              {compare && <td>{cmp ? <McNemarBadge m={cmp.mcnemar} /> : "—"}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function QualityBenchDialog({
  open,
  onClose,
  sparkId,
  llmPort,
  modelId,
  remoteTarget = null,
}: QualityBenchDialogProps) {
  const [selected, setSelected] = useState<QualityCategoryKey[]>([...QUALITY_DEFAULT_CATEGORIES] as QualityCategoryKey[]);
  const [concurrency, setConcurrency] = useState<number>(QUALITY_DEFAULT_CONCURRENCY);
  const [job, setJob] = useState<QualityBenchJob | null>(null);
  const [runs, setRuns] = useState<QualityRunSummary[]>([]);
  const [viewId, setViewId] = useState<string | null>(null);
  const [baselineId, setBaselineId] = useState<string>("");
  const [compare, setCompare] = useState<QualityCompareResponse | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const benchPort = remoteTarget?.port ?? llmPort;
  const { mounted, visible } = useModalPresence(open);
  const isRunning = job?.status === "running";
  useEscape(onClose, open && !starting);

  const stopPoll = useCallback(() => {
    if (pollRef.current != null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refreshRuns = useCallback(
    async (focus?: string) => {
      const data = await listQualityBench(sparkId);
      setRuns(data.runs);
      if (data.active) setJob(data.active);
      if (focus) setViewId(focus);
      else if (!data.active) setViewId((prev) => prev ?? data.runs[0]?.benchId ?? null);
      return data;
    },
    [sparkId]
  );

  const startPolling = useCallback(
    (benchId: string) => {
      stopPoll();
      pollRef.current = setInterval(() => {
        void getQualityBench(sparkId, benchId)
          .then((j) => {
            setJob(j);
            if (j.status !== "running") {
              stopPoll();
              void refreshRuns(j.benchId).catch(() => undefined);
            }
          })
          .catch((err: Error) => {
            stopPoll();
            setError(
              err.message === "Benchmark not found"
                ? "Benchmark interrupted — server restarted during the run"
                : err.message
            );
            void refreshRuns().catch(() => undefined);
          });
      }, 1000);
    },
    [sparkId, stopPoll, refreshRuns]
  );

  useEffect(() => {
    if (!open) {
      stopPoll();
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setConfiguring(false);
    listQualityBench(sparkId)
      .then((data) => {
        if (cancelled) return;
        setRuns(data.runs);
        if (data.active) {
          setJob(data.active);
          setSelected(data.active.config.categories);
          setConcurrency(data.active.config.concurrency);
          startPolling(data.active.benchId);
        } else {
          setJob(null);
          setViewId(data.runs[0]?.benchId ?? null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sparkId, startPolling, stopPoll]);

  useEffect(() => () => stopPoll(), [stopPoll]);

  const view: QualityRunSummary | null = useMemo(() => {
    if (isRunning) return null;
    const stored = runs.find((r) => r.benchId === viewId) ?? null;
    if (stored) return stored;
    if (job && job.benchId === viewId) return summaryFromJob(job);
    return null;
  }, [runs, viewId, job, isRunning]);

  // Default baseline: the previous run before the one on screen.
  useEffect(() => {
    if (!view) return;
    const older = runs.filter((r) => r.benchId !== view.benchId && (r.startedAt ?? "") <= (view.startedAt ?? ""));
    setBaselineId(older[0]?.benchId ?? "");
  }, [view?.benchId, runs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!view || !baselineId || baselineId === view.benchId) {
      setCompare(null);
      return;
    }
    let cancelled = false;
    compareQualityBench(sparkId, baselineId, view.benchId)
      .then((c) => {
        if (!cancelled) setCompare(c);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setCompare(null);
          setError(err.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sparkId, view?.benchId, baselineId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleCategory = (key: QualityCategoryKey) => {
    if (isRunning || starting) return;
    setSelected((prev) => {
      if (prev.includes(key)) return prev.length === 1 ? prev : prev.filter((k) => k !== key);
      return QUALITY_CATEGORIES.map((c) => c.key as QualityCategoryKey).filter((k) => k === key || prev.includes(k));
    });
  };

  const startLockRef = useRef(false);
  const handleStart = async () => {
    if (startLockRef.current) return;
    startLockRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const started = await startQualityBench(sparkId, {
        port: benchPort,
        categories: selected,
        concurrency,
        modelId: modelId || undefined,
        ...(remoteTarget ? { host: remoteTarget.host, tls: remoteTarget.tls } : {}),
      });
      setJob(started);
      setConfiguring(false);
      setViewId(started.benchId);
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
      setJob(await cancelQualityBench(sparkId, job.benchId));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!mounted) return null;

  const showConfig = !loading && !isRunning && (configuring || (!view && !job));
  const requestCount = qualityRequestCount(selected);
  const progressPct = job && job.progress.total > 0 ? Math.round((job.progress.done / job.progress.total) * 100) : 0;
  const baselineChoices = view ? runs.filter((r) => r.benchId !== view.benchId) : [];

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
      <div className="bench-sheet quality-sheet" role="dialog" aria-modal="true" aria-labelledby="quality-bench-title">
        <header className="bench-sheet__header">
          <div className="bench-sheet__header-text">
            <h2 id="quality-bench-title" className="bench-sheet__title">
              Quality benchmark
            </h2>
            <p className="bench-sheet__subtitle">
              {remoteTarget ? formatLlmBaseUrl(remoteTarget) : `Port ${llmPort}`}
              {modelId ? ` · ${modelId}` : ""}
            </p>
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
                  <h3 className="bench-sheet__section-title">Categories</h3>
                  <p className="bench-sheet__hint">
                    Greedy (temperature 0), fixed seed, thinking off. Overall = mean of category %.
                  </p>
                </div>
                <div className="bench-conc-grid quality-cat-grid" role="group" aria-label="Quality categories">
                  {QUALITY_CATEGORIES.map((c) => {
                    const key = c.key as QualityCategoryKey;
                    const on = selected.includes(key);
                    return (
                      <button
                        key={c.key}
                        type="button"
                        aria-pressed={on}
                        disabled={starting}
                        title={c.source}
                        onClick={() => toggleCategory(key)}
                        className={`bench-conc-btn${on ? " is-on" : ""}`}
                      >
                        {c.label} <span className="quality-cat-count">{c.count}</span>
                        {c.optIn ? <span className="quality-cat-optin"> opt-in</span> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="bench-field">
                <div className="bench-field__head">
                  <h3 className="bench-sheet__section-title">Concurrency</h3>
                  <p className="bench-sheet__hint">
                    Parallel requests. Batching can change greedy outputs slightly, so compare runs at the same concurrency.
                  </p>
                </div>
                <div className="bench-conc-grid" role="group" aria-label="Concurrency">
                  {QUALITY_CONCURRENCY_OPTIONS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={concurrency === n}
                      disabled={starting}
                      onClick={() => setConcurrency(n)}
                      className={`bench-conc-btn${concurrency === n ? " is-on" : ""}`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <p className="bench-sheet__hint" data-testid="quality-request-count">
                {requestCount.toLocaleString()} requests
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
                    {job.progress.done}/{job.progress.total}
                    {job.progress.errored ? ` · ${job.progress.errored} errors` : ""} · {formatDuration(job.durationMs)}
                  </span>
                </div>
                <div className="bench-progress__track">
                  <div className="bench-progress__fill" style={{ width: `${Math.min(100, progressPct)}%` }} />
                </div>
              </div>
              <CategoryTable categories={job.summary.categories.filter((c) => c.attempted > 0)} compare={null} />
            </section>
          )}

          {view && !showConfig && (
            <section className="bench-sheet__section">
              <div className="bench-status-row">
                <span className={`bench-status-pill bench-status-pill--${view.status === "partial" ? "failed" : view.status}`}>
                  {statusLabel(view.status)}
                </span>
                <span className="bench-status-meta">
                  {formatWhen(view.startedAt)}
                  {view.modelId ? ` · ${view.modelId}` : ""}
                  {view.concurrency ? ` · c${view.concurrency}` : ""}
                  {view.durationMs != null ? ` · ${formatDuration(view.durationMs)}` : ""}
                </span>
              </div>
              {job && job.benchId === view.benchId && job.error ? <p className="bench-sheet__error">{job.error}</p> : null}

              <div className="quality-overall">
                <div>
                  <span className="quality-overall__label">Overall</span>
                  <span className="quality-overall__value">{formatPct(view.overall)}</span>
                </div>
                {compare && (
                  <div className="quality-overall__cmp">
                    <span>
                      vs {formatPct(compare.overall.baseline)} ({compare.overall.delta != null && compare.overall.delta > 0 ? "+" : ""}
                      {compare.overall.delta?.toFixed(1) ?? "—"})
                    </span>
                    <McNemarBadge m={compare.overall.mcnemar} />
                  </div>
                )}
              </div>

              <div className="quality-baseline">
                <label htmlFor="quality-baseline-select">Compare with</label>
                <select
                  id="quality-baseline-select"
                  className="bench-input"
                  value={baselineId}
                  onChange={(e) => setBaselineId(e.target.value)}
                >
                  <option value="">No baseline</option>
                  {baselineChoices.map((r) => (
                    <option key={r.benchId} value={r.benchId}>
                      {runLabel(r)}
                    </option>
                  ))}
                </select>
              </div>

              <CategoryTable categories={view.categories} compare={compare} />

              {compare && compare.warnings.length > 0 && (
                <ul className="quality-warnings">
                  {compare.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              {compare && (compare.regressed.length > 0 || compare.improved.length > 0) && (
                <p className="bench-legend">
                  <strong>{compare.improved.length}</strong> item(s) newly passed,{" "}
                  <strong>{compare.regressed.length}</strong> newly failed
                  {compare.regressed.length ? ` (e.g. ${compare.regressed.slice(0, 4).join(", ")})` : ""}.
                </p>
              )}
              <p className="bench-legend">
                <strong>McNemar</strong> — exact two-sided test on items scored in both runs; p ≥{" "}
                {compare?.noiseP ?? 0.05} means the difference is within noise. Failed requests are not scored.
              </p>
            </section>
          )}

          {!isRunning && runs.length > 0 && (
            <section className="bench-sheet__section">
              <h3 className="bench-sheet__section-title">Runs</h3>
              <ul className="quality-runs">
                {runs.map((r) => (
                  <li key={r.benchId}>
                    <button
                      type="button"
                      className={`quality-run${view?.benchId === r.benchId && !showConfig ? " is-on" : ""}`}
                      onClick={() => {
                        setConfiguring(false);
                        setViewId(r.benchId);
                      }}
                    >
                      <span>{formatWhen(r.startedAt)}</span>
                      <span className="quality-run__model">{r.modelId || "unknown model"}</span>
                      <span className="quality-run__cats">{r.categories.length} cat · c{r.concurrency ?? "?"}</span>
                      <strong>{formatPct(r.overall)}</strong>
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
                onClick={() => (view ? setConfiguring(false) : onClose())}
              >
                {view ? "Back" : "Close"}
              </button>
              <button
                type="button"
                className="bench-btn bench-btn--primary"
                onClick={() => void handleStart()}
                disabled={starting || selected.length === 0}
              >
                {starting ? "Starting…" : "Run benchmark"}
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
