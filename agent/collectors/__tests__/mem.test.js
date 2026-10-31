import test from "node:test";
import assert from "node:assert/strict";
import { collectMem } from "../mem.js";

const MEMINFO = [
  "MemTotal:       131072000 kB", // 128000 MB
  "MemFree:         5120000 kB",
  "MemAvailable:   31457280 kB", // 30720 MB
].join("\n");

test("mem: computes used/total/available/percentage (ground truth)", async () => {
  const m = await collectMem({ readFile: async () => MEMINFO });
  assert.deepEqual(m, {
    usedMB: 97280, // 128000 − 30720
    totalMB: 128000,
    availableMB: 30720,
    percentage: 76, // 97280/128000 = 0.76
    cachedMB: 0,
    swapTotalMB: 0,
    swapFreeMB: 0,
  });
});

// Issue #26: Cached and swap for the Hasso-style pool breakdown.
const MEMINFO_FULL = [
  "MemTotal:       127535104 kB", // 124546 MB (121.6 GiB, a GB10)
  "MemFree:           838860 kB",
  "MemAvailable:    12373196 kB", // 12083 MB
  "Buffers:           102400 kB",
  "Cached:          11534336 kB", // 11264 MB
  "SwapCached:        524288 kB", // must NOT be read as Cached
  "SwapTotal:       16777216 kB", // 16384 MB
  "SwapFree:         7969177 kB", // 7782 MB
].join("\n");

test("mem: reports Cached, SwapTotal, SwapFree in MB (SwapCached is not Cached)", async () => {
  const m = await collectMem({ readFile: async () => MEMINFO_FULL });
  assert.equal(m.totalMB, 124546);
  assert.equal(m.availableMB, 12083);
  assert.equal(m.usedMB, 124546 - 12083);
  assert.equal(m.cachedMB, 11264);
  assert.equal(m.swapTotalMB, 16384);
  assert.equal(m.swapFreeMB, 7782);
});

test("mem: SwapCached before Cached does not shadow it", async () => {
  const raw = ["MemTotal: 1048576 kB", "MemAvailable: 524288 kB", "SwapCached: 2048 kB", "Cached: 4096 kB"].join("\n");
  const m = await collectMem({ readFile: async () => raw });
  assert.equal(m.cachedMB, 4);
});

test("mem: prefers /host/proc/meminfo, falls back to /proc/meminfo", async () => {
  const seen = [];
  const host = await collectMem({
    readFile: async (p) => {
      seen.push(p);
      if (p === "/host/proc/meminfo") return "MemTotal: 2097152 kB\nMemAvailable: 1048576 kB\n";
      return MEMINFO;
    },
  });
  assert.equal(host.totalMB, 2048);
  assert.deepEqual(seen, ["/host/proc/meminfo"]);

  const local = await collectMem({
    readFile: async (p) => {
      if (p === "/host/proc/meminfo") throw new Error("ENOENT");
      return MEMINFO;
    },
  });
  assert.equal(local.totalMB, 128000);
});

test("mem: clamps percentage to 0-100", async () => {
  const m = await collectMem({
    readFile: async () =>
      ["MemTotal: 1024 kB", "MemAvailable: 0 kB", "MemFree: 0 kB"].join("\n"),
  });
  assert.equal(m.percentage, 100);
  assert.equal(m.usedMB, 1);
});

test("mem: returns null on read failure", async () => {
  const readFile = async () => {
    throw new Error("ENOENT: /proc/meminfo");
  };
  assert.equal(await collectMem({ readFile }), null);
});

test("mem: returns null when MemTotal is missing", async () => {
  assert.equal(await collectMem({ readFile: async () => "nothing here\n" }), null);
});

test("mem: returns null when MemTotal is zero", async () => {
  assert.equal(
    await collectMem({
      readFile: async () => "MemTotal:       0 kB\nMemAvailable:  0 kB\n",
    }),
    null
  );
});

test("mem: discrete-GPU / CPU-only host reports system RAM only (VRAM never enters MemMetrics)", async () => {
  // 64 GiB x86 box with a 24 GiB card: meminfo knows nothing about VRAM, so neither does mem.
  const raw = "MemTotal: 67108864 kB\nMemAvailable: 41943040 kB\nCached: 10485760 kB\nSwapTotal: 8388608 kB\nSwapFree: 8388608 kB\n";
  const m = await collectMem({ readFile: async () => raw });
  assert.deepEqual(m, {
    usedMB: 24576,
    totalMB: 65536,
    availableMB: 40960,
    percentage: 38,
    cachedMB: 10240,
    swapTotalMB: 8192,
    swapFreeMB: 8192,
  });
  assert.equal("gpuAllocMB" in m, false);
});
