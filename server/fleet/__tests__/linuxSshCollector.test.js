// ─── S1.4 Linux SSH collector unit tests ───────────────────────────────────
// No SSH anywhere in here: a fake exec returns canned sample text (the
// injectable-exec seam from the spec). Pure parse math is asserted against
// hand-computed ground truth.

import test from "node:test";
import assert from "node:assert/strict";

import {
  LINUX_SAMPLE_CMD,
  parseLinuxSample,
  snapshotFromLinux,
  createLinuxSshCollector,
  createLinuxSshFleet,
} from "../linuxSshCollector.js";

const NODE = { id: "linux1", name: "Linux One", lanIp: "192.0.2.10", protocol: "ssh", ssh: { user: "steve" } };

// Hand-built sample mirroring LINUX_SAMPLE_CMD output.
// CPU math (ground truth): t1 = 1000+200+300+8000+400+50+25+10 = 9985,
// idle1 = 8000+400 = 8400; t2 = 1100+210+330+8600+440+55+27+12 = 10774,
// idle2 = 8600+440 = 9040. dTotal=789 dIdle=640 → usage = 100*(1-640/789)
// = 18.88 (149/789 = 0.18884…). RAPL pair Δ=12.5 MJ /0.5 s → 25 W.
const HAPPY = [
  "===OS=== NAME=\"Ubuntu\" VERSION=\"24.04 LTS\" ",
  "===UPTIME===",
  "123456.78 400000",
  "===CPU1===",
  "cpu  1000 200 300 8000 400 50 25 10 0 0",
  "===CPU2===",
  "cpu  1100 210 330 8600 440 55 27 12 0 0",
  "===CORES===",
  "8",
  "===MEM===",
  "MemTotal:       32768000 kB",
  "MemAvailable:   16384000 kB",
  "===NET===",
  "    eth0: 1000000 1000 0 0 0 0 0 1 2000000 1500 0 0 0 0 0 0",
  "      lo:  500000   50 0 0 0 0 0 1  500000   50 0 0 0 0 0 0",
  "   wlan0: 3000000  900 0 0 0 0 0 1 4000000  800 0 0 0 0 0 0",
  "===DISK===",
  "Filesystem     1024-blocks      Used  Available Capacity Mounted on",
  "/dev/nvme0n1p2  982729220 400000000  534876420  43% /",
  "/dev/loop0         128000    128000           0 100% /snap/core/1",
  "===TEMP===",
  "k10temp 41400",
  "acpitz 55000",
  "===RAPL===",
  "100000000",
  "112500000",
  "===END===",
].join("\n");

test("happy path: full snapshot conforms to NodeAgentSnapshot shape", () => {
  const parsed = parseLinuxSample(HAPPY, {}, 1000);

  assert.equal(parsed.uptimeSeconds, 123456);

  // CPU — hand-computed 18.88 (independent ground truth, see header).
  assert.ok(parsed.cpu);
  assert.equal(parsed.cpu.usage, 18.88);
  assert.equal(parsed.cpu.temperature, 41.4); // first CPU-ish zone (k10temp 41400 m°)
  assert.equal(parsed.cpu.draw, 25); // (112500000-100000000)/0.5/1e6 W
  assert.equal(parsed.cpu.tdp, 0);

  // Memory kB → MB ints.
  assert.deepEqual(parsed.mem, {
    usedMB: 16000,
    totalMB: 32000,
    availableMB: 16000,
    percentage: 50,
  });

  // Disk: /dev/loop0 + /snap mount skipped; 1K blocks → MB (×1024/1e6).
  assert.equal(parsed.disk.length, 1);
  const d = parsed.disk[0];
  assert.equal(d.device, "/dev/nvme0n1p2");
  assert.equal(d.mount, "/");
  assert.equal(d.totalMB, Math.round((982729220 * 1024) / 1e6));
  assert.equal(d.usedMB, Math.round((400000000 * 1024) / 1e6));
  assert.equal(d.availableMB, Math.round((534876420 * 1024) / 1e6));
  assert.equal(d.percentage, 43);

  // Net: lo skipped; first poll → speeds 0; ip/linkSpeed null.
  assert.deepEqual(parsed.net.map((n) => n.iface), ["eth0", "wlan0"]);
  for (const n of parsed.net) {
    assert.equal(n.ip, null);
    assert.equal(n.linkSpeedMbps, null);
    assert.equal(n.rxSpeed, 0);
    assert.equal(n.txSpeed, 0);
  }

  // Full snapshot via snapshotFromLinux.
  const snap = snapshotFromLinux(NODE, parsed, 2000);
  assert.equal(snap.nodeId, "linux1");
  assert.equal(snap.nodeName, "Linux One");
  assert.equal(snap.lanIp, "192.0.2.10");
  assert.equal(snap.agentVersion, "agentless-ssh-1");
  assert.equal(snap.online, true);
  assert.equal(snap.enrollment, undefined);
  assert.equal(snap.uptimeSeconds, 123456);
  assert.deepEqual(snap.cpu, parsed.cpu);
  assert.deepEqual(snap.mem, parsed.mem);
  assert.deepEqual(snap.disk, parsed.disk);
  assert.deepEqual(snap.net, parsed.net);
  assert.equal(snap.polledAt, 2000);
  // Families agentless Linux cannot see: empty/null per shared/types.ts.
  assert.equal(snap.gpu, null);
  assert.deepEqual(snap.containers, []);
  assert.deepEqual(snap.versions, []);
  assert.deepEqual(snap.services, []);
  assert.equal(snap.memory, null);
  assert.equal(snap.requests, null);
  assert.equal(snap.topology, null);
  assert.equal(snap.tailscale, null);
});

