/**
 * RoCE / RDMA port health for a unit, read without root or switch access
 * (docs/specs/roce.md). Two read-only sh scripts produce a small private
 * line protocol which the parsers below turn into objects:
 *
 *   fast  (every ~4.5 s)  "=dev <rdma>", "<file>=<value>", "if=<netdev>",
 *                         "hw:<counter>=<n>", "net:<stat>=<value>"
 *   slow  (every ~30 s)   "=if <netdev>", ethtool -S lines, "pause ...",
 *                         "=qos" … mlnx_qos output … "=end"
 *
 * LIC2 clean-room rewrite: written from the spec, not from upstream code.
 */

// `read -r` is a shell builtin, so the fast script forks almost nothing
// however many hw_counters a device exposes.
export const ROCE_FAST_SCRIPT = `\
for dev in /sys/class/infiniband/*; do
  [ -d "$dev" ] || continue
  echo "=dev \${dev##*/}"
  port="$dev/ports/1"
  for f in state phys_state rate link_layer; do
    v=""; { read -r v || [ -n "$v" ]; } 2>/dev/null < "$port/$f" && echo "$f=$v"
  done
  for c in "$port"/hw_counters/*; do
    v=""; { read -r v || [ -n "$v" ]; } 2>/dev/null < "$c" && echo "hw:\${c##*/}=$v"
  done
  nd=""
  for x in "$dev"/device/net/*; do
    [ -e "$x" ] && { nd="\${x##*/}"; break; }
  done
  [ -n "$nd" ] || continue
  echo "if=$nd"
  sys="/sys/class/net/$nd"
  for f in operstate mtu speed; do
    v=""; { read -r v || [ -n "$v" ]; } 2>/dev/null < "$sys/$f" && echo "net:$f=$v"
  done
  for f in rx_bytes tx_bytes rx_errors tx_errors rx_dropped tx_dropped; do
    v=""; { read -r v || [ -n "$v" ]; } 2>/dev/null < "$sys/statistics/$f" && echo "net:$f=$v"
  done
done`;

const IFNAME = /^[A-Za-z0-9._-]{1,15}$/;

const ETHTOOL_PICK =
  "^[[:space:]]+((rx|tx)_(discards_phy|pause_ctrl_phy|prio[0-7]_pause)|rx_(crc_errors_phy|symbol_err_phy|prio[0-7]_discards|out_of_buffer)):";

/** The slow script for these interfaces, or null when none has a safe name. */
export function roceSlowScript(netdevs) {
  const safe = Array.from(new Set(netdevs ?? [])).filter((name) => typeof name === "string" && IFNAME.test(name));
  if (!safe.length) return null;
  return `\
for n in ${safe.join(" ")}; do
  echo "=if $n"
  ethtool -S "$n" 2>/dev/null | grep -E '${ETHTOOL_PICK}'
  echo "pause $(ethtool -a "$n" 2>/dev/null | tr '\\n' ' ')"
  echo "=qos"
  mlnx_qos -i "$n" 2>/dev/null | head -n 80
  echo "=end"
done`;
}

/** hw_counters whose growth means lost packets or failed RDMA operations. */
export const LOSS_COUNTERS = [
  "out_of_buffer",
  "packet_seq_err",
  "local_ack_timeout_err",
  "rnr_nak_retry_err",
  "implied_nak_seq_err",
  "req_transport_retries_exceeded",
  "rx_icrc_encapsulated",
];

/** ethtool -S counters that count frames the port dropped or found corrupt. */
export const ETH_LOSS_COUNTERS = ["rx_discards_phy", "tx_discards_phy", "rx_crc_errors_phy", "rx_out_of_buffer"];

export const FAST_INTERVAL_MS = 4_500;
export const SLOW_INTERVAL_MS = 30_000;
export const NO_RDMA_RECHECK_MS = 600_000;
export const LOSS_STREAK_FOR_FINDING = 3;
export const ETH_LOSS_STREAK_FOR_FINDING = 2;
export const STALE_AFTER_FAILURES = 4;
export const RETRY_AFTER_FAILURE_MS = 15_000;

