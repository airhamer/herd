// ─── S1.5 macOS SSH collector unit tests ───────────────────────────────────
// No SSH anywhere in here: a fake exec returns canned sample text (the
// injectable-exec seam). Pure parse math is asserted against hand-computed
// ground truth. UNVERIFIED-LIVE per register S1.5 ruling — fixtures only.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MACOS_SAMPLE_CMD,
  parseMacosSample,
  snapshotFromMacos,
  createMacosSshCollector,
  createMacosSshFleet,
} from "../macosSshCollector.js";

const NODE = { id: "mac1", name: "Mac One", lanIp: "192.0.2.50", protocol: "ssh", platform: "macos", ssh: { user: "steve" } };

// Hand-built sample mirroring MACOS_SAMPLE_CMD output.
// Ground truth (fixture schema per spec description; pending-upstream-check):
//   MACMON: cpu.usage 42.5 → usage 42.5; cpu.power_mw 2500 → draw 2.5 W;
//           gpu.usage 63.25 → gpu.usage 63.25; gpu.power_mw 4000 → 4 W.
//   UPTIME: boot sec 1730000000, now 1730000600000 → 600 s.
//   MEM: hw.memsize 515396075264 B → 491520 MB? (515396075264/1048576=491519.99→491520)
//        page size 16384; free 1,000,000 pages + inactive 500,000 pages
//        → (1.5e6 × 16384)/1048576 = 23437.5 MB → round 23438 avail;
//        used = 491520 − 23438 = 468082; pct = 100×468082/491520 = 95.23…→ 95.2
//   DISK: 512-blocks × 512 / 1048576 → MB. /dev/disk3s1s1 + /dev/disk3s5 kept;
//        "map auto_home" skipped (fs col not /dev/...).
//   NET: en0 kept once (duplicate link-state row + inet row skipped);
//        lo0 + awdl0 + utun4 skipped.
const HAPPY = [
  "===MACMON===",
  '{"cpu":{"usage":42.5,"clusters":[{"usage":40.0},{"usage":45.0}],"power_mw":2500},"gpu":{"usage":63.25,"power_mw":4000},"mem":{"free":16384000000,"available":24576000000,"used":491520000000,"watermark":470000000000}}',
  "===UPTIME===",
  "{ sec = 1730000000, usec = 0 }",
  "===MEM===",
  "515396075264",
  "Mach Virtual Memory Statistics:",
  "page size of 16384 bytes",
  "Pages free:                            1000000.00",
  "Pages inactive:                         500000.00",
  "Pages wired down:                       300000.00",
  "===DISK===",
  "Filesystem        512-blocks        Used     Avail Capacity  Mounted on",
  "/dev/disk3s1s1    1907348160  488129440 1397167440    26%  /",
  "/dev/disk3s5      1907348160 1319218720 1397167440    49%  /System/Volumes/Data",
  "map auto_home              0          0          0   100%  /System/Volumes/Data/home",
  "===NET===",
  "Name        Mtu  Network Address                 Ipkts   Ilink  Opkts  Ocoll  Ibytes      Obytes",
  "en0        1500  <Link#1> a6:bc:c1:23:45:67       100     0     50      0      1000000     500000",
  "en0        1500  <Link#1> a6:bc:c1:23:45:67       100     0     50      0      1000000     500000",
  "en0        1500  fe80:1%en0 fe80::a4bc:c1ff:fe23:4567 100 0    50      0      1000000     500000",
  "lo0        16384 <Link#2> ::1                    9999  0     9999    0      1000000000  1000000000",
  "awdl0      1500  <Link#3> 66:77:88:99:aa:bb         5     0      5      0        1000       1000",
  "utun4      1500  10.99.0.1 10.99.0.1              20     0     20      0        5000       5000",
  "===END===",
].join("\n");

const NOW = 1730000600000;

