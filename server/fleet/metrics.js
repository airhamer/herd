/**
 * S2.1 — Prometheus text exposition (0.0.4) for the fleet snapshot.
 *
 * renderFleetMetrics(snapshot) is PURE: no I/O, no clock (polledAt lives in
 * the snapshot and is intentionally NOT emitted — sample timestamps are the
 * scraper's job), deterministic sorted output. The consumer is the owner's
 * external Prometheus; the golden-anchor unit test is the contract.
 *
 * Rules (docs/S2.1-SPEC.md):
 *  - every family that carries at least one sample emits one "# HELP" +
 *    "# TYPE gauge" header pair, then its samples;
 *  - families render alphabetically by name, samples sorted by rendered
 *    label set — the same snapshot always yields byte-identical output;
 *  - a null/absent family emits NOTHING for that node (absent != 0);
 *    non-finite numbers (NaN/±Infinity) are skipped, never printed;
 *  - MB sources are converted to bytes (x1048576);
 *  - unknown/extra snapshot properties are ignored (forward-compatible).
 */

const MB = 1048576;

const HELP = {
  herd_up: "Constant 1; the dashboard rendered a fleet snapshot.",
  herd_node_online: "1 when the node is online, 0 otherwise.",
  herd_node_uptime_seconds: "Node uptime in seconds.",
  herd_cpu_usage_percent: "CPU utilization percentage (0-100).",
  herd_cpu_temperature_celsius: "CPU temperature in Celsius.",
  herd_cpu_power_watts: "CPU power draw in watts.",
  herd_cpu_power_limit_watts: "CPU power limit (TDP) in watts.",
  herd_mem_total_bytes: "Total node memory in bytes.",
  herd_mem_used_bytes: "Used node memory in bytes.",
  herd_mem_available_bytes: "Available node memory in bytes.",
  herd_disk_total_bytes: "Filesystem total size in bytes.",
  herd_disk_used_bytes: "Filesystem used space in bytes.",
  herd_disk_available_bytes: "Filesystem available space in bytes.",
  herd_net_receive_bytes_per_second: "Interface receive throughput in bytes per second.",
  herd_net_transmit_bytes_per_second: "Interface transmit throughput in bytes per second.",
  herd_gpu_usage_percent: "GPU utilization percentage (0-100).",
  herd_gpu_temperature_celsius: "GPU temperature in Celsius.",
  herd_gpu_power_watts: "GPU power draw in watts.",
  herd_gpu_power_limit_watts: "GPU power limit in watts.",
  herd_gpu_vram_used_bytes: "GPU VRAM in use, in bytes.",
  herd_gpu_vram_total_bytes: "GPU VRAM total, in bytes.",
  herd_llm_requests_queued: "Queued requests per model/engine on a machine.",
  herd_llm_requests_running: "Running requests per model/engine on a machine.",
  herd_llm_requests_finished: "Finished requests per model/engine on a machine.",
  herd_fleet_mem_total_bytes: "Fleet aggregate memory total in bytes.",
  herd_fleet_mem_used_bytes: "Fleet aggregate memory used in bytes.",
  herd_fleet_mem_free_bytes: "Fleet aggregate memory free in bytes.",
};

/** Prometheus label-value escaping: backslash, quote, newline. */
function escapeLabelValue(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n");
}

/** Plain-number formatting: integers stay integers (String() guarantees it). */
function fmt(value) {
  return String(value);
}

