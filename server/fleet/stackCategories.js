/**
 * stackCategories.js — SC5a (issue #72): the live category for each
 * pre-defined stack on each landing target.
 *
 * Input:
 * - FleetStack entries from stacksBootstrap.js (a stack plus tp and target).
 * - The component catalog (componentCatalog.js projection).
 * - The node registry and per-node snapshots.
 *
 * Output: every stack gets a `category`, a `categoryReason`, a `perNode`
 * breakdown and its filter `facets`.
 *
 * Engine (decision #1): the single calculator is
 * agent/catalog/stacks-catalog.js `calculateStackCategory`. It is imported
 * here and never duplicated. stacks.js stays untouched as dead code.
 *
 * How a target is categorised, in order:
 * 1. Hard blocks, which win over everything, including proven:
 *    - a member component that is not in the catalog;
 *    - a member whose tp differs from the target's tp (copy-on-tp rule);
 *    - a Spark-only member on a host that is not a Spark.
 * 2. Proven: any target node's SC4 `stackHistory` holds a successful run of
 *    this stack at this tp.
 * 3. Memory, per node: the SC3 budget numbers (snapshot `memory`, else
 *    `mem`) feed the calculator. Memory already held by this stack's own
 *    running members is credited back, because a running stack fits itself.
 *    The worst node decides.
 * 4. When there is no telemetry, or the target has no nodes, the fit is not
 *    checked. The category stays "calculated" and the reason says why.
 *
 * Pure: no fs and no network. The route module supplies the inputs.
 */
import { calculateStackCategory } from "../../agent/catalog/stacks-catalog.js";
import { sparkEligibility } from "./groups.js";

/** LLM purpose vocabulary (decision #2); extendable in the recipe JSON. */
export const LLM_PURPOSES = ["chat", "code", "embed", "decision", "image", "video", "audio", "tts"];

const RANK = { calculated: 0, not_recommended: 1, blocked: 2 };
const GIB = 1024;

const gib = (mb) => `${(mb / GIB).toFixed(1)} GiB`;

/** Memory numbers from a snapshot: the SC3 budget first, else raw mem metrics. */
export function nodeMemory(snap) {
  const m = snap?.memory;
  if (m && Number.isFinite(m.totalMB) && Number.isFinite(m.usedMB)) return { totalMB: m.totalMB, usedMB: m.usedMB };
  const r = snap?.mem;
  if (r && Number.isFinite(r.totalMB) && Number.isFinite(r.usedMB)) return { totalMB: r.totalMB, usedMB: r.usedMB };
  return null;
}

/** True when the node's SC4 history holds a successful run of `stackId` at `tp`. */
export function provenOn(snap, stackId, tp) {
  const h = snap?.stackHistory?.[stackId];
  const entries = Array.isArray(h?.entries) ? h.entries : [];
  return entries.some((e) => e && e.success === true && e.tpSize === tp);
}

/**
 * The filter facets of one stack: its tp plus the union of its members'
 * source, engine and purpose. A missing value reads "unknown" (decision #3).
 */
export function stackFacets(stack, componentsById) {
  const members = stack.componentNames.map((id) => componentsById.get(id)).filter(Boolean);
  const uniq = (xs) => [...new Set(xs)].sort();
  const pick = (c, k) => (typeof c[k] === "string" && c[k].trim() !== "" ? c[k] : "unknown");
  return {
    tp: stack.tp,
    sources: uniq(members.map((c) => pick(c, "recipeSource"))),
    engines: uniq(members.map((c) => pick(c, "engine"))),
    purposes: uniq(members.map((c) => pick(c, "purpose"))),
  };
}

/**
 * Categorise one FleetStack.
 *
 * @param {object} stack FleetStack (Stack + tp + target)
 * @param {{ componentsById: Map<string, object>, nodesById: Map<string, object>,
 *           getSnapshot: (id: string) => object|null|undefined,
 *           floorMB?: number }} ctx
 * @returns {object} the stack plus category, categoryReason, perNode and facets
 */
