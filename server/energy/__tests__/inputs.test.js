// Fleet energy inputs: SSH Sparks + agent nodes in one scope (issue #33).
import test from "node:test";
import assert from "node:assert/strict";
import {
  baselineFor,
  createEnergyInputCollector,
  energyScopeIds,
  nodePowerEstimate,
  sparkPowerEstimate,
  NODE_FRESH_MS,
} from "../inputs.js";
import { gb10Watts } from "../powerModel.js";

const NOW = Date.UTC(2026, 9, 31, 6, 0, 0);

function sparkSnapshot(id, { kind = "spark", draw = 30, drawTotal, gpuCount, usage = 20, cpuDraw = 20, lanIp } = {}) {
  return {
    id,
    name: id,
    kind,
    online: true,
    lanIp: lanIp ?? `10.0.0.${id.length}`,
    role: "head",
    llmPorts: [],
    metrics: {
      gpu: { temperature: 50, usage: 10, power: { draw, limit: 100, drawTotal, gpuCount }, vram: { total: 1 } },
      cpu: { usage, temperature: 40, draw: cpuDraw, tdp: 65 },
    },
  };
}

/** A monitor whose GPU and CPU collections just succeeded. */
const freshMonitor = (atMs) => ({
  _metricCollectionSuccessful: { gpu: true, cpu: true },
  _lastUpdate: { gpu: atMs, cpu: atMs },
});

function nodeSnapshot(nodeId, { gpu = null, cpu = null, online = true, polledAt = 1, lanIp = "10.1.0.1" } = {}) {
  return { nodeId, nodeName: `${nodeId}-name`, lanIp, online, gpu, cpu, polledAt };
}

test("SSH Sparks: GB10 formula by default, measured model for kind host with summed GPUs", () => {
  const gb10 = sparkPowerEstimate(sparkSnapshot("s1", { draw: 40, usage: 50 }), 40);
  assert.equal(gb10.model, "gb10");
  assert.equal(gb10.watts, gb10Watts(40, 50));

  const host = sparkPowerEstimate(
    sparkSnapshot("h1", { kind: "host", draw: 250, drawTotal: 1000, gpuCount: 4, cpuDraw: 90 }),
    60
  );
  assert.equal(host.model, "measured");
  assert.equal(host.gpuCount, 4);
  assert.equal(host.gpuWatts, 1000, "all four GPUs, not GPU 0");
  assert.equal(host.cpuSource, "estimated");
  assert.equal(host.watts, 1000 + 90 + 60);
});

test("agent nodes: GB10 (unified memory), x86 + discrete, multi-GPU, AMD, CPU-only and pre-#33 agents", () => {
  const gb10 = nodePowerEstimate(
    { gpu: { powerDraw: 25, unifiedMemory: true, powerSource: "nvidia-smi", gpuCount: 1 }, cpu: { usage: 10, draw: 12 } },
    40
  );
  assert.equal(gb10.model, "gb10");
  assert.equal(gb10.watts, gb10Watts(25, 10));

  const x86 = nodePowerEstimate(
    { gpu: { powerDraw: 300, powerDrawTotal: 300, gpuCount: 1, powerSource: "nvidia-smi", unifiedMemory: false }, cpu: { usage: 30, draw: 70, drawSource: "rapl" } },
    45
  );
  assert.equal(x86.model, "measured");
  assert.equal(x86.watts, 300 + 70 + 45);
  assert.equal(x86.measuredWatts, 370);

  const multi = nodePowerEstimate(
    { gpu: { powerDraw: 200, powerDrawTotal: 790, gpuCount: 4, powerSource: "nvidia-smi", unifiedMemory: false }, cpu: { usage: 5, draw: 40, drawSource: "estimated" } },
    40
  );
  assert.equal(multi.gpuWatts, 790);
  assert.equal(multi.gpuCount, 4);
  assert.equal(multi.watts, 790 + 40 + 40);

  const amd = nodePowerEstimate(
    { gpu: { powerDraw: 80, powerDrawTotal: 80, gpuCount: 2, powerSource: "amd-hwmon" }, cpu: { usage: 5, draw: 30, drawSource: "hwmon" } },
    20
  );
  assert.equal(amd.gpuSource, "amd-hwmon");
  assert.equal(amd.watts, 130);

  const cpuOnly = nodePowerEstimate({ gpu: null, cpu: { usage: 5, draw: 18, drawSource: "rapl" } }, 25);
  assert.equal(cpuOnly.gpuWatts, null);
  assert.equal(cpuOnly.watts, 43);

  // An agent from before #33: powerDraw only (NVIDIA), cpu.draw modelled.
  const legacy = nodePowerEstimate({ gpu: { powerDraw: 120, unifiedMemory: false }, cpu: { usage: 5, draw: 30 } }, 40);
  assert.equal(legacy.gpuSource, "nvidia-smi");
  assert.equal(legacy.cpuSource, "estimated");
  assert.equal(legacy.watts, 190);

  // Old AMD agents reported powerDraw 0: that is "unknown", not a 0 W reading.
  const oldAmd = nodePowerEstimate({ gpu: { powerDraw: 0, unifiedMemory: false }, cpu: { usage: 5, draw: 30 } }, 40);
  assert.equal(oldAmd.gpuWatts, null);

  assert.equal(nodePowerEstimate({ gpu: null, cpu: null }, 40), null);
});

