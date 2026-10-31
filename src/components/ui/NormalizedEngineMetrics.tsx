// Normalized engine metrics (STAT2, #35): the same fields for every engine,
// each with its source tier, window, ≈ when approximate, and read count.
import { useState } from "react";
import type {
  NormalizedEngineField,
  NormalizedEngineRecord,
  NormalizedEngineValue,
  NormalizedEngineWindows,
} from "../../../shared/types";

interface FieldSpec {
  field: NormalizedEngineField;
  label: string;
  unit: string;
  format: (v: number) => string;
  help: string;
}

const fmtRate = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
const fmtSec = (v: number) => (v < 1 ? `${(v * 1000).toFixed(0)} ms` : `${v.toFixed(2)} s`);
const fmtPct = (v: number) => `${(v * 100).toFixed(0)}%`;

export const NORMALIZED_FIELD_SPECS: readonly FieldSpec[] = [
  { field: "decode_tps", label: "Decode", unit: "tok/s", format: fmtRate, help: "Decode tok/s per stream: output tokens after the first, over decode time." },
  { field: "prefill_tps", label: "Prefill", unit: "tok/s", format: fmtRate, help: "Computed prefill tok/s: prompt tokens the engine built KV for, over prefill time." },
  { field: "ttft_s", label: "TTFT", unit: "", format: fmtSec, help: "Mean time to first token of requests that started in the window." },
  { field: "queue_s", label: "Queue", unit: "", format: fmtSec, help: "Mean time requests waited before they were scheduled." },
  { field: "running", label: "Running", unit: "", format: (v) => v.toFixed(0), help: "Requests running now (peak over the window in the tooltip)." },
  { field: "waiting", label: "Waiting", unit: "", format: (v) => v.toFixed(0), help: "Requests waiting now (peak over the window in the tooltip)." },
  { field: "kv_pct", label: "KV", unit: "", format: (v) => `${v.toFixed(1)}%`, help: "KV cache in use now (peak over the window in the tooltip)." },
  { field: "cache_reuse", label: "Cache hit", unit: "", format: fmtPct, help: "Share of prompt tokens served from the prefix cache." },
  { field: "acc_len", label: "Accept len", unit: "", format: (v) => v.toFixed(2), help: "Mean tokens produced per speculative step." },
  { field: "idle_share", label: "Idle", unit: "", format: fmtPct, help: "Share of the window the scheduler sat idle (SGLang)." },
  { field: "throughput_tps", label: "Throughput", unit: "tok/s", format: fmtRate, help: "Output tokens per second of wall time, all streams." },
];

/** "12.3 tok/s" / "—" for one value. */
export function formatNormalizedValue(spec: FieldSpec, v: NormalizedEngineValue | undefined): string {
  if (!v || !v.valid || v.value == null) return "—";
  const body = spec.format(v.value);
  return `${v.approximate ? "≈" : ""}${body}${spec.unit ? ` ${spec.unit}` : ""}`;
}

/** Tooltip text: what it is, tier, window, approximate, reads, peak. */
export function describeNormalizedValue(spec: FieldSpec, v: NormalizedEngineValue | undefined): string {
  const parts = [spec.help];
  if (!v || !v.valid || v.value == null) {
    parts.push(v?.source ? `Not measured (source: ${v.source}).` : "Not measured.");
    return parts.join(" ");
  }
  parts.push(`Source: ${v.source ?? "unknown"}.`);
  parts.push(v.windowS === 0 ? "Instantaneous." : `Window: ${v.windowS} s.`);
  if (v.approximate) parts.push("Approximate.");
  parts.push(`Reads: ${v.samples}.`);
  if (v.peak != null) parts.push(`Peak: ${spec.format(v.peak)}${spec.unit ? ` ${spec.unit}` : ""}.`);
  return parts.join(" ");
}

function spanKeys(windows: NormalizedEngineWindows): string[] {
  return Object.keys(windows).sort((a, b) => Number(a) - Number(b));
}

function windowLabel(key: string): string {
  const s = Number(key);
  return s % 60 === 0 ? `${s / 60} min` : `${s} s`;
}

/** Full grid for the Spark LLM panel, with a window toggle. */
export function NormalizedEngineGrid({ windows }: { windows: NormalizedEngineWindows | null | undefined }) {
  const keys = windows ? spanKeys(windows) : [];
  const [chosen, setChosen] = useState<string | null>(null);
  if (!windows || keys.length === 0) return null;
  const key = chosen && keys.includes(chosen) ? chosen : keys[keys.length - 1];
  const rec: NormalizedEngineRecord = windows[key];
  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="llm-normalized">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-muted" title="Every engine reads the same fields. ≈ marks approximate values; hover a value for its source, window and reads.">
          Engine metrics
        </span>
        <div className="flex gap-1" role="group" aria-label="Window">
          {keys.map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={k === key}
              onClick={() => setChosen(k)}
              className={`rounded px-1.5 py-0.5 text-[10px] ${k === key ? "bg-accent/15 text-accent" : "text-muted hover:text-text"}`}
            >
              {windowLabel(k)}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {NORMALIZED_FIELD_SPECS.map((spec) => {
          const v = rec.values[spec.field];
          const measured = v?.valid && v.value != null;
          return (
            <div key={spec.field} className="space-y-0.5" title={describeNormalizedValue(spec, v)} data-testid={`llm-normalized-${spec.field}`}>
              <div className="text-[10px] uppercase tracking-wide text-muted">{spec.label}</div>
              <div className={`font-tabular text-sm ${measured ? "text-text" : "text-muted"}`}>
                {formatNormalizedValue(spec, v)}
              </div>
              {measured && (
                <div className="font-tabular text-[9px] text-muted">
                  {v.source}
                  {v.windowS ? ` · ${v.windowS} s` : ""}
                  {` · n ${v.samples}`}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="font-tabular text-[9px] text-muted" data-testid="llm-normalized-footer">
        {rec.reads} reads over {rec.coveredS} s{rec.resets > 0 ? ` · restarted ${rec.resets}×` : ""}
      </div>
    </div>
  );
}

const INLINE_FIELDS: readonly NormalizedEngineField[] = ["decode_tps", "ttft_s", "kv_pct"];

/**
 * Compact "decode · TTFT · KV" line for a Fleet node card model row. Uses
 * the longest window; renders nothing when none of the three is measured.
 */
export function NormalizedEngineInline({ windows }: { windows: NormalizedEngineWindows | null | undefined }) {
  if (!windows) return null;
  const keys = spanKeys(windows);
  if (keys.length === 0) return null;
  const rec = windows[keys[keys.length - 1]];
  const specs = INLINE_FIELDS.map((f) => NORMALIZED_FIELD_SPECS.find((s) => s.field === f)!);
  const shown = specs.filter((s) => rec.values[s.field]?.valid);
  if (shown.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-x-2 pl-3 font-tabular text-[10px] text-muted" data-testid="fleet-card-model-normalized">
      {shown.map((s) => {
        const v = rec.values[s.field];
        return (
          <span key={s.field} title={describeNormalizedValue(s, v)}>
            {s.label} {formatNormalizedValue(s, v)}
            <span className="opacity-60"> ({v.source})</span>
          </span>
        );
      })}
    </span>
  );
}
