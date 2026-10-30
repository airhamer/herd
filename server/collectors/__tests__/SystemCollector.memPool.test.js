import test from "node:test";
import assert from "node:assert/strict";
import { SystemCollector, parseMeminfoPoolMB } from "../SystemCollector.js";

// Issue #26: unifiedMemory carries Cached and swap for the Hasso-style pool bar.
const MEMINFO = [
  "MemTotal:       127549440 kB", // 124560 MB
  "MemFree:           794624 kB",
  "MemAvailable:    12328960 kB", // 12040 MB
  "Buffers:           102400 kB",
  "Cached:          11534336 kB", // 11264 MB
  "SwapCached:        524288 kB", // must not be read as Cached
  "SwapTotal:       16777216 kB", // 16384 MB
  "SwapFree:         7968768 kB", // 7782 MB
].join("\n");

test("parseMeminfoPoolMB: Cached / SwapTotal / SwapFree in MB, SwapCached ignored", () => {
  assert.deepEqual(parseMeminfoPoolMB(MEMINFO), { cached: 11264, swapTotal: 16384, swapFree: 7782 });
  assert.deepEqual(
    parseMeminfoPoolMB("SwapCached: 2048 kB\nCached: 4096 kB\n"),
    { cached: 4, swapTotal: 0, swapFree: 0 },
  );
});

test("parseMeminfoPoolMB: missing or junk input → zeros", () => {
  assert.deepEqual(parseMeminfoPoolMB(""), { cached: 0, swapTotal: 0, swapFree: 0 });
  assert.deepEqual(parseMeminfoPoolMB(undefined), { cached: 0, swapTotal: 0, swapFree: 0 });
  assert.deepEqual(parseMeminfoPoolMB("MemTotal: 1024 kB"), { cached: 0, swapTotal: 0, swapFree: 0 });
});

test("_getUnifiedMemory (local) adds cached and swap next to the existing fields", async () => {
  const c = new SystemCollector({ id: "spark1", host: "spark1", lanIp: "10.0.0.1", isLocal: true });
  c._readHostFile = async () => MEMINFO;
  c._nvidiaSmi = async () => {
    throw new Error("no dmon in tests");
  };
  c._readGpuMemoryFile = () => 0;
  c.nvidiaComputeAppsCache.set(4242, { name: "sglang::scheduler", vramMB: 101581 });
  const um = await c._getUnifiedMemory();
  assert.equal(um.total, 124560);
  assert.equal(um.available, 12040);
  assert.equal(um.gpuUsed, 101581);
  assert.equal(um.cached, 11264);
  assert.equal(um.swapTotal, 16384);
  assert.equal(um.swapFree, 7782);
});

test("_getRemoteUnifiedMemory asks for Cached and swap, and returns them", async () => {
  const c = new SystemCollector({ id: "spark1", host: "spark1", lanIp: "10.0.0.1" });
  let cmdSeen = "";
  const exec = async (_spark, cmd) => {
    cmdSeen = cmd;
    return `${MEMINFO}\n---\n4242, sglang::scheduler, 101581\n`;
  };
  const um = await c._getRemoteUnifiedMemory(exec);
  assert.match(cmdSeen, /Cached\|SwapTotal\|SwapFree/);
  assert.equal(um.total, 124560);
  assert.equal(um.available, 12040);
  assert.equal(um.gpuUsed, 101581);
  assert.equal(um.cached, 11264);
  assert.equal(um.swapTotal, 16384);
  assert.equal(um.swapFree, 7782);
});
