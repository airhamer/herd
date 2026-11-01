import { useEffect, useState } from "react";
import type { LiveComponentAction, StackPreview, StackPreviewStep } from "../../../shared/types";
import { fetchLiveActions, previewStack } from "../../api/client";
import { CategoryBadge } from "./StackCards";

type NamesById = Record<string, string>;

export interface PreviewApi {
  preview: typeof previewStack;
  live: typeof fetchLiveActions;
}
const DEFAULT_API: PreviewApi = { preview: previewStack, live: fetchLiveActions };

/** 95000 → "1:35". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function EtaBadge({ eta }: { eta: StackPreviewStep["eta"] }) {
  const hist = eta.source === "history";
  return (
    <span
      data-testid="eta-badge"
      title={hist ? `median of the last 5 of ${eta.runs} successful runs` : `${eta.runs} of 5 runs recorded; flat estimate until then`}
      className={`rounded border px-1 text-[10px] uppercase tracking-wide ${hist ? "border-success/60 text-success" : "border-warning/60 text-warning"}`}
    >
      {fmtDuration(eta.ms)} {hist ? "history" : "estimate"}
    </span>
  );
}

function Waves({ title, waves, names }: { title: string; waves: StackPreviewStep[][]; names: NamesById }) {
  if (!waves.length) return null;
  return (
    <div className="mt-2">
      <div className="text-[10px] uppercase tracking-wide text-muted">{title}</div>
      <ol className="mt-1 flex flex-col gap-1">
        {waves.map((wave, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2" data-testid="preview-wave">
            <span className="w-14 text-[10px] text-muted">wave {i + 1}{wave.length > 1 ? " ∥" : ""}</span>
            {wave.map((s) => (
              <span key={`${s.nodeId}|${s.componentId}|${s.type}`} className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5">
                <span className={s.type === "stop" ? "text-danger" : "text-accent"}>{s.type}</span>
                <span className="font-mono text-[10px] text-text">{s.componentId}</span>
                <span className="text-[10px] text-muted">on {names[s.nodeId] ?? s.nodeId}</span>
                <EtaBadge eta={s.eta} />
              </span>
            ))}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * SC5b downtime preview for one stack target: the shutdown and startup
 * waves, an ETA per step with its source badge, the total, and a live
 * elapsed timer for component actions running now (decision #2). It is
 * read-only and nothing is dispatched.
 */
export function StackPreviewPanel({
  stackId,
  nodeId,
  nodeNames,
  onClose,
  api = DEFAULT_API,
  pollMs = 2000,
}: {
  stackId: string;
  nodeId: string | null;
  nodeNames: NamesById;
  onClose: () => void;
  api?: PreviewApi;
  pollMs?: number;
}) {
  const [preview, setPreview] = useState<StackPreview | null>(null);
  const [live, setLive] = useState<LiveComponentAction[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setError(null);
    api
      .preview(stackId, nodeId)
      .then((r) => {
        if (!alive) return;
        setPreview(r.preview);
        setLive(r.live);
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [api, stackId, nodeId]);

  useEffect(() => {
    const t = setInterval(() => {
      api.live().then((r) => setLive(r.running)).catch(() => undefined);
    }, pollMs);
    return () => clearInterval(t);
  }, [api, pollMs]);

  return (
    <div className="mb-3 rounded-lg border border-accent/40 bg-surface-elevated p-3 text-xs" data-testid="stack-preview">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="panel-title">Switch preview</h3>
        {preview && (
          <>
            <span className="font-semibold text-text-strong">{preview.name}</span>
            <CategoryBadge category={preview.category} />
            <span className="text-[10px] uppercase tracking-wide text-muted">
              tp{preview.tp} · {preview.target.nodeIds.map((n) => nodeNames[n] ?? n).join(" + ") || "no nodes"}
            </span>
          </>
        )}
        <button type="button" className="ml-auto text-muted underline" onClick={onClose}>
          Close
        </button>
      </div>
      {error && <div className="mt-2 text-danger">Preview failed: {error}</div>}
      {!preview && !error && <div className="mt-2 text-muted">Planning…</div>}
      {preview && (
        <>
          <div className="mt-1 flex flex-wrap gap-3" data-testid="preview-total">
            <span className={preview.feasible ? "text-success" : "text-danger"}>
              {preview.feasible ? "feasible" : "not feasible"}
            </span>
            <span>
              total ETA <b className="text-text-strong">{fmtDuration(preview.totalEtaMs)}</b>{" "}
              <span className="text-muted">({preview.totalSource})</span>
            </span>
            <span className="text-muted">{preview.parallel ? "parallel where declared" : "sequential"}</span>
            <span className="text-muted">read-only: nothing is run</span>
          </div>
          {preview.alreadyRunning.length > 0 && (
            <div className="mt-1 text-muted">
              already running: {preview.alreadyRunning.map((a) => `${a.componentId} on ${nodeNames[a.nodeId] ?? a.nodeId}`).join(", ")}
            </div>
          )}
          <Waves title="1 · shutdowns (free memory)" waves={preview.shutdownSequence} names={nodeNames} />
          <Waves title="2 · startups" waves={preview.startupSequence} names={nodeNames} />
          {preview.notes.length > 0 && (
            <ul className="mt-2 list-disc pl-4 text-[11px] text-muted">
              {preview.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="mt-2 border-t border-border pt-2" data-testid="preview-live">
        <div className="text-[10px] uppercase tracking-wide text-muted">Live</div>
        {live.length === 0 ? (
          <div className="text-muted">no component action running</div>
        ) : (
          live.map((a) => (
            <div key={`${a.nodeId}|${a.componentId}|${a.startedAt}`} className="flex gap-2">
              <span className="text-accent">{a.type}</span>
              <span className="font-mono text-[10px]">{a.componentId}</span>
              <span className="text-muted">on {nodeNames[a.nodeId] ?? a.nodeId}</span>
              <span className={a.elapsedMs > a.etaMs ? "text-warning" : "text-text"}>
                {fmtDuration(a.elapsedMs)} / ETA {fmtDuration(a.etaMs)}
              </span>
              <span className="text-muted">running</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default StackPreviewPanel;
