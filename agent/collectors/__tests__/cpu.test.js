import test from "node:test";
import assert from "node:assert/strict";
import { collectCpu, resetCpuBaseline, parseCpuStat } from "../cpu.js";

const STAT_A = "cpu  100 0 50 800 50 0 0 0\n"; // total=1000, used=150
const STAT_B = "cpu  200 0 100 1600 100 0 0 0\n"; // total=2000, used=300

let statRaw = STAT_A;
const readFile = async (p) => {
  if (p === "/proc/stat") return statRaw;
  if (p === "/sys/class/thermal/thermal_zone0/temp") return "45000\n";
  if (p === "/proc/uptime") return "1000.0 500.0\n";
  throw new Error(`ENOENT: ${p}`);
};

test("parseCpuStat: field summing (ground truth)", () => {
  assert.deepEqual(parseCpuStat("cpu  100 5 50 800 50 10 20 5\n"), { total: 1040, used: 190 });
  assert.deepEqual(parseCpuStat(STAT_A), { total: 1000, used: 150 });
  assert.equal(parseCpuStat("nope\n"), null);
});

test("cpu: first call seeds baseline → usage 0, idle power estimate", async () => {
  resetCpuBaseline();
  statRaw = STAT_A;
  const c = await collectCpu({ readFile });
  assert.equal(c.usage, 0);
  assert.equal(c.tdp, 65); // GB10 default (no powercap CPU entry in mock)
  assert.equal(c.draw, 5.2); // idle = 65 * 0.08
  assert.equal(c.temperature, 45); // 45000 mC
});

test("cpu: second call computes delta usage (ground truth: 15%)", async () => {
  resetCpuBaseline();
  statRaw = STAT_A;
  await collectCpu({ readFile, now: () => 0 });
  statRaw = STAT_B;
  const c = await collectCpu({ readFile, now: () => 10_000 });
  assert.equal(c.usage, 15); // dUsed/dTotal = 150/1000
  assert.equal(c.tdp, 65);
  assert.equal(c.draw, 14.2); // 5.2 + (65−5.2)*0.15 = 14.17 → 14.2
  assert.equal(c.temperature, 45);
});

test("cpu: usage clamps to 100 on counter anomalies", async () => {
  resetCpuBaseline();
  statRaw = STAT_B; // total=2000
  await collectCpu({ readFile, now: () => 0 });
  statRaw = "cpu  100 0 0 0 0 0 0 0\n"; // total=100 < previous → no delta
  const c = await collectCpu({ readFile, now: () => 1000 });
  assert.equal(c.usage, 0); // counter went backwards → treated as reset, no negative usage
});

test("cpu: null when /proc/stat is unreadable", async () => {
  resetCpuBaseline();
  const readFileDeny = async () => {
    throw new Error("deny");
  };
  assert.equal(await collectCpu({ readFile: readFileDeny }), null);
});

test("cpu: null on all-zero counters", async () => {
  resetCpuBaseline();
  statRaw = "cpu 0 0 0 0 0 0 0 0\n";
  assert.equal(await collectCpu({ readFile }), null);
});

// ─── Issue #33: measured CPU package power ──────────────────────────────────

function raplFs(packages) {
  return {
    readDir: (dir) => {
      if (dir === "/sys/class/powercap") return [...Object.keys(packages), "intel-rapl:0:0"];
      throw new Error(`ENOENT: ${dir}`);
    },
    readFile: async (p) => {
      const m = p.match(/^\/sys\/class\/powercap\/(intel-rapl:\d+)\/energy_uj$/);
      if (m && m[1] in packages) return `${packages[m[1]]}\n`;
      return readFile(p);
    },
  };
}

test("cpu: RAPL energy delta over time is measured package power", async () => {
  resetCpuBaseline();
  statRaw = STAT_A;
  let t = 1_000_000;
  const packages = { "intel-rapl:0": 1_000_000, "intel-rapl:1": 5_000_000 };
  const first = await collectCpu({ ...raplFs(packages), now: () => t });
  assert.notEqual(first.drawSource, "rapl", "one reading is not a rate");

  t += 2_000;
  packages["intel-rapl:0"] += 60_000_000; // 60 J
  packages["intel-rapl:1"] += 40_000_000; // 40 J → 100 J / 2 s = 50 W
  statRaw = STAT_B;
  const second = await collectCpu({ ...raplFs(packages), now: () => t });
  assert.equal(second.drawSource, "rapl");
  assert.equal(second.draw, 50);
});

test("cpu: a RAPL wrap or package change is skipped, not reported as power", async () => {
  resetCpuBaseline();
  statRaw = STAT_A;
  let t = 0;
  const packages = { "intel-rapl:0": 9_000_000 };
  await collectCpu({ ...raplFs(packages), now: () => t });
  t += 1_000;
  packages["intel-rapl:0"] = 1_000; // wrapped
  const wrapped = await collectCpu({ ...raplFs(packages), now: () => t });
  assert.notEqual(wrapped.drawSource, "rapl");

  t += 1_000;
  const changed = await collectCpu({ ...raplFs({ ...packages, "intel-rapl:1": 1 }), now: () => t });
  assert.notEqual(changed.drawSource, "rapl");
});

test("cpu: without RAPL or sensors the draw is labelled estimated", async () => {
  resetCpuBaseline();
  statRaw = STAT_A;
  const c = await collectCpu({ readFile, readDir: () => [] });
  assert.equal(c.drawSource, "estimated");
  assert.equal(c.draw, 5.2);
});
