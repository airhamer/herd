import test from "node:test";
import assert from "node:assert/strict";
import { collectGpu } from "../gpu.js";

const MEMINFO = [
  "MemTotal:        131072000 kB", // 128000 MB
  "MemFree:          51200000 kB",
  "MemAvailable:     40960000 kB", // 40000 MB
].join("\n");

const readFile = async (p) => {
  if (p === "/proc/meminfo") return MEMINFO;
  throw new Error(`ENOENT: ${p}`);
};

/** Mock exec: first call = GPU query, subsequent = compute-apps. */
function mockExec(gpuLine, appsRaw) {
  let calls = 0;
  const exec = async () => {
    calls += 1;
    return calls === 1 ? gpuLine : appsRaw;
  };
  return exec;
}

test("gpu: parses nvidia-smi csv into GpuMetrics (ground truth)", async () => {
  const g = await collectGpu({
    exec: mockExec("42, 15, 12.5, 100, 8192, 65536", "123,python,1024\n456,vllm,4096"),
    readFile,
  });
  assert.deepEqual(g, {
    temperature: 42,
    usage: 15,
    powerDraw: 12.5,
    powerLimit: 100,
    vramUsedMB: 8192,
    vramTotalMB: 65536,
    vramPercentage: 13, // 8192/65536 = 12.5 → 13
    vramAvailableMB: 40000, // MemAvailable
    processes: [
      { pid: 456, name: "vllm", vramMB: 4096 },
      { pid: 123, name: "python", vramMB: 1024 },
    ],
    gpuAllocMB: 5120,
    unifiedMemory: false, // nvidia-smi reports its own memory.total
    powerDrawTotal: 12.5,
    gpuCount: 1,
    powerSource: "nvidia-smi",
  });
});

test("gpu: GB10 [N/A] memory falls back to meminfo + compute-apps sum", async () => {
  const g = await collectGpu({
    exec: mockExec("55, 90, 20.2, 90.0, [N/A], [N/A]", "789,sglang,51200"),
    readFile,
  });
  assert.equal(g.vramUsedMB, 51200);
  assert.equal(g.vramTotalMB, 128000); // MemTotal fallback
  assert.equal(g.vramAvailableMB, 40000);
  assert.equal(g.vramPercentage, 40); // 51200/128000
  assert.deepEqual(g.processes, [{ pid: 789, name: "sglang", vramMB: 51200 }]);
});

test("gpu: gpuAllocMB sums ALL compute apps, not just the top 5 (issue #26)", async () => {
  const apps = Array.from({ length: 7 }, (_, i) => `${i + 1},proc${i},1000`).join("\n");
  const g = await collectGpu({ exec: mockExec("55, 5, 10, 65, [N/A], [N/A]", apps), readFile });
  assert.equal(g.processes.length, 5);
  assert.equal(g.gpuAllocMB, 7000);
});

test("gpu: unifiedMemory is true when memory.total is [N/A] (GB10), false on a discrete total", async () => {
  const gb10 = await collectGpu({ exec: mockExec("55, 90, 20.2, 90.0, [N/A], [N/A]", "789,sglang,51200"), readFile });
  assert.equal(gb10.unifiedMemory, true);
  assert.equal(gb10.gpuAllocMB, 51200);
  const discrete = await collectGpu({ exec: mockExec("55, 5, 10, 65, 0, 65536", ""), readFile });
  assert.equal(discrete.unifiedMemory, false);
  assert.equal(discrete.gpuAllocMB, 0);
});

test("gpu: clamps vramPercentage to 100 when apps exceed pool", async () => {
  const g = await collectGpu({
    exec: mockExec("55, 5, 10, 65, [N/A], [N/A]", "1,a,200000\n2,b,200000"),
    readFile,
  });
  assert.equal(g.vramPercentage, 100);
  assert.equal(g.processes.length, 2);
});

test("gpu: keeps only top 5 processes by VRAM", async () => {
  const apps = Array.from({ length: 7 }, (_, i) => `${i + 1},proc${i},${i + 1}`).join("\n");
  const g = await collectGpu({ exec: mockExec("55, 5, 10, 65, 0, 65536", apps), readFile });
  assert.equal(g.processes.length, 5);
  assert.equal(g.processes[0].pid, 7); // highest VRAM first
});

test("gpu: usage clamped to 0-100", async () => {
  const g = await collectGpu({ exec: mockExec("42, 150, 12.5, 100, 0, 65536", ""), readFile });
  assert.equal(g.usage, 100);
  // smi memory.used = 0 with no compute apps → meminfo-host fallback (MemTotal-MemAvailable)
  assert.equal(g.vramUsedMB, 88000);
  assert.deepEqual(g.processes, []);
});

