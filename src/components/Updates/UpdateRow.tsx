import type { NodeRecord } from "../../api/client";
import type { NodeUpdatesView } from "../../api/types";
import { formatAgo } from "../OverviewPage/FleetCard";
import { statusLabel, statusTone } from "./format";

export interface UpdateRowProps {
  view: NodeUpdatesView;
  /** Registry record for group info; null when the node vanished from it. */
  node: NodeRecord | null;
  /** Injectable clock for the probe-age render (tests pass a fixed value). */
  now: number;
  expanded: boolean;
  /** Inline row notice (e.g. the 409 wave-lock text). */
  notice: string | null;
  onToggle: (nodeId: string) => void;
  onSchedule: (nodeId: string) => void;
  onConfirmNow: (nodeId: string) => void;
}

/** Renders sizeBytes (shared/types §9 — BYTES, not MB). */
function bytes(size: number | null): string {
  if (size == null) return "—";
  const mb = size / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
}

/**
 * One spark row of the Updates table (SPEC §6.3): versions, OTA, counts, probe
 * age, server-derived state, group/wave position, and row actions. State text
 * renders view.display — never re-derived client-side.
 */
export function UpdateRow(props: UpdateRowProps) {
  const { view, node, now, expanded, notice } = props;
  const snap = view.snapshot;

  return (
    <>
      <tr className="border-b border-border/50">
        <td className="py-1.5 pr-3 font-medium text-text">
          {node?.name ?? view.nodeId}
          {!view.reachable && <span className="ml-1 text-[10px] text-danger">offline</span>}
        </td>
        <td className="py-1.5 pr-3 font-tabular text-muted">{snap?.swBuild ?? "—"}</td>
        <td className="py-1.5 pr-3 font-tabular text-muted">{snap?.latestOtaApplied?.version ?? "—"}</td>
        <td className="py-1.5 pr-3 text-muted">
          {snap?.otaAvailable ? (
            <span className="font-tabular">
              {snap.otaAvailable.version}
              {snap.otaAvailable.priority ? ` · ${snap.otaAvailable.priority}` : ""}
              {snap.otaAvailable.releaseNotesUrl ? (
                <a
                  href={snap.otaAvailable.releaseNotesUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-1 text-accent underline"
                >
                  notes
                </a>
              ) : null}
            </span>
          ) : (
            "—"
          )}
        </td>
        <td className="py-1.5 pr-3 font-tabular text-muted">{snap?.packages.length ?? "—"}</td>
        <td className="py-1.5 pr-3 font-tabular text-muted">{snap?.firmware.length ?? "—"}</td>
        <td className="py-1.5 pr-3 font-tabular text-muted">
          {snap ? formatAgo(snap.probedAt, now) : "—"}
        </td>
        <td className={`py-1.5 pr-3 font-medium ${statusTone(view)}`} data-testid="update-row-state">
          {statusLabel(view)}
        </td>
        <td className="py-1.5 pr-3 font-tabular text-muted">
          {node?.groupId ?? "—"}
          {view.waveIndex != null ? ` · wave ${view.waveIndex + 1}` : ""}
        </td>
        <td className="py-1.5 text-right">
          <span className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={() => props.onConfirmNow(view.nodeId)}
              className="rounded border border-border bg-surface-elevated px-2 py-0.5 text-[10px] text-muted hover:bg-surface-hover"
            >
              Update now
            </button>
            <button
              type="button"
              onClick={() => props.onSchedule(view.nodeId)}
              className="rounded border border-border bg-surface-elevated px-2 py-0.5 text-[10px] text-muted hover:bg-surface-hover"
            >
              Schedule…
            </button>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => props.onToggle(view.nodeId)}
              className="rounded border border-border bg-surface-elevated px-2 py-0.5 text-[10px] text-muted hover:bg-surface-hover"
            >
              {expanded ? "▴" : "▸"}
            </button>
          </span>
          {notice && (
            <div className="mt-1 rounded bg-danger/20 px-2 py-1 text-left text-[10px] text-danger" role="alert">
              {notice}
            </div>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/50 bg-surface-elevated/40">
          <td colSpan={10} className="py-2 pr-3">
            {!snap ? (
              <p className="text-xs text-muted" data-testid="update-row-stale">
                probe stale/unreachable
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                <div>
                  <h4 className="mb-1 text-[10px] uppercase tracking-wide text-muted">Packages</h4>
                  {snap.packages.length === 0 ? (
                    <p className="text-[11px] text-muted">none pending</p>
                  ) : (
                    <table className="w-full text-left text-[11px]">
                      <thead>
                        <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted">
                          <th className="py-1 pr-3 font-medium">Package</th>
                          <th className="py-1 pr-3 font-medium">Current</th>
                          <th className="py-1 pr-3 font-medium">Available</th>
                          <th className="py-1 pr-3 font-medium">Size</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snap.packages.map((p) => (
                          <tr key={p.name} className="border-b border-border/40">
                            <td className="py-1 pr-3 text-text">
                              {p.name}
                              {p.description ? (
                                <div className="text-[10px] text-muted" title={p.description}>
                                  {p.description}
                                </div>
                              ) : null}
                            </td>
                            <td className="py-1 pr-3 font-tabular text-muted">{p.currentVersion}</td>
                            <td className="py-1 pr-3 font-tabular text-text">{p.availableVersion}</td>
                            <td className="py-1 pr-3 font-tabular text-muted">{p.size ?? bytes(p.sizeBytes)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <div>
                  <h4 className="mb-1 text-[10px] uppercase tracking-wide text-muted">Firmware</h4>
                  {snap.firmware.length === 0 ? (
                    <p className="text-[11px] text-muted">none pending</p>
                  ) : (
                    <table className="w-full text-left text-[11px]">
                      <thead>
                        <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted">
                          <th className="py-1 pr-3 font-medium">Component</th>
                          <th className="py-1 pr-3 font-medium">Current</th>
                          <th className="py-1 pr-3 font-medium">Available</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snap.firmware.map((f) => (
                          <tr key={f.component} className="border-b border-border/40">
                            <td className="py-1 pr-3 text-text">{f.component}</td>
                            <td className="py-1 pr-3 font-tabular text-muted">{f.currentVersion}</td>
                            <td className="py-1 pr-3 font-tabular text-text">{f.availableVersion ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
