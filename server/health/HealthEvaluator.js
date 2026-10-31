/**
 * Fleet health findings: small, explainable rules over metrics sparkDash
 * already collects. One evaluator per Spark keeps the few bits of state the
 * rules need (sample streaks, the last kernel-error counters).
 *
 * A finding is { id, severity: "warn" | "critical", title, detail, hint }.
 * Rules never throw and never guess: a missing metric simply raises nothing.
 */

export const LOW_POWER_STREAK = 5;
/** Kernel-error findings stay visible this long after the counter last rose. */
export const KERNEL_FINDING_TTL_MS = 60 * 60 * 1000;

const TEMP_WARN = 85;
const TEMP_CRITICAL = 90;
const MEM_AVAIL_WARN_MB = 4096;
const MEM_AVAIL_CRITICAL_MB = 1536;
const LOW_POWER_UTIL = 90;
const LOW_POWER_WATTS = 15;
const LINK_MIN_MBPS = 1000;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export class HealthEvaluator {
  constructor({ now = Date.now } = {}) {
    this._now = now;
    this._lowPowerStreak = 0;
    this._kernel = { xid: null, oom: null };
    this._kernelAt = { xid: 0, oom: 0 };
    this._kernelLast = { xid: null, oom: null };
    /** Events produced by the latest evaluate() (kernel counters rising). */
    this.pendingEvents = [];
  }

  /**
   * @param {{ gpu?: any, unifiedMemory?: any, network?: any, llm?: any[] }} metrics
   * @param {"gpu"|"other"} [domain] "gpu" advances the per-sample streaks.
   * @returns {Array<{id:string,severity:string,title:string,detail:string,hint:string}>}
   */
  evaluate(metrics, domain = "other") {
    this.pendingEvents = [];
    const out = [];
    try {
      const gpu = metrics?.gpu ?? null;
      const mem = metrics?.unifiedMemory ?? null;
      const net = metrics?.network ?? null;
      const llm = Array.isArray(metrics?.llm) ? metrics.llm : [];
      this._thermal(gpu, out);
      this._lowPower(gpu, domain, out);
      this._memory(mem, out);
      this._kernelErrors(gpu, out);
      this._concurrency(llm, mem, out);
      this._link(net, out);
      this._roce(metrics?.roce ?? null, out);
    } catch {
      /* a rule bug must never break the poll loop */
    }
    return out;
  }

  _thermal(gpu, out) {
    const t = num(gpu?.temperature);
    if (t == null || t < TEMP_WARN) return;
    const critical = t >= TEMP_CRITICAL;
    out.push({
      id: "thermal",
      severity: critical ? "critical" : "warn",
      title: critical ? "GPU is close to its shutdown temperature" : "GPU is running hot",
      detail: `${Math.round(t)}°C (warns at ${TEMP_WARN}°C, critical at ${TEMP_CRITICAL}°C).`,
      hint: "Check airflow and the room temperature, and that nothing blocks the vents. Lower the power limit or the load if it keeps climbing.",
    });
  }

  _lowPower(gpu, domain, out) {
    const util = num(gpu?.usage);
    const draw = num(gpu?.power?.draw);
    if (util == null || draw == null) {
      if (domain === "gpu") this._lowPowerStreak = 0;
      return;
    }
    const suspicious = util >= LOW_POWER_UTIL && draw < LOW_POWER_WATTS;
    if (domain === "gpu") this._lowPowerStreak = suspicious ? this._lowPowerStreak + 1 : 0;
    if (this._lowPowerStreak < LOW_POWER_STREAK) return;
    out.push({
      id: "low-power",
      severity: "warn",
      title: "GPU looks stuck in a low-power state",
      detail: `${Math.round(util)}% utilisation but only ${draw.toFixed(1)} W for ${this._lowPowerStreak} samples in a row.`,
      hint: "Often a driver or power-management hiccup. A GPU reset or a reboot usually clears it; check dmesg for NVRM errors first.",
    });
  }

  _memory(mem, out) {
    const avail = num(mem?.available);
    const total = num(mem?.total);
    if (avail == null || total == null || total <= 0) return;
    if (avail >= MEM_AVAIL_WARN_MB) return;
    const critical = avail < MEM_AVAIL_CRITICAL_MB;
    out.push({
      id: "memory",
      severity: critical ? "critical" : "warn",
      title: critical ? "Unified memory is almost exhausted" : "Unified memory is running low",
      detail: `${(avail / 1024).toFixed(1)} GB available of ${(total / 1024).toFixed(0)} GB.`,
      hint: "The kernel may start killing processes. Stop a model you are not using, lower the context length or the GPU memory utilisation.",
    });
  }

  _kernelErrors(gpu, out) {
    const ke = gpu?.kernelErrors;
    if (!ke) return;
    const now = this._now();
    const rules = [
      ["xid", "xid", "NVIDIA Xid error", "A GPU or driver error was logged by the kernel",
        "Look up the Xid code in NVIDIA's Xid catalog. Repeated driver-class Xids point at hardware or a driver bug."],
      ["oom", "oom", "Kernel killed a process (out of memory)", "The kernel's OOM killer ended a process",
        "Something ran out of memory. Lower the model's memory use or stop other workloads."],
    ];
    for (const [key, id, title, what, hint] of rules) {
      const count = num(key === "xid" ? ke.xid : ke.oomKills);
      if (count == null) continue;
      const prev = this._kernel[key];
      this._kernel[key] = count;
      if (prev != null && count > prev) {
        this._kernelAt[key] = now;
        const last = key === "xid" && typeof ke.lastXid === "string" && ke.lastXid ? ` (${ke.lastXid})` : "";
        this.pendingEvents.push({
          type: `health.${id}`,
          severity: "error",
          message: `${title}: ${count - prev} new since the last check${last}`,
        });
        this._kernelLast[key] = key === "xid" ? ke.lastXid ?? null : null;
      }
      if (this._kernelAt[key] && now - this._kernelAt[key] < KERNEL_FINDING_TTL_MS) {
        const extra = key === "xid" && this._kernelLast.xid ? ` Latest: ${this._kernelLast.xid}.` : "";
        out.push({
          id,
          severity: "critical",
          title,
          detail: `${what} within the last hour (${count} since boot).${extra}`,
          hint,
        });
      }
    }
  }

  _concurrency(llm, mem, out) {
    const serving = llm.filter((l) => l && l.available && l.modelId);
    const ids = new Set(serving.map((l) => l.modelId));
    if (ids.size < 2) return;
    const pct = num(mem?.percentage);
    if (pct == null || pct < 70) return;
    out.push({
      id: "concurrency",
      severity: "warn",
      title: "Several models are loaded on this node",
      detail: `${ids.size} different models are serving while ${Math.round(pct)}% of memory is in use.`,
      hint: "Heavy backends compete for the same unified memory. Stop the ones you are not using to avoid out-of-memory kills.",
    });
  }

  _link(net, out) {
    const mbps = num(net?.linkSpeedMbps);
    if (mbps == null || mbps <= 0 || mbps >= LINK_MIN_MBPS) return;
    out.push({
      id: "link-speed",
      severity: "warn",
      title: "Network link is slower than 1 Gb/s",
      detail: `${net?.primaryInterface ?? "The primary interface"} negotiated ${mbps} Mb/s.`,
      hint: "Check the cable and the switch port. A cluster running over a degraded link slows every tensor-parallel step.",
    });
  }
}


