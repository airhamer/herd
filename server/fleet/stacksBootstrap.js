/**
 * stacksBootstrap.js — SC10 bootstrap + pre-defined stacks handling.
 *
 * Seam (issue #19): input = existing fleet/node records (NodeRecord[] from
 * server/fleet/registry.js) + the hardcoded initial stacks (POC step 1, the
 * Hasso recipes — `bootstrapStacks()` in agent/catalog/stacks-catalog.js,
 * the single source of truth — imported, never duplicated here). Output =
 * stacks available to the stacks UI with `tp` defaulted per landing spot:
 *
 *   tp = 1  — the stack lands on a single machine (standalone node,
 *             single-member group, or no fleet records at all);
 *   tp = x  — the stack lands on a multi-machine group, x = group size.
 *
 * One stack per scope: a fleet of one standalone box and one TP=2 group
 * makes each bootstrap stack available twice — tp1 on the box, tp2 on the
 * group. The bootstrap definition itself never changes; scoping is derived
 * live from the registry, so the list tracks fleet membership with no
 * stored state (same "recompute live" discipline as StackStore.category).
 *
 * Style mirrors server/fleet/componentCatalog.js: plain ESM, dependency-free.
 */

// bootstrapStacks() is pure data (no fs, no side effects at import), so the
// server can import the agent catalog module directly — componentCatalog.js
// already treats agent/catalog/ as shared data, not agent-owned runtime.
import { bootstrapStacks } from "../../agent/catalog/stacks-catalog.js";

/**
 * A landing scope: one machine or one multi-machine group.
 *
 * @typedef {object} StackScope
 * @property {"single"|"group"} type
 * @property {string|null} groupId group id for "group" scopes, else null
 * @property {string[]} nodeIds machine ids in scope ([] = no fleet records)
 */

/**
 * Derive landing scopes from fleet/node records. Grouped records share a
 * `groupId`; a group with ≥2 machines is a multi-machine scope (tp = size).
 * Standalone records and single-member groups are single-machine scopes
 * (tp = 1). No usable records yields one scopeless single-machine scope so
 * the pre-defined stacks stay available (bootstrap works before any node
 * is registered — SC10 "hardcode initial, unlock UI").
 *
 * @param {object[]} nodeRecords NodeRecord[] (registry listNodes output)
 * @returns {StackScope[]} groups first (registry order), then single machines
 */
export function fleetScopes(nodeRecords) {
  const scopes = [];
  const groupOrder = [];
  const byGroup = new Map();
  const singles = [];
  for (const n of Array.isArray(nodeRecords) ? nodeRecords : []) {
    if (!n || typeof n.id !== "string" || n.id.trim() === "") continue;
    if (typeof n.groupId === "string" && n.groupId.trim() !== "") {
      const gid = n.groupId.trim();
      if (!byGroup.has(gid)) {
        byGroup.set(gid, new Map());
        groupOrder.push(gid);
      }
      byGroup.get(gid).set(n.id, true); // dedupe repeated ids within a group
    } else if (!singles.includes(n.id)) {
      singles.push(n.id);
    }
  }
  for (const gid of groupOrder) {
    const nodeIds = [...byGroup.get(gid).keys()];
    if (nodeIds.length >= 2) scopes.push({ type: "group", groupId: gid, nodeIds });
    else singles.push(...nodeIds); // a one-member group is a single machine
  }
  for (const nodeId of singles) scopes.push({ type: "single", groupId: null, nodeIds: [nodeId] });
  if (!scopes.length) scopes.push({ type: "single", groupId: null, nodeIds: [] });
  return scopes;
}

/**
 * Default tensor-parallel size for a scope: 1 for single machine, x =
 * machine count for a multi-machine group. Never below 1.
 *
 * @param {StackScope} scope
 * @returns {number}
 */
export function defaultTpForScope(scope) {
  const size = scope && Array.isArray(scope.nodeIds) ? scope.nodeIds.length : 0;
  return Math.max(1, size);
}

/**
 * SC10 bootstrap output: every pre-defined stack, once per fleet scope,
 * with `tp` defaulted and the landing `target` recorded. Order: stack-major
 * (all scopes of the first stack first) so the UI reads stack-by-stack.
 *
 * @param {object[]} nodeRecords NodeRecord[] from the fleet registry
 * @param {object[]} [stacks] stack definitions (default: bootstrapStacks())
 * @returns {object[]} BootstrapStack = Stack + { tp: number,
 *          target: { groupId: string|null, nodeIds: string[] } }
 */
export function bootstrapStacksForFleet(nodeRecords, stacks = bootstrapStacks()) {
  const scopes = fleetScopes(nodeRecords);
  const out = [];
  for (const stack of Array.isArray(stacks) ? stacks : []) {
    for (const scope of scopes) {
      out.push({
        ...stack,
        tp: defaultTpForScope(scope),
        target: { groupId: scope.groupId ?? null, nodeIds: [...scope.nodeIds] },
      });
    }
  }
  return out;
}

export default { fleetScopes, defaultTpForScope, bootstrapStacksForFleet };