function intOrNull(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!/^-?\d+/.test(s)) return null;
  return Number.parseInt(s, 10);
}

/** Drops a sysfs state's numeric prefix: "4: ACTIVE" → "ACTIVE". */
function stateWord(text) {
  if (text == null) return null;
  const word = String(text).trim().replace(/^\d+:\s*/, "");
  return word === "" ? null : word;
}

/** "200 Gb/sec (2X NDR)" → 200. */
function gbps(text) {
  const hit = /(\d+(?:\.\d+)?)\s*Gb\/sec/i.exec(String(text ?? ""));
  return hit ? Number(hit[1]) : null;
}

function lines(text) {
  return String(text ?? "").split(/\r?\n/);
}

/** Splits "key=value" at the first "=". */
function keyValue(line) {
  const at = line.indexOf("=");
  return at > 0 ? [line.slice(0, at), line.slice(at + 1)] : null;
}

/** Parses the fast script's output. */
export function parseRoceFast(text) {
  const devices = [];
  const netdevs = new Map();
  let dev = null;
  let net = null;
  for (const raw of lines(text)) {
    const line = raw.trim();
    if (line.startsWith("=dev ")) {
      const name = line.slice(5).trim();
      if (!name) {
        dev = null;
        continue;
      }
      dev = { name, state: null, physState: null, rateGbps: null, linkLayer: null, netdev: null, counters: {} };
      devices.push(dev);
      net = null;
      continue;
    }
    if (!dev) continue;
    const kv = keyValue(line);
    if (!kv) continue;
    const [key, value] = kv;
    if (key === "state") dev.state = stateWord(value);
    else if (key === "phys_state") dev.physState = stateWord(value);
    else if (key === "rate") dev.rateGbps = gbps(value);
    else if (key === "link_layer") dev.linkLayer = value.trim() || null;
    else if (key === "if" && IFNAME.test(value.trim())) {
      dev.netdev = value.trim();
      net = netdevs.get(dev.netdev) ?? {
        name: dev.netdev,
        operstate: null,
        mtu: null,
        speedMbps: null,
        rxBytes: null,
        txBytes: null,
        rxErrors: null,
        txErrors: null,
        rxDropped: null,
        txDropped: null,
      };
      netdevs.set(dev.netdev, net);
    } else if (key.startsWith("hw:")) {
      const count = intOrNull(value);
      if (count != null && key.length > 3) dev.counters[key.slice(3)] = count;
    } else if (key.startsWith("net:") && net) {
      applyNetStat(net, key.slice(4), value);
    }
  }
  return { devices, netdevs };
}

const NET_STAT_FIELDS = {
  rx_bytes: "rxBytes",
  tx_bytes: "txBytes",
  rx_errors: "rxErrors",
  tx_errors: "txErrors",
  rx_dropped: "rxDropped",
  tx_dropped: "txDropped",
  mtu: "mtu",
};

function applyNetStat(net, stat, value) {
  if (stat === "operstate") net.operstate = value.trim() || null;
  else if (stat === "speed") {
    const mbps = intOrNull(value);
    net.speedMbps = mbps != null && mbps > 0 ? mbps : null;
  } else if (NET_STAT_FIELDS[stat]) net[NET_STAT_FIELDS[stat]] = intOrNull(value);
}