test("lanIp falls back to ssh.host; negative cases parse without throwing", () => {
  const node = { id: "l2", name: "L2", protocol: "ssh", ssh: { user: "u", host: "10.0.0.5" } };
  const snap = snapshotFromLinux(node, parseLinuxSample("===END===", {}, 1), 1);
  assert.equal(snap.lanIp, "10.0.0.5");
  assert.equal(snap.online, true);

  // Empty / garbage input never throws and degrades every family.
  for (const junk of ["", "total noise", "===CPU1===\nnot-a-cpu-row\n===END==="]) {
    const p = parseLinuxSample(junk, {}, 1);
    assert.equal(p.cpu, null);
    assert.equal(p.mem, null);
    assert.equal(p.uptimeSeconds, null);
    assert.deepEqual(p.disk, []);
    assert.deepEqual(p.net, []);
  }
});

test("missing TEMP+RAPL+NET sections → temperature 0, draw 0, net [], no throw", () => {
  const dropSections = (src, names) => {
    const out = [];
    let skip = false;
    for (const line of src.split("\n")) {
      const m = /^===([A-Z0-9_]+)===$/.exec(line.trim());
      if (m) {
        skip = names.includes(m[1]);
        if (skip) continue;
      }
      if (!skip) out.push(line);
    }
    return out.join("\n");
  };
  const text = dropSections(HAPPY, ["NET", "TEMP", "RAPL"]);
  const parsed = parseLinuxSample(text, {}, 1000);
  assert.equal(parsed.cpu.temperature, 0);
  assert.equal(parsed.cpu.draw, 0);
  assert.deepEqual(parsed.net, []);
  assert.equal(parsed.cpu.usage, 18.88); // CPU/mem still fine
  assert.ok(parsed.mem);
});

test("exec throws → online:false snapshot, onStatus fired once with 'offline'", async () => {
  const statuses = [];
  const snapshots = [];
  const collector = createLinuxSshCollector({
    node: NODE,
    exec: async () => {
      throw new Error("SSH to 192.0.2.10 failed: connection refused");
    },
    pollIntervalMs: 60000, // no interval poll inside the test
    now: () => 5000,
  });
  collector.onSnapshot((id, snap) => snapshots.push([id, snap]));
  collector.onStatus((id, st) => statuses.push([id, st]));

  collector.start();
  await new Promise((r) => setTimeout(r, 30));
  collector.stop();

  assert.equal(statuses.length, 1);
  assert.deepEqual(statuses[0], ["linux1", "offline"]);
  assert.equal(snapshots.length, 1);
  const snap = snapshots[0][1];
  assert.equal(snap.online, false);
  assert.equal(snap.cpu, null);
  assert.equal(snap.mem, null);
  assert.equal(snap.uptimeSeconds, null);
  assert.deepEqual(snap.net, []);
  assert.equal(snap.polledAt, 5000);
  assert.equal(collector.getSnapshot("linux1").online, false);
  assert.equal(collector.isOnline("linux1"), false);
});

