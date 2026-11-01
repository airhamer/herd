import type { NodeAgentSnapshot, TopologyInfo } from "../../../shared/types";
import { FleetCard } from "./FleetCard";
import { GroupCard } from "./GroupCard";
import { collectGroups, groupHolder } from "./FleetPage";
import { GroupSinglesPanel } from "./GroupSinglesPanel";
import type { CatalogComponent } from "../../api/client";

export interface GroupDetailPageProps {
  groupId: string;
  nodes: NodeAgentSnapshot[];
  topologyNodes: TopologyInfo[];
  onSelectNode?: (nodeId: string) => void;
  onBack?: () => void;
  /** SC5e: component catalog loader (tests inject one; default GET /api/components). */
  loadComponents?: () => Promise<{ components: CatalogComponent[] }>;
}

/**
 * Group drill-down (SC5d, #75): the group's aggregated card on top, then
 * each member's own Fleet card with its own bars.
 */
export function GroupDetailPage({ groupId, nodes, topologyNodes, onSelectNode, onBack, loadComponents }: GroupDetailPageProps) {
  const group = collectGroups(nodes, topologyNodes).find((g) => g.groupId === groupId) ?? null;
  if (!group) {
    return (
      <div className="panel mx-auto mt-16 max-w-md p-8 text-center" data-testid="group-detail-missing">
        <h2 className="text-sm font-semibold text-text-strong">Group not found</h2>
        <p className="mt-1 text-xs text-muted">No spark group “{groupId}”. Groups are edited on the Topology tab.</p>
        {onBack && (
          <button type="button" onClick={onBack} className="mt-4 text-xs text-accent underline">
            Back to fleet overview
          </button>
        )}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-page-gap)" }} data-testid="group-detail">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1
          className="font-normal leading-tight tracking-tight text-text-strong"
          style={{ fontSize: "var(--density-overview-title)" }}
        >
          {group.name}
        </h1>
        {onBack && (
          <button type="button" onClick={onBack} className="text-[11px] text-accent hover:underline">
            ← Fleet overview
          </button>
        )}
      </div>
      <div className="grid lg:grid-cols-3 sm:grid-cols-2" style={{ gap: "var(--density-page-gap)" }}>
        <GroupCard
          groupId={group.groupId}
          name={group.name}
          members={group.members}
          holder={groupHolder(group.members.map((m) => m.snapshot))}
        />
      </div>
      <h2 className="panel-title">Members</h2>
      <div
        className="overview-page grid sm:grid-cols-2 lg:grid-cols-3"
        style={{ gap: "var(--density-page-gap)" }}
        data-testid="group-detail-members"
      >
        {group.members.map(({ snapshot: node, rank }) => {
          const topo = topologyNodes.find((t) => t.nodeId === node.nodeId);
          return (
            <FleetCard
              key={node.nodeId}
              nodeId={node.nodeId}
              nodeName={node.nodeName}
              lanIp={node.lanIp}
              role={topo?.role ?? "standalone"}
              rank={rank}
              groupId={group.groupId}
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
      <GroupSinglesPanel
        members={group.members.map(({ snapshot: m }) => ({ nodeId: m.nodeId, nodeName: m.nodeName, mem: m.mem, gpu: m.gpu }))}
        {...(loadComponents ? { loadComponents } : {})}
      />
    </div>
  );
}
