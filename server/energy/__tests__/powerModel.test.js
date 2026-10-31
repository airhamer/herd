// Per-host power model (issue #33).
import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateHostPower,
  gb10Watts,
  normalizeBaseline,
  DEFAULT_IDLE_BASELINE_W,
  MAX_HOST_WATTS,
} from "../powerModel.js";

test("GB10 keeps the calibrated whole-system formula and its 240 W clamp", () => {
  assert.equal(gb10Watts(30, 0), 30 + 5.2 + 23);
  assert.equal(gb10Watts(30, 100), 30 + 65 + 23);
  assert.equal(gb10Watts(500, 100), 240);
  assert.equal(gb10Watts(null, 10), null);
  assert.equal(gb10Watts(10, Number.NaN), null);

  const power = estimateHostPower({ model: "gb10", gpuWatts: 30, cpuUsage: 50 });
  assert.equal(power.model, "gb10");
  assert.equal(power.watts, gb10Watts(30, 50));
  assert.equal(power.measuredWatts, 30, "only the GPU term is a sensor reading");
  assert.equal(power.gpuSource, "nvidia-smi");
  assert.equal(power.cpuSource, "estimated");
  assert.equal(power.baselineWatts, 23);
});

test("x86 + discrete GPU: nvidia-smi draw + RAPL package power + idle baseline", () => {
  const power = estimateHostPower({
    model: "measured",
    gpuWatts: 280,
    gpuSource: "nvidia-smi",
    gpuCount: 1,
    cpuWatts: 65,
    cpuSource: "rapl",
    baselineW: 50,
  });
  assert.equal(power.watts, 280 + 65 + 50);
  assert.equal(power.measuredWatts, 345);
  assert.equal(power.baselineWatts, 50);
});

test("multi-GPU hosts use the summed draw they are given", () => {
  const power = estimateHostPower({
    model: "measured",
    gpuWatts: 4 * 300,
    gpuSource: "nvidia-smi",
    gpuCount: 4,
    cpuWatts: 120,
    cpuSource: "estimated",
  });
  assert.equal(power.gpuCount, 4);
  assert.equal(power.watts, 1200 + 120 + DEFAULT_IDLE_BASELINE_W);
  assert.equal(power.measuredWatts, 1200, "a modelled CPU is not counted as measured");
});

test("AMD hwmon GPU power counts as measured; a CPU-only host still reports", () => {
  const amd = estimateHostPower({ model: "measured", gpuWatts: 90, gpuSource: "amd-hwmon", cpuWatts: 20, cpuSource: "hwmon", baselineW: 0 });
  assert.equal(amd.watts, 110);
  assert.equal(amd.measuredWatts, 110);
  const cpuOnly = estimateHostPower({ model: "measured", cpuWatts: 15, cpuSource: "rapl", baselineW: 30 });
  assert.equal(cpuOnly.gpuWatts, null);
  assert.equal(cpuOnly.watts, 45);
});

test("hosts with no power telemetry are not estimated, and totals are clamped", () => {
  assert.equal(estimateHostPower({ model: "measured" }), null);
  assert.equal(estimateHostPower({ model: "measured", gpuWatts: 10 }), null, "a GPU figure needs a source");
  assert.equal(estimateHostPower({ model: "measured", cpuWatts: 0 }), null);
  const huge = estimateHostPower({ model: "measured", gpuWatts: 1e6, gpuSource: "nvidia-smi" });
  assert.equal(huge.watts, MAX_HOST_WATTS);
});

test("idle baselines are clamped and fall back to the default", () => {
  assert.equal(normalizeBaseline(25), 25);
  assert.equal(normalizeBaseline(0), 0);
  assert.equal(normalizeBaseline(-3), DEFAULT_IDLE_BASELINE_W);
  assert.equal(normalizeBaseline("x"), DEFAULT_IDLE_BASELINE_W);
  assert.equal(normalizeBaseline(1e9), 2_000);
});
