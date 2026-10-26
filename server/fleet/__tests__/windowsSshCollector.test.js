// ─── S1.6 Windows SSH collector unit tests ─────────────────────────────────
// No SSH anywhere in here — fixtures only BY REGISTER RULING (no Windows
// host in the fleet): a fake exec asserts the encoded command and returns
// canned sections. Pure parse math is asserted against hand-computed ground
// truth. UNVERIFIED-LIVE: docs/S1.6-CAPABILITY.md.

import test from "node:test";
import assert from "node:assert/strict";

import {
  WINDOWS_SAMPLE_SCRIPT,
  WINDOWS_SAMPLE_CMD,
  encodePsScript,
  parseWindowsSample,
  snapshotFromWindows,
  createWindowsSshCollector,
  createWindowsFleet,
} from "../windowsSshCollector.js";

const NODE = { id: "win1", name: "Win One", lanIp: "192.0.2.80", protocol: "ssh", platform: "windows", ssh: { user: "steve" } };

// Hand-built sample mirroring WINDOWS_SAMPLE_SCRIPT output.
// Ground truth (fixture schema per spec; WMI availability SKU-dependent):
//   UPTIME: boot 1730000000, now 1730000600000 → 600 s.
//   CPU: LoadPercentage max 37 → usage 37; temperature/draw/tdp 0.
//   MEM: 16777216 KB total → 16384 MB; 4194304 KB free → 4096 MB;
//        used 12288; pct = 100×12288/16384 = 75.0
//   DISK: C: 256060514080/1048576 → totalMB; free → availMB; used = total−avail.
//   NET: counters are rates (bytes/s) → /1048576 MB/s, round 3:
//        Ethernet 10485760 → 10; 2097152 → 2. Wi-Fi 524288 → 0.5; 104858 → 0.1.
//        isatap line skipped (belt+braces parser filter).
const HAPPY = [
  "===OS===",
  "Microsoft Windows 11 Pro | 10.0.22631",
  "===UPTIME===",
  "1730000000",
  "===CPU===",
  "37",
  "===MEM===",
  "16777216 4194304",
  "===DISK===",
  "C: 256060514080 103079239200",
  "D: 1000000000000 250000000000",
  "===NET===",
  "Ethernet 10485760 2097152",
  "Wi-Fi 524288 104858",
  "isatap.{8b1e2f3a-4b5c-6d7e-8f90-a1b2c3d4e5f6} 0 0",
  "===END===",
].join("\r\n");

const NOW = 1730000600000;

test("command shape: powershell -EncodedCommand prefix, utf16le round-trip, raw script < 2500, FULL encoded command < 8191", () => {
  const cmd = WINDOWS_SAMPLE_CMD();
  assert.ok(cmd.startsWith("powershell -NoProfile -NonInteractive -EncodedCommand "));

  // Raw ASCII budget (spec: < 2500) and ASCII-only.
  assert.ok(
    WINDOWS_SAMPLE_SCRIPT.length < 2500,
    `raw script is ${WINDOWS_SAMPLE_SCRIPT.length} chars (budget 2500)`
  );
  assert.ok(/^[\x20-\x7E\r\n]*$/.test(WINDOWS_SAMPLE_SCRIPT), "script must be ASCII-only");

  // Decode base64 (utf16le) back to the script; round-trip + sections intact.
  const b64 = cmd.slice("powershell -NoProfile -NonInteractive -EncodedCommand ".length);
  const decoded = Buffer.from(b64, "base64").toString("utf16le");
  assert.equal(decoded, WINDOWS_SAMPLE_SCRIPT);
  assert.ok(decoded.includes("===MEM==="));
  assert.ok(decoded.includes("===END==="));
  assert.equal(encodePsScript("A"), Buffer.from("A", "utf16le").toString("base64"));

  // THE cmd.exe budget assertion (spec test 1) — measured, not assumed.
  console.log(
    `[S1.6] measured encoded-command length: ${cmd.length} chars ` +
      `(raw script ${WINDOWS_SAMPLE_SCRIPT.length}, budget 8191)`
  );
  assert.ok(cmd.length < 8191, `encoded command is ${cmd.length} chars (budget 8191)`);

  // The collector must actually SEND this command.
  let seen = null;
  const collector = createWindowsSshCollector({
    node: NODE,
    exec: async (c) => {
      seen = c;
      return HAPPY;
    },
    pollIntervalMs: 60000,
  });
  collector.start();
  setTimeout(() => collector.stop(), 1000).unref(); // stop below ends the poll anyway
  return new Promise((r) => setTimeout(r, 30)).then(() => {
    collector.stop();
    assert.equal(seen, cmd);
  });
});

