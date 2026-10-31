import { useState } from "react";
import type { NodeLanes, VersionInfo } from "../../../shared/types";
import { Panel } from "../ui/Panel";
import { ActivityIcon } from "../ui/icons";
import { AeonLadderDialog } from "./AeonLadderDialog";
import { BenchmarkDialog } from "./BenchmarkDialog";

const LAUNCHER_BTN =
  "rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs font-medium text-text transition-colors hover:border-accent hover:bg-accent-soft";

export interface NodeBenchEndpoint {
  port: number;
  modelId: string | null;
  engine: string | null;
  lane: string | null;
}

/**
 * LLM endpoints a node reports: running lanes first, then live LLM services
 * that are not lanes (mirrors server/fleet/nodeBench.js; the server
 * re-checks every start).
 */
export function nodeBenchEndpoints(lanes: NodeLanes | null | undefined, versions: VersionInfo[]): NodeBenchEndpoint[] {
  const live = (versions || []).filter((v) => v && v.kind === "llm" && Number.isInteger(v.port) && v.state !== "stopped");
  const byPort = new Map<number, NodeBenchEndpoint>();
  for (const pool of lanes?.pools ?? []) {
    for (const lane of pool.lanes ?? []) {
      if (!lane.running || lane.port == null || byPort.has(lane.port)) continue;
      const v = live.find((x) => x.port === lane.port);
      byPort.set(lane.port, {
        port: lane.port,
        modelId: v?.modelId ?? lane.modelId ?? null,
        engine: v?.engine ?? null,
        lane: lane.recipe ?? null,
      });
    }
  }
  for (const v of live) {
    if (!byPort.has(v.port)) byPort.set(v.port, { port: v.port, modelId: v.modelId ?? null, engine: v.engine ?? null, lane: null });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** Decode benches against an agent node's running LLM lanes (BENCH3). */
export function NodeBenchPanel({
  nodeId,
  nodeName,
  lanes,
  versions,
}: {
  nodeId: string;
  nodeName: string;
  lanes?: NodeLanes | null;
  versions: VersionInfo[];
}) {
  const endpoints = nodeBenchEndpoints(lanes, versions);
  const [open, setOpen] = useState<{ kind: "aeon" | "decode"; ep: NodeBenchEndpoint } | null>(null);
  return (
    <Panel title="LLM benchmarks" icon={<ActivityIcon />} bodyClassName="space-y-2">
      {endpoints.length === 0 ? (
        <p className="text-xs text-muted">No running LLM lane reported by this node.</p>
      ) : (
        <ul className="node-bench-lanes" aria-label="Benchable LLM lanes">
          {endpoints.map((ep) => (
            <li key={ep.port} className="node-bench-lane">
              <span className="node-bench-lane__label" title={ep.lane ?? undefined}>
                :{ep.port} · {ep.modelId || "unknown model"}
                {ep.engine ? ` · ${ep.engine}` : ""}
              </span>
              <button type="button" className={LAUNCHER_BTN} onClick={() => setOpen({ kind: "aeon", ep })}>
                AEON ladder
              </button>
              <button type="button" className={LAUNCHER_BTN} onClick={() => setOpen({ kind: "decode", ep })}>
                Decode bench
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[10px] leading-snug text-muted">
        Runs from the dashboard host over the LAN to the lane port. AEON ladder results are stored with AEON's metric
        definitions in the bench results store.
      </p>
      {open && (
        <AeonLadderDialog
          open={open.kind === "aeon"}
          onClose={() => setOpen(null)}
          targetId={nodeId}
          scope="node"
          port={open.ep.port}
          modelId={open.ep.modelId}
          title={nodeName}
        />
      )}
      {open && (
        <BenchmarkDialog
          open={open.kind === "decode"}
          onClose={() => setOpen(null)}
          sparkId={nodeId}
          scope="node"
          llmPort={open.ep.port}
          modelId={open.ep.modelId}
          sparkName={nodeName}
        />
      )}
    </Panel>
  );
}
