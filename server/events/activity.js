// Activity events (issue #32): turn what the dashboard already observes into
// entries for the fleet EventLog.
//
// Two kinds of producers live here:
//   - pure "diff" functions that compare two observations of the same unit
//     (a Spark snapshot or a fleet node snapshot) and return the events that
//     the change implies, and a small watcher that runs them on a timer;
//   - pure "builders" for one-off events raised by routes and job managers
//     (a Spark added, a node claimed, a power action, a benchmark finishing).
//
// Every event carries `sparkId` = the fleet-wide unit id (Spark id or node
// agent id) and `sparkName` = its display name, so the feed can be filtered
// per unit the same way for both lanes.

/** Consecutive observations a flappy signal must hold before it is reported. */
export const SETTLE_TICKS = 2;
export const DEFAULT_WATCH_INTERVAL_MS = 5_000;
/**
 * After start(), changes are absorbed silently for this long: monitors and
 * agents connect over the first seconds of a boot, and "came online" for
 * every unit on each restart is noise, not activity.
 */
export const DEFAULT_WARMUP_MS = 30_000;

const nameOf = (unit) => unit?.name || unit?.nodeName || unit?.id || unit?.nodeId || "unit";

/** Event for a unit: fills sparkId/sparkName from the unit. */
function unitEvent(unit, type, severity, message, data) {
  const ev = {
    type,
    severity,
    sparkId: unit?.id ?? unit?.nodeId ?? null,
    sparkName: nameOf(unit),
    message,
  };
  if (data !== undefined) ev.data = data;
  return ev;
}

// ─── Settling ──────────────────────────────────────────────────────────────

/**
 * Remembers a settled value per key and only reports a change once the new
 * value has been seen `need` times in a row. The first observation of a key
 * becomes its settled value silently (a baseline, not a change).
 */
export class Settler {
  constructor(need = SETTLE_TICKS) {
    this.need = Math.max(1, need);
    /** @type {Map<string, {settled: any, candidate: any, count: number}>} */
    this.state = new Map();
    /** Last known detail per key (e.g. the health finding), for messages. */
    this.meta = new Map();
  }

  /** Keys currently tracked that start with `prefix`. */
  keys(prefix) {
    return [...this.state.keys()].filter((k) => k.startsWith(prefix));
  }

  /** @returns {{from: any, to: any} | null} */
  observe(key, value) {
    const st = this.state.get(key);
    if (!st) {
      this.state.set(key, { settled: value, candidate: value, count: 0 });
      return null;
    }
    if (value === st.settled) {
      st.candidate = value;
      st.count = 0;
      return null;
    }
    if (value === st.candidate) st.count += 1;
    else {
      st.candidate = value;
      st.count = 1;
    }
    if (st.count < this.need) return null;
    const from = st.settled;
    st.settled = value;
    st.count = 0;
    return { from, to: value };
  }

  /** Forget every key that starts with `prefix`. */
  forget(prefix) {
    for (const key of this.keys(prefix)) {
      this.state.delete(key);
      this.meta.delete(key);
    }
  }
}

// ─── Spark snapshots ───────────────────────────────────────────────────────

const throttleOf = (snap) => snap?.metrics?.gpu?.throttle ?? null;