// RoCE rules (docs/specs/roce.md §4; LIC2 clean-room rewrite). The sampler in
// collectors/roce.js already tracks the streaks; these rules only threshold them.
const ROCE_RDMA_LOSS_RUN = 3;
const ROCE_PORT_LOSS_RUN = 2;

const roceLabel = (d) => d.netdev ?? d.name;

HealthEvaluator.prototype._roce = function evaluateRoce(roce, out) {
  if (!Array.isArray(roce?.devices) || roce.devices.length === 0) return;

  // Only a port seen ACTIVE before counts as "went down"; uncabled ports never were.
  const lost = roce.devices.filter((d) => d.everActive && !d.active);
  if (lost.length) {
    const what = lost.map((d) => {
      const phys = d.physState ? ` (${d.physState})` : "";
      return `${roceLabel(d)}: ${d.state ?? "unknown"}${phys}`;
    });
    out.push({
      id: "roce-link",
      severity: "critical",
      title: lost.length > 1 ? `${lost.length} RoCE links went down` : "A RoCE link went down",
      detail: `${what.join(", ")}.`,
      hint: "Look at the cable, the transceiver and the switch port. RDMA/NCCL traffic on this port stops or moves to a slower path until it is back.",
    });
  }

  const dropping = roce.devices.filter((d) => {
    if (!d.active) return false;
    const rdmaRun = num(d.loss?.streak) ?? 0;
    const portRun = num(d.loss?.ethStreak) ?? 0;
    return rdmaRun >= ROCE_RDMA_LOSS_RUN || portRun >= ROCE_PORT_LOSS_RUN;
  });
  if (dropping.length) {
    const what = dropping.map((d) => {
      const counters = Array.isArray(d.loss?.rising) && d.loss.rising.length ? d.loss.rising.join(", ") : "counters rising";
      return `${roceLabel(d)}: ${counters}`;
    });
    out.push({
      id: "roce-loss",
      severity: "warn",
      title: "RoCE is dropping packets",
      detail: `${what.join("; ")}.`,
      hint: "Loss counters that keep climbing usually mean congestion or a lossless-fabric setup that does not match (PFC, ECN, trust mode). Check those settings on each unit and on the switch.",
    });
  }
};

export default HealthEvaluator;