test("happy path: full snapshot conforms to NodeAgentSnapshot shape (every field); isatap skipped", () => {
  const parsed = parseWindowsSample(HAPPY, NOW);

  assert.equal(parsed.uptimeSeconds, 600);

  // CPU — LoadPercentage; temp/draw/tdp 0 (no portable source, capability report).
  assert.deepEqual(parsed.cpu, { usage: 37, temperature: 0, draw: 0, tdp: 0 });

  // Memory — KB → MB ints, used = total − free, pct round 1.
  assert.deepEqual(parsed.mem, {
    usedMB: 12288,
    totalMB: 16384,
    availableMB: 4096,
    percentage: 75,
  });

  // Disk — bytes/1048576 int MB; `C:` style mount kept with trailing backslash.
  assert.equal(parsed.disk.length, 2);
  const cTotal = Math.round(256060514080 / 1048576);
  const cAvail = Math.round(103079239200 / 1048576);
  assert.deepEqual(parsed.disk[0], {
    device: "C:",
    mount: "C:\\",
    usedMB: cTotal - cAvail,
    totalMB: cTotal,
    availableMB: cAvail,
    percentage: Math.round(((100 * (cTotal - cAvail)) / cTotal + Number.EPSILON) * 100) / 100,
  });
  const dTotal = Math.round(1000000000000 / 1048576);
  const dAvail = Math.round(250000000000 / 1048576);
  assert.equal(parsed.disk[1].device, "D:");
  assert.equal(parsed.disk[1].mount, "D:\\");
  assert.equal(parsed.disk[1].totalMB, dTotal);
  assert.equal(parsed.disk[1].availableMB, dAvail);

  // Net — counters ALREADY rates: bytes/s ÷ 1048576 → MB/s round 3, no prev.
  assert.deepEqual(parsed.net, [
    { iface: "Ethernet", ip: null, rxSpeed: 10, txSpeed: 2, linkSpeedMbps: null },
    { iface: "Wi-Fi", ip: null, rxSpeed: 0.5, txSpeed: 0.1, linkSpeedMbps: null },
  ]); // isatap line skipped

  // Full snapshot via snapshotFromWindows.
  const snap = snapshotFromWindows(NODE, parsed, 2000);
  assert.equal(snap.nodeId, "win1");
  assert.equal(snap.nodeName, "Win One");
  assert.equal(snap.lanIp, "192.0.2.80");
  assert.equal(snap.agentVersion, "agentless-ssh-1");
  assert.equal(snap.online, true);
  assert.equal(snap.enrollment, undefined);
  assert.equal(snap.uptimeSeconds, 600);
  assert.deepEqual(snap.cpu, parsed.cpu);
  assert.deepEqual(snap.mem, parsed.mem);
  assert.deepEqual(snap.disk, parsed.disk);
  assert.deepEqual(snap.net, parsed.net);
  assert.equal(snap.polledAt, 2000);
  // Families agentless Windows SSH collection cannot see: empty/null per types.
  assert.equal(snap.gpu, null);
  assert.deepEqual(snap.containers, []);
  assert.deepEqual(snap.versions, []);
  assert.deepEqual(snap.services, []);
  assert.equal(snap.memory, null);
  assert.equal(snap.requests, null);
  assert.equal(snap.topology, null);
  assert.equal(snap.tailscale, null);
});

test("garbled CPU + missing NET section → cpu null, net []; uptime/mem/disk still good; no throw", () => {
  const broken = [
    "===OS===",
    "===UPTIME===",
    "1730000000",
    "===CPU===",
    "garbage not a number",
    "===MEM===",
    "16777216 4194304",
    "===DISK===",
    "C: 256060514080 103079239200",
    "===END===", // no NET section at all
  ].join("\r\n");
  const parsed = parseWindowsSample(broken, NOW);
  assert.equal(parsed.cpu, null);
  assert.deepEqual(parsed.net, []);
  assert.equal(parsed.uptimeSeconds, 600);
  assert.deepEqual(parsed.mem, { usedMB: 12288, totalMB: 16384, availableMB: 4096, percentage: 75 });
  assert.equal(parsed.disk.length, 1);

  // Total garbage / empty input never throws either.
  for (const junk of ["", "total noise", "===CPU===\n", "===MEM===\nnot two numbers\n===END==="]) {
    const p = parseWindowsSample(junk, 1);
    assert.equal(p.cpu, null);
    assert.equal(p.mem, null);
    assert.equal(p.uptimeSeconds, null);
    assert.deepEqual(p.disk, []);
    assert.deepEqual(p.net, []);
  }
});

