import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  cancelDecodeBench,
  getDecodeBench,
  listDecodeBench,
  startDecodeBench,
} from "../../api/client";
import type {
  AeonCell,
  AeonLadderDefaults,
  AeonLevel,
  DecodeBenchJob,
  DecodeBenchScope,
  LlmBenchTarget,
} from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";
import { formatLlmBaseUrl } from "../../shared/llmTarget.js";
import { formatDuration } from "./QualityBenchDialog";

/** AEON aeon-perf-v1 conditions; the server's defaults win when present. */
export const AEON_FALLBACK: AeonLadderDefaults = {
  suite: "aeon-perf-v1",
  suiteVersion: "1",
  ladder: [1, 4, 8, 16, 32],
  maxTokens: 256,
  temperature: 0,
  categories: ["Math", "Reasoning", "Coding", "Prose", "Instruction"],
  promptsPerCategory: 4,
  requests: 320,
};

/** Requests a ladder sends: categories × max(prompts, c) per rung. */
export function aeonRequests(ladder: number[], d: AeonLadderDefaults = AEON_FALLBACK): number {
  return ladder.reduce((s, c) => s + d.categories.length * Math.max(d.promptsPerCategory, c), 0);
}

const isAeon = (j: DecodeBenchJob | null | undefined): j is DecodeBenchJob =>
  !!j && j.config?.protocol === "aeon-perf-v1";

function fmt(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(digits);
}

