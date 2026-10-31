import test from "node:test";
import assert from "node:assert/strict";
import { SystemCollector, discreteVram } from "../SystemCollector.js";

// Issue #26 follow-up: on a discrete-GPU / CPU-only "host" unit, VRAM is the
// card's own memory and system RAM never stands in for it.
// 64 GiB host (MemAvailable 40 GiB) with one 24 GiB RTX 4090.
const MEMTOTAL_MB = 65536;
const MEMAVAIL_MB = 40960;
const MEMINFO = `MemTotal:       ${MEMTOTAL_MB * 1024} kB\nMemAvailable:   ${MEMAVAIL_MB * 1024} kB`;

function localHost({ smiMem, apps = "" }) {
  const c = new SystemCollector({ id: "x86", host: "x86", lanIp: "10.0.0.9", isLocal: true, kind: "host" });
  c._nvidiaSmi = async (args) => {
    if (args.includes("memory.used")) {
      if (smiMem == null) throw new Error("nvidia-smi not found");
      return smiMem;
    }
    if (args.includes("compute-apps")) {
      if (smiMem == null) throw new Error("nvidia-smi not found");
      return apps;
    }
    throw new Error("unexpected");
  };
  c._readMeminfoMB = async () => ({ totalMB: MEMTOTAL_MB, availMB: MEMAVAIL_MB });
  c._readGpuMemoryFileFull = () => ({ used: 0, total: 0, processes: [] });
  return c;
}

function remoteHost(kind = "host") {
  const c = new SystemCollector({ id: "x86", host: "x86", lanIp: "10.0.0.9", kind });
  c._nvErrNoMemory = async () => 0;
  c._kernelErrors = async () => [];
  return c;
}
const remoteOut = (memFields, apps = "") =>
  ["55, 30, 120.5, 450, 2520, 2520, Not Active, Not Active, Not Active, Not Active", memFields, apps, MEMINFO, ""].join("\n---\n");

test("discreteVram: free = total − used, never system RAM; unknown total → 0", () => {
  assert.deepEqual(discreteVram(8192, 24564), { total: 24564, available: 16372 });
  assert.deepEqual(discreteVram(0, 24564), { total: 24564, available: 24564 });
  assert.deepEqual(discreteVram(30000, 24564), { total: 24564, available: 0 });
  assert.deepEqual(discreteVram(0, 0), { total: 0, available: 0 });
});

test("local discrete host: VRAM from nvidia-smi, available = total − used", async () => {
  const v = await localHost({ smiMem: "8192, 24564", apps: "1234, python, 8000" })._queryNvidiaVram();
  assert.deepEqual(v, { used: 8192, total: 24564, percentage: 33, available: 16372 });
});

test("local discrete host idle (used 0): free VRAM is the whole card, not MemAvailable", async () => {
  const v = await localHost({ smiMem: "0, 24564" })._queryNvidiaVram();
  assert.equal(v.used, 0);
  assert.equal(v.total, 24564);
  assert.equal(v.available, 24564);
  assert.notEqual(v.available, MEMAVAIL_MB);
});

test("local multi-GPU host: GPU 0's own used=0 is kept, not the cross-card compute-apps sum", async () => {
  const v = await localHost({ smiMem: "0, 81559\n40000, 81559", apps: "1, a, 40000" })._queryNvidiaVram();
  assert.equal(v.used, 0);
  assert.equal(v.available, 81559);
});

test("local CPU-only host: no VRAM total borrowed from MemTotal", async () => {
  const v = await localHost({ smiMem: null })._queryNvidiaVram();
  assert.deepEqual(v, { used: 0, total: 0, percentage: 0, available: 0 });
});

test("local [N/A] memory on a discrete host: total unknown, not MemTotal or the 128 GB spec", async () => {
  const v = await localHost({ smiMem: "[N/A], [N/A]", apps: "1, a, 5000" })._queryNvidiaVram();
  assert.equal(v.used, 5000);
  assert.equal(v.total, 0);
  assert.equal(v.available, 0);
});

test("remote discrete host: same separation over SSH (busy and idle)", async () => {
  const busy = await remoteHost()._getRemoteGpu(async () => remoteOut("8192, 24564", "1234, python, 8000"));
  assert.deepEqual(busy.vram, { used: 8192, total: 24564, percentage: 33, available: 16372 });
  const idle = await remoteHost()._getRemoteGpu(async () => remoteOut("0, 24564"));
  assert.deepEqual(idle.vram, { used: 0, total: 24564, percentage: 0, available: 24564 });
});

test("remote CPU-only host: VRAM stays empty instead of mirroring system RAM", async () => {
  const g = await remoteHost()._getRemoteGpu(async () => remoteOut(""));
  assert.deepEqual(g.vram, { used: 0, total: 0, percentage: 0, available: 0 });
});

test("remote GB10 Spark is unchanged: shared pool total = MemTotal, available = MemAvailable", async () => {
  const g = await remoteHost("spark")._getRemoteGpu(async () => remoteOut("[N/A], [N/A]", "1, sglang, 30000"));
  assert.equal(g.vram.used, 30000);
  assert.equal(g.vram.total, MEMTOTAL_MB);
  assert.equal(g.vram.available, MEMAVAIL_MB);
});
