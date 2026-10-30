import { describe, expect, it } from "vitest";
import { render } from "../../testing/render";
import { FleetCard, type FleetCardProps } from "./FleetCard";
import type {
  ContainerInfo,
  CpuMetrics,
  GpuMetrics,
  MemMetrics,
  MemoryBudget,
  NodeRole,
  RequestStats,
  ServiceInstance,
  TopologyInfo,
  VersionInfo,
} from "../../../shared/types";

function gpu(): GpuMetrics {
  return {
    temperature: 62,
    usage: 40,
    powerDraw: 45,
    powerLimit: 90,
    vramUsedMB: 20480,
    vramTotalMB: 128000,
    vramPercentage: 16,
    vramAvailableMB: 107520,
    processes: [{ pid: 1001, name: "sglang", vramMB: 19000 }],
  };
}

function cpu(): CpuMetrics {
  return { usage: 25, temperature: 55, draw: 18, tdp: 60 };
}

function mem(): MemMetrics {
  return { usedMB: 40000, totalMB: 128000, availableMB: 88000, percentage: 31 };
}

function memoryBudget(overrides: Partial<MemoryBudget> = {}): MemoryBudget {
  return {
    nodeId: "gx10-1c2c",
    totalMB: 128000,
    usedMB: 96000,
    freeMB: 32000,
    servicesUsedMB: 90000,
    otherUsedMB: 6000,
    services: [
      { name: "llm-tp1", kind: "llm", footprintMB: 88000, running: true, needed: false },
    ],
    makeRoom: [],
    needMakeRoom: false,
    polledAt: Date.now(),
    ...overrides,
  };
}

function containers(): ContainerInfo[] {
  return [
    {
      name: "sglang",
      image: "lmsysorg/sglang:v1.2.0",
      imageDigest: null,
      status: "running",
      uptimeSeconds: 90000,
      ports: ["8080:8080"],
      memUsedMB: 90000,
      memLimitMB: null,
      cpuPercent: 120,
    },
    {
      name: "qdrant",
      image: "qdrant/qdrant:1.11",
      imageDigest: null,
      status: "running",
      uptimeSeconds: 200000,
      ports: [],
      memUsedMB: 512,
      memLimitMB: null,
      cpuPercent: 1,
    },
    {
      name: "old-worker",
      image: "vllm/vllm:0.8",
      imageDigest: null,
      status: "stopped",
      uptimeSeconds: null,
      ports: [],
      memUsedMB: null,
      memLimitMB: null,
      cpuPercent: null,
    },
  ];
}

function services(): ServiceInstance[] {
  return [
    {
      name: "llm-tp1",
      kind: "llm",
      engine: "sglang",
      port: 8080,
      status: "running",
      modelId: "qwen3.8-27b",
      engineVersion: "v1.2.0",
      footprintMB: 88000,
      active: true,
      polledAt: Date.now(),
    },
    {
      name: "comfy",
      kind: "image",
      engine: "comfyui",
      port: 8188,
      status: "stopped",
      modelId: null,
      engineVersion: null,
      footprintMB: 2048,
      active: false,
      polledAt: Date.now(),
    },
  ];
}

function requests(): RequestStats {
  return {
    nodeId: "gx10-1c2c",
    stats: [
      { modelId: "qwen3.8-27b", engine: "sglang", nodeId: "gx10-1c2c", port: 8080, queued: 1, running: 2, finished: 10, polledAt: Date.now() },
    ],
    polledAt: Date.now(),
  };
}

function topology(): TopologyInfo {
  return {
    nodeId: "gx10-1c2c",
    role: "head",
    rank: 0,
    groupId: "tp2-glm",
    headId: null,
    links: [],
  };
}

function makeCard(overrides: Partial<FleetCardProps> = {}): FleetCardProps {
  const now = Date.now();
  return {
    nodeId: "gx10-1c2c",
    nodeName: "gx10-1c2c",
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
    polledAt: now - 65_000, // stable in the "1m ago" bucket for the test window
    ...overrides,
  };
}

