import type {
  MemoryBudget as MemoryBudgetType,
  ServiceInstance,
  VersionInfo,
} from "../../../shared/types";
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
  onStart: (serviceName: string) => void;
  onStop: (serviceName: string) => void;
  onSwitch: (serviceName: string) => void;
}

function versionKey(v: VersionInfo): string {
  return `${v.serviceName}:${v.port}`;
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
  onStart,
  onStop,
  onSwitch,
}: ServiceManagerPageProps) {
  const svcs = services ?? [];
  const versionsList = versions ?? [];

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

        <section className="space-y-2 md:col-span-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Services</h2>
          {svcs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted">
              No services
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2" style={{ gap: "var(--density-page-gap)" }}>
              {svcs.map((s) => {
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
              })}
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
