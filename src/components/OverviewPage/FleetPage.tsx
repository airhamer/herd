import type { ReactNode } from "react";
import type {
  MemoryBudget,
  NodeAgentSnapshot,
  RequestStat,
  RoceLink,
  TopologyInfo,
} from "../../../shared/types";
import { FleetCard } from "./FleetCard";
import { GroupCard } from "./GroupCard";
import { aggregateMemoryPool } from "../../lib/groupMemory";
import { gpuHolderLabel } from "../../lib/memoryPool";
import { MemoryPoolBar } from "../ui/MemoryPoolBar";

export interface FleetPageProps {
  nodes: NodeAgentSnapshot[];
  topology: {
    nodes: TopologyInfo[];
    links: RoceLink[];
  };
  requests: {
    byModel: Record<string, RequestStat[]>;
    byEngine: Record<string, RequestStat[]>;
    byMachine: Record<string, RequestStat[]>;
  };
  memory: {
    totalMB: number;
    usedMB: number;
    freeMB: number;
    byNode: Record<string, MemoryBudget>;
  };
  /** When set, node cards become clickable and open the node detail view. */
  onSelectNode?: (nodeId: string) => void;
  /** Rendered under the node cards (the Fleet energy card, issue #33). */
  energy?: ReactNode;
  /** Rendered beside the energy card (the LLM token totals card, issue #38). */
  tokens?: ReactNode;
  /** Rendered under the node cards (the Recent activity card, issue #32). */
  activity?: ReactNode;
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/**
 * Resolve a node's role/rank/groupId from the assembled topology graph,
 * falling back to the node's own telemetry topology.
 */
function resolveRole(
  node: NodeAgentSnapshot,
  topologyNodes: TopologyInfo[]
): { role: TopologyInfo["role"]; rank: number | null; groupId: string | null } {
  const fromGraph = topologyNodes.find((t) => t.nodeId === node.nodeId);
  const info = fromGraph ?? node.topology;
  if (!info) return { role: "standalone", rank: null, groupId: null };
  return { role: info.role, rank: info.rank, groupId: info.groupId };
}

/** Sum request stats across the byMachine partition (each stat appears once). */
function sumRequests(byMachine: Record<string, RequestStat[]>) {
  let queued = 0;
  let running = 0;
  let finished = 0;
  for (const stats of Object.values(byMachine)) {
    for (const s of stats) {
      queued += s.queued;
      running += s.running;
      finished += s.finished;
    }
  }
  return { queued, running, finished };
}

/** A TP group assembled from the fleet's nodes (SC9). */
interface FleetGroup {
  groupId: string;
  members: NodeAgentSnapshot[];
}

/** Group nodes by resolved groupId, in first-appearance order. */
function collectGroups(
  nodes: NodeAgentSnapshot[],
  topologyNodes: TopologyInfo[],
): FleetGroup[] {
  const byId = new Map<string, FleetGroup>();
  for (const node of nodes) {
    const { groupId } = resolveRole(node, topologyNodes);
    if (!groupId) continue;
    let group = byId.get(groupId);
    if (!group) {
      group = { groupId, members: [] };
      byId.set(groupId, group);
    }
    group.members.push(node);
  }
  return [...byId.values()];
}

/** Who holds the GPU part of a set of nodes (one group, or the fleet): the models running across them. */
function groupHolder(members: NodeAgentSnapshot[]): string {
  const models = members
    .flatMap((m) => m.services)
    .filter((s) => s.kind === "llm" && s.status === "running")
    .map((s) => s.modelId);
  const topProcess = members
    .map((m) => ({ gpu: m.gpu }))
    .filter((x) => (x.gpu?.gpuAllocMB ?? 0) > 0)
    .sort((a, b) => (b.gpu?.gpuAllocMB ?? 0) - (a.gpu?.gpuAllocMB ?? 0))[0]?.gpu?.processes?.[0]?.name;
  return gpuHolderLabel(models, topProcess);
}

/**
 * Fleet overview page: summary strip + one FleetCard per node, then the
 * optional energy and activity slots.
 */
export function FleetPage({ nodes, topology, requests, memory, onSelectNode, energy, tokens, activity }: FleetPageProps) {
  const onlineCount = nodes.filter((n) => n.online).length;
  const offlineCount = nodes.length - onlineCount;
  const reqs = sumRequests(requests.byMachine);
  const groups = collectGroups(nodes, topology.nodes);
  // SC9: the fleet's memory is shown Hasso-style (issue #26 display), not as
  // plain numbers — one pool aggregated across every node's readings.
  const fleetPool = aggregateMemoryPool(nodes.map((n) => ({ mem: n.mem, gpu: n.gpu })));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-page-gap)" }}>
      {/* Header + summary */}
      <div className="flex flex-wrap items-end justify-between gap-6">
        <h1
          className="font-normal leading-tight tracking-tight text-text-strong"
          style={{ fontSize: "var(--density-overview-title)" }}
        >
          Fleet Overview
        </h1>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <a
            href="/fleet/showcase"
            className="text-[11px] text-accent hover:underline"
            title="Run the Prompt Showcase on every LLM lane at once"
          >
            Fleet showcase
          </a>
          <span className="online-chip">
            <span className="dot" />
            {onlineCount}/{nodes.length} online
          </span>
          <span className="text-[11px] text-muted">
            {nodes.length} node{nodes.length === 1 ? "" : "s"} ·{" "}
            {topology.links.length} link{topology.links.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      {/* Summary strip */}
      <div
        className="panel grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4"
        style={{ padding: "var(--density-panel-pad)" }}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[10px] tracking-wide text-muted">Nodes</span>
          <span className="font-tabular text-[13px] font-semibold text-text" data-testid="fleet-summary-nodes">
            {nodes.length} total · {onlineCount} online · {offlineCount} offline
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[10px] tracking-wide text-muted">Requests</span>
          <span className="font-tabular text-[13px] font-semibold text-text" data-testid="fleet-summary-requests">
            q{reqs.queued} · r{reqs.running} · f{reqs.finished}
          </span>
        </div>
        {!fleetPool && (
          <>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[10px] tracking-wide text-muted">Memory</span>
              <span className="font-tabular text-[13px] font-semibold text-text" data-testid="fleet-summary-memory">
                {formatMb(memory.usedMB)} / {formatMb(memory.totalMB)} used
              </span>
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[10px] tracking-wide text-muted">Free</span>
              <span
                className="font-tabular text-[13px] font-semibold"
                data-testid="fleet-summary-free"
              >
                {formatMb(memory.freeMB)}
              </span>
            </div>
          </>
        )}
        {fleetPool && (
          <div className="col-span-2 sm:col-span-4 min-w-0" data-testid="fleet-summary-memory">
            <MemoryPoolBar pool={fleetPool} holder={groupHolder(nodes)} />
          </div>
        )}
      </div>

      {/* TP groups: aggregated group memory, group-level facts only (SC9) */}
      {groups.length > 0 && (
        <div className="flex flex-col gap-3" data-testid="fleet-group-cards">
          <h2 className="panel-title">TP Groups</h2>
          <div
            className="overview-page grid sm:grid-cols-2 lg:grid-cols-3"
            style={{ gap: "var(--density-page-gap)" }}
          >
            {groups.map((group) => (
              <GroupCard
                key={group.groupId}
                groupId={group.groupId}
                memberCount={group.members.length}
                onlineCount={group.members.filter((m) => m.online).length}
                pool={aggregateMemoryPool(group.members.map((m) => ({ mem: m.mem, gpu: m.gpu })))}
                holder={groupHolder(group.members)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Cards */}
      {nodes.length === 0 ? (
        <div className="panel mx-auto mt-8 max-w-md p-8 text-center">
          <h2 className="text-sm font-semibold text-text-strong">No nodes registered</h2>
          <p className="mt-1 text-xs text-muted">
            Register a Spark node-agent to see it here.
          </p>
        </div>
      ) : (
        <div
          className="overview-page grid sm:grid-cols-2 lg:grid-cols-3"
          style={{ gap: "var(--density-page-gap)" }}
        >
          {nodes.map((node) => {
            const { role, rank, groupId } = resolveRole(node, topology.nodes);
            return (
              <FleetCard
                key={node.nodeId}
                nodeId={node.nodeId}
                nodeName={node.nodeName}
                lanIp={node.lanIp}
                role={role}
                rank={rank}
                groupId={groupId}
                online={node.online}
                enrollment={node.enrollment}
                gpu={node.gpu}
                cpu={node.cpu}
                mem={node.mem}
                containers={node.containers}
                services={node.services}
                versions={node.versions}
                requests={node.requests}
                topology={node.topology}
                memory={node.memory}
                polledAt={node.polledAt}
                llm={node.llm}
                onSelect={onSelectNode}
              />
            );
          })}
        </div>
      )}

      {tokens && energy ? (
        <div
          className="grid items-start lg:grid-cols-2"
          style={{ gap: "var(--density-page-gap)" }}
          data-testid="fleet-usage-row"
        >
          {tokens}
          {energy}
        </div>
      ) : (
        <>
          {tokens}
          {energy}
        </>
      )}
      {activity}
    </div>
  );
}