describe("FleetCard", () => {
  it("renders header, GPU, CPU, mem, containers, services, requests, memory budget, and polled-at", () => {
    const { container } = render(<FleetCard {...makeCard()} />);
    const text = container.textContent ?? "";

    // Header
    expect(text).toContain("gx10-1c2c");
    expect(text).toContain("Head");
    expect(text).toContain("192.168.50.226");
    expect(container.querySelector('[data-testid="fleet-card-status"]')?.textContent).toBe("online");

    // GPU
    expect(text).toContain("45W / 90W"); // power draw / limit
    expect(text).toContain("62°C"); // temperature
    expect(text).toContain("40%"); // usage

    // CPU
    expect(text).toContain("25% · 55°C");

    // Unified memory pool (#26): GB10 → one pool bar instead of VRAM + Mem
    expect(text).toContain("Unified memory");
    expect(text).toContain("39.1 / 125.0 GiB in use"); // MemTotal − MemAvailable
    expect(text).not.toContain("VRAM");

    // Containers: 3 total, 2 running
    expect(text).toContain("3 (2 running)");

    // Services: 2 total, 1 running
    expect(text).toContain("2 (1 active)");

    // Requests
    expect(text).toContain("q1 · r2 · f10");

    // Memory budget
    expect(text).toContain("31.3 GB free");

    // PolledAt
    expect(container.querySelector('[data-testid="fleet-card-polledat"]')?.textContent).toContain("1m ago");
  });

  it("memory pool (#26): names the running model, splits cache and swap from the agent's meminfo fields", () => {
    const { container } = render(
      <FleetCard
        {...makeCard({
          gpu: { ...gpu(), gpuAllocMB: 30000, unifiedMemory: true },
          mem: {
            ...mem(),
            cachedMB: 20480,
            swapTotalMB: 16384,
            swapFreeMB: 8192,
          },
        })}
      />
    );
    const legend = container.querySelector('[data-testid="memory-pool-legend"]')?.textContent ?? "";
    expect(legend).toContain("qwen3.8-27b29.3"); // gpuAllocMB 30000 MB
    expect(legend).toContain("System and apps9.8"); // 40000 − 30000
    expect(legend).toContain("Page cache20.0");
    expect(legend).toContain("Free65.9"); // 88000 − 20480
    expect(legend).toContain("Swap in use8.0");
    expect(container.querySelector('[data-testid="memory-pool-floor-text"]')?.textContent).toBe(
      "82.9 above the 3 GiB floor"
    );
  });

  it("memory pool (#26): a discrete GPU keeps its VRAM bar and the pool has no GPU segment", () => {
    const { container } = render(
      <FleetCard
        {...makeCard({
          gpu: { ...gpu(), vramTotalMB: 24576, vramUsedMB: 8192, unifiedMemory: false },
        })}
      />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("VRAM");
    expect(text).toContain("8.0 / 24.0 GB");
    expect(container.querySelector('[data-testid="memory-pool"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="memory-pool-seg-gpu"]')).toBeNull();
    expect(text).not.toContain("Unified memory");
  });

  it("shows offline status and unreachable placeholder", () => {
    const { container } = render(<FleetCard {...makeCard({ online: false })} />);
    expect(container.querySelector('[data-testid="fleet-card-status"]')?.textContent).toBe("offline");
    expect(container.textContent).toContain("Host unreachable");
    // Metric rows are replaced by the placeholder
    expect(container.textContent).not.toContain("45W / 90W");
  });

  it("shows pending enrollment state (S1.2)", () => {
    const { container } = render(<FleetCard {...makeCard({ online: false, enrollment: "pending" })} />);
    expect(container.querySelector('[data-testid="fleet-card-status"]')?.textContent).toBe("pending");
  });

  it("renders the role badge for each role", () => {
    const head = render(<FleetCard {...makeCard({ role: "head" as NodeRole })} />);
    expect(head.container.textContent).toContain("Head");

    const worker = render(
      <FleetCard {...makeCard({ role: "worker" as NodeRole, rank: 1, nodeId: "gx10-27c1" })} />
    );
    expect(worker.container.textContent).toContain("Worker");
    expect(worker.container.textContent).toContain("rank 1");

    const standalone = render(
      <FleetCard
        {...makeCard({
          role: "standalone" as NodeRole,
          rank: null,
          groupId: null,
          nodeId: "narthex",
          topology: null,
        })}
      />
    );
    expect(standalone.container.textContent).toContain("Standalone");
    // no rank/group line when null
    expect(standalone.container.textContent).not.toContain("rank null");
  });

  it("shows the make-room banner when the budget needs room", () => {
    const { container } = render(
      <FleetCard
        {...makeCard({
          memory: memoryBudget({
            freeMB: 1000,
            needMakeRoom: true,
            makeRoom: [{ serviceName: "comfy", freesMB: 2048, reason: "stoppable" }],
          }),
        })}
      />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Make room needed");
    expect(text).toContain("stop: comfy");
    expect(text).toContain("1000 MB free");
  });

  it("renders waiting placeholder for an online node with no metrics", () => {
    const { container } = render(
      <FleetCard {...makeCard({ gpu: null, cpu: null, mem: null, memory: null, requests: null })} />
    );
    expect(container.textContent).toContain("Waiting for metrics…");
  });

  it("Models: renders one row per LLM service with model id, engine and port (multi-model)", () => {
    const second: ServiceInstance = {
      name: "llm-glm",
      kind: "llm",
      engine: "sglang",
      port: 8081,
      status: "running",
      modelId: "glm-5.3",
      engineVersion: "v1.3.0",
      footprintMB: 40000,
      active: false,
      polledAt: Date.now(),
    };
    const { container } = render(<FleetCard {...makeCard({ services: [...services(), second] })} />);
    const rows = container.querySelectorAll('[data-testid="fleet-card-models"] li');
    expect(rows).toHaveLength(2);
    const text = container.textContent ?? "";
    expect(text).toContain("qwen3.8-27b");
    expect(text).toContain("glm-5.3");
    expect(text).toContain("sglang · :8081");
  });

  it("Models: sorts running > loading > stopped and labels non-running rows", () => {
    const stopped: ServiceInstance = {
      name: "llm-idle",
      kind: "llm",
      engine: "vllm",
      port: 8082,
      status: "stopped",
      modelId: null,
      engineVersion: null,
      footprintMB: 1000,
      active: false,
      polledAt: Date.now(),
    };
    const loading: ServiceInstance = { ...stopped, name: "llm-loading", port: 8083, status: "loading", modelId: "qwen-new" };
    const base = services().find((s) => s.kind === "llm")!;
    const { container } = render(<FleetCard {...makeCard({ services: [stopped, loading, base] })} />);
    const names = [...container.querySelectorAll('[data-testid="fleet-card-models"] li')].map(
      (li) => (li.querySelector("span:nth-child(2)")?.textContent ?? "").trim()
    );
    expect(names).toEqual(["qwen3.8-27b", "qwen-new", "llm-idle"]);
    expect(container.textContent).toContain("loading");
  });

  it("Models: tooltip carries model path and quantization from versions", () => {
    const v: VersionInfo = {
      serviceName: "llm-tp1",
      kind: "llm",
      engine: "sglang",
      engineVersion: "v1.2.0",
      modelId: "qwen3.8-27b",
      modelPath: "RadixArk/Qwen3.8-27B-NVFP4",
      modelRevision: null,
      quantization: "nvfp4",
      contextLength: 131072,
      memFraction: 0.8,
      tpSize: 1,
      port: 8080,
      state: "running",
      polledAt: Date.now(),
    };
    const { container } = render(<FleetCard {...makeCard({ versions: [v] })} />);
    const row = container.querySelector('[data-testid="fleet-card-models"] li');
    expect(row?.getAttribute("title")).toContain("RadixArk/Qwen3.8-27B-NVFP4");
    expect(row?.getAttribute("title")).toContain("nvfp4");
  });

  it("Models: empty state when the node has no LLM services", () => {
    const { container } = render(
      <FleetCard {...makeCard({ services: services().filter((s) => s.kind !== "llm") })} />
    );
    expect(container.querySelector('[data-testid="fleet-card-models-empty"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="fleet-card-models"]')).toBeNull();
  });
});
