import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, flush } from "../../testing/render";
import { FleetCard, type FleetCardProps } from "../OverviewPage/FleetCard";
import { FleetUpdatesProvider } from "./FleetUpdatesContext";
import { makeFetchRouter, updatesView, type RecordedCall } from "./testKit";
import { fleetViewToPath, parseFleetPath } from "../../hooks/useRoute";
import type {
  ContainerInfo,
  CpuMetrics,
  GpuMetrics,
  MemMetrics,
  MemoryBudget,
  RequestStats,
  ServiceInstance,
  TopologyInfo,
  VersionInfo,
} from "../../../shared/types";

// §6.3: single "DGX update available" badge from view.display === "available",
// click → /updates. Provider fans out one GET /api/fleet/updates (mocked).

const NODE_ID = "gx10-1c2c";

function mountCard(displayByNodeId: Record<string, "available" | "current">) {
  const router = makeFetchRouter((call: RecordedCall) => {
    if (call.url === "/api/fleet/updates") {
      return {
        status: 200,
        body: { views: Object.entries(displayByNodeId).map(([nodeId, display]) => updatesView(nodeId, { display })) },
      };
    }
    return { status: 404, body: { error: `unexpected ${call.method} ${call.url}` } };
  });
  const openUpdates = vi.fn();
  render(
    <FleetUpdatesProvider openUpdates={openUpdates}>
      <FleetCard {...makeCard()} />
    </FleetUpdatesProvider>
  );
  return { calls: router.calls, openUpdates };
}

// ── minimal FleetCard props (mirrors OverviewPage/FleetCard.test.tsx) ──

const FIXED_TS = 1_700_000_000_000;

function gpu(): GpuMetrics {
  return {
    temperature: 62, usage: 40, powerDraw: 45, powerLimit: 90,
    vramUsedMB: 20480, vramTotalMB: 128000, vramPercentage: 16, vramAvailableMB: 107520,
    processes: [],
  };
}
function cpu(): CpuMetrics {
  return { usage: 25, temperature: 55, draw: 18, tdp: 60 };
}
function mem(): MemMetrics {
  return { usedMB: 40000, totalMB: 128000, availableMB: 88000, percentage: 31 };
}
function containers(): ContainerInfo[] {
  return [
    { name: "sglang", image: "lmsysorg/sglang:v1.2.0", imageDigest: null, status: "running", uptimeSeconds: 90000, ports: ["8080:8080"], memUsedMB: 90000, memLimitMB: null, cpuPercent: 120 },
  ];
}
function services(): ServiceInstance[] {
  return [
    { name: "llm-tp1", kind: "llm", engine: "sglang", port: 8080, status: "running", modelId: "m", engineVersion: "v", footprintMB: 88000, active: true, polledAt: FIXED_TS },
  ];
}
function requests(): RequestStats {
  return { nodeId: NODE_ID, stats: [], polledAt: FIXED_TS };
}
function topology(): TopologyInfo {
  return { nodeId: NODE_ID, role: "head", rank: 0, groupId: "tp2-glm", headId: null, links: [] };
}
function memoryBudget(): MemoryBudget {
  return {
    nodeId: NODE_ID, totalMB: 128000, usedMB: 96000, freeMB: 32000,
    servicesUsedMB: 90000, otherUsedMB: 6000, services: [], makeRoom: [], needMakeRoom: false,
    polledAt: FIXED_TS,
  };
}

function makeCard(overrides: Partial<FleetCardProps> = {}): FleetCardProps {
  return {
    nodeId: NODE_ID,
    nodeName: NODE_ID,
    lanIp: "192.168.50.226",
    role: "head",
    rank: 0,
    groupId: "tp2-glm",
    online: true,
    gpu: gpu(),
    cpu: cpu(),
    mem: mem(),
    containers: containers(),
    services: services(),
    versions: [] as VersionInfo[],
    requests: requests(),
    topology: topology(),
    memory: memoryBudget(),
    polledAt: FIXED_TS,
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("FleetCard update badge (§6.3)", () => {
  it("appears when the fleet view says display=available and routes to /updates on click", async () => {
    const { calls, openUpdates } = mountCard({ [NODE_ID]: "available" });
    await flush();
    expect(calls.some((c) => c.method === "GET" && c.url === "/api/fleet/updates")).toBe(true);
    const badge = document.querySelector('[data-testid="update-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("DGX update available");
    act(() => {
      (badge as HTMLElement).click();
    });
    expect(openUpdates).toHaveBeenCalledTimes(1);
  });

  it("negative: no badge when display=current", async () => {
    mountCard({ [NODE_ID]: "current" });
    await flush();
    expect(document.querySelector('[data-testid="update-badge"]')).toBeNull();
  });

  it("route seam: the badge target maps /updates both ways", () => {
    expect(parseFleetPath("/updates")).toEqual({ page: "updates" });
    expect(fleetViewToPath({ page: "updates" })).toBe("/updates");
  });
});