/** Reads trust mode, PFC priorities, cable length and the DSCP map from `mlnx_qos -i`. */
export function parseMlnxQos(text) {
  const qos = { trust: null, pfcPriorities: null, cableLen: null, dscpMap: null };
  const rows = lines(text);
  let pfcFrom = -1;
  rows.forEach((line, i) => {
    const trust = /trust state:\s*(\S+)/i.exec(line);
    if (trust) qos.trust = trust[1].toLowerCase();
    const cable = /cable len:\s*(\d+)/i.exec(line);
    if (cable) qos.cableLen = Number(cable[1]);
    if (/^\s*PFC configuration/i.test(line)) pfcFrom = i;
    if (pfcFrom >= 0 && i > pfcFrom && i <= pfcFrom + 3 && qos.pfcPriorities == null) {
      const cells = line.trim().split(/\s+/);
      if (cells[0]?.toLowerCase() === "enabled" && cells.length > 1 && cells.slice(1).every((c) => c === "0" || c === "1")) {
        qos.pfcPriorities = cells.slice(1).flatMap((flag, prio) => (flag === "1" ? [prio] : []));
      }
    }
    const map = /prio:(\d+)\s+dscp:([\d,]+)/i.exec(line);
    if (map) {
      qos.dscpMap ??= {};
      qos.dscpMap[map[1]] = map[2].split(",").filter((v) => v !== "").map(Number);
    }
  });
  return qos;
}

/** "Autonegotiate: off RX: on TX: off" → { rx: true, tx: false }. */
function pauseFlags(text) {
  const flag = (dir) => {
    const hit = new RegExp(`\\b${dir}:\\s*(on|off)\\b`, "i").exec(text);
    return hit ? hit[1].toLowerCase() === "on" : null;
  };
  return { rx: flag("RX"), tx: flag("TX") };
}

/** Parses the slow script's output into per-interface facts. */
export function parseRoceSlow(text) {
  const byIf = new Map();
  let entry = null;
  let qosLines = null;
  for (const raw of lines(text)) {
    if (raw.startsWith("=if ")) {
      entry = { eth: {}, flowControl: { rx: null, tx: null }, qos: parseMlnxQos("") };
      byIf.set(raw.slice(4).trim(), entry);
      qosLines = null;
      continue;
    }
    if (!entry) continue;
    if (qosLines) {
      if (raw.trim() === "=end") {
        entry.qos = parseMlnxQos(qosLines.join("\n"));
        qosLines = null;
      } else qosLines.push(raw);
      continue;
    }
    if (raw.trim() === "=qos") qosLines = [];
    else if (raw.startsWith("pause")) entry.flowControl = pauseFlags(raw);
    else {
      const stat = /^\s+([a-z0-9_]+):\s*(\d+)\s*$/i.exec(raw);
      if (stat) entry.eth[stat[1]] = Number(stat[2]);
    }
  }
  return byIf;
}

/**
 * Turns successive reads into rates, counter deltas and loss streaks.
 * `run(script)` executes a script on the unit and resolves with stdout.
 */
export class RoceSampler {
  constructor({ run, now = Date.now } = {}) {
    this.run = run;
    this.now = now;
    this.inflight = null;
    this.result = null;
    this.resultAt = -Infinity;
    this.skipUntil = -Infinity; // no RDMA hardware: idle until then
    this.retryAt = -Infinity;
    this.failures = 0;
    this.hadDevices = false;
    this.history = new Map(); // rdma name -> { at, counters, rx, tx, lossRun, everUp }
    this.slowAt = -Infinity;
    this.slowFacts = new Map(); // netdev -> parseRoceSlow entry
    this.portLoss = new Map(); // netdev -> { last: eth counters, run }
  }