test("gpu: returns null when nvidia-smi is unavailable", async () => {
  const exec = async () => {
    throw new Error("nvidia-smi: command not found");
  };
  assert.equal(await collectGpu({ exec, readFile }), null);
});

test("gpu: returns null on empty/unparseable output", async () => {
  assert.equal(await collectGpu({ exec: async () => "", readFile }), null);
  assert.equal(await collectGpu({ exec: async () => "garbage", readFile }), null);
});

test("gpu: [N/A] temperature still returns metrics when usage is valid", async () => {
  const g = await collectGpu({ exec: mockExec("[N/A], 15, 12.5, 100, 0, 65536", ""), readFile });
  assert.notEqual(g, null);
  assert.equal(g.usage, 15);
  assert.equal(g.temperature, null);
});

// ─── Issue #33: per-host power for Fleet energy ─────────────────────────────

test("gpu: multi-GPU nvidia-smi sums power across every GPU", async () => {
  const g = await collectGpu({
    exec: mockExec(
      ["40, 10, 300.5, 450, 1000, 81920", "41, 20, 250, 450, 1000, 81920", "39, 0, 60.25, 450, 0, 81920"].join("\n"),
      ""
    ),
    readFile,
  });
  assert.equal(g.powerDraw, 300.5, "headline stays GPU 0");
  assert.equal(g.powerDrawTotal, 610.75);
  assert.equal(g.gpuCount, 3);
  assert.equal(g.powerSource, "nvidia-smi");
});

/** sysfs for two AMD cards; card1 has no power sensor. */
function amdFs({ card0Average = "95000000", card1Power = null } = {}) {
  const files = {
    "/proc/meminfo": MEMINFO,
    "/sys/class/drm/card0/device/gpu_busy_percent": "37\n",
    "/sys/class/drm/card0/device/mem_info_vram_total": String(16 * 1024 * 1024 * 1024),
    "/sys/class/drm/card0/device/mem_info_vram_used": String(4 * 1024 * 1024 * 1024),
    "/sys/class/drm/card0/device/hwmon/hwmon3/temp1_input": "61000",
    "/sys/class/drm/card1/device/gpu_busy_percent": "2\n",
    "/sys/class/drm/card1/device/mem_info_vram_total": String(512 * 1024 * 1024),
    "/sys/class/drm/card1/device/mem_info_vram_used": String(64 * 1024 * 1024),
  };
  if (card0Average != null) files["/sys/class/drm/card0/device/hwmon/hwmon3/power1_average"] = card0Average;
  else files["/sys/class/drm/card0/device/hwmon/hwmon3/power1_input"] = "88000000";
  if (card1Power != null) files["/sys/class/drm/card1/device/hwmon/hwmon4/power1_input"] = card1Power;
  return {
    readFile: async (p) => {
      if (p in files) return files[p];
      throw new Error(`ENOENT: ${p}`);
    },
    readDir: (dir) => {
      if (dir === "/sys/class/drm/card0/device/hwmon") return ["hwmon3"];
      if (dir === "/sys/class/drm/card1/device/hwmon") return ["hwmon4"];
      throw new Error(`ENOENT: ${dir}`);
    },
  };
}

const noNvidia = async () => {
  throw new Error("nvidia-smi: not found");
};

test("gpu: AMD hwmon power1_average (µW) becomes measured board power", async () => {
  const g = await collectGpu({ exec: noNvidia, ...amdFs() });
  assert.equal(g.usage, 37);
  assert.equal(g.powerDraw, 95);
  assert.equal(g.powerDrawTotal, 95);
  assert.equal(g.powerSource, "amd-hwmon");
  assert.equal(g.gpuCount, 2);
});

test("gpu: AMD falls back to power1_input and sums cards that report", async () => {
  const g = await collectGpu({ exec: noNvidia, ...amdFs({ card0Average: null, card1Power: "7500000" }) });
  assert.equal(g.powerDraw, 88);
  assert.equal(g.powerDrawTotal, 95.5);
  assert.equal(g.powerSource, "amd-hwmon");
});

test("gpu: AMD without any power sensor reports no power source", async () => {
  const fsMock = amdFs();
  const g = await collectGpu({
    exec: noNvidia,
    readFile: async (p) => (p.endsWith("power1_average") ? Promise.reject(new Error("ENOENT")) : fsMock.readFile(p)),
    readDir: fsMock.readDir,
  });
  assert.equal(g.powerDraw, 0);
  assert.equal(g.powerDrawTotal, undefined);
  assert.equal(g.powerSource, undefined);
});
