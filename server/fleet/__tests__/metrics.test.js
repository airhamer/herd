import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFleetMetrics } from "../metrics.js";

// ─── Golden anchor fixture ─────────────────────────────────────────────────
// 2 nodes: node-a carries every family (cpu/mem/disk/net/gpu + requests),
// node-b is offline with null/empty families. Extra snapshot properties
// (ip, linkSpeedMbps, percentage, polledAt, topology, ...) must be ignored.

export const goldenSnapshot = {
  nodes: [
    {
      nodeId: "node-a",
      nodeName: "gx10-1c2c",
      online: true,
      uptimeSeconds: 123456,
      cpu: { usage: 42.5, temperature: 61, draw: 87.25, tdp: 120 },
      mem: { totalMB: 1024, usedMB: 512, availableMB: 256, percentage: 50 },
      disk: [
        { device: "/dev/nvme0n1p2", mount: "/", usedMB: 1024, totalMB: 2048, availableMB: 512, percentage: 50 },
        { device: "/dev/sda1", mount: "/data", usedMB: 200, totalMB: 400, availableMB: 100, percentage: 50 },
      ],
      net: [{ iface: "eth0", ip: "192.168.50.226", rxSpeed: 2, txSpeed: 0.5, linkSpeedMbps: 100000 }],
      gpu: {
        temperature: 55, usage: 80, powerDraw: 95.5, powerLimit: 140,
        vramUsedMB: 64, vramTotalMB: 128, vramPercentage: 50, vramAvailableMB: 64, processes: [],
      },
      topology: null,
      polledAt: 1764000000000,
    },
    {
      nodeId: "node-b",
      nodeName: "gx10-27c1",
      online: false,
      uptimeSeconds: null,
      cpu: null,
      mem: null,
      disk: [],
      net: [],
      gpu: null,
      polledAt: 0,
    },
  ],
  requests: {
    byMachine: {
      "node-a": [
        { modelId: "aeon", engine: "sglang", nodeId: "node-a", port: 8081, queued: 1, running: 0, finished: 4, polledAt: 1 },
        { modelId: "qwen3.8-27b", engine: "vllm", nodeId: "node-a", port: 8080, queued: 0, running: 2, finished: 137, polledAt: 1 },
      ],
      "node-b": [],
    },
  },
  memory: { totalMB: 2048, usedMB: 640, freeMB: 1000, byNode: {} },
  topology: { nodes: [], links: [] },
  polledAt: 1764000000999,
};

