// ─── RoCE plan for a spark grouping (SC5d, issue #75) ──────────────────────
//
// Pure: given the grouping and the RoCE links registered between Sparks,
// work out which links (and so which interfaces) should be enabled and at
// what speed:
//   - 2-spark group  → only the link between those two, at full 200G;
//   - 3-spark group  → all three links of the triangle, each at 100G (half
//                      speed: the GB10 port is shared by two peers — a
//                      hardware limitation);
//   - any link not inside an active group (individual sparks, or a cable
//     between a group member and an outsider) → disabled.
//
// The plan is advisory. Applying it is a separate, explicit confirm action
// that defaults to a dry run (server/fleet/groupsRoutes.js →
// agent/actions/roceLinks.js), and there is no verified command path yet.
//
// TODO(later feature): verify physical cabling and link type before
// planning (we trust the registry's links today), and RoCE-switch support
// for groups of 4+ (config flag `switchPresent` is recorded only).

import { activeGroups } from "./groups.js";

export const FULL_SPEED_MBPS = 200000;
export const HALF_SPEED_MBPS = 100000;

/** Per-link speed for a group of `size` sparks over direct cables. */
export function linkSpeedForGroupSize(size) {
  if (size === 2) return FULL_SPEED_MBPS;
  if (size === 3) return HALF_SPEED_MBPS;
  return null;
}

const pairKey = (a, b) => [a, b].sort().join("\u0000");

/**
 * @param {{
 *   groups: { groups: Array<{id: string, members: string[]}> },
 *   links: Array<{from: string, to: string, fromIf?: string|null, toIf?: string|null,
 *                 speedMbps: number|null, transport: string, up: boolean}>,
 *   isSpark?: (id: string) => boolean,
 * }} input  links: deduplicated undirected links (buildTopology().links)
 */
export function computeRocePlan({ groups, links, isSpark = () => true }) {
  const active = activeGroups(groups);
  const groupOf = new Map();
  for (const g of active) for (const m of g.members) groupOf.set(m, g);

  const planLinks = [];
  const seenPairs = new Set();
  for (const l of Array.isArray(links) ? links : []) {
    if (!l || l.transport !== "roce") continue;
    if (!isSpark(l.from) || !isSpark(l.to)) continue;
    const key = pairKey(l.from, l.to);
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    const ga = groupOf.get(l.from);
    const gb = groupOf.get(l.to);
    const inGroup = ga && ga === gb ? ga : null;
    const targetSpeedMbps = inGroup ? linkSpeedForGroupSize(inGroup.members.length) : null;
    const action = inGroup ? "enable" : "disable";
    const currentSpeedMbps = l.speedMbps ?? null;
    const change = inGroup ? !l.up || currentSpeedMbps !== targetSpeedMbps : l.up === true;
    planLinks.push({
      from: l.from,
      to: l.to,
      fromIf: l.fromIf ?? null,
      toIf: l.toIf ?? null,
      groupId: inGroup ? inGroup.id : null,
      action,
      targetSpeedMbps,
      currentSpeedMbps,
      currentUp: l.up === true,
      change,
      reason: inGroup
        ? `${inGroup.id}: ${inGroup.members.length}-spark group, ${targetSpeedMbps / 1000}G per link`
        : "not inside a group: logically disabled",
    });
  }

  const warnings = [];
  const groupSummaries = active.map((g) => {
    const missing = [];
    for (let i = 0; i < g.members.length; i++) {
      for (let j = i + 1; j < g.members.length; j++) {
        if (!seenPairs.has(pairKey(g.members[i], g.members[j]))) missing.push([g.members[i], g.members[j]]);
      }
    }
    for (const [a, b] of missing) {
      warnings.push(`${g.id}: no RoCE link is registered between ${a} and ${b}`);
    }
    return {
      groupId: g.id,
      size: g.members.length,
      tp: g.members.length,
      linkSpeedMbps: linkSpeedForGroupSize(g.members.length),
      expectedLinks: (g.members.length * (g.members.length - 1)) / 2,
      missingLinks: missing,
    };
  });

  /** Interface view: one entry per (node, interface) the plan touches. */
  const interfaces = [];
  for (const l of planLinks) {
    for (const [nodeId, ifName] of [
      [l.from, l.fromIf],
      [l.to, l.toIf],
    ]) {
      if (!ifName) {
        warnings.push(`${l.from}↔${l.to}: interface name on ${nodeId} is not registered`);
        continue;
      }
      interfaces.push({ nodeId, ifName, action: l.action, speedMbps: l.targetSpeedMbps, peer: nodeId === l.from ? l.to : l.from });
    }
  }

  return {
    links: planLinks,
    interfaces,
    groups: groupSummaries,
    changes: planLinks.filter((l) => l.change).length,
    warnings: [...new Set(warnings)],
    todo: [
      "Physical cable and link-type verification is a later feature; the plan trusts the registered links.",
      "RoCE switch support (groups of 4+) is a later feature; groups are capped at 3.",
    ],
  };
}

/** Group a plan's interfaces per node, in the shape POST /roce/apply takes. */
export function interfacesByNode(plan) {
  /** @type {Map<string, Array<{ifName: string, action: string, speedMbps: number|null}>>} */
  const out = new Map();
  for (const i of plan.interfaces) {
    if (!out.has(i.nodeId)) out.set(i.nodeId, []);
    const list = out.get(i.nodeId);
    if (list.some((e) => e.ifName === i.ifName)) continue;
    list.push({ ifName: i.ifName, action: i.action, speedMbps: i.speedMbps });
  }
  return out;
}
