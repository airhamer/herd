// RoCE sampler, parsers and health rules (docs/specs/roce.md). All inputs
// below are synthetic: they are built by the helpers in this file.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ETH_LOSS_COUNTERS,
  FAST_INTERVAL_MS,
  LOSS_COUNTERS,
  NO_RDMA_RECHECK_MS,
  RETRY_AFTER_FAILURE_MS,
  ROCE_FAST_SCRIPT,
  RoceSampler,
  SLOW_INTERVAL_MS,
  STALE_AFTER_FAILURES,
  parseMlnxQos,
  parseRoceFast,
  parseRoceSlow,
  roceSlowScript,
} from "../roce.js";
import { HealthEvaluator } from "../../health/HealthEvaluator.js";

// ─── Synthetic unit ───────────────────────────────────────

/** Fast-script output for a list of ports. */
function fastOutput(ports) {
  const out = [];
  for (const p of ports) {
    out.push(`=dev ${p.dev}`);
    out.push(`state=${p.up === false ? "1: DOWN" : "4: ACTIVE"}`);
    out.push(`phys_state=${p.up === false ? "3: Disabled" : "5: LinkUp"}`);
    out.push("rate=100 Gb/sec (4X EDR)", "link_layer=Ethernet");
    for (const [k, v] of Object.entries(p.hw ?? {})) out.push(`hw:${k}=${v}`);
    if (!p.ifname) continue;
    out.push(`if=${p.ifname}`, "net:operstate=up", "net:mtu=4200", `net:speed=${p.speed ?? 100000}`);
    out.push(`net:rx_bytes=${p.rx ?? 0}`, `net:tx_bytes=${p.tx ?? 0}`);
    out.push("net:rx_errors=1", "net:tx_errors=2", "net:rx_dropped=3", "net:tx_dropped=4");
  }
  return out.join("\n") + "\n";
}

const QOS_TEXT = [
  "DCBX mode: OS controlled",
  "Priority trust state: DSCP",
  "dscp2prio mapping:",
  "\tprio:0 dscp:07,06,05,04,03,02,01,00,",
  "\tprio:4 dscp:39,38,37,36,35,34,33,32,",
  "Cable len: 3",
  "PFC configuration:",
  "\tpriority    0   1   2   3   4   5   6   7",
  "\tenabled     0   0   0   0   1   0   1   0",
  "\tbuffer      0   0   0   0   1   0   1   0",
].join("\n");

/** Slow-script output for interfaces mapped to their ethtool counters. */
function slowOutput(byIf) {
  const out = [];
  for (const [name, eth] of Object.entries(byIf)) {
    out.push(`=if ${name}`);
    for (const [k, v] of Object.entries(eth)) out.push(`     ${k}: ${v}`);
    out.push("pause Pause parameters for x: Autonegotiate: off RX: on TX: off ", "=qos", QOS_TEXT, "=end");
  }
  return out.join("\n") + "\n";
}

/** A sampler on a manual clock whose unit answers from `unit.fast` / `unit.slow`. */
function rig(unit) {
  const clock = { at: 1_000_000 };
  const calls = { fast: 0, slow: 0 };
  const sampler = new RoceSampler({
    now: () => clock.at,
    run: async (script) => {
      const kind = script === ROCE_FAST_SCRIPT ? "fast" : "slow";
      calls[kind]++;
      const answer = unit[kind];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer() : answer;
    },
  });
  return { clock, calls, sampler, tick: (ms = FAST_INTERVAL_MS) => (clock.at += ms) };
}

// ─── Parsers and scripts ──────────────────────────────────

test("parseRoceFast builds devices and netdev statistics", () => {
  const { devices, netdevs } = parseRoceFast(
    fastOutput([{ dev: "mlx5_0", ifname: "ens1", hw: { out_of_buffer: 9 }, rx: 100, tx: 200 }]),
  );
  assert.deepEqual(devices, [
    {
      name: "mlx5_0",
      state: "ACTIVE",
      physState: "LinkUp",
      rateGbps: 100,
      linkLayer: "Ethernet",
      netdev: "ens1",
      counters: { out_of_buffer: 9 },
    },
  ]);
  assert.deepEqual(netdevs.get("ens1"), {
    name: "ens1",
    operstate: "up",
    mtu: 4200,
    speedMbps: 100000,
    rxBytes: 100,
    txBytes: 200,
    rxErrors: 1,
    txErrors: 2,
    rxDropped: 3,
    txDropped: 4,
  });
  const unknownSpeed = parseRoceFast(fastOutput([{ dev: "d", ifname: "e", speed: -1 }]));
  assert.equal(unknownSpeed.netdevs.get("e").speedMbps, null);
});

