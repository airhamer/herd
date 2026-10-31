import test from "node:test";
import assert from "node:assert/strict";
import { extractSample, memoryReading, networkRates } from "../historySample.js";

/** A healthy Spark-class unit with one LLM endpoint on :8000. */
function unit(patch = {}) {
  const base = {
    id: "u1",
    kind: "spark",
    online: true,
    llmPorts: [8000],
    metrics: {
      gpu: { usage: 40, temperature: 62, power: { draw: 55, limit: 140 }, vram: { used: 60_000, total: 120_000, available: 50_000 } },
      cpu: { usage: 22, temperature: 57, draw: 12, tdp: 80 },
      ram: { used: 30_000, total: 120_000, percentage: 25 },
      unifiedMemory: { total: 120_000, gpuUsed: 60_000, cpuUsed: 10_000, available: 48_000 },
      network: {
        primaryInterface: "eth0",
        interfaces: [
          { name: "eth0", rxSpeed: 300, txSpeed: 100 },
          { name: "eth1", rxSpeed: 7, txSpeed: 9 },
        ],
      },
      llm: [{ available: true, generationTps: 33.3, prefillTps: 950, kvCacheUsage: 0.2 }],
    },
  };
  return { ...base, ...patch, metrics: { ...base.metrics, ...(patch.metrics ?? {}) } };
}

test("a healthy unit yields every series it reports", () => {
  assert.deepEqual(extractSample(unit()), {
    gpuUtil: 40,
    gpuTemp: 62,
    gpuPower: 55,
    memUsedMB: 70_000,
    memFreeMB: 48_000,
    cpuUtil: 22,
    cpuTemp: 57,
    netRx: 300,
    netTx: 100,
    "llm:8000:genTps": 33.3,
    "llm:8000:prefillTps": 950,
    "llm:8000:kvUsage": 0.2,
  });
});

test("a unit that is not online gives no sample at all", () => {
  assert.equal(extractSample(unit({ online: false })), null);
  assert.equal(extractSample(null), null);
});

test("placeholders, stale domains and unavailable fields are left out, never zeroed", () => {
  const placeholderGpu = { usage: 0, temperature: 0, power: { draw: 0, limit: 120 }, vram: { used: 0, total: 0, available: 0 } };
  const s1 = extractSample(unit({ metrics: { gpu: placeholderGpu, unifiedMemory: null } }));
  for (const key of ["gpuUtil", "gpuTemp", "gpuPower", "memUsedMB", "memFreeMB"]) assert.equal(key in s1, false, key);

  const s2 = extractSample(unit({ metrics: { cpu: { usage: 0, temperature: 0, draw: 0, tdp: 0 } } }));
  assert.equal("cpuUtil" in s2, false);

  const gpu = { ...unit().metrics.gpu, metricAvailability: { usage: false, powerDraw: false } };
  const s3 = extractSample(unit({ metrics: { gpu } }));
  assert.equal("gpuUtil" in s3, false);
  assert.equal("gpuPower" in s3, false);
  assert.equal(s3.gpuTemp, 62);

  const s4 = extractSample(unit({ metrics: { cpu: { usage: 5, temperature: 0, draw: 1, tdp: 10 } } }));
  assert.equal(s4.cpuUtil, 5);
  assert.equal("cpuTemp" in s4, false, "0 °C means no sensor");

  const stale = new Set(["gpu", "network", "llm"]);
  const s5 = extractSample(unit(), (d) => !stale.has(d));
  assert.deepEqual(Object.keys(s5).sort(), ["cpuTemp", "cpuUtil", "memFreeMB", "memUsedMB"]);

  const s6 = extractSample(unit({ metrics: { llm: [{ available: false, generationTps: 1 }] } }));
  assert.equal(Object.keys(s6).some((k) => k.startsWith("llm:")), false);

  const s7 = extractSample(unit({ metrics: { gpu: { ...unit().metrics.gpu, usage: NaN } } }));
  assert.equal("gpuUtil" in s7, false);
});

test("RAM is a host series; KV fill is clamped; LLM entries follow llmPorts by position", () => {
  assert.equal("ramUsedMB" in extractSample(unit()), false);
  const host = extractSample(unit({ kind: "host" }));
  assert.equal(host.ramUsedMB, 30_000);

  const two = extractSample(
    unit({
      llmPorts: [8000, "x"],
      metrics: { llm: [{ available: true, generationTps: 1, prefillTps: 2, kvCacheUsage: 3 }, { available: true, generationTps: 9 }] },
    })
  );
  assert.equal(two["llm:8000:kvUsage"], 1);
  assert.equal(Object.keys(two).filter((k) => k.startsWith("llm:")).length, 3, "a non-integer port is skipped");
});

test("memory: unified pool on Sparks, VRAM on discrete hosts", () => {
  assert.deepEqual(memoryReading(unit()), { usedMB: 70_000, freeMB: 48_000 });
  // Pool without `available`: free is what the parts leave.
  const pool = { total: 100, gpuUsed: 30, cpuUsed: Infinity, available: undefined };
  assert.deepEqual(memoryReading(unit({ metrics: { unifiedMemory: pool } })), { usedMB: 30, freeMB: 70 });
  // No pool reading: fall back to VRAM, where a Spark's available is the pool's free.
  assert.deepEqual(memoryReading(unit({ metrics: { unifiedMemory: null } })), { usedMB: 60_000, freeMB: 50_000 });
  // A discrete host's vram.available is system RAM, so free is total − used.
  assert.deepEqual(memoryReading(unit({ kind: "host" })), { usedMB: 60_000, freeMB: 60_000 });
  // Stale memory domain on a Spark: also VRAM.
  assert.deepEqual(memoryReading(unit(), (d) => d !== "memory"), { usedMB: 60_000, freeMB: 50_000 });
  assert.equal(memoryReading(unit({ metrics: { unifiedMemory: null } }), (d) => d !== "gpu"), null);
});

test("network: the primary interface, else the shown interfaces summed", () => {
  assert.deepEqual(networkRates(unit().metrics.network), { rx: 300, tx: 100 });
  const noPrimary = {
    primaryInterface: "wlan9",
    interfaces: [
      { name: "a", rxSpeed: 1, txSpeed: 2 },
      { name: "b", rxSpeed: 10, txSpeed: 20 },
      { name: "lo", rxSpeed: 1000, txSpeed: 1000 },
      { name: "c", rxSpeed: 500, txSpeed: 500, disabled: true },
    ],
  };
  assert.deepEqual(networkRates(noPrimary), { rx: 11, tx: 22 });
  // A disabled primary does not count as the primary.
  assert.deepEqual(networkRates({ ...noPrimary, primaryInterface: "c" }), { rx: 11, tx: 22 });
  assert.equal(networkRates({ interfaces: [{ name: "a" }] }), null);
  assert.equal(networkRates(undefined), null);
});
