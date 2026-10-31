/**
 * sparkdash-node-agent — memory budgeting model.
 *
 * Computes how much unified memory is free on one node and, when a caller
 * wants to reserve more than what is free, which services to stop to make
 * room (greedy, largest-first, stoppable = running && !needed).
 *
 * SC3 adds the multi-spark / TP-group layer: computeGroupMemoryBudget
 * plans one TP=x service across x sparks (per-spark shard math, group
 * total + per-spark breakdown) by delegating the per-spark math to
 * computeMemoryBudget, and BOOTSTRAP_COMPONENTS seeds the initial memory
 * estimates (decision #2: unlocked in the UI, basis "estimated", refined
 * after 5 history runs).
 *
 * Seam contract: shared/types.ts → MemoryService, MakeRoomEntry,
 * MemoryBudget, GroupSparkEntry, GroupResourcePlan,
 * BootstrapComponentEstimate.
 * Pure functions: no I/O, no module state — deterministic given their
 * inputs (polledAt is the only clock read).
 */

/**
 * One service's memory footprint in the budget (shared/types.ts → MemoryService).
 * @typedef {object} MemoryService
 * @property {string} name
 * @property {string} kind
 * @property {number} footprintMB
 * @property {boolean} running
 * @property {boolean} needed
 */

/**
 * One entry in the make-room plan (shared/types.ts → MakeRoomEntry).
 * @typedef {object} MakeRoomEntry
 * @property {string} serviceName
 * @property {number} freesMB
 * @property {string} reason
 */

/**
 * Memory budget for one node (shared/types.ts → MemoryBudget).
 * @typedef {object} MemoryBudget
 * @property {string} nodeId
 * @property {number} totalMB
 * @property {number} usedMB
 * @property {number} freeMB
 * @property {number} servicesUsedMB
 * @property {number} otherUsedMB
 * @property {MemoryService[]} services
 * @property {MakeRoomEntry[]} makeRoom
 * @property {boolean} needMakeRoom
 * @property {number} [groupAvailableMB] SC3: present with opts.group context
 * @property {number} polledAt
 */

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Normalize + validate one MemoryService input.
 * @param {unknown} s
 * @param {number} i
 * @returns {MemoryService}
 * @throws {TypeError}
 */
function normalizeMemoryService(s, i) {
  const label = `services[${i}]`;
  if (typeof s !== "object" || s === null || Array.isArray(s)) {
    throw new TypeError(`${label} must be an object`);
  }
  if (typeof s.name !== "string" || s.name.length === 0) {
    throw new TypeError(`${label}.name must be a non-empty string`);
  }
  const kind = typeof s.kind === "string" && s.kind.length > 0 ? s.kind : "other";
  if (!isFiniteNumber(s.footprintMB) || s.footprintMB < 0) {
    throw new TypeError(
      `${label}.footprintMB must be a non-negative finite number (got ${JSON.stringify(s.footprintMB)})`
    );
  }
  return {
    name: s.name,
    kind,
    footprintMB: s.footprintMB,
    running: s.running === true,
    needed: s.needed === true,
  };
}

/**
 * Compute the memory budget for one node.
 *
 * Steps (Batch 1B work plan):
 *  1. freeMB = totalMB - usedMB (clamped to >= 0 for inconsistent telemetry)
 *  2. freeMB >= wantMB → needMakeRoom=false, makeRoom=[]
 *  3. otherwise deficit = wantMB - freeMB; sort stoppable services
 *     (running=true, needed=false) by footprintMB desc (name asc on ties);
 *     greedily add to makeRoom until the deficit is covered.
 *
 * Invariants:
 *  - needed services are never stoppable; stopped services are never stoppable.
 *  - servicesUsedMB = Σ footprintMB over running services.
 *  - otherUsedMB = max(0, usedMB - servicesUsedMB).
 *  - needMakeRoom=true with makeRoom=[] means "infeasible": no stoppable set
 *    covers the deficit — consumers must surface that, not treat [] as OK.
 *
 * @param {number} totalMB total unified memory (MB)
 * @param {number} usedMB currently used memory (MB)
 * @param {MemoryService[]} services
 * @param {number} wantMB memory the caller wants to reserve (MB)
 * @param {{nodeId?: string, group?: {sparkIds?: string[], perSparkMB?: number,
 *   estimated?: boolean}}} [opts]
 *   group: when this node belongs to a TP group whose per-spark need
 *   exceeds what is free here, the budget reports that headroom as
 *   `groupAvailableMB` and drives needMakeRoom off the group need (SC3:
 *   group plans reuse the same per-spark budget the UI already reads).
 * @returns {MemoryBudget}
 * @throws {TypeError} on non-finite / negative memory values or malformed services
 */