test("parsers shrug off noise", () => {
  for (const junk of ["", null, "x|y|z\n=dev\nhw:=1", "state=ACTIVE"]) {
    const { devices, netdevs } = parseRoceFast(junk);
    assert.equal(devices.length, 0);
    assert.equal(netdevs.size, 0);
    assert.equal(parseRoceSlow(junk).size, 0);
  }
  const { devices } = parseRoceFast("=dev a\nhw:x=abc\nif=bad name\nnet:mtu=1");
  assert.deepEqual(devices[0].counters, {});
  assert.equal(devices[0].netdev, null);
});

test("parseMlnxQos reads trust, PFC, cable length and the DSCP map", () => {
  assert.deepEqual(parseMlnxQos(QOS_TEXT), {
    trust: "dscp",
    pfcPriorities: [4, 6],
    cableLen: 3,
    dscpMap: { 0: [7, 6, 5, 4, 3, 2, 1, 0], 4: [39, 38, 37, 36, 35, 34, 33, 32] },
  });
  const off = parseMlnxQos("Priority trust state: pcp\nPFC configuration:\n priority 0 1\n enabled 0 0\n");
  assert.deepEqual(off.pfcPriorities, []);
  assert.deepEqual(parseMlnxQos("mlnx_qos: command not found"), {
    trust: null,
    pfcPriorities: null,
    cableLen: null,
    dscpMap: null,
  });
});

test("parseRoceSlow splits facts per interface", () => {
  const facts = parseRoceSlow(slowOutput({ ens1: { rx_discards_phy: 5, tx_pause_ctrl_phy: 2 }, ens2: {} }));
  assert.deepEqual([...facts.keys()], ["ens1", "ens2"]);
  const one = facts.get("ens1");
  assert.deepEqual(one.eth, { rx_discards_phy: 5, tx_pause_ctrl_phy: 2 });
  assert.deepEqual(one.flowControl, { rx: true, tx: false });
  assert.equal(one.qos.trust, "dscp");
  assert.deepEqual(facts.get("ens2").eth, {});
});