test("happy path: full snapshot conforms to NodeAgentSnapshot shape (every field)", () => {
  const parsed = parseMacosSample(HAPPY, {}, NOW);

  assert.equal(parsed.macmon, true);
  assert.equal(parsed.uptimeSeconds, 600);

  // CPU — macmon-derived (fixture schema pending-upstream-check).
  assert.ok(parsed.cpu);
  assert.equal(parsed.cpu.usage, 42.5);
  assert.equal(parsed.cpu.temperature, 0); // macmon exposes no temperature
  assert.equal(parsed.cpu.draw, 2.5); // 2500 mW → 2.5 W
  assert.equal(parsed.cpu.tdp, 0);

  // GPU — set ONLY because macmon gpu.usage exists; exact GpuMetrics shape.
  assert.deepEqual(parsed.gpu, {
    temperature: 0,
    usage: 63.25,
    powerDraw: 4, // 4000 mW → 4 W
    powerLimit: 0,
    vramUsedMB: 0,
    vramTotalMB: 0,
    vramPercentage: 0,
    vramAvailableMB: 0,
    processes: [],
  });

  // Memory — hw.memsize + vm_stat free+inactive (hand-computed above).
  assert.deepEqual(parsed.mem, {
    usedMB: 468082,
    totalMB: 491520,
    availableMB: 23438,
    percentage: 95.2,
  });

  // Disk — /dev/ filesystems only; 512-blocks → MB.
  assert.equal(parsed.disk.length, 2);
  const d0 = parsed.disk[0];
  assert.equal(d0.device, "/dev/disk3s1s1");
  assert.equal(d0.mount, "/");
  assert.equal(d0.totalMB, Math.round((1907348160 * 512) / 1048576));
  assert.equal(d0.usedMB, Math.round((488129440 * 512) / 1048576));
  assert.equal(d0.availableMB, Math.round((1397167440 * 512) / 1048576));
  assert.equal(d0.percentage, 26);
  assert.equal(parsed.disk[1].device, "/dev/disk3s5");
  assert.equal(parsed.disk[1].mount, "/System/Volumes/Data");
  assert.equal(parsed.disk[1].percentage, 49);

  // Net — en0 exactly once; lo0/awdl0/utun4 skipped; first poll → speeds 0.
  assert.deepEqual(parsed.net.map((n) => n.iface), ["en0"]);
  assert.deepEqual(parsed.net[0], {
    iface: "en0",
    ip: null,
    rxSpeed: 0,
    txSpeed: 0,
    linkSpeedMbps: null,
  });

  // Full snapshot via snapshotFromMacos.
  const snap = snapshotFromMacos(NODE, parsed, 2000);
  assert.equal(snap.nodeId, "mac1");
  assert.equal(snap.nodeName, "Mac One");
  assert.equal(snap.lanIp, "192.0.2.50");
  assert.equal(snap.agentVersion, "agentless-ssh-1");
  assert.equal(snap.online, true);
  assert.equal(snap.enrollment, undefined);
  assert.equal(snap.uptimeSeconds, 600);
  assert.deepEqual(snap.cpu, parsed.cpu);
  assert.deepEqual(snap.gpu, parsed.gpu);
  assert.deepEqual(snap.mem, parsed.mem);
  assert.deepEqual(snap.disk, parsed.disk);
  assert.deepEqual(snap.net, parsed.net);
  assert.equal(snap.polledAt, 2000);
  // Families agentless macOS SSH collection cannot see: empty/null per types.
  assert.deepEqual(snap.containers, []);
  assert.deepEqual(snap.versions, []);
  assert.deepEqual(snap.services, []);
  assert.equal(snap.memory, null);
  assert.equal(snap.requests, null);
  assert.equal(snap.topology, null);
  assert.equal(snap.tailscale, null);
});

test("lanIp falls back to ssh.host; empty/garbage input never throws", () => {
  const node = { id: "m2", name: "M2", protocol: "ssh", platform: "macos", ssh: { user: "u", host: "10.0.0.9" } };
  const snap = snapshotFromMacos(node, parseMacosSample("===END===", {}, 1), 1);
  assert.equal(snap.lanIp, "10.0.0.9");
  assert.equal(snap.online, true);

  for (const junk of ["", "total noise", "===MACMON===\n}{ not json\n===END==="]) {
    const p = parseMacosSample(junk, {}, 1);
    assert.equal(p.macmon, false);
    assert.equal(p.cpu, null);
    assert.equal(p.gpu, null);
    assert.equal(p.mem, null);
    assert.equal(p.uptimeSeconds, null);
    assert.deepEqual(p.disk, []);
    assert.deepEqual(p.net, []);
  }
});

