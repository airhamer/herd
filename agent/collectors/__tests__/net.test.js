import test from "node:test";
import assert from "node:assert/strict";
import { collectNet, resetNetBaseline } from "../net.js";

const NET_DEV = [
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
  "    lo: 1234567      10    0    0    0     0          0         0  1234567      10    0    0    0     0          0         0",
  "  eth0: 104857600    5000    0    0    0     0          0         0  52428800    4000    0    0    0     0          0         0",
  "docker0: 1000        50    0    0    0     0          0         0    1000        50    0    0    0     0          0         0",
].join("\n");

const IP_OUT = [
  "1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 state UNKNOWN",
  "    inet 127.0.0.1/8 scope host lo",
  "2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP",
  "    inet 192.168.50.150/24 brd 192.168.50.255 scope global eth0",
].join("\n");

const readFile = async (p) => {
  if (p === "/proc/net/dev") return NET_DEV;
  if (p === "/sys/class/net/eth0/speed") return "25000\n";
  throw new Error(`ENOENT: ${p}`);
};

/**
 * Stateful /proc/net/dev mock: counters advance between reads so the delta
 * is measurable. Read 1: zero; read 2: eth0 rx=104857600 B, tx=52428800 B.
 */
function makeNetDevReader() {
  let reads = 0;
  const readFile = async (p) => {
    if (p === "/proc/net/dev") {
      reads += 1;
      const rx = reads === 1 ? 0 : 104857600;
      const tx = reads === 1 ? 0 : 52428800;
      return [
        "Inter-|   Receive                                                |  Transmit",
        " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
        "    lo: 1234567      10    0    0    0     0          0         0  1234567      10    0    0    0     0          0         0",
        `  eth0: ${rx}    5000    0    0    0     0          0         0  ${tx}    4000    0    0    0     0          0         0`,
        "docker0: 1000        50    0    0    0     0          0         0    1000        50    0    0    0     0          0         0",
      ].join("\n");
    }
    if (p === "/sys/class/net/eth0/speed") return "25000\n";
    throw new Error(`ENOENT: ${p}`);
  };
  return readFile;
}

test("net: excludes virtual ifaces; first call → 0 speeds; second → delta MB/s (ground truth)", async () => {
  resetNetBaseline();
  const exec = async () => IP_OUT;
  const readFile = makeNetDevReader();
  const first = await collectNet({ exec, readFile, now: () => 0 });
  assert.equal(first.length, 1); // lo + docker0 excluded
  assert.equal(first[0].iface, "eth0");
  assert.equal(first[0].rxSpeed, 0);
  assert.equal(first[0].txSpeed, 0);

  const second = await collectNet({ exec, readFile, now: () => 10_000 });
  assert.deepEqual(second, [
    {
      iface: "eth0",
      ip: "192.168.50.150",
      rxSpeed: 10, // 104857600 B / 10 s = 10 MB/s
      txSpeed: 5, // 52428800 B / 10 s = 5 MB/s
      linkSpeedMbps: 25000,
      wireless: null,
      mac: null,
    },
  ]);
});

test("net: missing ip tool → ip null, speeds still computed", async () => {
  resetNetBaseline();
  const exec = async () => {
    throw new Error("ip: not found");
  };
  const readFile = makeNetDevReader();
  await collectNet({ exec, readFile, now: () => 0 });
  const second = await collectNet({ exec, readFile, now: () => 10_000 });
  assert.equal(second[0].ip, null);
  assert.equal(second[0].rxSpeed, 10);
});

test("net: link speed unknown → null", async () => {
  resetNetBaseline();
  const readFileNoSpeed = async (p) => {
    if (p === "/proc/net/dev") return NET_DEV;
    throw new Error(`ENOENT: ${p}`);
  };
  const out = await collectNet({ exec: async () => IP_OUT, readFile: readFileNoSpeed });
  assert.equal(out[0].linkSpeedMbps, null);
});

test("net: returns [] when /proc/net/dev is unreadable", async () => {
  const readFileDeny = async () => {
    throw new Error("deny");
  };
  assert.deepEqual(await collectNet({ exec: async () => IP_OUT, readFile: readFileDeny }), []);
});

// ── Real-world fixture from Narthex `ip addr` (owner-provided) ────────────

const NARTHEX_JSON = JSON.stringify([
  { ifname: "lo", operstate: "UNKNOWN", addr_info: [{ family: "inet", local: "127.0.0.1" }] },
  { ifname: "enp16s0", operstate: "UP", addr_info: [] },
  { ifname: "wlp17s0", operstate: "DOWN", addr_info: [] },
  { ifname: "br0", operstate: "UP", addr_info: [{ family: "inet", local: "192.168.50.150" }] },
  { ifname: "virbr0", operstate: "DOWN", addr_info: [{ family: "inet", local: "192.168.122.1" }] },
  { ifname: "tailscale0", operstate: "UNKNOWN", addr_info: [{ family: "inet", local: "100.122.55.39" }] },
  { ifname: "docker0", operstate: "UP", addr_info: [{ family: "inet", local: "172.17.0.1" }] },
  { ifname: "br-8625be1db2e5", operstate: "DOWN", addr_info: [{ family: "inet", local: "172.21.0.1" }] },
]);

const NARTHEX_NET_DEV = [
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
  "    lo: 1      10    0    0    0     0          0         0  1      10    0    0    0     0          0         0",
  "enp16s0: 2000000    5000    0    0    0     0          0         0  1000000    4000    0    0    0     0          0         0",
  "wlp17s0: 5        1    0    0    0     0          0         0  5        1    0    0    0     0          0         0",
  "   br0: 2000000    5000    0    0    0     0          0         0  1000000    4000    0    0    0     0          0         0",
  "virbr0: 0        0    0    0    0     0          0         0  0        0    0    0    0     0          0         0",
  "tailscale0: 900    90    0    0    0     0          0         0  900      90    0    0    0     0          0         0",
  "docker0: 1000       50    0    0    0     0          0         0  1000       50    0    0    0     0          0         0",
].join("\n");

