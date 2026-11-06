import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchComponents,
  fetchFleetNodes,
  fetchStacks,
  saveStack,
  sendComponentAction,
  sendGroupComponentAction,
  fetchRecordingStatus,
  fetchRecordings,
  fetchRecording,
  deleteRecording,
  setRecordingPolicy,
  STACKS_EXPORT_URL,
  type CatalogComponent,
  type ComponentActionSendRequest,
  type FleetStack,
  type RecordingListItem,
  type RecordingStatus,
  type StacksView,
} from "../../api/client";
import type { ComponentActionResult } from "../../api/types";
import { StackBuilder } from "./StackBuilder";
import { StackCards } from "./StackCards";
import { StackPreviewPanel } from "./StackPreviewPanel";
import {
  DEFAULT_FILTERS,
  componentBlockedReason,
  filterComponents,
  filterStacks,
  loadFilters,
  saveFilters,
  type StackFilters,
} from "./stackFilters";

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ACTIONS = ["start", "stop", "restart", "install"] as const;
const VARIANT_ACTION = "swap-variant" as const;
type ActionType = (typeof ACTIONS)[number] | typeof VARIANT_ACTION;

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
        {value !== "all" && !options.includes(value) && <option value={value}>{value}</option>}
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
 * ComponentsPage — POC Components tab (issue #7), with the SC5a (#72)
 * filter bar (tp / recipe source / engine / purpose / stack, persisted in
 * localStorage) and stack cards with live category badges. Lists the POC1 catalog
 * (GET /api/components: definitions + live per-node state) and drives
 * start/stop/restart through the POC2 v2 action seam: pressing a verb first
 * fires a dry-run preview (ComponentActionRequest.dryRun), "Confirm" replays
 * it as the real action, carrying the plan's confirmationToken when the
 * confirm class is "required" (the agent refuses those without a token).
 */
export interface ComponentsPageProps {
  /** Limit stacks and actions to one node (node-detail sub-tab). */
  scopeNodeId?: string;
  /** Limit stacks to one spark group (group-detail sub-tab). */
  scopeGroupId?: string;
}

export function ComponentsPage({ scopeNodeId, scopeGroupId }: ComponentsPageProps = {}) {
  const [components, setComponents] = useState<CatalogComponent[] | null>(null);
  const [stacks, setStacks] = useState<FleetStack[]>([]);
  const [facets, setFacets] = useState<StacksView["facets"]>({ tp: [], sources: [], engines: [], purposes: [] });
  const [nodeNames, setNodeNames] = useState<NamesById>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  // SC5a: filter state persists in localStorage (decision #6 on #72).
  const [filters, setFilters] = useState<StackFilters>(() => loadFilters());
  const [building, setBuilding] = useState(false);
  // SC5b: the stack target whose switch preview is open.
  const [previewOf, setPreviewOf] = useState<{ stackId: string; nodeId: string | null } | null>(null);
  const [action, setAction] = useState<ActionState>({ busy: null, plan: null, result: null, error: null });

  const reload = useCallback(async () => {
    try {
      const [comps, nodes, stks] = await Promise.all([
        fetchComponents(),
        fetchFleetNodes(),
        // SC10 stacks fail-soft: an older server without /api/stacks must
        // never take the Components tab down with it.
        fetchStacks({ nodeId: scopeNodeId, groupId: scopeGroupId }).catch(
          (): StacksView => ({ stacks: [], facets: { tp: [], sources: [], engines: [], purposes: [] }, errors: [] })
        ),
      ]);
      setComponents(comps.components);
      setStacks(stks.stacks);
      setFacets(stks.facets);
      const names: NamesById = {};
      for (const n of nodes.nodes) names[n.id] = n.name;
      setNodeNames(names);
      setLoadError(null);
    } catch (err) {
      setLoadError(errText(err));
    }
  }, [scopeNodeId, scopeGroupId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    saveFilters(filters);
  }, [filters]);
  const setFilter = useCallback(
    <K extends keyof StackFilters>(key: K, value: StackFilters[K]) => setFilters((f) => ({ ...f, [key]: value })),
    []
  );

  const shownStacks = useMemo(() => filterStacks(stacks, filters), [stacks, filters]);
  const hiddenBlocked = useMemo(
    () => (filters.showBlocked ? 0 : filterStacks(stacks, { ...filters, showBlocked: true }).length - shownStacks.length),
    [stacks, filters, shownStacks]
  );
  const visible = useMemo(() => filterComponents(components ?? [], stacks, filters), [components, stacks, filters]);
  const hiddenComponents = useMemo(() => {
    if (!components) return 0;
    return filterComponents(components, stacks, { ...filters, showBlocked: true }).length - visible.length;
  }, [components, stacks, filters, visible]);
  const unresolvedCount = useMemo(
    () => stacks.reduce((n, s) => n + ((s.unresolved ?? []).length > 0 ? 1 : 0), 0),
    [stacks],
  );
  const stackIds = useMemo(() => Array.from(new Set(stacks.map((s) => s.id))), [stacks]);
  const filtered =
    JSON.stringify({ ...filters, showBlocked: false }) !== JSON.stringify({ ...DEFAULT_FILTERS, showBlocked: false });

  /** One action against one node: preview (dryRun) or the confirmed real run. */
  const runAction = useCallback(
    async (
      comp: CatalogComponent,
      nodeId: string,
      type: ActionType,
      confirmationToken: string | null,
      variantId: string | null = null
    ) => {
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
        timeoutMs: type === "install" || type === "swap-variant" ? 20 * 60_000 : null,
        variantId,
      };
      setAction((a) => ({ ...a, busy: key, error: null }));
      try {
        const result = scopeGroupId && comp.tp === 2
          ? await sendGroupComponentAction(scopeGroupId, { ...body, groupRef: scopeGroupId })
          : await sendComponentAction(nodeId, body);
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
    [nodeNames, reload, scopeGroupId]
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
            data-testid="stack-filter-bar"
          >
            <FilterSelect label="tp" value={filters.tp} onChange={(v) => setFilter("tp", v)} options={facets.tp.map(String)} />
            <FilterSelect label="source" value={filters.source} onChange={(v) => setFilter("source", v)} options={facets.sources} />
            <FilterSelect label="engine" value={filters.engine} onChange={(v) => setFilter("engine", v)} options={facets.engines} />
            <FilterSelect label="purpose" value={filters.purpose} onChange={(v) => setFilter("purpose", v)} options={facets.purposes} />
            <FilterSelect label="stack" value={filters.stack} onChange={(v) => setFilter("stack", v)} options={stackIds} />
            <label className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted">
              <input
                type="checkbox"
                checked={filters.showBlocked}
                onChange={(e) => setFilter("showBlocked", e.target.checked)}
              />
              show blocked
            </label>
            {filtered && (
              <button
                type="button"
                className="text-xs text-muted underline"
                onClick={() => setFilters((f) => ({ ...DEFAULT_FILTERS, showBlocked: f.showBlocked }))}
              >
                Clear
              </button>
            )}
            <span className="ml-auto flex gap-3">
              <button type="button" className="text-xs text-accent underline" onClick={() => setBuilding((b) => !b)}>
                New stack
              </button>
              <a className="text-xs text-accent underline" href={STACKS_EXPORT_URL} download="stacks.json">
                Export
              </a>
              <button
                type="button"
                className="text-xs text-accent underline"
                onClick={() => {
                  void reload();
                }}
              >
                Refresh
              </button>
            </span>
          </div>
          {building && (
            <StackBuilder
              components={(components ?? []).map((c) => ({ id: c.id, name: c.name }))}
              onCancel={() => setBuilding(false)}
              onSave={async (draft) => {
                await saveStack(draft);
                setBuilding(false);
                await reload();
              }}
            />
          )}
          <StackCards
            stacks={shownStacks}
            hiddenBlocked={hiddenBlocked}
            nodeNames={nodeNames}
            selected={filters.stack}
            onSelect={(id) => setFilter("stack", id)}
            extra={(s) =>
              s.target.nodeIds.length > 0 && (
                <button
                  type="button"
                  data-testid={`preview-${s.id}-${s.target.nodeIds[0]}`}
                  onClick={() => setPreviewOf({ stackId: s.id, nodeId: s.target.nodeIds[0] })}
                  className="self-start rounded border border-border bg-surface px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-text"
                >
                  Preview switch…
                </button>
              )
            }
          />
          {previewOf && (
            <StackPreviewPanel
              stackId={previewOf.stackId}
              nodeId={previewOf.nodeId}
              nodeNames={nodeNames}
              onClose={() => setPreviewOf(null)}
            />
          )}
          <h3 className="panel-title" style={{ marginBottom: "var(--density-panel-title-mb)" }}>
            Components ({visible.length})
          </h3>
          {visible.length === 0 ? (
            <p className="text-xs text-muted" data-testid="components-empty">
              No components match the catalog filters.
              {hiddenComponents > 0 ? ` ${hiddenComponents} blocked hidden.` : ""}
              {unresolvedCount > 0 ? ` ${unresolvedCount} stack${unresolvedCount === 1 ? "" : "s"} name an unknown component.` : ""}
              {hiddenComponents > 0 ? " Turn on “show blocked” to inspect them." : ""}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {visible.map((comp) => (
                <ComponentRow
                  key={comp.id}
                  comp={comp}
                  blockedReason={componentBlockedReason(comp, stacks)}
                  nodeNames={nodeNames}
                  action={action}
                  onAction={(nodeId, type, token, variantId) => void runAction(comp, nodeId, type, token, variantId)}
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
  blockedReason,
  nodeNames,
  action,
  onAction,
}: {
  comp: CatalogComponent;
  /** Shown when "show blocked" reveals a blocked component. */
  blockedReason: string | null;
  nodeNames: NamesById;
  action: ActionState;
  onAction: (nodeId: string, type: ActionType, confirmationToken: string | null, variantId?: string | null) => void;
}) {
  const targets = actionTargets(comp, nodeNames);
  return (
    <div className="rounded-lg border border-border bg-surface-elevated p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs font-semibold text-text-strong">{comp.name}</span>
        <span className="font-mono text-[10px] text-muted">{comp.id}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wide text-muted">
          {comp.kind} · {comp.purpose} · tp{comp.tp} · {comp.engine ?? "unknown"} · {comp.recipeSource ?? "unknown"}
          {comp.memoryPerSparkMB != null ? ` · ${Math.round(comp.memoryPerSparkMB / 1024)} GiB` : ""}
        </span>
      </div>
      {blockedReason && <p className="mt-1 text-[11px] text-danger">Blocked: {blockedReason}</p>}
      {comp.description && <p className="mt-1 text-[11px] text-muted">{comp.description}</p>}
      <RecordingControls comp={comp} nodeId={targets[0] ?? null} />
      <p className="mt-1 text-[11px] text-muted">
        {comp.runtimeProfile?.ports?.engine != null
          ? `engine :${comp.runtimeProfile.ports.engine}`
          : ""}
        {comp.runtimeProfile?.ports?.guard != null ? ` / guard :${comp.runtimeProfile.ports.guard}` : ""}
        {comp.runtimeProfile?.adapters?.length
          ? ` · adapters ${comp.runtimeProfile.adapters.map((a) => a.id).join(", ")}`
          : ""}
      </p>
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
              {(comp.variants ?? []).length > 1 && (
                <VariantSwap
                  comp={comp}
                  nodeId={nodeId}
                  busy={busy}
                  onAction={onAction}
                />
              )}
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

function VariantSwap({
  comp,
  nodeId,
  busy,
  onAction,
}: {
  comp: CatalogComponent;
  nodeId: string;
  busy: boolean;
  onAction: (nodeId: string, type: ActionType, confirmationToken: string | null, variantId?: string | null) => void;
}) {
  const options = comp.variants ?? [];
  const current = comp.activeVariantId ?? options[0]?.id;
  return (
    <label className="flex items-center gap-1 text-[11px] text-muted">
      variant
      <select
        data-testid={`variant-select-${comp.id}`}
        defaultValue={current ?? ""}
        disabled={busy}
        className="rounded border border-border bg-surface px-1 py-0.5 text-[11px] text-text"
        id={`variant-${comp.id}-${nodeId}`}
      >
        {options.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label || v.id}
          </option>
        ))}
      </select>
      <button
        type="button"
        data-testid={`variant-swap-${comp.id}`}
        disabled={busy}
        onClick={() => {
          const sel = document.getElementById(`variant-${comp.id}-${nodeId}`) as HTMLSelectElement | null;
          onAction(nodeId, "swap-variant", null, sel?.value || current || null);
        }}
        className="rounded border border-border bg-surface px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-text disabled:opacity-40"
      >
        swap variant…
      </button>
    </label>
  );
}

function RecordingControls({ comp, nodeId }: { comp: CatalogComponent; nodeId: string | null }) {
  const desired = comp.recording?.content ?? comp.runtimeProfile?.recording?.content ?? "metadata";
  const [status, setStatus] = useState<RecordingStatus | null>(null);
  const [items, setItems] = useState<RecordingListItem[] | null>(null);
  const [detail, setDetail] = useState<{ prompt: string | null; response: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!nodeId) {
      setStatus({ recording: false, available: false, content: desired, ui: "not recording / unavailable", reason: "observer-unavailable" });
      return;
    }
    try {
      const s = await fetchRecordingStatus(nodeId, { content: desired, observer: comp.runtimeProfile?.recording?.observer ?? "relay" });
      setStatus(s);
    } catch {
      setStatus({ recording: false, available: false, content: desired, ui: "not recording / unavailable", reason: "observer-unavailable" });
    }
  }, [nodeId, desired, comp.runtimeProfile?.recording?.observer]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enabled = status?.recording === true;
  return (
    <div className="mt-1 text-[11px] text-muted" data-testid={`recording-${comp.id}`}>
      Recording: {status ? status.ui : "checking observer…"}
      {status && !status.available ? " (desired policy cannot record without an observer)" : ""}
      {nodeId && (
        <>
          <button
            type="button"
            className="ml-2 rounded border border-border bg-surface px-2 py-0.5 text-[11px]"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              const next = enabled || desired === "prompts+responses" ? "metadata" : "prompts+responses";
              void setRecordingPolicy(nodeId, { componentId: comp.id, content: next, observer: "relay" })
                .then(() => refresh())
                .finally(() => setBusy(false));
            }}
          >
            {enabled ? "disable content recording" : "enable content recording"}
          </button>
          <button
            type="button"
            className="ml-1 rounded border border-border bg-surface px-2 py-0.5 text-[11px]"
            onClick={() => {
              if (!nodeId) return;
              void fetchRecordings(nodeId, comp.id).then((r) => setItems(r.recordings));
            }}
          >
            view recordings
          </button>
        </>
      )}
      {items && (
        <ul className="mt-1 space-y-1">
          {items.length === 0 && <li>No stored recordings.</li>}
          {items.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                className="underline"
                onClick={() => {
                  if (!nodeId) return;
                  void fetchRecording(nodeId, it.id).then((r) => setDetail({ prompt: r.recording.prompt, response: r.recording.response }));
                }}
              >
                {it.requestId} · {it.segment}
                {it.stream?.incomplete ? " (incomplete)" : ""}
              </button>
              <button
                type="button"
                className="ml-2 text-danger"
                onClick={() => {
                  if (!nodeId) return;
                  void deleteRecording(nodeId, it.id).then(() => fetchRecordings(nodeId, comp.id).then((r) => setItems(r.recordings)));
                }}
              >
                delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {detail && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface p-2 text-[10px]">
          prompt: {detail.prompt ?? "(none)"}{"\n"}response: {detail.response ?? "(none)"}
        </pre>
      )}
    </div>
  );
}

export default ComponentsPage;