test("macmon binary absent (empty MACMON section) → cpu/gpu null; native families emitted", () => {
  const absent = HAPPY.replace(
    '{"cpu":{"usage":42.5,"clusters":[{"usage":40.0},{"usage":45.0}],"power_mw":2500},"gpu":{"usage":63.25,"power_mw":4000},"mem":{"free":16384000000,"available":24576000000,"used":491520000000,"watermark":470000000000}}',
    ""
  );
  const parsed = parseMacosSample(absent, {}, NOW);
  assert.equal(parsed.macmon, false);
  assert.equal(parsed.cpu, null);
  assert.equal(parsed.gpu, null);
  // Native-only families still collect:
  assert.equal(parsed.uptimeSeconds, 600);
  assert.ok(parsed.mem);
  assert.equal(parsed.disk.length, 2);
  assert.deepEqual(parsed.net.map((n) => n.iface), ["en0"]);
});

test("unparseable MACMON line → cpu/gpu null; rest good; no throw", () => {
  const broken = HAPPY.replace(
    /\{"cpu":.*\}\n/,
    "this is definitely not NDJSON {{{\n"
  );
  assert.ok(broken.includes("this is definitely not NDJSON"));
  const parsed = parseMacosSample(broken, {}, NOW);
  assert.equal(parsed.macmon, false);
  assert.equal(parsed.cpu, null);
  assert.equal(parsed.gpu, null);
  assert.equal(parsed.uptimeSeconds, 600);
  assert.ok(parsed.mem);
  assert.equal(parsed.disk.length, 2);
  assert.deepEqual(parsed.net.map((n) => n.iface), ["en0"]);
});

test("exec throws → online:false snapshot, onStatus fired exactly once with 'offline'", async () => {
  const statuses = [];
  const snapshots = [];
  const collector = createMacosSshCollector({
    node: NODE,
    exec: async () => {
      throw new Error("SSH to 192.0.2.50 failed: connection refused");
    },
    pollIntervalMs: 60000,
    now: () => 5000,
  });
  collector.onSnapshot((id, snap) => snapshots.push([id, snap]));
  collector.onStatus((id, st) => statuses.push([id, st]));

  collector.start();
  await new Promise((r) => setTimeout(r, 30));
  collector.stop();

  assert.equal(statuses.length, 1);
  assert.deepEqual(statuses[0], ["mac1", "offline"]);
  assert.equal(snapshots.length, 1);
  const snap = snapshots[0][1];
  assert.equal(snap.online, false);
  assert.equal(snap.cpu, null);
  assert.equal(snap.gpu, null);
  assert.equal(snap.mem, null);
  assert.equal(snap.uptimeSeconds, null);
  assert.deepEqual(snap.net, []);
  assert.equal(snap.polledAt, 5000);
  assert.equal(collector.getSnapshot("mac1").online, false);
  assert.equal(collector.isOnline("mac1"), false);
});

test("two polls with bumped net counters → rxSpeed > 0, onSnapshot twice", async () => {
  // Δrx = 5,000,000 B over 1 s → 5 MB/s; Δtx = 1,000,000 → 1 MB/s.
  const poll2 = HAPPY
    .replace("100     0     50      0      1000000     500000", "150     0     60      0      6000000    1500000")
    .replace("100     0     50      0      1000000     500000", "150     0     60      0      6000000    1500000")
    .replace("100 0    50      0      1000000     500000", "150 0    60      0      6000000    1500000");

  let ts = NOW;
  let poll = 0;
  const collector = createMacosSshCollector({
    node: NODE,
    exec: async () => {
      const out = poll++ === 0 ? HAPPY : poll2;
      ts += 1000;
      return out;
    },
    pollIntervalMs: 15,
    now: () => ts,
  });

  const snapshots = [];
  collector.onSnapshot((id, snap) => snapshots.push(snap));
  collector.start();
  await new Promise((r) => setTimeout(r, 60));
  collector.stop();

  assert.ok(snapshots.length >= 2, `expected >=2 snapshots, got ${snapshots.length}`);
  assert.equal(snapshots[0].online, true);
  assert.equal(snapshots[1].online, true);
  const en0a = snapshots[0].net.find((n) => n.iface === "en0");
  const en0b = snapshots[1].net.find((n) => n.iface === "en0");
  assert.equal(en0a.rxSpeed, 0);
  assert.ok(en0b.rxSpeed > 0, `rxSpeed was ${en0b.rxSpeed}`);
  assert.equal(en0b.rxSpeed, 5);
  assert.equal(en0b.txSpeed, 1);
});

