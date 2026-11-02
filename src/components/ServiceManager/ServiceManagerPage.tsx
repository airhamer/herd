import { useEffect, useState } from "react";
import type {
  MemoryBudget as MemoryBudgetType,
  ServiceInstance,
  VersionInfo,
} from "../../../shared/types";
import { fetchComponents, type CatalogComponent } from "../../api/client";
import { Panel } from "../ui/Panel";
import { GridIcon } from "../ui/icons";
import { KindBadge, ServiceCard, StatusBadge } from "./ServiceCard";
import { MemoryBudget, type GroupPlanForNode } from "./MemoryBudget";

export interface ServiceManagerPageProps {
  nodeId: string;
  nodeName: string;
  services: ServiceInstance[];
  memory: MemoryBudgetType;
  versions: VersionInfo[];
  /**
   * SC3: this node's TP-group plan (GroupResourcePlan narrowed to the
   * member view MemoryBudget renders). Parent builds it from the fleet
   * snapshot: topology groups + memory.byNode budgets + the calculator's
   * output. null/undefined → single-node view, unchanged.
   */
  groupPlan?: GroupPlanForNode | null;
  /**
   * Issue #94: live catalog components used to group each configured
   * service under its owning component card. Omit → the page self-fetches
   * GET /api/components once (GuardPanel precedent); a failed fetch degrades
   * to the flat card list (today's behavior). An empty list groups nothing.
   */
  components?: CatalogComponentWithPort[] | null;
  onStart: (serviceName: string) => void;
  onStop: (serviceName: string) => void;
  onSwitch: (serviceName: string) => void;
}

function versionKey(v: VersionInfo): string {
  return `${v.serviceName}:${v.port}`;
}

/**
 * CatalogComponent plus the projected engine port (issue #94 server-side
 * projection). Optional so older servers without the field still typecheck.
 */
export type CatalogComponentWithPort = CatalogComponent & { port?: number | null };

/**
 * Client mirror of matchServiceToComponent (server/fleet/componentCatalog.js
 * — same rules; the server module imports node:fs so it cannot be bundled
 * here). Map one configured service to its owning catalog component:
 * engine must match case-insensitively, then EITHER the component's port
 * equals service.port OR the live model id equals servedModelName pins the
 * row. No agreement → null (the service stays a flat card).
 */
export function matchServiceToComponent(
  components: readonly CatalogComponentWithPort[],
  service: Pick<ServiceInstance, "engine" | "port" | "modelId">,
): CatalogComponentWithPort | null {
  if (!Array.isArray(components) || !service) return null;
  const engine = typeof service.engine === "string" ? service.engine.trim().toLowerCase() : "";
  if (!engine) return null;
  for (const c of components) {
    if (!c || typeof c.engine !== "string") continue;
    if (c.engine.trim().toLowerCase() !== engine) continue;
    const portHit = Number.isFinite(c.port ?? NaN) && (c.port as number) === service.port;
    const modelHit =
      typeof service.modelId === "string" &&
      service.modelId !== "" &&
      typeof c.servedModelName === "string" &&
      c.servedModelName === service.modelId;
    if (portHit || modelHit) return c;
  }
  return null;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 truncate font-tabular text-text" title={value}>
        {value}
      </span>
    </div>
  );
}

/** One live version row (the ACTUAL running configuration, not a recipe). */
function VersionRow({ v }: { v: VersionInfo }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium text-text" title={v.serviceName}>
            {v.serviceName}
          </span>
          <KindBadge kind={v.kind} />
          <StatusBadge status={v.state} />
        </div>
        <span className="shrink-0 font-tabular text-xs text-muted">:{v.port}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs md:grid-cols-3">
        <Field
          label="Engine"
          value={v.engineVersion ? `${v.engine} ${v.engineVersion}` : v.engine || "—"}
        />
        <Field label="Model" value={v.modelId ?? "—"} />
        <Field label="Model path" value={v.modelPath ?? "—"} />
        <Field
          label="Context"
          value={v.contextLength != null ? v.contextLength.toLocaleString("en-US") : "—"}
        />
        <Field label="Mem fraction" value={v.memFraction != null ? String(v.memFraction) : "—"} />
        <Field label="TP size" value={v.tpSize != null ? String(v.tpSize) : "—"} />
      </div>
    </div>
  );
}

/**
 * Service Manager page for one node: memory budget + make-room plan, one card
 * per service (start/stop/switch), and live version info. Layout mirrors
 * SparkPage (stacked sections in a 2-column grid).
 *
 * SC3: when `groupPlan` is threaded the MemoryBudget panel unlocks its
 * multi-spark/TP section (group total + per-spark breakdown + shard
 * availability); without it the page is byte-for-byte the single-node view.
 */