export function computeMemoryBudget(totalMB, usedMB, services, wantMB, opts = {}) {
  for (const [field, v] of [
    ["totalMB", totalMB],
    ["usedMB", usedMB],
    ["wantMB", wantMB],
  ]) {
    if (!isFiniteNumber(v) || v < 0) {
      throw new TypeError(`${field} must be a non-negative finite number (got ${JSON.stringify(v)})`);
    }
  }
  if (!Array.isArray(services)) {
    throw new TypeError("services must be an array");
  }
  const nodeId =
    typeof opts?.nodeId === "string" && opts.nodeId.length > 0 ? opts.nodeId : "unknown";

  const group =
    typeof opts?.group === "object" && opts.group !== null && !Array.isArray(opts.group)
      ? opts.group
      : null;
  let groupPerSparkMB = null;
  if (group) {
    if (
      group.sparkIds !== undefined &&
      (!Array.isArray(group.sparkIds) ||
        group.sparkIds.some((id) => typeof id !== "string" || id.length === 0))
    ) {
      // An empty array is legal: "group membership not yet known" (a single
      // node enriches before the topology view assembles).
      throw new TypeError("opts.group.sparkIds must be an array of non-empty strings");
    }
    if (group.perSparkMB !== undefined && (!isFiniteNumber(group.perSparkMB) || group.perSparkMB < 0)) {
      throw new TypeError(`opts.group.perSparkMB must be a non-negative finite number (got ${JSON.stringify(group.perSparkMB)})`);
    }
    if (group.perSparkMB !== undefined) groupPerSparkMB = group.perSparkMB;
  }

  const normalized = services.map(normalizeMemoryService);

  const servicesUsedMB = normalized.reduce(
    (sum, s) => (s.running ? sum + s.footprintMB : sum),
    0
  );
  const freeMB = Math.max(0, totalMB - usedMB);
  const otherUsedMB = Math.max(0, usedMB - servicesUsedMB);

  // SC3: a TP-group member's effective want is the larger of the caller's
  // own reservation and the group's per-spark need — the group plan must
  // fit in THIS spark, so it drives make-room even when wantMB is 0.
  const effectiveWantMB = Math.max(wantMB, groupPerSparkMB ?? 0);

  let needMakeRoom = false;
  let makeRoom = [];
  if (freeMB < effectiveWantMB) {
    needMakeRoom = true;
    const deficit = effectiveWantMB - freeMB;
    const stoppable = normalized
      .filter((s) => s.running && !s.needed)
      .sort((a, b) => b.footprintMB - a.footprintMB || a.name.localeCompare(b.name));
    let freed = 0;
    for (const s of stoppable) {
      if (freed >= deficit) break;
      makeRoom.push({ serviceName: s.name, freesMB: s.footprintMB, reason: "stoppable" });
      freed += s.footprintMB;
    }
  }

  return {
    nodeId,
    totalMB,
    usedMB,
    freeMB,
    servicesUsedMB,
    otherUsedMB,
    services: normalized,
    makeRoom,
    needMakeRoom,
    ...(groupPerSparkMB !== null ? { groupAvailableMB: freeMB } : {}),
    polledAt: Date.now(),
  };
}

// ─── SC3: multi-spark / TP-group resource calculator ───────────────────