export function renderFleetMetrics(snapshot) {
  /** @type {Map<string, Array<{labels: [string, unknown][], value: number}>>} */
  const samples = new Map();

  function emit(name, value, labels) {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    const list = samples.get(name);
    if (list) list.push({ labels: labels || [], value });
    else samples.set(name, [{ labels: labels || [], value }]);
  }

  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};

  emit("herd_up", 1, []);

  const nodes = Array.isArray(snap.nodes) ? snap.nodes : [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const nid = node.nodeId ?? node.nodeName ?? "unknown";
    const nl = [["node", nid]];

    emit("herd_node_online", node.online ? 1 : 0, nl);
    emit("herd_node_uptime_seconds", node.uptimeSeconds, nl);

    if (node.cpu && typeof node.cpu === "object") {
      emit("herd_cpu_usage_percent", node.cpu.usage, nl);
      emit("herd_cpu_temperature_celsius", node.cpu.temperature, nl);
      emit("herd_cpu_power_watts", node.cpu.draw, nl);
      emit("herd_cpu_power_limit_watts", node.cpu.tdp, nl);
    }

    if (node.mem && typeof node.mem === "object") {
      emit("herd_mem_total_bytes", node.mem.totalMB * MB, nl);
      emit("herd_mem_used_bytes", node.mem.usedMB * MB, nl);
      emit("herd_mem_available_bytes", node.mem.availableMB * MB, nl);
    }

    const disks = Array.isArray(node.disk) ? node.disk : [];
    for (const d of disks) {
      if (!d || typeof d !== "object") continue;
      const dl = [["node", nid], ["mount", d.mount], ["device", d.device]];
      emit("herd_disk_total_bytes", d.totalMB * MB, dl);
      emit("herd_disk_used_bytes", d.usedMB * MB, dl);
      emit("herd_disk_available_bytes", d.availableMB * MB, dl);
    }

    const nets = Array.isArray(node.net) ? node.net : [];
    for (const n of nets) {
      if (!n || typeof n !== "object") continue;
      const xl = [["node", nid], ["iface", n.iface]];
      // NetMetrics field names per shared/types.ts: rxSpeed / txSpeed (MB/s).
      emit("herd_net_receive_bytes_per_second", n.rxSpeed * MB, xl);
      emit("herd_net_transmit_bytes_per_second", n.txSpeed * MB, xl);
    }

    // Snapshot gpu is GpuMetrics | null in shared/types.ts; the spec table
    // writes node.gpu[] with a 0-based index label. Accept both shapes.
    const gpus = Array.isArray(node.gpu) ? node.gpu : node.gpu && typeof node.gpu === "object" ? [node.gpu] : [];
    gpus.forEach((g, i) => {
      if (!g || typeof g !== "object") return;
      const gl = [["node", nid], ["index", String(i)]];
      emit("herd_gpu_usage_percent", g.usage, gl);
      emit("herd_gpu_temperature_celsius", g.temperature, gl);
      emit("herd_gpu_power_watts", g.powerDraw, gl);
      emit("herd_gpu_power_limit_watts", g.powerLimit, gl);
      emit("herd_gpu_vram_used_bytes", g.vramUsedMB * MB, gl);
      emit("herd_gpu_vram_total_bytes", g.vramTotalMB * MB, gl);
    });
  }

  const byMachine = snap.requests && snap.requests.byMachine;
  if (byMachine && typeof byMachine === "object") {
    for (const [machine, stats] of Object.entries(byMachine)) {
      if (!Array.isArray(stats)) continue;
      for (const s of stats) {
        if (!s || typeof s !== "object") continue;
        const rl = [
          ["node", machine],
          ["model", s.modelId],
          ["engine", s.engine],
          ["port", s.port],
        ];
        emit("herd_llm_requests_queued", s.queued, rl);
        emit("herd_llm_requests_running", s.running, rl);
        emit("herd_llm_requests_finished", s.finished, rl);
      }
    }
  }

  if (snap.memory && typeof snap.memory === "object") {
    emit("herd_fleet_mem_total_bytes", snap.memory.totalMB * MB, []);
    emit("herd_fleet_mem_used_bytes", snap.memory.usedMB * MB, []);
    emit("herd_fleet_mem_free_bytes", snap.memory.freeMB * MB, []);
  }

  const out = [];
  for (const name of [...samples.keys()].sort()) {
    const rows = samples.get(name);
    if (rows.length === 0) continue;
    out.push(`# HELP ${name} ${HELP[name]}`);
    out.push(`# TYPE ${name} gauge`);
    const lines = rows.map((r) => {
      const labels = r.labels.length
        ? `{${r.labels.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",")}}`
        : "";
      return `${name}${labels} ${fmt(r.value)}`;
    });
    lines.sort();
    out.push(...lines);
  }
  return out.join("\n") + "\n";
}
