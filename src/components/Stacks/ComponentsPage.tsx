import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchComponents,
  fetchFleetNodes,
  sendComponentAction,
  type CatalogComponent,
  type ComponentActionSendRequest,
} from "../../api/client";
import type { ComponentActionResult } from "../../api/types";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ACTIONS = ["start", "stop", "restart"] as const;
type ActionType = (typeof ACTIONS)[number];

type NamesById = Record<string, string>;

/** Action targets for a component: observed nodes, else every registered node. */
function actionTargets(comp: CatalogComponent, names: NamesById): string[] {
  if (comp.nodes.length > 0) return comp.nodes.map((n) => n.nodeId);
  return Object.keys(names);
}

/** Human summary of a dry-run plan (ComponentActionPlan). */
function planSummary(result: ComponentActionResult): string {
  const plan = result.plan;
  if (!plan) return result.error || result.message || "no plan returned";
  if (plan.scopeBlocked) return `blocked: ${plan.scopeBlocked}`;
  const parts = [`will do: ${plan.willDo.join(" → ") || "nothing"}`];
  if (plan.displaces) parts.push(`displaces ${plan.displaces}`);
  parts.push(`confirm: ${plan.confirm}`);
  if (plan.estDowntimeMs > 0) parts.push(`downtime ~${Math.round(plan.estDowntimeMs / 1000)}s`);
  if (plan.memoryDeltaMB !== 0) parts.push(`memory ${plan.memoryDeltaMB > 0 ? "+" : ""}${plan.memoryDeltaMB} MB`);
  if (plan.inflightRequests != null) parts.push(`${plan.inflightRequests} in-flight`);
  return parts.join(" · ");
}

function stateClass(state: string): string {
  if (state === "running" || state === "ready") return "text-accent";
  if (state === "stopped") return "text-muted";
  return "text-danger";
}