export function categorizeStack(stack, ctx) {
  const { componentsById, nodesById, getSnapshot } = ctx;
  const floorMB = ctx.floorMB ?? 3072;
  const names = [...new Set(stack.componentNames)];
  const members = names.map((id) => componentsById.get(id) ?? null);
  const facets = stackFacets(stack, componentsById);
  const done = (category, categoryReason, perNode = []) => ({ ...stack, category, categoryReason, perNode, facets });

  // 1. Hard blocks that do not depend on a node.
  const missing = names.filter((_, i) => !members[i]);
  if (missing.length) return done("blocked", `not in the component catalog: ${missing.join(", ")}`);
  const wrongTp = members.filter((c) => c.tp !== stack.tp);
  if (wrongTp.length) {
    const c = wrongTp[0];
    return done(
      "blocked",
      `${c.id} is a tp${c.tp} definition and this target needs tp${stack.tp}; it needs a tp${stack.tp} copy (copy-on-tp rule)`
    );
  }

  const nodeIds = stack.target?.nodeIds ?? [];
  if (!nodeIds.length) return done("calculated", "no fleet nodes registered yet; fit not checked");

  const footprintMB = members.reduce((a, c) => a + (c.memoryPerSparkMB ?? 0), 0);
  const noEstimate = members.filter((c) => c.memoryPerSparkMB == null).map((c) => c.id);
  const sparkOnly = members.filter((c) => typeof c.machineClass === "string" && c.machineClass.startsWith("dgx-spark"));

  const perNode = [];
  let proven = false;
  for (const nodeId of nodeIds) {
    const rec = nodesById.get(nodeId) ?? { id: nodeId };
    const snap = getSnapshot(nodeId) ?? null;
    const name = rec.name || nodeId;
    if (sparkOnly.length && snap) {
      const elig = sparkEligibility(rec, snap, new Set());
      if (!elig.spark) {
        perNode.push({ nodeId, category: "blocked", hard: true, reason: `${name}: ${sparkOnly[0].id} needs a DGX Spark (${elig.reason})`, footprintMB, totalMB: null, usedMB: null });
        continue;
      }
    }
    if (provenOn(snap, stack.id, stack.tp)) proven = true;
    const mem = nodeMemory(snap);
    if (!mem) {
      perNode.push({ nodeId, category: "calculated", hard: false, reason: `${name}: no memory telemetry; fit not checked`, footprintMB, totalMB: null, usedMB: null });
      continue;
    }
    // A running member already holds its own memory, so credit it back.
    const runningMB = members
      .filter((c) => (c.nodes ?? []).some((n) => n.nodeId === nodeId && (n.state === "running" || n.state === "ready")))
      .reduce((a, c) => a + (c.memoryPerSparkMB ?? 0), 0);
    const usedMB = Math.max(0, mem.usedMB - runningMB);
    const category = calculateStackCategory(
      members.map((c) => ({ name: c.id, footprintMB: c.memoryPerSparkMB ?? 0 })),
      mem.totalMB,
      floorMB,
      usedMB,
      false
    );
    const usable = Math.max(0, mem.totalMB - floorMB - usedMB - Math.max(2048, Math.floor(mem.totalMB * 0.08)));
    const fit = `needs ${gib(footprintMB)} per spark, ${gib(usable)} usable on ${name}`;
    const reason =
      category === "blocked"
        ? `does not fit: ${fit}`
        : category === "not_recommended"
          ? `tight fit (>80% of usable): ${fit}`
          : `fits: ${fit}`;
    perNode.push({ nodeId, category, hard: false, reason, footprintMB, totalMB: mem.totalMB, usedMB });
  }

  const hard = perNode.find((p) => p.hard);
  if (hard) return done("blocked", hard.reason, perNode);
  const estNote = noEstimate.length ? ` (no memory estimate for ${noEstimate.join(", ")}; counted as 0)` : "";
  if (proven) return done("proven", `a successful tp${stack.tp} run is recorded in the stack history${estNote}`, perNode);
  const worst = perNode.reduce((w, p) => (RANK[p.category] > RANK[w.category] ? p : w), perNode[0]);
  return done(worst.category, worst.reason + estNote, perNode);
}

/**
 * Categorise a FleetStack list and collect the filter-bar options.
 * @returns {{ stacks: object[], facets: { tp: number[], sources: string[], engines: string[], purposes: string[] } }}
 */
export function categorizeStacks(stacks, ctx) {
  const out = (Array.isArray(stacks) ? stacks : []).map((s) => categorizeStack(s, ctx));
  const all = (k) => [...new Set(out.flatMap((s) => s.facets[k]))].sort();
  return {
    stacks: out,
    facets: {
      tp: [...new Set(out.map((s) => s.tp))].sort((a, b) => a - b),
      sources: all("sources"),
      engines: all("engines"),
      purposes: all("purposes"),
    },
  };
}

export default { LLM_PURPOSES, nodeMemory, provenOn, stackFacets, categorizeStack, categorizeStacks };