/**
 * SC3 bootstrap hardcodes (shared/types.ts → BootstrapComponentEstimate).
 *
 * Seed memory estimates for the calculator, per decision #2 of
 * docs/IMPLEMENTATION_PLAN.md ("Bootstrap with hardcodes (use TP=2
 * qwen38-27b aeon7 + Hasso model), update from real-world testing/runs
 * (after 5 history for avg)"). The UI is UNLOCKED: these seed editable
 * inputs flagged basis:"estimated" until >= 5 proven history runs replace
 * them with measured averages.
 *
 * Values mirror the component definitions they describe
 * (agent/catalog/components/*.json → memory_estimate_mb).
 */
export const BOOTSTRAP_COMPONENTS = [
  {
    id: "qwen38-27b-aeon7-vllm-tp2",
    name: "Qwen3.8-27B aeon7 vLLM (TP=2 pair)",
    tp: 2,
    perSparkMB: 98304,
    basis: "estimated",
    notes:
      "Bootstrap hardcode from the live fleet TP2 pair (gx10-102c/25ed, aeon-vllm-ultimate v0.29.0-omni): ~96 GiB observed per spark at 1M context (IMPLEMENTATION_PLAN.md §1.1). Basis: estimated — refine after 5 history runs.",
  },
  {
    id: "qwen38-27b-stock-sglang-tp1-gx10",
    name: "Qwen3.8-27B NVFP4 + DFlash2 (SGLang, native window)",
    tp: 1,
    perSparkMB: 102400,
    basis: "measured",
    notes:
      "From agent/catalog/components/qwen38-27b-stock-sglang-tp1-gx10.json memory_estimate_mb (measured on Hasso reference GB10: docker cap 100g, mem_fraction 0.50).",
  },
];

/**
 * One spark inside a group plan (shared/types.ts → GroupSparkEntry).
 * @typedef {object} GroupSparkEntry
 * @property {string} nodeId
 * @property {boolean} head
 * @property {number} totalMB
 * @property {number} usedMB
 * @property {number} freeMB
 * @property {number} plannedMB
 * @property {number} projectedFreeMB
 * @property {MakeRoomEntry[]} makeRoom
 * @property {boolean} feasible
 */

/**
 * Group resource plan (shared/types.ts → GroupResourcePlan).
 * @typedef {object} GroupResourcePlan
 * @property {string} groupId
 * @property {number} tp
 * @property {string[]} sparkIds
 * @property {number} perSparkMB
 * @property {number} groupTotalMB
 * @property {number} groupTotalMemMB
 * @property {number} groupUsedMemMB
 * @property {number} groupFreeMemMB
 * @property {number} groupFloorMB
 * @property {GroupSparkEntry[]} sparks
 * @property {boolean} fits
 * @property {boolean} estimated
 */

/**
 * Plan one TP=x service across a spark group.
 *
 * The model: a TP=x service holds the model sharded across exactly x
 * sparks — each spark carries one equal shard (totalEstimateMB / x, so a
 * 192 GB estimate at TP=2 needs 96 GB per spark). Per-spark math is
 * delegated to computeMemoryBudget (same want-floor + greedy make-room
 * rules as single-node budgets), so a group plan is literally x
 * MemoryBudget calls plus a group rollup:
 *
 *  - perSparkMB = ceil(totalEstimateMB / tp)
 *  - want per spark = perSparkMB + floorMB (headroom held back)
 *  - fits = every spark can host its shard after its own make-room plan
 *    (an infeasible spark — computeMemoryBudget's
 *    needMakeRoom=true && makeRoom=[] — makes the group infeasible)
 *  - group aggregates = sums over sparks (total/used/free memory,
 *    groupFloorMB = tp × floorMB)
 *
 * This is the integration seam: `sparks` entries carry the live
 * MemoryBudget-shaped fields (totalMB/usedMB/freeMB/makeRoom) the existing
 * MemoryBudget UI already understands, plus plannedMB/projectedFreeMB for
 * the group view (per-spark breakdown + group total line).
 *
 * @param {{groupId?: string, tp: number, perSparkMB?: number,
 *   totalEstimateMB?: number, basis?: "measured"|"estimated"}} service
 *   the planned service. Per-spark footprint comes from perSparkMB, or is
 *   derived from totalEstimateMB / tp (the bootstrap-estimate path:
 *   component defs store a GROUP total). basis "estimated" marks
 *   bootstrap/estimate numbers (SC10/SC5 read this from history).
 * @param {Array<{nodeId: string, totalMB: number, usedMB: number,
 *   services?: MemoryService[], head?: boolean}>} sparkEntries live
 *   per-spark telemetry (one per group member; order is preserved into
 *   `sparks`).
 * @param {{floorMB?: number}} [opts]
 *   floorMB: per-spark headroom held back (default 0 — pure fit math;
 *   callers apply their own floor policy).
 * @returns {GroupResourcePlan}
 * @throws {TypeError} on a malformed service, tp mismatch against the
 *   spark list, or any value computeMemoryBudget would reject
 */