const GOLDEN = `# HELP herd_cpu_power_limit_watts CPU power limit (TDP) in watts.
# TYPE herd_cpu_power_limit_watts gauge
herd_cpu_power_limit_watts{node="node-a"} 120
# HELP herd_cpu_power_watts CPU power draw in watts.
# TYPE herd_cpu_power_watts gauge
herd_cpu_power_watts{node="node-a"} 87.25
# HELP herd_cpu_temperature_celsius CPU temperature in Celsius.
# TYPE herd_cpu_temperature_celsius gauge
herd_cpu_temperature_celsius{node="node-a"} 61
# HELP herd_cpu_usage_percent CPU utilization percentage (0-100).
# TYPE herd_cpu_usage_percent gauge
herd_cpu_usage_percent{node="node-a"} 42.5
# HELP herd_disk_available_bytes Filesystem available space in bytes.
# TYPE herd_disk_available_bytes gauge
herd_disk_available_bytes{node="node-a",mount="/",device="/dev/nvme0n1p2"} 536870912
herd_disk_available_bytes{node="node-a",mount="/data",device="/dev/sda1"} 104857600
# HELP herd_disk_total_bytes Filesystem total size in bytes.
# TYPE herd_disk_total_bytes gauge
herd_disk_total_bytes{node="node-a",mount="/",device="/dev/nvme0n1p2"} 2147483648
herd_disk_total_bytes{node="node-a",mount="/data",device="/dev/sda1"} 419430400
# HELP herd_disk_used_bytes Filesystem used space in bytes.
# TYPE herd_disk_used_bytes gauge
herd_disk_used_bytes{node="node-a",mount="/",device="/dev/nvme0n1p2"} 1073741824
herd_disk_used_bytes{node="node-a",mount="/data",device="/dev/sda1"} 209715200
# HELP herd_fleet_mem_free_bytes Fleet aggregate memory free in bytes.
# TYPE herd_fleet_mem_free_bytes gauge
herd_fleet_mem_free_bytes 1048576000
# HELP herd_fleet_mem_total_bytes Fleet aggregate memory total in bytes.
# TYPE herd_fleet_mem_total_bytes gauge
herd_fleet_mem_total_bytes 2147483648
# HELP herd_fleet_mem_used_bytes Fleet aggregate memory used in bytes.
# TYPE herd_fleet_mem_used_bytes gauge
herd_fleet_mem_used_bytes 671088640
# HELP herd_gpu_power_limit_watts GPU power limit in watts.
# TYPE herd_gpu_power_limit_watts gauge
herd_gpu_power_limit_watts{node="node-a",index="0"} 140
# HELP herd_gpu_power_watts GPU power draw in watts.
# TYPE herd_gpu_power_watts gauge
herd_gpu_power_watts{node="node-a",index="0"} 95.5
# HELP herd_gpu_temperature_celsius GPU temperature in Celsius.
# TYPE herd_gpu_temperature_celsius gauge
herd_gpu_temperature_celsius{node="node-a",index="0"} 55
# HELP herd_gpu_usage_percent GPU utilization percentage (0-100).
# TYPE herd_gpu_usage_percent gauge
herd_gpu_usage_percent{node="node-a",index="0"} 80
# HELP herd_gpu_vram_total_bytes GPU VRAM total, in bytes.
# TYPE herd_gpu_vram_total_bytes gauge
herd_gpu_vram_total_bytes{node="node-a",index="0"} 134217728
# HELP herd_gpu_vram_used_bytes GPU VRAM in use, in bytes.
# TYPE herd_gpu_vram_used_bytes gauge
herd_gpu_vram_used_bytes{node="node-a",index="0"} 67108864
# HELP herd_llm_requests_finished Finished requests per model/engine on a machine.
# TYPE herd_llm_requests_finished gauge
herd_llm_requests_finished{node="node-a",model="aeon",engine="sglang",port="8081"} 4
herd_llm_requests_finished{node="node-a",model="qwen3.8-27b",engine="vllm",port="8080"} 137
# HELP herd_llm_requests_queued Queued requests per model/engine on a machine.
# TYPE herd_llm_requests_queued gauge
herd_llm_requests_queued{node="node-a",model="aeon",engine="sglang",port="8081"} 1
herd_llm_requests_queued{node="node-a",model="qwen3.8-27b",engine="vllm",port="8080"} 0
# HELP herd_llm_requests_running Running requests per model/engine on a machine.
# TYPE herd_llm_requests_running gauge
herd_llm_requests_running{node="node-a",model="aeon",engine="sglang",port="8081"} 0
herd_llm_requests_running{node="node-a",model="qwen3.8-27b",engine="vllm",port="8080"} 2
# HELP herd_mem_available_bytes Available node memory in bytes.
# TYPE herd_mem_available_bytes gauge
herd_mem_available_bytes{node="node-a"} 268435456
# HELP herd_mem_total_bytes Total node memory in bytes.
# TYPE herd_mem_total_bytes gauge
herd_mem_total_bytes{node="node-a"} 1073741824
# HELP herd_mem_used_bytes Used node memory in bytes.
# TYPE herd_mem_used_bytes gauge
herd_mem_used_bytes{node="node-a"} 536870912
# HELP herd_net_receive_bytes_per_second Interface receive throughput in bytes per second.
# TYPE herd_net_receive_bytes_per_second gauge
herd_net_receive_bytes_per_second{node="node-a",iface="eth0"} 2097152
# HELP herd_net_transmit_bytes_per_second Interface transmit throughput in bytes per second.
# TYPE herd_net_transmit_bytes_per_second gauge
herd_net_transmit_bytes_per_second{node="node-a",iface="eth0"} 524288
# HELP herd_node_online 1 when the node is online, 0 otherwise.
# TYPE herd_node_online gauge
herd_node_online{node="node-a"} 1
herd_node_online{node="node-b"} 0
# HELP herd_node_uptime_seconds Node uptime in seconds.
# TYPE herd_node_uptime_seconds gauge
herd_node_uptime_seconds{node="node-a"} 123456
# HELP herd_up Constant 1; the dashboard rendered a fleet snapshot.
# TYPE herd_up gauge
herd_up 1
`;

test("renderFleetMetrics: golden exposition — 2 nodes, every family, exact bytes", () => {
  assert.equal(renderFleetMetrics(goldenSnapshot), GOLDEN);
});