test("getSnapshot is node-scoped; idempotent start/stop", async () => {
  const collector = createMacosSshCollector({ node: NODE, exec: async () => HAPPY, pollIntervalMs: 10 });
  collector.start();
  await new Promise((r) => setTimeout(r, 30));
  collector.stop();
  collector.stop(); // idempotent
  collector.start();
  collector.start(); // idempotent
  collector.stop();
  assert.equal(collector.getSnapshot("someone-else"), null);
  assert.equal(collector.isOnline("someone-else"), false);
  assert.ok(collector.getAllSnapshots()["mac1"]);
});

test("fleet filter: platform:\"macos\" only (legacy ssh node excluded); keys by id; unsubscribe works", async () => {
  const macNode = { id: "m-a", name: "MA", lanIp: "192.0.2.60", protocol: "ssh", platform: "macos", ssh: { user: "u" } };
  const legacySshNode = { id: "l-a", name: "LA", protocol: "ssh", ssh: { user: "u" } }; // no platform
  const agentNode = { id: "h-a", name: "HA", lanIp: "192.0.2.61" }; // no protocol

  const fleet = createMacosSshFleet({
    nodes: [macNode, legacySshNode, agentNode],
    transportFactory: (node) => ({
      nodeId: node.id,
      protocol: "ssh",
      exec: async () => HAPPY,
      test: async () => ({ ok: true, message: "ok" }),
    }),
    pollIntervalMs: 60000,
  });

  let fired = 0;
  const unsub = fleet.onSnapshot(() => fired++);
  fleet.start();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(fired, 1);
  unsub();
  assert.deepEqual(Object.keys(fleet.getAllSnapshots()), ["m-a"]); // legacy + agent excluded
  assert.equal(fleet.getSnapshot("l-a"), null);
  assert.equal(fleet.isOnline("m-a"), true);
  assert.equal(fleet.isOnline("l-a"), false);

  fleet.stop();
  fired = 0;
  const snapBefore = fleet.getSnapshot("m-a");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fired, 0);
  assert.equal(fleet.getSnapshot("m-a"), snapBefore);
});

test("fleet survives a misconfigured macos record (transportFactory throws) → node offline", async () => {
  const good = { id: "good-m", name: "G", lanIp: "192.0.2.70", protocol: "ssh", platform: "macos", ssh: { user: "u" } };
  const bad = { id: "bad-m", name: "B", protocol: "ssh", platform: "macos", ssh: {} };
  const fleet = createMacosSshFleet({
    nodes: [good, bad],
    transportFactory: (node) => {
      if (node.id === "bad-m") throw new Error("node bad-m: protocol \"ssh\" without ssh.user");
      return { exec: async () => HAPPY };
    },
    pollIntervalMs: 60000,
  });
  fleet.start();
  await new Promise((r) => setTimeout(r, 30));
  fleet.stop();
  assert.equal(fleet.isOnline("good-m"), true);
  assert.equal(fleet.getSnapshot("bad-m").online, false);
});

test("MACOS_SAMPLE_CMD: discovery order, pipe|head -n 1, no timeout binary, ===END=== tail", () => {
  assert.ok(MACOS_SAMPLE_CMD.includes("/opt/homebrew/bin/macmon"));
  assert.ok(MACOS_SAMPLE_CMD.includes("/usr/local/bin/macmon"));
  assert.ok(MACOS_SAMPLE_CMD.includes("$HOME/.cargo/bin/macmon"));
  assert.ok(MACOS_SAMPLE_CMD.includes("command -v macmon"));
  assert.ok(MACOS_SAMPLE_CMD.includes('"$MACMON_BIN" pipe 2>/dev/null | head -n 1'));
  assert.ok(!MACOS_SAMPLE_CMD.includes("timeout "), "macOS has no timeout(1) — must not be used");
  assert.ok(MACOS_SAMPLE_CMD.includes("echo '===END==='"));
});