  sample() {
    if (!this.inflight) {
      this.inflight = this.read().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  async read() {
    const at = this.now();
    if (at < this.skipUntil) return null;
    if (this.result && at - this.resultAt < FAST_INTERVAL_MS) return this.result;
    if (at < this.retryAt) return this.failures >= STALE_AFTER_FAILURES ? null : this.result;

    let fast;
    try {
      fast = parseRoceFast(await this.run(ROCE_FAST_SCRIPT));
    } catch (err) {
      return this.failed(at, err);
    }
    if (fast.devices.length === 0) {
      if (this.hadDevices) return this.failed(at, null);
      this.result = null;
      this.skipUntil = at + NO_RDMA_RECHECK_MS;
      return null;
    }
    this.hadDevices = true;
    this.failures = 0;
    if (at - this.slowAt >= SLOW_INTERVAL_MS) await this.readSlow(fast.devices, at);

    const devices = fast.devices.map((dev) => this.describe(dev, fast.netdevs.get(dev.netdev), at));
    devices.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    this.result = { available: true, sampledAt: at, devices };
    this.resultAt = at;
    return this.result;
  }

  failed(at, err) {
    this.failures++;
    this.retryAt = at + RETRY_AFTER_FAILURE_MS;
    if (this.failures < STALE_AFTER_FAILURES) return this.result;
    this.result = null;
    if (err) throw err;
    return null;
  }

  async readSlow(devices, at) {
    const script = roceSlowScript(devices.map((d) => d.netdev).filter(Boolean));
    if (script == null) return;
    this.slowAt = at;
    let facts;
    try {
      facts = parseRoceSlow(await this.run(script));
    } catch {
      return; // optional detail: keep what we had until the next slow slot
    }
    for (const [ifname, info] of facts) {
      const seen = this.portLoss.get(ifname);
      const grew = seen != null && ETH_LOSS_COUNTERS.some((key) => (info.eth[key] ?? 0) > (seen.last[key] ?? 0));
      this.portLoss.set(ifname, { last: { ...info.eth }, run: grew ? (seen?.run ?? 0) + 1 : 0 });
    }
    this.slowFacts = facts;
  }

  describe(dev, net, at) {
    const before = this.history.get(dev.name);
    const active = dev.state === "ACTIVE";
    const everUp = active || (before?.everUp ?? false);
    const seconds = before ? (at - before.at) / 1000 : 0;
    const perSecond = (now, then) =>
      seconds > 0 && Number.isFinite(now) && Number.isFinite(then) ? Math.max(0, (now - then) / seconds) : null;

    const deltas = {};
    const rising = [];
    if (before) {
      for (const [key, value] of Object.entries(dev.counters)) {
        const grew = Math.max(0, value - (before.counters[key] ?? value));
        deltas[key] = grew;
        if (grew > 0 && LOSS_COUNTERS.includes(key)) rising.push(key);
      }
    }
    const lossRun = rising.length ? (before?.lossRun ?? 0) + 1 : 0;
    const ethStreak = (net && this.portLoss.get(net.name)?.run) || 0;
    if (ethStreak > 0) rising.push("port discards");
    const slow = net ? this.slowFacts.get(net.name) : undefined;

    this.history.set(dev.name, {
      at,
      counters: { ...dev.counters },
      rx: net?.rxBytes ?? null,
      tx: net?.txBytes ?? null,
      lossRun,
      everUp,
    });

    return {
      name: dev.name,
      netdev: dev.netdev,
      state: dev.state,
      physState: dev.physState,
      active,
      everActive: everUp,
      rateGbps: dev.rateGbps,
      linkLayer: dev.linkLayer,
      operstate: net?.operstate ?? null,
      mtu: net?.mtu ?? null,
      speedMbps: net?.speedMbps ?? null,
      rxBps: before ? perSecond(net?.rxBytes, before.rx) : null,
      txBps: before ? perSecond(net?.txBytes, before.tx) : null,
      rxErrors: net?.rxErrors ?? null,
      txErrors: net?.txErrors ?? null,
      rxDropped: net?.rxDropped ?? null,
      txDropped: net?.txDropped ?? null,
      counters: dev.counters,
      deltas,
      loss: { rising, streak: lossRun, ethStreak },
      eth: slow?.eth ?? null,
      flowControl: slow?.flowControl ?? null,
      qos: slow?.qos ?? null,
    };
  }
}

function sortKey(device) {
  return device.netdev ?? device.name;
}
