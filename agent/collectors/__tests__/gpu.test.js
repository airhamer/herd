import test from "node:test";
import assert from "node:assert/strict";
import { collectGpu, isUnifiedGpuName } from "../gpu.js";

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

const GB10 = "NVIDIA GB10";

// ─── Discrete GPUs: dedicated VRAM, never system RAM ─────────────────────────

test("gpu: discrete GPU parses nvidia-smi into GpuMetrics; VRAM free = total − used, not MemAvailable", async () => {
  const g = await collectGpu({
    exec: mockExec("42, 15, 12.5, 100, 8192, 65536, NVIDIA RTX 6000 Ada Generation", "123,python,1024\n456,vllm,4096"),
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
    vramAvailableMB: 57344, // 65536 − 8192 (system MemAvailable is 40000: must not appear)
    processes: [
      { pid: 456, name: "vllm", vramMB: 4096 },
      { pid: 123, name: "python", vramMB: 1024 },
    ],
    gpuAllocMB: 5120,
    unifiedMemory: false,
  });
});

test("gpu: discrete 24 GiB card on a 64 GiB host keeps RAM out of every VRAM figure", async () => {
  const meminfo64 = async (p) => {
    if (p === "/proc/meminfo") return "MemTotal: 67108864 kB\nMemAvailable: 41943040 kB\n"; // 65536 / 40960 MB
    throw new Error("ENOENT");
  };
  const g = await collectGpu({ exec: mockExec("51, 30, 120, 450, 18000, 24564, NVIDIA GeForce RTX 4090", "77,ollama,17500"), readFile: meminfo64 });
  assert.equal(g.unifiedMemory, false);
  assert.equal(g.vramTotalMB, 24564);
  assert.equal(g.vramUsedMB, 18000);
  assert.equal(g.vramAvailableMB, 6564);
  assert.equal(g.vramPercentage, 73);
});

test("gpu: idle discrete GPU (memory.used 0, no apps) reports 0 used, not system RAM used", async () => {
  const g = await collectGpu({ exec: mockExec("42, 150, 12.5, 100, 0, 65536, NVIDIA A100-SXM4-80GB", ""), readFile });
  assert.equal(g.usage, 100); // clamped
  assert.equal(g.vramUsedMB, 0);
  assert.equal(g.vramAvailableMB, 65536);
  assert.deepEqual(g.processes, []);
});

test("gpu: [N/A] memory on a NON-GB10 GPU is not unified and never borrows MemTotal", async () => {
  const g = await collectGpu({ exec: mockExec("55, 5, 10, 65, [N/A], [N/A], NVIDIA H100 80GB HBM3", "9,trainer,30000"), readFile });
  assert.equal(g.unifiedMemory, false);
  assert.equal(g.vramTotalMB, 0); // unknown, not 128000 (system RAM)
  assert.equal(g.vramUsedMB, 30000); // single GPU: compute-apps sum is this card's
  assert.equal(g.vramAvailableMB, 0);
  // No name at all (older output): [N/A] alone does not make a GPU unified either.
  const unnamed = await collectGpu({ exec: mockExec("55, 5, 10, 65, [N/A], [N/A]", ""), readFile });
  assert.equal(unnamed.unifiedMemory, false);
  assert.equal(unnamed.vramTotalMB, 0);
});

test("gpu: multi-GPU discrete host reports GPU 0's own VRAM, no sums across cards or RAM", async () => {
  const smi = [
    "40, 10, 70, 300, 1024, 81920, NVIDIA H100 80GB HBM3",
    "60, 95, 650, 700, 79000, 81920, NVIDIA H100 80GB HBM3",
  ].join("\n");
  const apps = "11,vllm-gpu1,78000\n12,small-gpu0,900";
  const g = await collectGpu({ exec: mockExec(smi, apps), readFile });
  assert.equal(g.unifiedMemory, false);
  assert.equal(g.vramUsedMB, 1024); // GPU 0's memory.used
  assert.equal(g.vramTotalMB, 81920); // GPU 0's total, not 2× and not MemTotal
  assert.equal(g.vramAvailableMB, 80896);
  // [N/A] used on GPU 0 of a multi-GPU box: the all-cards apps sum must not stand in.
  const na = await collectGpu({
    exec: mockExec("40, 10, 70, 300, [N/A], 81920, NVIDIA H100\n60, 95, 650, 700, 79000, 81920, NVIDIA H100", apps),
    readFile,
  });
  assert.equal(na.vramUsedMB, 0);
  assert.equal(na.vramAvailableMB, 81920);
});