interface ActionState {
  /** `${componentId}|${nodeId}` currently running an action */
  busy: string | null;
  /** last dry-run preview, by key */
  plan: { key: string; type: ActionType; result: ComponentActionResult } | null;
  /** last real-action outcome, by key */
  result: { key: string; result: ComponentActionResult } | null;
  error: string | null;
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <label className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-border bg-surface-elevated px-1.5 py-0.5 text-[11px] normal-case tracking-normal text-text"
      >
        <option value="all">all</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * ComponentsPage — POC Components tab (issue #7). Lists the POC1 catalog
 * (GET /api/components: definitions + live per-node state) and drives
 * start/stop/restart through the POC2 v2 action seam: pressing a verb first
 * fires a dry-run preview (ComponentActionRequest.dryRun), "Confirm" replays
 * it as the real action, carrying the plan's confirmationToken when the
 * confirm class is "required" (the agent refuses those without a token).
 */
export function ComponentsPage() {
  const [components, setComponents] = useState<CatalogComponent[] | null>(null);
  const [nodeNames, setNodeNames] = useState<NamesById>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [tpFilter, setTpFilter] = useState<string>("all");
  const [action, setAction] = useState<ActionState>({ busy: null, plan: null, result: null, error: null });

  const reload = useCallback(async () => {
    try {
      const [comps, nodes] = await Promise.all([fetchComponents(), fetchFleetNodes()]);
      setComponents(comps.components);
      const names: NamesById = {};
      for (const n of nodes.nodes) names[n.id] = n.name;
      setNodeNames(names);
      setLoadError(null);
    } catch (err) {
      setLoadError(errText(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const kinds = useMemo(
    () => Array.from(new Set((components ?? []).map((c) => c.kind))).sort(),
    [components]
  );
  const tps = useMemo(
    () => Array.from(new Set((components ?? []).map((c) => String(c.tp)))).sort(),
    [components]
  );
  const visible = useMemo(
    () =>
      (components ?? []).filter(
        (c) =>
          (kindFilter === "all" || c.kind === kindFilter) &&
          (tpFilter === "all" || String(c.tp) === tpFilter)
      ),
    [components, kindFilter, tpFilter]
  );

  /** One action against one node: preview (dryRun) or the confirmed real run. */
  const runAction = useCallback(
    async (comp: CatalogComponent, nodeId: string, type: ActionType, confirmationToken: string | null) => {
      const key = `${comp.id}|${nodeId}`;
      const preview = confirmationToken === null;
      const body: ComponentActionSendRequest = {
        type,
        componentId: comp.id,
        groupRef: null,
        exclusiveWith: null,
        confirmationToken: preview ? null : confirmationToken,
        dryRun: preview,
        recipeName: null,
        timeoutMs: null,
      };
      setAction((a) => ({ ...a, busy: key, error: null }));
      try {
        const result = await sendComponentAction(nodeId, body);
        setAction((a) => ({
          ...a,
          busy: null,
          plan: preview ? { key, type, result } : a.plan,
          result: preview ? a.result : { key, result },
        }));
        if (!preview) void reload();
      } catch (err) {
        setAction((a) => ({
          ...a,
          busy: null,
          error: `${type} ${comp.id} on ${nodeNames[nodeId] ?? nodeId}: ${errText(err)}`,
        }));
      }
    },
    [nodeNames, reload]
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-page-gap)" }}>
      {loadError && <div className="text-xs text-danger">Components API error: {loadError}</div>}
      {!components && !loadError ? (
        <div className="panel mx-auto mt-16 max-w-md p-8 text-center">
          <h2 className="text-sm font-semibold text-text-strong">Loading components…</h2>
          <p className="mt-1 text-xs text-muted">Reading the catalog and node state…</p>
        </div>
      ) : (
        <div className="panel" style={{ padding: "var(--density-panel-pad)" }}>
          <div
            className="flex flex-wrap items-center gap-3"
            style={{ marginBottom: "var(--density-panel-title-mb)" }}
          >
            <h3 className="panel-title">Components ({visible.length})</h3>
            <FilterSelect label="kind" value={kindFilter} onChange={setKindFilter} options={kinds} />
            <FilterSelect label="tp" value={tpFilter} onChange={setTpFilter} options={tps} />
            <button
              type="button"
              className="ml-auto text-xs text-accent underline"
              onClick={() => {
                void reload();
              }}
            >
              Refresh
            </button>
          </div>
          {visible.length === 0 ? (
            <p className="text-xs text-muted">No components match the catalog filters.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {visible.map((comp) => (
                <ComponentRow
                  key={comp.id}
                  comp={comp}
                  nodeNames={nodeNames}
                  action={action}
                  onAction={(nodeId, type, token) => void runAction(comp, nodeId, type, token)}
                />
              ))}
            </div>
          )}
          {action.error && <div className="mt-2 text-xs text-danger">{action.error}</div>}
        </div>
      )}
    </div>
  );
}

/** One catalog component: definition facts, live per-node state, action controls. */
function ComponentRow({
  comp,
  nodeNames,
  action,
  onAction,
}: {
  comp: CatalogComponent;
  nodeNames: NamesById;
  action: ActionState;
  onAction: (nodeId: string, type: ActionType, confirmationToken: string | null) => void;
}) {
  const targets = actionTargets(comp, nodeNames);
  return (
    <div className="rounded-lg border border-border bg-surface-elevated p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs font-semibold text-text-strong">{comp.name}</span>
        <span className="font-mono text-[10px] text-muted">{comp.id}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wide text-muted">
          {comp.kind} · {comp.purpose} · tp{comp.tp} · {comp.engine ?? "?"}
          {comp.memoryPerSparkMB != null ? ` · ${Math.round(comp.memoryPerSparkMB / 1024)} GiB` : ""}
        </span>
      </div>
      {comp.description && <p className="mt-1 text-[11px] text-muted">{comp.description}</p>}
      <div className="mt-2 flex flex-col gap-1.5">
        {targets.map((nodeId) => {
          const key = `${comp.id}|${nodeId}`;
          const observed = comp.nodes.find((n) => n.nodeId === nodeId);
          const busy = action.busy === key;
          const plan = action.plan && action.plan.key === key ? action.plan : null;
          const outcome = action.result && action.result.key === key ? action.result.result : null;
          const needsConfirm =
            plan != null && plan.result.plan?.confirm === "required" && plan.result.ok;
          return (
            <div key={nodeId} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="min-w-24 text-text">{nodeNames[nodeId] ?? nodeId}</span>
              <span className={`font-tabular ${stateClass(observed?.state ?? "unknown")}`}>
                {observed ? observed.state : "unknown"}
              </span>
              {ACTIONS.map((type) => (
                <button
                  key={type}
                  type="button"
                  disabled={busy}
                  onClick={() => onAction(nodeId, type, null)}
                  className="rounded border border-border bg-surface px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-accent hover:text-text disabled:opacity-40"
                >
                  {busy && plan?.type === type ? "planning…" : `${type}…`}
                </button>
              ))}
              {plan && (
                <span className="min-w-full text-[11px] text-muted">
                  preview {plan.type}: {planSummary(plan.result)}
                  {needsConfirm && (
                    <button
                      type="button"
                      className="ml-2 rounded border border-accent/50 bg-accent-soft px-2 py-0.5 text-[11px] text-accent"
                      onClick={() =>
                        onAction(nodeId, plan.type, plan.result.plan?.confirmationToken ?? "")
                      }
                    >
                      Confirm {plan.type}
                    </button>
                  )}
                  {!needsConfirm && plan.result.ok && (
                    <button
                      type="button"
                      className="ml-2 rounded border border-accent/50 bg-accent-soft px-2 py-0.5 text-[11px] text-accent"
                      onClick={() => onAction(nodeId, plan.type, "")}
                    >
                      Run {plan.type}
                    </button>
                  )}
                </span>
              )}
              {busy && <span className="text-[11px] text-muted">working…</span>}
              {outcome && !busy && (
                <span
                  className={`min-w-full text-[11px] ${outcome.ok ? "text-accent" : "text-danger"}`}
                >
                  {outcome.type} {outcome.ok ? "ok" : "failed"}: {outcome.error || outcome.message}
                  {outcome.logs ? ` — logs: ${outcome.logs.slice(-400)}` : ""}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ComponentsPage;