const narthexReadFile = async (p) => {
  if (p === "/proc/net/dev") return NARTHEX_NET_DEV;
  if (p === "/sys/class/net/enp16s0/speed") return "5000\n";
  if (p === "/sys/class/net/enp16s0/address") return "fc:9d:05:02:36:7c\n";
  if (p === "/sys/class/net/br0/address") return "3a:6e:3e:a7:8b:f4\n";
  throw new Error(`ENOENT: ${p}`);
};

// ── Container path: host `ip` binary is glibc-incompatible (node:18-slim),
// but /proc/net/fib_trie, /proc/net/route and sysfs are all readable. ───

const FIB_TRIE_LOCAL = [
  "Main:",
  "  +-- 0.0.0.0/0 3 0 5",
  "     |-- 0.0.0.0",
  "        /0 universe UNICAST",
  "     +-- 100.64.0.0/10 2 0 2",
  "        |-- 100.122.55.39",
  "           /32 host LOCAL",
  "     +-- 172.17.0.0/16 2 0 2",
  "        |-- 172.17.0.1",
  "           /32 host LOCAL",
  "     +-- 192.168.50.128/25 2 0 2",
  "        |-- 192.168.50.150",
  "           /32 host LOCAL",
  "     +-- 198.51.100.0/24 2 0 2",
  "        |-- 198.51.100.7",
  "           /32 universe UNICAST",  // a route to another host — not ours
].join("\n");

const PROC_ROUTE_NARTHEX = [
  "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
  "br0\t00000000\t0132A8C0\t0003\t0\t0\t425\t00000000\t0\t0\t0",
  "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
  "br0\t0032A8C0\t00000000\t0001\t0\t0\t425\t00FFFFFF\t0\t0\t0",
].join("\n");

const NET_DEV_BRIDGE = [
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
  "    lo: 1234567      10    0    0    0     0          0         0  1234567      10    0    0    0     0          0         0",
  "enp16s0: 2000000    5000    0    0    0     0          0         0  1000000    4000    0    0    0     0          0         0",
  "   br0: 2000000    5000    0    0    0     0          0         0  1000000    4000    0    0    0     0          0         0",
  "tailscale0: 900    90    0    0    0     0          0         0  900      90    0    0    0     0          0         0",
].join("\n");

test("net: broken ip tool → /proc fallback puts LAN IP on the bridge, tailnet on tailscale0", async () => {
  resetNetBaseline();
  const exec = async (cmd) => {
    if (String(cmd).includes("tailscale status")) {
      return JSON.stringify({ Self: { IPAddress: "100.122.55.39" } });
    }
    throw new Error("ip: symbol lookup error"); // host binary unusable in slim image
  };
  const readFile = async (p) => {
    if (p === "/proc/net/dev") return NET_DEV_BRIDGE;
    if (p === "/proc/net/fib_trie") return FIB_TRIE_LOCAL;
    if (p === "/proc/net/route") return PROC_ROUTE_NARTHEX;
    if (p === "/sys/class/net/lo/operstate") return "unknown\n";
    if (p === "/sys/class/net/br0/operstate") return "up\n";
    if (p === "/sys/class/net/br0/brif") return "enp16s0\n";
    if (p === "/sys/class/net/enp16s0/operstate") return "up\n";
    if (p === "/sys/class/net/enp16s0/speed") return "5000\n";
    if (p === "/sys/class/net/tailscale0/operstate") return "unknown\n";
    throw new Error(`ENOENT: ${p}`);
  };
  const rows = await collectNet({ exec, readFile, now: () => 0 });
  const br0 = rows.find(r => r.iface === "br0");
  // the (host) bridge row carries the LAN address from fib_trie LOCAL labels;
  // its slave honestly shows none — same shape as the Narthex ip-tool path
  assert.equal(br0.ip, "192.168.50.150");
  const slave = rows.find(r => r.iface === "enp16s0");
  assert.equal(slave.ip, null);
  // tailnet address surfaces on tailscale0
  const ts = rows.find(r => r.iface === "tailscale0");
  assert.equal(ts.ip, "100.122.55.39");
  // UNICAST route (not ours) never claimed
  assert.equal(rows.every(r => r.ip !== "198.51.100.7"), true);
});

test("net: Narthex real-world — br0 keeps the LAN IP, tailscale0 surfaces, disconnected wifi + docker noise dropped", async () => {
  resetNetBaseline();
  const exec = async () => NARTHEX_JSON;
  const rows = await collectNet({ exec, readFile: narthexReadFile, now: () => 0 });
  const byIface = Object.fromEntries(rows.map((r) => [r.iface, r]));
  // bridge carries the real IP; its slave enp16s0 honestly shows no IP
  assert.equal(byIface.br0.ip, "192.168.50.150");
  assert.equal(byIface.enp16s0.ip, null);
  assert.equal(byIface.enp16s0.mac, "fc:9d:05:02:36:7c");
  assert.equal(byIface.enp16s0.linkSpeedMbps, 5000); // wired stays despite no IP
  // tailnet IP visible without the Tailscale CLI
  assert.equal(byIface.tailscale0.ip, "100.122.55.39");
  // disconnected wifi and all docker/vm plumbing are gone
  assert.equal(rows.some((r) => r.iface === "wlp17s0"), false);
  assert.equal(rows.some((r) => r.iface.startsWith("docker") || r.iface.startsWith("br-")), false);
  assert.equal(byIface.virbr0, undefined);
});
