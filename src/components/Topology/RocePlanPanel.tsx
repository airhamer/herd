import { useState } from "react";
import type { GroupsApi, RoceApplyResult, RocePlan } from "../../api/client";

function gbps(mbps: number | null): string {
  if (mbps == null) return "—";
  return `${Math.round(mbps / 1000)}G`;
}

/**
 * The computed RoCE link plan for the current grouping (SC5d, #75):
 * a pair runs its one link at 200G; a triple runs all three links at 100G;
 * links outside a group are disabled. Applying is a separate, explicit
 * confirm that defaults to a dry run. There is no known-safe command path to
 * change NIC links yet, so the agent returns "not implemented" and the dry
 * run lists no commands.
 */
export function RocePlanPanel({ plan, api }: { plan: RocePlan; api: Pick<GroupsApi, "apply"> }) {
  const [confirming, setConfirming] = useState(false);
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RoceApplyResult | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setApplyError(null);
    setResult(null);
    try {
      setResult(await api.apply(dryRun ? { dryRun: true } : { dryRun: false, confirm: true }));
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const commands = result ? [...(result.commands ?? []), ...(result.nodes ?? []).flatMap((n) => n.commands ?? [])] : [];

  return (
    <div className="mt-4 border-t border-border pt-3" data-testid="roce-plan">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold text-text-strong">RoCE link plan</h4>
        <span className="text-[10px] text-muted">
          {plan.changes} change{plan.changes === 1 ? "" : "s"} · pair = 1 link @ 200G · triple = 3 links @ 100G
        </span>
      </div>
      {plan.links.length === 0 ? (
        <p className="text-[11px] text-muted">No RoCE links between Sparks reported.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <thead>
              <tr className="border-b border-border text-[10px] uppercase tracking-wide text-muted">
                <th className="py-1 pr-3 font-medium">Link</th>
                <th className="py-1 pr-3 font-medium">Group</th>
                <th className="py-1 pr-3 font-medium">Now</th>
                <th className="py-1 pr-3 font-medium">Plan</th>
                <th className="py-1 pr-3 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {plan.links.map((l) => (
                <tr
                  key={`${l.from}|${l.to}`}
                  className="border-b border-border/50"
                  data-testid={`plan-${l.from}-${l.to}`}
                  data-change={l.change ? "true" : "false"}
                >
                  <td className="py-1 pr-3 font-tabular text-text">
                    {l.from}
                    {l.fromIf ? `:${l.fromIf}` : ""} ↔ {l.to}
                    {l.toIf ? `:${l.toIf}` : ""}
                  </td>
                  <td className="py-1 pr-3 text-muted">{l.groupId ?? "—"}</td>
                  <td className="py-1 pr-3 font-tabular text-muted">
                    {l.currentUp ? `up ${gbps(l.currentSpeedMbps)}` : "down"}
                  </td>
                  <td className={`py-1 pr-3 font-tabular ${l.change ? "text-accent" : "text-muted"}`}>
                    {l.action === "enable" ? `enable @ ${gbps(l.targetSpeedMbps)}` : "disable"}
                    {l.change ? " •" : ""}
                  </td>
                  <td className="py-1 pr-3 text-muted">{l.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {plan.warnings.length > 0 && (
        <ul className="mt-2 list-disc pl-4 text-[11px] text-warning" data-testid="plan-warnings">
          {plan.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {plan.todo.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-[10px] text-muted">
          {plan.todo.map((t) => (
            <li key={t}>TODO: {t}</li>
          ))}
        </ul>
      )}

      <div className="mt-3">
        {!confirming ? (
          <button
            type="button"
            data-testid="roce-apply-open"
            onClick={() => setConfirming(true)}
            className="rounded border border-border px-2 py-1 text-[11px] text-text hover:border-accent"
          >
            Apply to hardware…
          </button>
        ) : (
          <div className="rounded border border-border p-2" data-testid="roce-apply-confirm">
            <p className="mb-2 text-[11px] text-text">
              Apply this plan to the Sparks' RoCE NICs? A dry run shows the exact commands without running them.
            </p>
            <label className="mb-2 flex items-center gap-1.5 text-[11px] text-text">
              <input
                type="checkbox"
                data-testid="roce-dry-run"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
              />
              Dry run (show commands only)
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="roce-apply-run"
                disabled={busy}
                onClick={() => void run()}
                className={`rounded px-2 py-1 text-[11px] font-medium ${dryRun ? "bg-accent/20 text-accent" : "bg-danger/20 text-danger"}`}
              >
                {busy ? "Working…" : dryRun ? "Run dry run" : "Apply for real"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  setResult(null);
                  setApplyError(null);
                  setDryRun(true);
                }}
                className="rounded px-2 py-1 text-[11px] text-muted hover:text-text"
              >
                Cancel
              </button>
            </div>
            {applyError && (
              <p role="alert" className="mt-2 text-[11px] text-danger" data-testid="roce-apply-error">
                {applyError}
              </p>
            )}
            {result && (
              <div className="mt-2 text-[11px]" data-testid="roce-apply-result">
                <p className="text-muted">
                  {result.dryRun ? "Dry run" : "Apply"} · {result.implemented ? "implemented" : "not implemented"}
                </p>
                <p className="mb-1 text-text">Commands:</p>
                {commands.length === 0 ? (
                  <p className="font-tabular text-muted" data-testid="roce-commands-none">
                    (none)
                  </p>
                ) : (
                  <pre className="overflow-x-auto rounded bg-surface p-1.5 font-tabular text-[10px]">{commands.join("\n")}</pre>
                )}
                {result.message && <p className="mt-1 text-muted">{result.message}</p>}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