test("gpu: keeps only top 5 processes by VRAM", async () => {
  const apps = Array.from({ length: 7 }, (_, i) => `${i + 1},proc${i},${i + 1}`).join("\n");
  const g = await collectGpu({ exec: mockExec("55, 5, 10, 65, 0, 65536, NVIDIA L4", apps), readFile });
  assert.equal(g.processes.length, 5);
  assert.equal(g.processes[0].pid, 7); // highest VRAM first
});

test("gpu: [N/A] temperature still returns metrics when usage is valid", async () => {
  const g = await collectGpu({ exec: mockExec("[N/A], 15, 12.5, 100, 0, 65536, NVIDIA L4", ""), readFile });
  assert.notEqual(g, null);
  assert.equal(g.usage, 15);
  assert.equal(g.temperature, null);
});

// ─── GB10 unified memory: unchanged sparkDash semantics ──────────────────────

test("gpu: isUnifiedGpuName is a positive GB10 match only", () => {
  assert.equal(isUnifiedGpuName("NVIDIA GB10"), true);
  assert.equal(isUnifiedGpuName("gb10"), true);
  for (const n of ["NVIDIA H100 80GB HBM3", "NVIDIA GeForce RTX 4090", "NVIDIA GB100", "NVIDIA GB200", "", undefined, null]) {
    assert.equal(isUnifiedGpuName(n), false, String(n));
  }
});

test("gpu: GB10 [N/A] memory falls back to meminfo + compute-apps sum", async () => {
  const g = await collectGpu({
    exec: mockExec(`55, 90, 20.2, 90.0, [N/A], [N/A], ${GB10}`, "789,sglang,51200"),
    readFile,
  });
  assert.equal(g.unifiedMemory, true);
  assert.equal(g.vramUsedMB, 51200);
  assert.equal(g.vramTotalMB, 128000); // MemTotal fallback
  assert.equal(g.vramAvailableMB, 40000); // MemAvailable: the GPU draws from the OS pool
  assert.equal(g.vramPercentage, 40); // 51200/128000
  assert.equal(g.gpuAllocMB, 51200);
  assert.deepEqual(g.processes, [{ pid: 789, name: "sglang", vramMB: 51200 }]);
});

test("gpu: GB10 with no apps and 0 used falls back to MemTotal − MemAvailable", async () => {
  const g = await collectGpu({ exec: mockExec(`42, 15, 12.5, 100, 0, [N/A], ${GB10}`, ""), readFile });
  assert.equal(g.vramUsedMB, 88000);
});

test("gpu: gpuAllocMB sums ALL compute apps, not just the top 5 (issue #26)", async () => {
  const apps = Array.from({ length: 7 }, (_, i) => `${i + 1},proc${i},1000`).join("\n");
  const g = await collectGpu({ exec: mockExec(`55, 5, 10, 65, [N/A], [N/A], ${GB10}`, apps), readFile });
  assert.equal(g.processes.length, 5);
  assert.equal(g.gpuAllocMB, 7000);
});

test("gpu: clamps vramPercentage to 100 when apps exceed pool", async () => {
  const g = await collectGpu({
    exec: mockExec(`55, 5, 10, 65, [N/A], [N/A], ${GB10}`, "1,a,200000\n2,b,200000"),
    readFile,
  });
  assert.equal(g.vramPercentage, 100);
  assert.equal(g.processes.length, 2);
});

// ─── No GPU ──────────────────────────────────────────────────────────────────

test("gpu: CPU-only host (no nvidia-smi, no AMD sysfs) returns null", async () => {
  const exec = async () => {
    throw new Error("nvidia-smi: command not found");
  };
  assert.equal(await collectGpu({ exec, readFile }), null);
});

test("gpu: returns null on empty/unparseable output", async () => {
  assert.equal(await collectGpu({ exec: async () => "", readFile }), null);
  assert.equal(await collectGpu({ exec: async () => "garbage", readFile }), null);
});

test("gpu: AMD discrete card reports its own VRAM free, not MemAvailable", async () => {
  const files = {
    "/proc/meminfo": MEMINFO,
    "/sys/class/drm/card0/device/gpu_busy_percent": "12\n",
    "/sys/class/drm/card0/device/mem_info_vram_total": String(16 * 1024 * 1024 * 1024),
    "/sys/class/drm/card0/device/mem_info_vram_used": String(4 * 1024 * 1024 * 1024),
    "/sys/class/drm/card0/device/hwmon/hwmon0/temp1_input": "48000",
  };
  const amdRead = async (p) => {
    if (p in files) return files[p];
    throw new Error(`ENOENT: ${p}`);
  };
  const g = await collectGpu({ exec: async () => { throw new Error("no nvidia-smi"); }, readFile: amdRead });
  assert.equal(g.vramTotalMB, 16384);
  assert.equal(g.vramUsedMB, 4096);
  assert.equal(g.vramAvailableMB, 12288);
  assert.equal(g.unifiedMemory, false);
});