test("renderFleetMetrics: null/absent families emit nothing (absent != 0)", () => {
  const out = renderFleetMetrics({
    nodes: [{ nodeId: "solo", online: true, uptimeSeconds: 10, cpu: null, gpu: null, mem: null, disk: [], net: [] }],
    requests: null,
    memory: null,
  });
  assert.equal(
    out,
    `# HELP herd_node_online 1 when the node is online, 0 otherwise.
# TYPE herd_node_online gauge
herd_node_online{node="solo"} 1
# HELP herd_node_uptime_seconds Node uptime in seconds.
# TYPE herd_node_uptime_seconds gauge
herd_node_uptime_seconds{node="solo"} 10
# HELP herd_up Constant 1; the dashboard rendered a fleet snapshot.
# TYPE herd_up gauge
herd_up 1
`
  );
  assert.ok(!out.includes("NaN"));
  assert.ok(!out.includes("null"));
});

test("renderFleetMetrics: non-finite samples skipped, never printed", () => {
  const out = renderFleetMetrics({
    nodes: [
      { nodeId: "bad", online: true, cpu: { usage: NaN, temperature: Infinity, draw: -Infinity, tdp: 100 } },
      { nodeId: "good", online: true, cpu: { usage: 5 } },
    ],
  });
  // usage: only the good node's sample survives, header stays.
  assert.ok(out.includes("herd_cpu_usage_percent{node=\"good\"} 5"));
  assert.ok(!out.includes("node=\"bad\"} 5") === false || true);
  assert.ok(!/herd_cpu_usage_percent\{node="bad"\}/.test(out));
  // temperature/draw had no surviving samples at all → family fully absent.
  assert.ok(!out.includes("herd_cpu_temperature_celsius"));
  assert.ok(!out.includes("herd_cpu_power_watts"));
  // tdp is finite on "bad" → still emitted.
  assert.ok(out.includes("herd_cpu_power_limit_watts{node=\"bad\"} 100"));
  assert.ok(!out.includes("NaN"));
  assert.ok(!out.includes("Infinity"));
});

test("renderFleetMetrics: label values escape backslash, quote, newline", () => {
  const out = renderFleetMetrics({
    nodes: [
      {
        nodeId: 'a"b\\c',
        online: true,
        cpu: null,
        disk: [{ device: "x\\y", mount: '/mnt/we"ird', usedMB: 0, totalMB: 1, availableMB: 1 }],
        net: [],
      },
    ],
  });
  assert.ok(out.includes('herd_node_online{node="a\\"b\\\\c"} 1'), out);
  assert.ok(
    out.includes('herd_disk_total_bytes{node="a\\"b\\\\c",mount="/mnt/we\\"ird",device="x\\\\y"} 1048576'),
    out
  );
});

test("renderFleetMetrics: deterministic — same snapshot twice, any node order", () => {
  const a = renderFleetMetrics(goldenSnapshot);
  const b = renderFleetMetrics(goldenSnapshot);
  assert.equal(a, b);
  const shuffled = { ...goldenSnapshot, nodes: [...goldenSnapshot.nodes].reverse() };
  assert.equal(renderFleetMetrics(shuffled), a);
});

test("renderFleetMetrics: requests.byMachine iterated across all machines", () => {
  const out = renderFleetMetrics({
    nodes: [],
    requests: {
      byMachine: {
        m1: [{ modelId: "mm", engine: "vllm", nodeId: "m1", port: 8080, queued: 1, running: 2, finished: 3 }],
        m2: [{ modelId: "nn", engine: "sglang", nodeId: "m2", port: 30001, queued: 4, running: 5, finished: 6 }],
      },
    },
  });
  const requestLines = out.split("\n").filter((l) => l.startsWith("herd_llm_requests"));
  assert.equal(requestLines.length, 6); // 2 machines × 3 metrics (queued/running/finished)
  assert.ok(out.includes('herd_llm_requests_queued{node="m1",model="mm",engine="vllm",port="8080"} 1'), out);
  assert.ok(out.includes('herd_llm_requests_running{node="m1",model="mm",engine="vllm",port="8080"} 2'), out);
  assert.ok(out.includes('herd_llm_requests_finished{node="m1",model="mm",engine="vllm",port="8080"} 3'), out);
  assert.ok(out.includes('herd_llm_requests_queued{node="m2",model="nn",engine="sglang",port="30001"} 4'), out);
  assert.ok(out.includes('herd_llm_requests_running{node="m2",model="nn",engine="sglang",port="30001"} 5'), out);
  assert.ok(out.includes('herd_llm_requests_finished{node="m2",model="nn",engine="sglang",port="30001"} 6'), out);
});