test("two polls with changed counters → net rxSpeed > 0, cpu.usage differs, onSnapshot twice", async () => {
  const polls = [];
  const poll2 = HAPPY.replace(
    "cpu  1100 210 330 8600 440 55 27 12 0 0",
    "cpu  1200 220 360 9200 480 60 30 14 0 0"
  ).replace("eth0: 1000000", "eth0: 6000000").replace("2000000 1500", "2500000 1500");

  let ts = 1000;
  const collector = createLinuxSshCollector({
    node: NODE,
    exec: async () => {
      const out = polls.length === 0 ? HAPPY : poll2;
      polls.push(out);
      ts += 1000; // 1 s between polls
      return out;
    },
    pollIntervalMs: 15, // drives the second poll inside the wait window
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

  // Poll 1: first-seen → speeds 0. Poll 2: Δrx = 5 MB over 1 s → 5 MB/s;
  // Δtx = 0.5 MB/s. CPU: 2nd jiffie window differs from the first.
  const eth0a = snapshots[0].net.find((n) => n.iface === "eth0");
  const eth0b = snapshots[1].net.find((n) => n.iface === "eth0");
  assert.equal(eth0a.rxSpeed, 0);
  assert.ok(eth0b.rxSpeed > 0, `rxSpeed was ${eth0b.rxSpeed}`);
  assert.equal(eth0b.rxSpeed, 5); // (6000000-1000000)/1s/1e6 = 5 MB/s
  assert.equal(eth0b.txSpeed, 0.5);
  assert.notEqual(snapshots[0].cpu.usage, snapshots[1].cpu.usage);
});

test("getSnapshot is node-scoped; idempotent start/stop", async () => {
  const collector = createLinuxSshCollector({ node: NODE, exec: async () => HAPPY, pollIntervalMs: 10 });
  collector.start();
  await new Promise((r) => setTimeout(r, 30));
  collector.stop();
  collector.stop(); // idempotent
  collector.start();
  collector.start(); // idempotent
  collector.stop();
  assert.equal(collector.getSnapshot("someone-else"), null);
  assert.equal(collector.isOnline("someone-else"), false);
  assert.ok(collector.getAllSnapshots()["linux1"]);
});

test("S1.5 split: platform-tagged ssh records route by lane (macos skipped, legacy + linux collected)", async () => {
  const legacy = { id: "lin", name: "Lin", protocol: "ssh", ssh: { user: "u" } }; // no platform
  const tagged = { id: "lnx", name: "Lnx", protocol: "ssh", platform: "linux", ssh: { user: "u" } };
  const mac = { id: "mac", name: "Mac", protocol: "ssh", platform: "macos", ssh: { user: "u" } };
  const fleet = createLinuxSshFleet({
    nodes: [legacy, tagged, mac],
    transportFactory: () => ({ exec: async () => HAPPY }),
    pollIntervalMs: 60000,
  });
  fleet.start();
  await new Promise((r) => setTimeout(r, 30));
  fleet.stop();
  assert.equal(fleet.getSnapshot("mac"), null); // macos lane owns it
  assert.equal(fleet.isOnline("mac"), false);
  assert.equal(fleet.isOnline("lin"), true); // legacy round-trips unchanged
  assert.equal(fleet.isOnline("lnx"), true);
});

test("createLinuxSshFleet filters non-ssh nodes; getAllSnapshots keys by id; unsubscribe removes callbacks", async () => {
  const sshNode = { id: "a", name: "A", lanIp: "192.0.2.20", protocol: "ssh", ssh: { user: "u" } };
  const agentNode = { id: "b", name: "B", lanIp: "192.0.2.21" }; // no protocol:"ssh"

  const seen = [];
  const fleet = createLinuxSshFleet({
    nodes: [sshNode, agentNode],
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
  assert.deepEqual(Object.keys(fleet.getAllSnapshots()), ["a"]); // "b" filtered out
  assert.equal(fleet.getSnapshot("b"), null);
  assert.equal(fleet.isOnline("a"), true);
  assert.equal(fleet.isOnline("b"), false);

  fleet.stop();
  // After unsubscribe a further poll must not fire the callback again.
  fired = 0;
  const snapBefore = fleet.getSnapshot("a");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fired, 0);
  assert.equal(fleet.getSnapshot("a"), snapBefore);
});

test("fleet survives a misconfigured record (transportFactory throws) — node reports offline", async () => {
  const good = { id: "good", name: "G", lanIp: "192.0.2.30", protocol: "ssh", ssh: { user: "u" } };
  const bad = { id: "bad", name: "B", protocol: "ssh", ssh: {} }; // no user/host → factory throws
  const fleet = createLinuxSshFleet({
    nodes: [good, bad],
    transportFactory: (node) => {
      if (node.id === "bad") throw new Error("node bad: protocol \"ssh\" without ssh.user");
      return { exec: async () => HAPPY };
    },
    pollIntervalMs: 60000,
  });
  fleet.start();
  await new Promise((r) => setTimeout(r, 30));
  fleet.stop();
  assert.equal(fleet.isOnline("good"), true);
  assert.equal(fleet.getSnapshot("bad").online, false);
});

test("markers glued onto a data line are honored (live OS-section bug)", () => {
  // Live localhost sshd, 2026-10-26: the OS section's `tr '\n' ' '` swallows
  // the newline before the NEXT marker, so "===UPTIME===" arrives on the same
  // line as the os-release text. A whole-line-only parser lost uptime here
  // (snapshot showed uptimeSeconds:null against a host with 84 days uptime).
  const glued =
    "===OS=== NAME=\"Ubuntu\" VERSION=\"24.04 LTS\" ===UPTIME===\n" +
    "7257890.12 3000000\n" +
    "===CPU1===\ncpu 100 20 30 800 40 10 5 3 0 0\n===END===";
  const parsed = parseLinuxSample(glued, {}, 1000);
  assert.equal(parsed.uptimeSeconds, 7257890);
  assert.ok(parsed.cpu); // sections after the glued one still parse
});

test("LINUX_SAMPLE_CMD covers the nonstandard-kernel glob (/sys/cl*ss/) and ends with ===END===", () => {
  assert.ok(LINUX_SAMPLE_CMD.includes("/sys/cl*ss/thermal/thermal_zone*"));
  assert.ok(LINUX_SAMPLE_CMD.includes("/sys/cl*ss/powercap/intel-rapl:"));
  assert.ok(LINUX_SAMPLE_CMD.includes("echo '===END==='"));
});
