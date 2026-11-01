/**
 * stackPreview.js — SC5b (issue #73): a read-only downtime preview for
 * switching one landing target to a stack. Pure: no clock, no network,
 * no side effects.
 *
 * Input: one categorised stack from stackCategories.js, the component
 * catalog joined with live state, node snapshots and an ETA lookup.
 *
 * Building the plan:
 * - Members already running on their node need no step.
 * - Members to start land on the target's first node (the group head comes
 *   first, so for tp>1 the start runs on the head across the group).
 * - Make-room: on every target node, the SC3 calculator `computeMemoryBudget`
 *   is fed the catalog components running there that are not part of this
 *   stack (stoppable). It is asked for the per-spark need plus the same
 *   floor and headroom the category calculator reserves, and its make-room
 *   list becomes the stop steps.
 * - The steps go through SC8 `buildDowntimePreview`: shutdowns first
 *   (reverse dependency order), then startups.
 *
 * Parallelism (decision #3): sequential unless the stack sets
 * `parallel: true`. A parallel stack puts every step in its own SC8 plan
 * stack, so steps in the same phase share one wave.
 *
 * ETA per step comes from the duration store: history once there are 5 or
 * more successful runs, otherwise the flat estimate, and each step is
 * labelled with its source. A wave lasts as long as its slowest step; the
 * total is the sum of the waves.
 */
import { computeMemoryBudget } from "../../agent/catalog/memory.js";
import { buildDowntimePreview } from "./downtimeSequencer.js";
import { nodeMemory } from "./stackCategories.js";

const MB = 1024 * 1024;
const FLOOR_MB = 3072;
const isRunning = (state) => state === "running" || state === "ready";

/** Same reservation the category calculator makes: floor + max(2 GiB, 8%). */
export function reserveMB(totalMB) {
  return FLOOR_MB + Math.max(2048, Math.floor(totalMB * 0.08));
}

/**
 * @param {object} stack CategorizedStack (one target)
 * @param {{ components: object[], getSnapshot: (id: string) => object|null|undefined,
 *           eta: (componentId: string, type: string) => { ms: number, source: string, runs: number } }} ctx
 */
export function buildStackPreview(stack, ctx) {
  const byId = new Map(ctx.components.map((c) => [c.id, c]));
  const nodeIds = stack.target?.nodeIds ?? [];
  const notes = [];
  const members = [...new Set(stack.componentNames)];
  const head = nodeIds[0] ?? null;

  const runningOn = (c, nodeId) => (c?.nodes ?? []).some((n) => n.nodeId === nodeId && isRunning(n.state));
  const alreadyRunning = [];
  const toStart = [];
  for (const id of members) {
    const c = byId.get(id);
    if (head && runningOn(c, head)) alreadyRunning.push({ componentId: id, nodeId: head });
    else toStart.push(id);
  }
  const needPerSparkMB = toStart.reduce((a, id) => a + (byId.get(id)?.memoryPerSparkMB ?? 0), 0);

  // Make-room per target node through the SC3 calculator.
  const stops = [];
  const unmet = [];
  let targetFreeMB = 0;
  for (const nodeId of nodeIds) {
    const mem = nodeMemory(ctx.getSnapshot(nodeId));
    if (!mem) {
      notes.push(`${nodeId}: no memory telemetry; make-room not computed`);
      continue;
    }
    const stoppable = ctx.components
      .filter((c) => !members.includes(c.id) && runningOn(c, nodeId))
      .map((c) => ({ name: c.id, kind: c.kind, footprintMB: c.memoryPerSparkMB ?? 0, running: true, needed: false }));
    const wantMB = toStart.length ? needPerSparkMB + reserveMB(mem.totalMB) : 0;
    const budget = computeMemoryBudget(mem.totalMB, mem.usedMB, stoppable, wantMB, { nodeId });
    if (!budget.needMakeRoom) continue;
    const deficit = wantMB - budget.freeMB;
    targetFreeMB += deficit;
    const freed = budget.makeRoom.reduce((a, m) => a + m.freesMB, 0);
    for (const m of budget.makeRoom) stops.push({ nodeId, component: m.serviceName, action: "stop", freesBytes: m.freesMB * MB });
    if (freed < deficit) {
      unmet.push(nodeId);
      notes.push(
        `${nodeId}: stopping every other catalog component frees ${(freed / 1024).toFixed(1)} of the ${(deficit / 1024).toFixed(1)} GiB needed; memory held outside the catalog cannot be planned`
      );
    }
  }
  if (stack.tp > 1 && toStart.length) notes.push(`tp${stack.tp}: each start runs on ${head} across ${nodeIds.join(" + ")}`);
  if (!toStart.length) notes.push("every member is already running; nothing to start");

  const starts = toStart.map((id) => ({ nodeId: head, component: id, action: "start" }));
  const parallel = stack.parallel === true;
  const steps = [...stops, ...starts];
  const planStacks = parallel
    ? steps.map((s, i) => ({ stackId: `${stack.id}#${i}`, nodes: nodeIds, components: [s] }))
    : [{ stackId: stack.id, nodes: nodeIds, components: steps }];
  const preview = head
    ? buildDowntimePreview({ stacks: planStacks.filter((p) => p.components.length), targetFreeBytes: targetFreeMB * MB })
    : { shutdownSequence: [], startupSequence: [], feasible: false, freeBytesProjected: 0, targetFreeBytes: 0 };
  if (!head) notes.push("no fleet nodes in this target");

  const withEta = (waves) =>
    waves.map((wave) => wave.map((s) => ({ ...s, stackId: stack.id, eta: ctx.eta(s.componentId, s.type) })));
  const shutdownSequence = withEta(preview.shutdownSequence);
  const startupSequence = withEta(preview.startupSequence);
  const waves = [...shutdownSequence, ...startupSequence];
  const totalEtaMs = waves.reduce((a, w) => a + Math.max(0, ...w.map((s) => s.eta.ms)), 0);
  const sources = new Set(waves.flat().map((s) => s.eta.source));
  const totalSource = sources.size === 0 ? "none" : sources.size === 1 ? [...sources][0] : "mixed";

  return {
    stackId: stack.id,
    name: stack.name,
    tp: stack.tp,
    target: stack.target,
    category: stack.category,
    categoryReason: stack.categoryReason,
    parallel,
    alreadyRunning,
    shutdownSequence,
    startupSequence,
    feasible: Boolean(head) && preview.feasible && unmet.length === 0,
    freeBytesProjected: preview.freeBytesProjected,
    targetFreeBytes: preview.targetFreeBytes,
    totalEtaMs,
    totalSource,
    notes,
  };
}

export default { buildStackPreview, reserveMB };
