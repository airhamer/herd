import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { compareUpgrade, listUpgradeRuns } from "../../api/client";
import { useModalPresence } from "../../hooks/useModalPresence";
import type {
  BenchUpgradeResponse,
  BenchUpgradeRun,
  BenchUpgradeThroughputCell,
  BenchUpgradeQualityCategory,
  BenchUpgradeVerdictCode,
} from "../../../shared/types";

/**
 * "Upgrade worth it?" (BENCH6, #46): pick a baseline and a candidate run
 * (a throughput run, optionally a quality run per side) and read the
 * verdict. Built from the issue's spec; the rules live server-side in
 * server/bench/upgrade/.
 */

const QUALITY_BENCH = "QualityBench";

export const VERDICT_LABEL: Record<BenchUpgradeVerdictCode, string> = {
  worth_it: "Worth it",
  within_noise: "Within noise",
  regression: "Regression",
  refused: "Refused",
};

function fmt(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(digits);
}

function signed(v: number | null | undefined, digits = 1, unit = "%"): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}${unit}`;
}

function fmtP(p: number | null | undefined): string {
  if (p == null) return "—";
  return p < 0.001 ? "<0.001" : p.toFixed(3);
}

function gb(mb: number | null | undefined): string {
  return mb == null ? "—" : `${(mb / 1024).toFixed(1)} GB`;
}

export function runLabel(r: BenchUpgradeRun): string {
  const day = r.started_at.slice(0, 16).replace("T", " ");
  const lane = [r.model_id || "unknown model", r.engine, r.engine_version].filter(Boolean).join(" · ");
  const conc = r.concurrencies.length ? ` · c${r.concurrencies.join("/")}` : "";
  return `${day} · ${r.suite} · ${lane}${conc}`;
}

/** Newest throughput run as candidate; the next older one with the same suite and hardware as baseline. */
export function defaultPicks(runs: BenchUpgradeRun[]) {
  const tput = runs.filter((r) => r.bench !== QUALITY_BENCH);
  const qual = runs.filter((r) => r.bench === QUALITY_BENCH);
  const cand = tput[0] ?? null;
  const base = cand ? tput.find((r) => r !== cand && r.suite === cand.suite && r.suite_version === cand.suite_version && r.hw_bucket === cand.hw_bucket) ?? null : null;
  const qc = qual[0] ?? null;
  const qb = qc ? qual.find((r) => r !== qc && r.suite_version === qc.suite_version && r.hw_bucket === qc.hw_bucket) ?? null : null;
  return {
    baseline: base?.run_id ?? "",
    candidate: cand?.run_id ?? "",
    baselineQuality: qb?.run_id ?? "",
    candidateQuality: qb ? qc?.run_id ?? "" : "",
  };
}

const STATUS_CLASS: Record<string, string> = {
  gain: "quality-badge quality-badge--better",
  better: "quality-badge quality-badge--better",
  loss: "quality-badge quality-badge--worse",
  worse: "quality-badge quality-badge--worse",
};

function Status({ s, label }: { s: string; label?: string }) {
  return <span className={STATUS_CLASS[s] ?? "quality-badge"}>{label ?? (s === "noise" ? "within noise" : s)}</span>;
}

function ThroughputTable({ cells }: { cells: BenchUpgradeThroughputCell[] }) {
  return (
    <table className="quality-table" data-testid="upgrade-throughput">
      <thead>
        <tr>
          <th>Cell</th>
          <th className="num">Baseline</th>
          <th className="num">Candidate</th>
          <th className="num">Δ</th>
          <th className="num">Noise ±</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {cells.map((c) => (
          <tr key={c.cell} className={c.headline ? undefined : "upgrade-detail"}>
            <th title={`${c.metric} · ${c.definition}`}>
              {c.cell}
              {!c.headline && <span className="upgrade-muted"> (detail)</span>}
            </th>
            <td className="num">{fmt(c.baseline)}</td>
            <td className="num">{fmt(c.candidate)}</td>
            <td className={`num quality-delta${c.status === "gain" ? " is-up" : c.status === "loss" ? " is-down" : ""}`}>{signed(c.delta_pct)}</td>
            <td
              className="num"
              title={
                c.noise_source === "repeats"
                  ? `Measured spread of repeated runs: ${fmt(c.measured_noise_pct, 2)}% (floored at 3%)`
                  : "No repeated runs on either lane: 15% default (single-stream spread on one Spark)"
              }
            >
              {fmt(c.noise_pct)}%{c.noise_source === "default" ? "*" : ""}
            </td>
            <td>
              <Status s={c.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function QualityTable({ cats }: { cats: BenchUpgradeQualityCategory[] }) {
  return (
    <table className="quality-table" data-testid="upgrade-quality">
      <thead>
        <tr>
          <th>Category</th>
          <th className="num">Baseline</th>
          <th className="num">Candidate</th>
          <th className="num">Δ pp</th>
          <th className="num">McNemar p</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {cats.map((q) => (
          <tr key={q.cell}>
            <th>{q.category}</th>
            <td className="num">{fmt(q.baseline_pct)}%</td>
            <td className="num">{fmt(q.candidate_pct)}%</td>
            <td className={`num quality-delta${q.status === "better" ? " is-up" : q.status === "worse" ? " is-down" : ""}`}>{signed(q.delta_pp, 1, "")}</td>
            <td className="num" title={q.mcnemar ? `${q.mcnemar.paired} paired · ${q.mcnemar.baseline_only} baseline-only · ${q.mcnemar.candidate_only} candidate-only` : undefined}>
              {fmtP(q.mcnemar?.p)}
            </td>
            <td>
              <Status s={q.status} label={q.status === "noise" ? "within noise" : q.status === "unpaired" ? "no item vectors" : undefined} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RunSelect({
  label,
  value,
  onChange,
  runs,
  optional,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  runs: BenchUpgradeRun[];
  optional?: boolean;
  testId: string;
}) {
  return (
    <label className="quality-baseline">
      <span className="upgrade-pick__label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} className="rounded border border-border bg-surface px-2 py-1 text-xs">
        <option value="">{optional ? "— none —" : "— pick a run —"}</option>
        {runs.map((r) => (
          <option key={r.run_id} value={r.run_id}>
            {runLabel(r)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function UpgradeCompareDialog({
  open,
  onClose,
  nodeId,
  title,
}: {
  open: boolean;
  onClose: () => void;
  /** Limit the pickers to one node's runs; omitted = every run in the store. */
  nodeId?: string | null;
  title?: string | null;
}) {
  const { mounted, visible } = useModalPresence(open);
  const [runs, setRuns] = useState<BenchUpgradeRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [picks, setPicks] = useState({ baseline: "", candidate: "", baselineQuality: "", candidateQuality: "" });
  const [result, setResult] = useState<BenchUpgradeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    listUpgradeRuns(nodeId ? { node_id: nodeId } : {})
      .then((data) => {
        if (!live) return;
        setRuns(data.runs);
        setPicks(defaultPicks(data.runs));
      })
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [open, nodeId]);

  const baseIds = useMemo(() => [picks.baseline, picks.baselineQuality].filter(Boolean), [picks]);
  const candIds = useMemo(() => [picks.candidate, picks.candidateQuality].filter(Boolean), [picks]);

  useEffect(() => {
    if (!open || baseIds.length === 0 || candIds.length === 0) {
      setResult(null);
      return;
    }
    let live = true;
    setError(null);
    compareUpgrade(baseIds, candIds)
      .then((r) => live && setResult(r))
      .catch((err: unknown) => {
        if (!live) return;
        setResult(null);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [open, baseIds, candIds]);

  if (!mounted) return null;
  const tput = runs.filter((r) => r.bench !== QUALITY_BENCH);
  const qual = runs.filter((r) => r.bench === QUALITY_BENCH);
  const set = (k: keyof typeof picks) => (v: string) => setPicks((p) => ({ ...p, [k]: v }));
  const v = result?.verdict;
  const energy = result?.cost.energy;
  const memory = result?.cost.memory;

  const dialog = (
    <div className={`bench-overlay${visible ? " is-open" : ""}`} role="presentation">
      <button type="button" className="bench-overlay__scrim" aria-label="Close dialog" onClick={onClose} />
      <div className="bench-sheet quality-sheet upgrade-sheet" role="dialog" aria-modal="true" aria-labelledby="upgrade-title">
        <header className="bench-sheet__header">
          <div className="bench-sheet__header-text">
            <h2 id="upgrade-title" className="bench-sheet__title">
              Upgrade worth it?
            </h2>
            <p className="bench-sheet__subtitle">
              {title ? `${title} · ` : ""}baseline vs candidate: same hardware bucket, suite version and conditions
            </p>
          </div>
          <button type="button" className="bench-sheet__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="bench-sheet__body">
          {loading && <p className="bench-sheet__hint">Loading runs…</p>}
          {!loading && runs.length === 0 && (
            <p className="bench-sheet__hint">No stored runs yet. Run a decode, AEON or Hasso bench before and after the upgrade.</p>
          )}

          {runs.length > 0 && (
            <section className="bench-sheet__section upgrade-picks">
              <div className="upgrade-pick">
                <h3 className="bench-sheet__section-title">Baseline</h3>
                <RunSelect label="Throughput" value={picks.baseline} onChange={set("baseline")} runs={tput} testId="upgrade-baseline" />
                <RunSelect label="Quality" value={picks.baselineQuality} onChange={set("baselineQuality")} runs={qual} optional testId="upgrade-baseline-quality" />
              </div>
              <div className="upgrade-pick">
                <h3 className="bench-sheet__section-title">Candidate</h3>
                <RunSelect label="Throughput" value={picks.candidate} onChange={set("candidate")} runs={tput} testId="upgrade-candidate" />
                <RunSelect label="Quality" value={picks.candidateQuality} onChange={set("candidateQuality")} runs={qual} optional testId="upgrade-candidate-quality" />
              </div>
            </section>
          )}

          {error && <p className="bench-sheet__error">{error}</p>}

          {result && v && (
            <section className="bench-sheet__section">
              <div className={`upgrade-verdict upgrade-verdict--${v.code}`} data-testid="upgrade-verdict">
                <div>
                  <span className="quality-overall__label">Verdict</span>
                  <span className="upgrade-verdict__value">{VERDICT_LABEL[v.code]}</span>
                  <ul className="quality-warnings" data-testid="upgrade-reasons">
                    {v.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </div>
                {result.reference && (
                  <aside className="upgrade-reference" data-testid="upgrade-reference">
                    <span className="quality-overall__label">Nearest published reference</span>
                    <a href={result.reference.reference.url} target="_blank" rel="noopener noreferrer">
                      {result.reference.reference.title || result.reference.reference.source || result.reference.reference.id}
                    </a>
                    <span className="upgrade-reference__value">
                      {fmt(result.reference.reference.value)} {result.reference.unit} vs yours {fmt(result.reference.candidate)} ({result.reference.cell}, {result.reference.metric})
                    </span>
                    {result.reference.reference.differences.length > 0 && (
                      <span className="upgrade-muted" title={result.reference.reference.differences.join("\n")}>
                        {result.reference.reference.differences.length} difference(s): shown beside, not diffed
                      </span>
                    )}
                  </aside>
                )}
              </div>
            </section>
          )}

          {result && result.comparable && (
            <>
              <section className="bench-sheet__section">
                <h3 className="bench-sheet__section-title">Throughput</h3>
                {result.throughput.length ? (
                  <ThroughputTable cells={result.throughput} />
                ) : (
                  <p className="bench-sheet__hint">No throughput run on both sides.</p>
                )}
                <p className="bench-legend">
                  Δ is higher-is-better throughput per cell. Noise band: spread of repeated runs on the same lane, or
                  <strong> 15%*</strong> when there are none (single-stream spread on one Spark).
                </p>
              </section>
              <section className="bench-sheet__section">
                <h3 className="bench-sheet__section-title">Quality</h3>
                {result.quality.length ? (
                  <QualityTable cats={result.quality} />
                ) : (
                  <p className="bench-sheet__hint">Quality not compared: pick a quality run on both sides (~755 requests per run).</p>
                )}
              </section>
              <section className="bench-sheet__section" data-testid="upgrade-cost">
                <h3 className="bench-sheet__section-title">Cost</h3>
                <table className="quality-table">
                  <thead>
                    <tr>
                      <th />
                      <th className="num">Baseline</th>
                      <th className="num">Candidate</th>
                      <th className="num">Δ</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th title={energy?.definition}>Energy (Wh / 1k tok)</th>
                      <td className="num">{fmt(energy?.baseline?.wh_per_1k_tokens, 3)}</td>
                      <td className="num">{fmt(energy?.candidate?.wh_per_1k_tokens, 3)}</td>
                      <td className={`num quality-delta${energy?.delta_pct != null ? (energy.delta_pct < 0 ? " is-up" : energy.delta_pct > 0 ? " is-down" : "") : ""}`}>{signed(energy?.delta_pct)}</td>
                    </tr>
                    <tr>
                      <th title="Lower of the available unified memory read at run start and end">Memory headroom</th>
                      <td className="num">{gb(memory?.baseline?.headroom_mb)}</td>
                      <td className="num">{gb(memory?.candidate?.headroom_mb)}</td>
                      <td className="num">{memory?.delta_mb == null ? "—" : signed(memory.delta_mb / 1024, 1, " GB")}</td>
                    </tr>
                  </tbody>
                </table>
                <p className="bench-legend">
                  Energy is the fleet energy tracker's estimate for the node over the run window (whole run, approximate); Sparks
                  in the registry only. Not part of the verdict.
                </p>
              </section>
              {(result.unpaired.baseline.length > 0 || result.unpaired.candidate.length > 0) && (
                <p className="bench-sheet__hint" data-testid="upgrade-unpaired">
                  Not compared (no partner cell): {[...result.unpaired.baseline.map((c) => `baseline ${c}`), ...result.unpaired.candidate.map((c) => `candidate ${c}`)].join(", ")}
                </p>
              )}
            </>
          )}
        </div>

        <footer className="bench-sheet__footer">
          <button type="button" className="bench-btn bench-btn--primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