function formatWhen(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

interface AeonLadderDialogProps {
  open: boolean;
  onClose: () => void;
  /** Spark id, or agent node id when scope is "node". */
  targetId: string;
  scope: DecodeBenchScope;
  port: number;
  modelId: string | null;
  remoteTarget?: LlmBenchTarget | null;
  /** Unit / node display name. */
  title?: string | null;
}

/** Level table: both aggregates side by side, never merged. */
export function AeonLevelTable({ levels }: { levels: AeonLevel[] }) {
  return (
    <table className="quality-table aeon-table" data-testid="aeon-level-table">
      <thead>
        <tr>
          <th scope="col">Conc</th>
          <th scope="col" className="num" title="aeon.wave_peak_concurrent_window.v1">
            Agg peak window
          </th>
          <th scope="col" className="num" title="aeon.agg_saturated_est.v1">
            Agg Σ (decode×c)
          </th>
          <th scope="col" className="num">Decode/stream</th>
          <th scope="col" className="num">TTFT p50</th>
          <th scope="col" className="num">Prefill</th>
          <th scope="col" className="num">Errors</th>
        </tr>
      </thead>
      <tbody>
        {levels.map((lv) => (
          <tr key={lv.conc}>
            <th scope="row">c{lv.conc}</th>
            <td className="num aeon-table__agg">{fmt(lv.overall.agg_decode_tps)}</td>
            <td className="num">{fmt(lv.overall.agg_saturated_est)}</td>
            <td className="num">{fmt(lv.overall.decode_tps_mean)}</td>
            <td className="num">{lv.overall.ttft_ms_p50 == null ? "—" : `${Math.round(lv.overall.ttft_ms_p50)} ms`}</td>
            <td className="num">{fmt(lv.overall.prefill_tps_mean, 0)}</td>
            <td className={`num${lv.overall.n_errors ? " quality-errored" : ""}`}>
              {lv.overall.n_errors}/{lv.overall.n + lv.overall.n_errors}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Per-category peak window at each level (the cells AEON publishes). */
export function AeonCategoryTable({ levels, categories }: { levels: AeonLevel[]; categories: string[] }) {
  const cell = (lv: AeonLevel, cat: string): AeonCell | undefined => lv.categories[cat];
  return (
    <table className="quality-table aeon-table" data-testid="aeon-category-table">
      <thead>
        <tr>
          <th scope="col">Category</th>
          {levels.map((lv) => (
            <th key={lv.conc} scope="col" className="num">
              c{lv.conc}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {categories.map((cat) => (
          <tr key={cat}>
            <th scope="row">{cat}</th>
            {levels.map((lv) => {
              const c = cell(lv, cat);
              return (
                <td
                  key={lv.conc}
                  className="num"
                  title={c ? `${c.case_id} · Σ ${fmt(c.agg_saturated_est)} · ${c.agg_source ?? ""}` : undefined}
                >
                  {fmt(c?.agg_decode_tps)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * AEON aeon-perf-v1 concurrency ladder (BENCH3) for a Spark LLM or an agent
 * node lane: runs DecodeBench with protocol "aeon-perf-v1" and shows the
 * peak-window and Σ aggregates as separate columns.
 */
export function AeonLadderDialog({
  open,
  onClose,
  targetId,
  scope,
  port,
  modelId,
  remoteTarget = null,
  title = null,
}: AeonLadderDialogProps) {
  const [defaults, setDefaults] = useState<AeonLadderDefaults>(AEON_FALLBACK);
  const [ladder, setLadder] = useState<number[]>([...AEON_FALLBACK.ladder]);
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
      if (data.defaults?.aeon) setDefaults(data.defaults.aeon);
      setHistory((data.history || []).filter(isAeon));
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
        if (isAeon(data.active)) {
          setJob(data.active);
          if (data.active.status === "running") startPolling(data.active.benchId);
          return;
        }
        const last = (data.history || []).find(isAeon) || null;
        setJob(last);
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

  const toggle = (c: number) => {
    setLadder((prev) => {
      if (prev.includes(c)) return prev.length === 1 ? prev : prev.filter((x) => x !== c);
      return [...prev, c].sort((a, b) => a - b);
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
          protocol: "aeon-perf-v1",
          port: benchPort,
          concurrencies: ladder,
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
  const levels = job?.aeon?.levels ?? [];
  const requests = aeonRequests(ladder, defaults);
  const done = job?.progress.requestsDone ?? 0;
  const total = job?.progress.requestsTotal ?? job?.config.requests ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const errorsTotal = levels.reduce((s, lv) => s + lv.overall.n_errors, 0);
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
      <div className="bench-sheet quality-sheet aeon-sheet" role="dialog" aria-modal="true" aria-labelledby="aeon-ladder-title">
        <header className="bench-sheet__header">
          <div className="bench-sheet__header-text">
            <h2 id="aeon-ladder-title" className="bench-sheet__title">
              AEON concurrency ladder
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
                  <h3 className="bench-sheet__section-title">Ladder</h3>
                  <p className="bench-sheet__hint">
                    {defaults.suite} · {defaults.categories.length} categories × {defaults.promptsPerCategory} prompts
                    (one ~1,500-token) · {defaults.maxTokens} max tokens · temperature {defaults.temperature} · waves of
                    c, every prompt cache-busted, no warmup.
                  </p>
                </div>
                <div className="bench-conc-grid" role="group" aria-label="AEON ladder levels">
                  {defaults.ladder.map((c) => {
                    const on = ladder.includes(c);
                    return (
                      <button
                        key={c}
                        type="button"
                        aria-pressed={on}
                        disabled={starting}
                        onClick={() => toggle(c)}
                        className={`bench-conc-btn${on ? " is-on" : ""}`}
                      >
                        c{c}
                      </button>
                    );
                  })}
                </div>
              </div>
              <p className="bench-sheet__hint" data-testid="aeon-request-count">
                {requests.toLocaleString()} requests
                {ladder.length < defaults.ladder.length ? " · partial ladder" : " · full AEON ladder"}
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

          {job && !showConfig && levels.length > 0 && (
            <section className="bench-sheet__section">
              {!isRunning && (
                <div className="bench-status-row">
                  <span
                    className={`bench-status-pill bench-status-pill--${
                      job.status === "completed" && errorsTotal ? "failed" : job.status
                    }`}
                  >
                    {job.status === "completed" && errorsTotal ? "Partial" : job.status.charAt(0).toUpperCase() + job.status.slice(1)}
                  </span>
                  <span className="bench-status-meta">
                    {formatWhen(job.startedAt)}
                    {job.config.modelId ? ` · ${job.config.modelId}` : ""} · {formatDuration(job.durationMs)}
                  </span>
                </div>
              )}
              {job.error ? <p className="bench-sheet__error">{job.error}</p> : null}
              <AeonLevelTable levels={levels} />
              <h3 className="bench-sheet__section-title">Peak window by category (tok/s)</h3>
              <AeonCategoryTable levels={levels} categories={job.config.categories ?? defaults.categories} />
              <p className="bench-legend">
                <strong>Agg peak window</strong> — AEON <code>agg_decode_tps</code>: per wave of c streams, Σ output
                tokens ÷ (last token − first token across the wave); peak wave per category, best category per level
                (<code>aeon.wave_peak_concurrent_window.v1</code>). <strong>Agg Σ</strong> — AEON{" "}
                <code>agg_saturated_est</code>: mean per-stream decode × c, an upper-bound estimate (
                <code>aeon.agg_saturated_est.v1</code>). Rows are stored as <code>perf.direct.&lt;category&gt;.c&lt;n&gt;</code>.
              </p>
            </section>
          )}

          {!isRunning && history.length > 0 && (
            <section className="bench-sheet__section">
              <h3 className="bench-sheet__section-title">Runs</h3>
              <ul className="quality-runs">
                {history.map((h) => {
                  const lv = h.aeon?.levels ?? [];
                  const peak = lv.reduce<number | null>(
                    (m, l) => (l.overall.agg_decode_tps != null && (m == null || l.overall.agg_decode_tps > m) ? l.overall.agg_decode_tps : m),
                    null
                  );
                  return (
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
                        <span className="quality-run__cats">{lv.map((l) => `c${l.conc}`).join(" ")}</span>
                        <strong>{fmt(peak)} tok/s</strong>
                      </button>
                    </li>
                  );
                })}
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
                disabled={starting || ladder.length === 0}
              >
                {starting ? "Starting…" : "Run ladder"}
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