export function ServiceManagerPage({
  nodeId,
  nodeName,
  services,
  memory,
  versions,
  groupPlan,
  components,
  onStart,
  onStop,
  onSwitch,
}: ServiceManagerPageProps) {
  const svcs = services ?? [];
  const versionsList = versions ?? [];

  // Resolve the catalog used for grouping: prop wins; otherwise one
  // best-effort fetch (degrade to flat cards on any failure).
  const [resolved, setResolved] = useState<CatalogComponentWithPort[] | null>(
    components ?? null,
  );
  useEffect(() => {
    if (components !== undefined) {
      setResolved(components ?? []);
      return;
    }
    let alive = true;
    fetchComponents()
      .then((v) => alive && setResolved(Array.isArray(v?.components) ? v.components : []))
      .catch(() => alive && setResolved([]));
    return () => {
      alive = false;
    };
  }, [components]);

  // Group configured services under their owning component card (#94);
  // unmatched services stay flat, exactly as before.
  const comps = resolved ?? [];
  const groups: { comp: CatalogComponentWithPort; members: ServiceInstance[] }[] = [];
  const groupBy = new Map<string, (typeof groups)[number]>();
  const orphans: ServiceInstance[] = [];
  for (const s of svcs) {
    const owner = comps.length > 0 ? matchServiceToComponent(comps, s) : null;
    if (!owner) {
      orphans.push(s);
      continue;
    }
    let g = groupBy.get(owner.id);
    if (!g) {
      g = { comp: owner, members: [] };
      groupBy.set(owner.id, g);
      groups.push(g);
    }
    g.members.push(s);
  }

  const serviceCard = (s: ServiceInstance) => {
    // `source` rides the snapshot when the server-side probe
    // (issue #93) produced status truth; absent otherwise.
    const source = (s as ServiceInstance & { source?: "engine" | "proxy" | null }).source;
    return (
      <ServiceCard
        key={s.name}
        name={s.name}
        kind={s.kind}
        engine={s.engine}
        port={s.port}
        status={s.status}
        modelId={s.modelId}
        engineVersion={s.engineVersion}
        footprintMB={s.footprintMB}
        active={s.active}
        source={source ?? null}
        polledAt={s.polledAt}
        onStart={() => onStart(s.name)}
        onStop={() => onStop(s.name)}
        onSwitch={() => onSwitch(s.name)}
      />
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-page-gap)" }}>
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-text-strong">Service Manager</h1>
          <p className="mt-0.5 text-xs text-muted">
            {nodeName} · {nodeId}
          </p>
        </div>
      </header>

      <div className="spark-page grid grid-cols-1 md:grid-cols-2" style={{ gap: "var(--density-page-gap)" }}>
        <MemoryBudget
          totalMB={memory.totalMB}
          usedMB={memory.usedMB}
          freeMB={memory.freeMB}
          servicesUsedMB={memory.servicesUsedMB}
          otherUsedMB={memory.otherUsedMB}
          services={memory.services}
          makeRoom={memory.makeRoom}
          needMakeRoom={memory.needMakeRoom}
          groupAvailableMB={memory.groupAvailableMB}
          group={groupPlan ?? null}
        />

        <section className="space-y-2 md:col-span-2" data-testid="services-section">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Services</h2>
          {svcs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted">
              No services
            </div>
          ) : (
            <div className="space-y-3">
              {groups.map((g) => (
                <div
                  key={`component:${g.comp.id}`}
                  data-component-group={g.comp.id}
                  className="rounded-lg border border-border bg-surface p-3"
                >
                  <div className="mb-2 flex min-w-0 items-center gap-1.5">
                    <span
                      className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-text-strong"
                      title={g.comp.name}
                    >
                      {g.comp.name}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted">
                      {g.comp.engine || "—"}
                      {Number.isFinite(g.comp.port ?? NaN) ? ` :${g.comp.port}` : ""}
                    </span>
                  </div>
                  <div
                    className="grid grid-cols-1 md:grid-cols-2"
                    style={{ gap: "var(--density-page-gap)" }}
                  >
                    {g.members.map(serviceCard)}
                  </div>
                </div>
              ))}
              {orphans.length > 0 && (
                <div
                  className="grid grid-cols-1 md:grid-cols-2"
                  style={{ gap: "var(--density-page-gap)" }}
                >
                  {orphans.map(serviceCard)}
                </div>
              )}
            </div>
          )}
        </section>

        <div className="md:col-span-2">
          <Panel title="Versions" icon={<GridIcon />} bodyClassName="space-y-2">
            {versionsList.length === 0 ? (
              <div className="text-sm text-muted">No version info</div>
            ) : (
              versionsList.map((v) => <VersionRow key={versionKey(v)} v={v} />)
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