test("scripts only read, and interface names are vetted before use", () => {
  for (const banned of [/\bsudo\b/, /\brm\b/, /\bwrite\b/, /\becho [^"]*>/]) {
    assert.doesNotMatch(ROCE_FAST_SCRIPT, banned);
  }
  assert.equal(roceSlowScript([]), null);
  assert.equal(roceSlowScript(["$(reboot)", "a b", "x".repeat(16)]), null);
  const script = roceSlowScript(["ens1", "ens1", "bond0.10", "evil;rm"]);
  assert.match(script, /for n in ens1 bond0\.10; do/);
  assert.doesNotMatch(script, /evil/);
  assert.ok(LOSS_COUNTERS.includes("out_of_buffer") && ETH_LOSS_COUNTERS.includes("rx_crc_errors_phy"));
});

// ─── Sampler ──────────────────────────────────────────────

test("rates and deltas come from consecutive reads", async () => {
  const unit = { slow: slowOutput({ ens1: {} }) };
  const { sampler, tick } = rig(unit);
  unit.fast = fastOutput([{ dev: "mlx5_0", ifname: "ens1", hw: { np_cnp_sent: 10 }, rx: 1000, tx: 0 }]);
  const first = await sampler.sample();
  assert.equal(first.available, true);
  assert.equal(first.devices[0].rxBps, null);
  assert.deepEqual(first.devices[0].deltas, {});
  assert.equal(first.devices[0].qos.trust, "dscp");

  tick(5_000);
  unit.fast = fastOutput([{ dev: "mlx5_0", ifname: "ens1", hw: { np_cnp_sent: 15 }, rx: 6000, tx: 0 }]);
  const [dev] = (await sampler.sample()).devices;
  assert.equal(dev.rxBps, 1000);
  assert.equal(dev.txBps, 0);
  assert.deepEqual(dev.deltas, { np_cnp_sent: 5 });
  assert.deepEqual(dev.loss, { rising: [], streak: 0, ethStreak: 0 });
});

test("reads are throttled to the fast interval and the slow facts to theirs", async () => {
  const unit = { fast: fastOutput([{ dev: "d", ifname: "e" }]), slow: slowOutput({ e: {} }) };
  const { sampler, calls, tick } = rig(unit);
  const a = await sampler.sample();
  tick(FAST_INTERVAL_MS - 1);
  assert.equal(await sampler.sample(), a);
  tick(1);
  assert.notEqual(await sampler.sample(), a);
  assert.deepEqual(calls, { fast: 2, slow: 1 });
  tick(SLOW_INTERVAL_MS);
  await sampler.sample();
  assert.deepEqual(calls, { fast: 3, slow: 2 });
});

test("no RDMA hardware: null, then quiet for ten minutes", async () => {
  const unit = { fast: "" };
  const { sampler, calls, tick } = rig(unit);
  assert.equal(await sampler.sample(), null);
  tick(NO_RDMA_RECHECK_MS - 1);
  assert.equal(await sampler.sample(), null);
  assert.equal(calls.fast, 1);
  tick(1);
  await sampler.sample();
  assert.equal(calls.fast, 2);
});

test("the RDMA loss streak counts consecutive reads with a rising loss counter", async () => {
  let drops = 0;
  const unit = { slow: "", fast: () => fastOutput([{ dev: "d", ifname: "e", hw: { packet_seq_err: drops } }]) };
  const { sampler, tick } = rig(unit);
  await sampler.sample();
  const streaks = [];
  for (const rise of [1, 1, 1, 0, 1]) {
    drops += rise;
    tick();
    const [dev] = (await sampler.sample()).devices;
    streaks.push([dev.loss.streak, dev.loss.rising.join()]);
  }
  assert.deepEqual(streaks, [
    [1, "packet_seq_err"],
    [2, "packet_seq_err"],
    [3, "packet_seq_err"],
    [0, ""],
    [1, "packet_seq_err"],
  ]);
});

test("port discards: one rise lasts one slow period; two in a row raise the finding", async () => {
  let discards = 0;
  const unit = {
    fast: fastOutput([{ dev: "d", ifname: "e" }]),
    slow: () => slowOutput({ e: { rx_discards_phy: discards } }),
  };
  const { sampler, tick } = rig(unit);
  const health = new HealthEvaluator();
  await sampler.sample();
  discards = 1;
  tick(SLOW_INTERVAL_MS);
  let roce = await sampler.sample();
  assert.deepEqual(roce.devices[0].loss, { rising: ["port discards"], streak: 0, ethStreak: 1 });
  // Fast reads inside the slow period keep the flag but never grow the streak.
  for (let i = 0; i < 5; i++) {
    tick();
    roce = await sampler.sample();
  }
  assert.equal(roce.devices[0].loss.ethStreak, 1);
  assert.deepEqual(health.evaluate({ roce }).map((f) => f.id), []);
  discards = 2;
  tick(SLOW_INTERVAL_MS);
  roce = await sampler.sample();
  assert.equal(roce.devices[0].loss.ethStreak, 2);
  assert.deepEqual(health.evaluate({ roce }).map((f) => f.id), ["roce-loss"]);
  tick(SLOW_INTERVAL_MS);
  roce = await sampler.sample();
  assert.deepEqual(roce.devices[0].loss.rising, []);
});

test("failures keep the last good sample, then drop it", async () => {
  const unit = { fast: fastOutput([{ dev: "d", ifname: "e" }]), slow: "" };
  const { sampler, calls, tick } = rig(unit);
  const good = await sampler.sample();

  unit.fast = ""; // the devices vanished
  for (let i = 1; i < STALE_AFTER_FAILURES; i++) {
    tick(RETRY_AFTER_FAILURE_MS);
    assert.equal(await sampler.sample(), good, `empty read ${i}`);
  }
  tick(1_000);
  assert.equal(await sampler.sample(), good, "waiting out the retry delay");
  assert.equal(calls.fast, STALE_AFTER_FAILURES);
  tick(RETRY_AFTER_FAILURE_MS);
  assert.equal(await sampler.sample(), null, "stale");

  unit.fast = fastOutput([{ dev: "d", ifname: "e" }]);
  tick(RETRY_AFTER_FAILURE_MS);
  assert.ok(await sampler.sample(), "recovers");

  unit.fast = new Error("ssh timed out");
  for (let i = 1; i < STALE_AFTER_FAILURES; i++) {
    tick(RETRY_AFTER_FAILURE_MS);
    assert.ok(await sampler.sample());
  }
  tick(RETRY_AFTER_FAILURE_MS);
  await assert.rejects(sampler.sample(), /ssh timed out/);
  tick(1_000);
  assert.equal(await sampler.sample(), null);
});

test("concurrent sample() calls share one read", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const unit = { slow: "", fast: () => gate.then(() => fastOutput([{ dev: "d" }])) };
  const { sampler, calls } = rig(unit);
  const both = Promise.all([sampler.sample(), sampler.sample()]);
  release();
  const [a, b] = await both;
  assert.equal(a, b);
  assert.equal(calls.fast, 1);
});

test("devices are ordered by interface name whatever the read order", async () => {
  const unit = {
    slow: "",
    fast: fastOutput([
      { dev: "mlx5_3", ifname: "ens9" },
      { dev: "mlx5_1" },
      { dev: "mlx5_0", ifname: "ens1" },
    ]),
  };
  const { sampler } = rig(unit);
  const { devices } = await sampler.sample();
  assert.deepEqual(
    devices.map((d) => d.netdev ?? d.name),
    ["ens1", "ens9", "mlx5_1"],
  );
});

// ─── Health ───────────────────────────────────────────────

const port = (over) => ({
  name: "mlx5_0",
  netdev: "ens1",
  state: "ACTIVE",
  physState: "LinkUp",
  active: true,
  everActive: true,
  loss: { rising: [], streak: 0, ethStreak: 0 },
  ...over,
});

test("health: a port that was up and went down is critical; never-up ports are ignored", () => {
  const health = new HealthEvaluator();
  const findings = health.evaluate({
    roce: {
      devices: [
        port({ state: "DOWN", physState: "Polling", active: false }),
        port({ name: "mlx5_1", netdev: null, state: null, physState: null, active: false }),
        port({ name: "mlx5_2", netdev: "ens3", state: "DOWN", active: false, everActive: false }),
      ],
    },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "roce-link");
  assert.equal(findings[0].severity, "critical");
  assert.equal(findings[0].title, "2 RoCE links went down");
  assert.equal(findings[0].detail, "ens1: DOWN (Polling), mlx5_1: unknown.");
  const single = health.evaluate({ roce: { devices: [port({ active: false, state: "DOWN", physState: null })] } });
  assert.equal(single[0].title, "A RoCE link went down");
  assert.equal(single[0].detail, "ens1: DOWN.");
});

test("health: loss needs three rising reads (or two rising port samples) on an up port", () => {
  const health = new HealthEvaluator();
  const ids = (devices) => health.evaluate({ roce: { devices } }).map((f) => f.id);
  assert.deepEqual(ids([port({ loss: { rising: ["out_of_buffer"], streak: 2, ethStreak: 1 } })]), []);
  const findings = health.evaluate({
    roce: {
      devices: [
        port({ loss: { rising: ["out_of_buffer"], streak: 3, ethStreak: 0 } }),
        port({ netdev: "ens2", loss: { rising: [], streak: 0, ethStreak: 2 } }),
        port({ netdev: "ens3", active: false, everActive: false, loss: { rising: ["x"], streak: 9, ethStreak: 9 } }),
      ],
    },
  });
  assert.deepEqual(findings.map((f) => [f.id, f.severity]), [["roce-loss", "warn"]]);
  assert.equal(findings[0].title, "RoCE is dropping packets");
  assert.equal(findings[0].detail, "ens1: out_of_buffer; ens2: counters rising.");
  assert.deepEqual(ids(null), []);
});