export function computeGroupMemoryBudget(service, sparkEntries, opts = {}) {
  if (typeof service !== "object" || service === null || Array.isArray(service)) {
    throw new TypeError("service must be an object");
  }
  if (!Number.isInteger(service.tp) || service.tp < 1) {
    throw new TypeError(`service.tp must be an integer >= 1 (got ${JSON.stringify(service.tp)})`);
  }
  const hasPerSpark = isFiniteNumber(service.perSparkMB) && service.perSparkMB >= 0;
  const hasTotal = isFiniteNumber(service.totalEstimateMB) && service.totalEstimateMB >= 0;
  if (!hasPerSpark && !hasTotal) {
    throw new TypeError("service needs a non-negative perSparkMB or totalEstimateMB");
  }
  const perSparkMB = hasPerSpark
    ? service.perSparkMB
    : Math.ceil(service.totalEstimateMB / service.tp);

  if (!Array.isArray(sparkEntries) || sparkEntries.length !== service.tp) {
    throw new TypeError(
      `sparkEntries must be an array of exactly tp=${service.tp} entries (got ${
        Array.isArray(sparkEntries) ? sparkEntries.length : typeof sparkEntries
      })`
    );
  }
  const floorMB = isFiniteNumber(opts?.floorMB) && opts.floorMB >= 0 ? opts.floorMB : 0;

  const sparks = sparkEntries.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(`sparkEntries[${i}] must be an object`);
    }
    const budget = computeMemoryBudget(
      entry.totalMB,
      entry.usedMB,
      Array.isArray(entry.services) ? entry.services : [],
      perSparkMB + floorMB,
      { nodeId: typeof entry.nodeId === "string" && entry.nodeId ? entry.nodeId : `spark-${i}` }
    );
    // Feasible when free already covers the shard, or the make-room plan
    // actually frees enough (needMakeRoom && makeRoom.length===0 is the
    // documented infeasible signal).
    const freed = budget.makeRoom.reduce((sum, m) => sum + m.freesMB, 0);
    const feasible = !budget.needMakeRoom || freed >= perSparkMB + floorMB - budget.freeMB;
    return {
      nodeId: budget.nodeId,
      head: entry.head === true || i === 0,
      totalMB: budget.totalMB,
      usedMB: budget.usedMB,
      freeMB: budget.freeMB,
      plannedMB: perSparkMB,
      projectedFreeMB: budget.freeMB + freed - perSparkMB - floorMB,
      makeRoom: budget.makeRoom,
      feasible,
    };
  });

  const sparkIds = sparks.map((s) => s.nodeId);

  return {
    groupId:
      typeof service.groupId === "string" && service.groupId.length > 0 ? service.groupId : "group",
    tp: service.tp,
    sparkIds,
    perSparkMB,
    groupTotalMB: perSparkMB * service.tp,
    groupTotalMemMB: sparks.reduce((sum, s) => sum + s.totalMB, 0),
    groupUsedMemMB: sparks.reduce((sum, s) => sum + s.usedMB, 0),
    groupFreeMemMB: sparks.reduce((sum, s) => sum + s.freeMB, 0),
    groupFloorMB: floorMB * service.tp,
    sparks,
    fits: sparks.every((s) => s.feasible),
    estimated: service.basis === "estimated",
  };
}