/** Clock cap in MHz, null when uncapped, undefined when not reported. */
function clockCapOf(snap) {
  const t = throttleOf(snap);
  if (!t || !("clockCapMHz" in t)) return undefined;
  const v = t.clockCapMHz;
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

/**
 * Events implied by one Spark going from `prev` to `next`. `settler` holds
 * debounce state for flappy signals (throttle, health findings); pass a
 * fresh Settler(1) for an undebounced comparison.
 */
export function diffSpark(prev, next, settler = new Settler(1)) {
  const out = [];
  if (!prev || !next) return out;
  const id = next.id;
  if (Boolean(prev.online) !== Boolean(next.online)) {
    out.push(
      next.online
        ? unitEvent(next, "spark.online", "success", `${nameOf(next)} came online`)
        : unitEvent(next, "spark.offline", "warn", `${nameOf(next)} went offline`),
    );
  }
  // Metrics of an offline unit are stale; don't read changes into them.
  if (!next.online) return out;

  const t = throttleOf(next);
  if (t && typeof t.active === "boolean") {
    const change = settler.observe(`${id}\u0000throttle`, t.active ? `on:${t.reason || "unknown"}` : "off");
    if (change) {
      const wasOn = String(change.from).startsWith("on:");
      if (t.active) {
        const reason = t.reason || "unknown";
        out.push(
          unitEvent(next, "gpu.throttle.start", "warn", `GPU throttling (${reason})${t.detail ? `: ${t.detail}` : ""}`, { reason }),
        );
      } else if (wasOn) {
        out.push(unitEvent(next, "gpu.throttle.end", "info", "GPU throttling ended"));
      }
    }
  }

  const before = clockCapOf(prev);
  const after = clockCapOf(next);
  if (before !== undefined && after !== undefined && before !== after) {
    if (after == null) {
      out.push(unitEvent(next, "gpu.clock.released", "info", "GPU clock cap removed", { fromMHz: before }));
    } else if (before == null) {
      out.push(unitEvent(next, "gpu.clock.capped", "warn", `GPU clock capped at ${after} MHz`, { toMHz: after }));
    } else {
      out.push(
        unitEvent(next, "gpu.clock.capped", "warn", `GPU clock cap changed from ${before} to ${after} MHz`, {
          fromMHz: before,
          toMHz: after,
        }),
      );
    }
  }

  if (Array.isArray(next.health)) {
    const seen = new Map();
    for (const f of next.health) if (f && f.id) seen.set(f.id, f);
    const prefix = `${id}\u0000health\u0000`;
    const ids = new Set(seen.keys());
    const prevIds = new Set();
    for (const f of Array.isArray(prev.health) ? prev.health : []) if (f && f.id) prevIds.add(f.id);
    for (const fid of prevIds) ids.add(fid);
    for (const key of settler.keys(prefix)) ids.add(key.slice(prefix.length));
    for (const fid of ids) {
      const key = prefix + fid;
      if (seen.has(fid)) settler.meta.set(key, seen.get(fid));
      const finding = seen.get(fid) || settler.meta.get(key) || { id: fid };
      // A finding id first met now starts from what the previous snapshot said.
      if (!settler.state.has(key)) settler.observe(key, prevIds.has(fid));
      const change = settler.observe(key, seen.has(fid));
      if (!change) continue;
      const title = finding.title || fid;
      if (change.to) {
        out.push(
          unitEvent(next, "health.raised", finding.severity === "critical" ? "error" : "warn", title, {
            findingId: fid,
            severity: finding.severity ?? null,
          }),
        );
      } else {
        out.push(unitEvent(next, "health.cleared", "success", `${title} cleared`, { findingId: fid }));
      }
    }
  }
  return out;
}

/** Seed debounce state for a Spark seen for the first time (no events). */
function baselineSpark(snap, settler) {
  if (!snap?.online) return;
  const t = throttleOf(snap);
  if (t && typeof t.active === "boolean") {
    settler.observe(`${snap.id}\u0000throttle`, t.active ? `on:${t.reason || "unknown"}` : "off");
  }
  for (const f of Array.isArray(snap.health) ? snap.health : []) {
    if (!f?.id) continue;
    const key = `${snap.id}\u0000health\u0000${f.id}`;
    settler.observe(key, true);
    settler.meta.set(key, f);
  }
}

// ─── Fleet node snapshots ──────────────────────────────────────────────────

const RUNNING = "running";

/**
 * Events implied by one fleet node going from `prev` to `next`
 * (entries of buildFleetSnapshot().nodes).
 */
export function diffNode(prev, next) {
  const out = [];
  if (!prev || !next) return out;
  const name = nameOf(next);
  if (Boolean(prev.online) !== Boolean(next.online)) {
    out.push(
      next.online
        ? unitEvent(next, "node.online", "success", `${name} came online`)
        : unitEvent(next, "node.offline", "warn", `${name} went offline`),
    );
  }
  if (prev.enrollment === "pending" && next.enrollment === "claimed") {
    out.push(unitEvent(next, "node.claimed", "success", `${name} claimed`));
  }
  if (!prev.online || !next.online) return out;

  const prevContainers = Array.isArray(prev.containers) ? prev.containers : [];
  const nextContainers = Array.isArray(next.containers) ? next.containers : [];
  // An empty list usually means "not collected"; don't treat it as a change.
  if (prevContainers.length > 0 && nextContainers.length > 0) {
    const before = new Map(prevContainers.map((c) => [c.name, c]));
    for (const c of nextContainers) {
      const was = before.get(c.name);
      const wasRunning = was ? was.status === RUNNING : false;
      const isRunning = c.status === RUNNING;
      if (!was && !isRunning) continue;
      if (wasRunning === isRunning) continue;
      out.push(
        isRunning
          ? unitEvent(next, "container.started", "info", `Container ${c.name} started`, { container: c.name, image: c.image ?? null })
          : unitEvent(next, "container.stopped", "info", `Container ${c.name} ${c.status || "stopped"}`, {
              container: c.name,
              status: c.status ?? null,
            }),
      );
    }
  }

  const prevServices = Array.isArray(prev.services) ? prev.services : [];
  const nextServices = Array.isArray(next.services) ? next.services : [];
  if (prevServices.length > 0 && nextServices.length > 0) {
    const key = (s) => `${s.name}:${s.port ?? ""}`;
    const before = new Map(prevServices.map((s) => [key(s), s]));
    for (const s of nextServices) {
      const was = before.get(key(s));
      if (!was || was.status === s.status) continue;
      const label = s.modelId ? `${s.name} (${s.modelId})` : s.name;
      const data = { service: s.name, port: s.port ?? null, from: was.status, to: s.status };
      if (s.status === RUNNING) {
        out.push(unitEvent(next, "service.started", "success", `Service ${label} is running`, data));
      } else if (s.status === "stopped" && was.status === RUNNING) {
        out.push(unitEvent(next, "service.stopped", "info", `Service ${label} stopped`, data));
      } else if (s.status === "wedged") {
        out.push(unitEvent(next, "service.wedged", "error", `Service ${label} is wedged`, data));
      }
    }
  }
  return out;
}

// ─── Watcher ───────────────────────────────────────────────────────────────

/**
 * Polls Spark and fleet-node snapshots and records the events their changes
 * imply. The first sight of a unit is a silent baseline; a unit that
 * disappears is forgotten (removal events come from the routes that remove).
 * For `warmupMs` after start() the watcher tracks state but records nothing.
 *
 * @param {{
 *   getSparks: () => any[],
 *   getNodes: () => any[],
 *   record: (event: object) => unknown,
 *   intervalMs?: number,
 *   settleTicks?: number,
 *   warmupMs?: number,
 *   now?: () => number,
 * }} opts
 */
export function createActivityWatcher({
  getSparks,
  getNodes,
  record,
  intervalMs = DEFAULT_WATCH_INTERVAL_MS,
  settleTicks = SETTLE_TICKS,
  warmupMs = 0,
  now = Date.now,
}) {
  let quietUntil = 0;
  const sparks = new Map();
  const nodes = new Map();
  const settler = new Settler(settleTicks);
  let timer = null;

  const safeList = (fn) => {
    try {
      const v = fn?.();
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };

  function tick() {
    const emitted = [];
    const sawSparks = new Set();
    for (const snap of safeList(getSparks)) {
      if (!snap?.id) continue;
      sawSparks.add(snap.id);
      const prev = sparks.get(snap.id);
      if (prev) emitted.push(...diffSpark(prev, snap, settler));
      else baselineSpark(snap, settler);
      sparks.set(snap.id, snap);
    }
    for (const id of [...sparks.keys()]) {
      if (!sawSparks.has(id)) {
        sparks.delete(id);
        settler.forget(`${id}\u0000`);
      }
    }

    const sawNodes = new Set();
    for (const node of safeList(getNodes)) {
      if (!node?.nodeId) continue;
      sawNodes.add(node.nodeId);
      const prev = nodes.get(node.nodeId);
      if (prev) emitted.push(...diffNode(prev, node));
      nodes.set(node.nodeId, node);
    }
    for (const id of [...nodes.keys()]) if (!sawNodes.has(id)) nodes.delete(id);

    if (now() < quietUntil) return [];
    for (const ev of emitted) {
      try {
        record(ev);
      } catch {
        // the sink must not stop the watcher
      }
    }
    return emitted;
  }

  return {
    tick,
    start() {
      if (timer) return;
      quietUntil = now() + Math.max(0, warmupMs);
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

// ─── One-off event builders (routes, managers) ─────────────────────────────

const msgOf = (err) => (err && typeof err === "object" && "message" in err ? err.message : err ? String(err) : "");

export const activity = {
  sparkAdded: (spark) => unitEvent(spark, "spark.added", "success", `${nameOf(spark)} added to the fleet`),
  sparkRemoved: (spark) => unitEvent(spark, "spark.removed", "info", `${nameOf(spark)} removed from the fleet`),
  nodeAdded: (node) => unitEvent(node, "node.added", "success", `${nameOf(node)} registered as a fleet node`),
  nodeRemoved: (node) => unitEvent(node, "node.removed", "info", `${nameOf(node)} removed from the fleet`),

  /** Service action proxied to a node agent (/fleet/nodes/:id/actions). */
  serviceAction(node, { action, service, ok, error }) {
    const what = service ? `${action} ${service}` : action;
    return ok
      ? unitEvent(node, "service.action", "info", `Requested ${what}`, { action, service: service ?? null })
      : unitEvent(node, "service.action.failed", "error", `${what} failed: ${error || "unknown error"}`, {
          action,
          service: service ?? null,
        });
  },

  /** Component start/stop/restart (install-class actions) on a node. */
  componentAction(node, { type, componentId, ok, dryRun, error }) {
    const what = `${type} ${componentId}${dryRun ? " (dry run)" : ""}`;
    return ok
      ? unitEvent(node, `component.${type}`, "info", `Component ${what} requested`, { componentId, dryRun: Boolean(dryRun) })
      : unitEvent(node, "component.failed", "error", `Component ${what} failed: ${error || "unknown error"}`, {
          componentId,
          type,
        });
  },

  updateStarted: (node, { ok, error } = { ok: true }) =>
    ok
      ? unitEvent(node, "update.started", "info", "Software update started")
      : unitEvent(node, "update.failed", "error", `Software update failed to start: ${error || "unknown error"}`),
  updateScheduled: (node, schedule) =>
    unitEvent(node, "update.scheduled", "info", schedule ? "Update schedule changed" : "Update schedule cleared", {
      schedule: schedule ?? null,
    }),

  powerShutdown: (unit, { ok, error } = { ok: true }) =>
    ok
      ? unitEvent(unit, "power.shutdown", "warn", `Shutdown sent to ${nameOf(unit)}`)
      : unitEvent(unit, "power.shutdown.failed", "error", `Shutdown of ${nameOf(unit)} failed: ${error || "unknown error"}`),
  powerWake: (unit, { ok, error } = { ok: true }) =>
    ok
      ? unitEvent(unit, "power.wake", "info", `Wake-on-LAN sent to ${nameOf(unit)}`)
      : unitEvent(unit, "power.wake.failed", "error", `Wake of ${nameOf(unit)} failed: ${error || "unknown error"}`),

  alertFired: (a) => ({
    type: "alert.fired",
    severity: a.severity === "critical" ? "error" : "warn",
    sparkId: a.unitId ?? null,
    sparkName: a.unitName ?? null,
    message: `${a.ruleName || a.ruleId}: ${a.summary || a.label || "firing"}`,
    data: { ruleId: a.ruleId, key: a.key, severity: a.severity ?? null },
  }),
  alertResolved: (a) => ({
    type: "alert.resolved",
    severity: "success",
    sparkId: a.unitId ?? null,
    sparkName: a.unitName ?? null,
    message: `${a.ruleName || a.ruleId} resolved`,
    data: { ruleId: a.ruleId, key: a.key },
  }),

  /**
   * Benchmark lifecycle. `kind` is "decode" or "prefill"; `job` is the
   * manager's job (status running|completed|failed|cancelled).
   */
  bench(kind, job) {
    const label = kind === "prefill" ? "Prefill benchmark" : "Decode benchmark";
    const model = job?.config?.modelId ? ` (${job.config.modelId})` : "";
    const data = { benchId: job?.benchId ?? null, kind, port: job?.config?.port ?? null };
    const unit = { id: job?.sparkId };
    switch (job?.status) {
      case "running":
        return { ...unitEvent(unit, `bench.${kind}.started`, "info", `${label} started${model}`, data), sparkName: null };
      case "completed":
        return { ...unitEvent(unit, `bench.${kind}.completed`, "success", `${label} finished${model}`, data), sparkName: null };
      case "cancelled":
        return { ...unitEvent(unit, `bench.${kind}.cancelled`, "info", `${label} cancelled${model}`, data), sparkName: null };
      default:
        return {
          ...unitEvent(unit, `bench.${kind}.failed`, "error", `${label} failed${model}: ${msgOf(job?.error) || "unknown error"}`, data),
          sparkName: null,
        };
    }
  },

  /** Showcase (multi-stream demo) lifecycle. */
  showcase(session) {
    const model = session?.modelId ? ` (${session.modelId})` : "";
    const streams = Array.isArray(session?.streams) ? session.streams.length : 0;
    const data = { sessionId: session?.sessionId ?? null, streams, port: session?.port ?? null };
    const base = { sparkId: session?.sparkId ?? null, sparkName: null, data };
    switch (session?.status) {
      case "running":
        return { ...base, type: "showcase.started", severity: "info", message: `Showcase started: ${streams} streams${model}` };
      case "completed":
        return { ...base, type: "showcase.completed", severity: "success", message: `Showcase finished${model}` };
      case "cancelled":
        return { ...base, type: "showcase.cancelled", severity: "info", message: `Showcase cancelled${model}` };
      default:
        return {
          ...base,
          type: "showcase.failed",
          severity: "error",
          message: `Showcase failed${model}: ${msgOf(session?.error) || "unknown error"}`,
        };
    }
  },

  /** Fleet-wide Showcase (SHOW1) lifecycle; not tied to one unit. */
  fleetShowcase(session) {
    const lanes = Array.isArray(session?.lanes) ? session.lanes : [];
    const names = lanes.map((l) => `${l?.nodeName ?? "?"}:${l?.port ?? "?"}`);
    const label = `${lanes.length} lane${lanes.length === 1 ? "" : "s"}`;
    const data = { sessionId: session?.sessionId ?? null, lanes: names };
    const base = { sparkId: null, sparkName: null, data };
    switch (session?.status) {
      case "running":
        return { ...base, type: "fleet.showcase.started", severity: "info", message: `Fleet showcase started on ${label}` };
      case "completed":
        return { ...base, type: "fleet.showcase.completed", severity: "success", message: `Fleet showcase finished on ${label}` };
      case "cancelled":
        return { ...base, type: "fleet.showcase.cancelled", severity: "info", message: `Fleet showcase cancelled (${label})` };
      default:
        return {
          ...base,
          type: "fleet.showcase.failed",
          severity: "error",
          message: `Fleet showcase failed (${label}): ${msgOf(session?.error) || "unknown error"}`,
        };
    }
  },
};

/**
 * Wrap a record function so events missing a unit name get one from
 * `resolveName(sparkId)`. Never throws.
 */
export function withUnitNames(record, resolveName) {
  return (event) => {
    try {
      if (event && event.sparkId && !event.sparkName) {
        const name = resolveName(event.sparkId);
        if (name) event = { ...event, sparkName: name };
      }
      return record(event);
    } catch {
      return null;
    }
  };
}