test("exec throws → online:false, onStatus fired exactly once offline; recovery poll → online transition", async () => {
  const statuses = [];
  const snapshots = [];
  let poll = 0;
  const collector = createWindowsSshCollector({
    node: NODE,
    exec: async () => {
      if (poll++ === 0) throw new Error("SSH to 192.0.2.80 failed: connection refused");
      return HAPPY;
    },
    pollIntervalMs: 15,
    now: () => 5000,
  });
  collector.onSnapshot((id, snap) => snapshots.push([id, snap]));
  collector.onStatus((id, st) => statuses.push([id, st]));

  collector.start();
  await new Promise((r) => setTimeout(r, 60));
  collector.stop();

  assert.equal(snapshots[0][1].online, false);
  assert.equal(snapshots[0][1].cpu, null);
  assert.equal(snapshots[0][1].polledAt, 5000);
  const offlineIdx = statuses.findIndex(([, st]) => st === "offline");
  const onlineIdx = statuses.findIndex(([, st]) => st === "online");
  assert.equal(offlineIdx, 0); // fired exactly once, first
  assert.ok(onlineIdx > 0, "recovery → online transition fired");
  assert.equal(statuses.filter(([, st]) => st === "offline").length, 1);
  assert.equal(statuses.filter(([, st]) => st === "online").length, 1);
  assert.equal(collector.getSnapshot("win1").online, true);
  assert.equal(collector.isOnline("win1"), true);
  assert.equal(collector.getSnapshot("someone-else"), null);
  assert.equal(collector.isOnline("someone-else"), false);
});

test("fleet filter: platform:\"windows\" only (legacy ssh + macos nodes excluded); unsubscribe removes callbacks", async () => {
  const winNode = { id: "w-a", name: "WA", lanIp: "192.0.2.90", protocol: "ssh", platform: "windows", ssh: { user: "u" } };
  const legacySshNode = { id: "l-a", name: "LA", protocol: "ssh", ssh: { user: "u" } }; // no platform
  const macNode = { id: "m-a", name: "MA", protocol: "ssh", platform: "macos", ssh: { user: "u" } };

  const fleet = createWindowsFleet({
    nodes: [winNode, legacySshNode, macNode],
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
  assert.deepEqual(Object.keys(fleet.getAllSnapshots()), ["w-a"]); // legacy + macos excluded
  assert.equal(fleet.getSnapshot("l-a"), null);
  assert.equal(fleet.getSnapshot("m-a"), null);
  assert.equal(fleet.isOnline("w-a"), true);
  assert.equal(fleet.isOnline("l-a"), false);

  fleet.stop();
  fired = 0;
  const snapBefore = fleet.getSnapshot("w-a");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fired, 0);
  assert.equal(fleet.getSnapshot("w-a"), snapBefore);
});

test("fleet survives a misconfigured windows record (transportFactory throws) → node offline, not fleet down", async () => {
  const good = { id: "good-w", name: "G", lanIp: "192.0.2.91", protocol: "ssh", platform: "windows", ssh: { user: "u" } };
  const bad = { id: "bad-w", name: "B", protocol: "ssh", platform: "windows", ssh: {} };
  const fleet = createWindowsFleet({
    nodes: [good, bad],
    transportFactory: (node) => {
      if (node.id === "bad-w") throw new Error("node bad-w: protocol \"ssh\" without ssh.user");
      return { exec: async () => HAPPY };
    },
    pollIntervalMs: 60000,
  });
  fleet.start();
  await new Promise((r) => setTimeout(r, 30));
  fleet.stop();
  assert.equal(fleet.isOnline("good-w"), true);
  assert.equal(fleet.getSnapshot("bad-w").online, false);
});

test("lanIp falls back to ssh.host; idempotent start/stop", async () => {
  const node = { id: "w2", name: "W2", protocol: "ssh", platform: "windows", ssh: { user: "u", host: "10.0.0.9" } };
  const snap = snapshotFromWindows(node, parseWindowsSample("===END===", 1), 1);
  assert.equal(snap.lanIp, "10.0.0.9");
  assert.equal(snap.online, true);

  const collector = createWindowsSshCollector({ node, exec: async () => HAPPY, pollIntervalMs: 10 });
  collector.start();
  await new Promise((r) => setTimeout(r, 30));
  collector.stop();
  collector.stop(); // idempotent
  collector.start();
  collector.start(); // idempotent
  collector.stop();
});