test("per-host baseline overrides beat the fleet default; bad values fall back", () => {
  const settings = { energyIdleBaselineW: 35, energyHostBaselines: { big: 120, bad: -1 } };
  assert.equal(baselineFor("big", settings), 120);
  assert.equal(baselineFor("bad", settings), 35);
  assert.equal(baselineFor("other", settings), 35);
  assert.equal(baselineFor("other", {}), 40);
});

test("the startup scope counts a node on a Spark's LAN IP once, under the Spark", () => {
  const ids = energyScopeIds(
    [{ id: "s1", lanIp: "10.0.0.1" }, { id: "s2", lanIp: "10.0.0.2" }],
    [{ id: "n1", lanIp: "10.0.0.1" }, { id: "n2", lanIp: "10.0.0.9" }, { id: "s2" }]
  );
  assert.deepEqual(ids, ["s1", "s2", "n2"]);
});

test("collector: one scope for Sparks and nodes, duplicates skipped, freshness by server clock", () => {
  let atMs = NOW;
  const sparks = [sparkSnapshot("s1", { lanIp: "10.0.0.1" })];
  let nodes = [
    nodeSnapshot("dup", { lanIp: "10.0.0.1", gpu: { powerDraw: 30, powerSource: "nvidia-smi" }, cpu: { usage: 1, draw: 10 } }),
    nodeSnapshot("x86", { lanIp: "10.0.0.7", gpu: { powerDraw: 200, powerDrawTotal: 200, gpuCount: 1, powerSource: "nvidia-smi" }, cpu: { usage: 10, draw: 50, drawSource: "rapl" }, polledAt: 100 }),
    nodeSnapshot("mac", { lanIp: "10.0.0.8", gpu: null, cpu: null, polledAt: 100 }),
  ];
  const collector = createEnergyInputCollector({
    orderedSnapshots: () => sparks,
    monitors: new Map([["s1", { get _metricCollectionSuccessful() { return { gpu: true, cpu: true }; }, get _lastUpdate() { return { gpu: atMs, cpu: atMs }; } }]]),
    fleetNodes: () => nodes,
    getSettings: () => ({ energyIdleBaselineW: 30 }),
    now: () => atMs,
  });

  const first = collector.collect();
  assert.deepEqual(first.scope, ["s1", "x86", "mac"]);
  assert.deepEqual(first.inputs.map((input) => input.id), ["s1", "x86", "mac"]);
  const byId = Object.fromEntries(first.inputs.map((input) => [input.id, input]));
  assert.equal(byId.s1.telemetryFresh, true);
  assert.equal(byId.s1.role, "head", "Spark clones keep what the token counter needs");
  assert.equal(byId.x86.telemetryFresh, true);
  assert.equal(byId.x86.power.watts, 200 + 50 + 30);
  assert.equal(byId.mac.telemetryFresh, false, "no power telemetry, so not counted");

  const hosts = Object.fromEntries(first.hosts.map((host) => [host.id, host]));
  assert.equal(hosts.dup.duplicateOf, "s1");
  assert.equal(hosts.x86.reporting, true);
  assert.equal(hosts.x86.watts, 280);
  assert.equal(hosts.mac.reporting, false);
  assert.equal(hosts.mac.watts, null);
  assert.deepEqual(collector.scope(), first.scope);

  // Same poll still inside the window: fresh. Past it with no new poll: stale.
  atMs = NOW + NODE_FRESH_MS;
  assert.equal(collector.collect().inputs.find((i) => i.id === "x86").telemetryFresh, true);
  atMs = NOW + NODE_FRESH_MS + 1;
  assert.equal(collector.collect().inputs.find((i) => i.id === "x86").telemetryFresh, false);
  nodes = nodes.map((node) => (node.nodeId === "x86" ? { ...node, polledAt: 101 } : node));
  assert.equal(collector.collect().inputs.find((i) => i.id === "x86").telemetryFresh, true);

  // Offline nodes are never fresh; removed nodes leave the scope.
  nodes = [nodeSnapshot("x86", { ...nodes[1], online: false, polledAt: 102, gpu: nodes[1].gpu, cpu: nodes[1].cpu, lanIp: "10.0.0.7" })];
  const offline = collector.collect();
  assert.equal(offline.inputs.find((i) => i.id === "x86").telemetryFresh, false);
  assert.deepEqual(offline.scope, ["s1", "x86"]);
});

test("collector matches duplicates on the registry LAN IP even when the agent reports another", () => {
  const collector = createEnergyInputCollector({
    orderedSnapshots: () => [sparkSnapshot("s1", { lanIp: "192.168.1.5" })],
    sparkLanIps: () => new Map([["s1", "192.168.1.5"]]),
    fleetNodes: () => [{ ...nodeSnapshot("n1", { lanIp: "10.200.0.4" }), registryLanIp: "192.168.1.5" }],
    now: () => NOW,
  });
  const { scope, hosts } = collector.collect();
  assert.deepEqual(scope, ["s1"]);
  assert.equal(hosts.find((host) => host.id === "n1").duplicateOf, "s1");
});

test("Spark freshness still requires current monitor telemetry", () => {
  const collector = createEnergyInputCollector({
    orderedSnapshots: () => [sparkSnapshot("s1")],
    monitors: new Map([["s1", freshMonitor(NOW - 60_000)]]),
    now: () => NOW,
  });
  const { inputs, hosts } = collector.collect();
  assert.equal(inputs[0].telemetryFresh, false);
  assert.equal(hosts[0].reporting, false);
});
