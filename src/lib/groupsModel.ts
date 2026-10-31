import type { GroupsNode, SparkGroup } from "../api/client";

/**
 * groupsModel — pure edits of the spark grouping on the Topology tab (SC5d,
 * #75). Pages work like a phone home screen: "Home" holds every individual
 * node, each group is its own page. The server re-validates every save
 * (server/fleet/groups.js); these checks give the same answers up front.
 */

/** Two or three sparks over direct RoCE cables; a 4th needs a RoCE switch (later feature). */
export const MAX_GROUP_SIZE = 3;
export const MIN_ACTIVE_GROUP_SIZE = 2;
/** Pseudo page id for Home (individual nodes). */
export const HOME = null;

export type MoveResult = { ok: true; groups: SparkGroup[] } | { ok: false; error: string };

/** The group a node is on, or null for Home. */
export function groupOf(groups: readonly SparkGroup[], nodeId: string): SparkGroup | null {
  return groups.find((g) => g.members.includes(nodeId)) ?? null;
}

/** Nodes on the Home page: every node not in a group, in registry order. */
export function homeNodes(groups: readonly SparkGroup[], nodes: readonly GroupsNode[]): GroupsNode[] {
  return nodes.filter((n) => !groupOf(groups, n.nodeId));
}

/** A fresh empty group page ("+" button): first unused group-N id. */
export function addGroup(groups: readonly SparkGroup[]): { groups: SparkGroup[]; id: string } {
  const ids = new Set(groups.map((g) => g.id));
  let n = 1;
  while (ids.has(`group-${n}`)) n += 1;
  const id = `group-${n}`;
  return { groups: [...groups, { id, name: `Group ${n}`, members: [] }], id };
}

/** Delete a group page; its members go back to Home. */
export function removeGroup(groups: readonly SparkGroup[], id: string): SparkGroup[] {
  return groups.filter((g) => g.id !== id);
}

export function renameGroup(groups: readonly SparkGroup[], id: string, name: string): SparkGroup[] {
  const clean = name.trim().slice(0, 64);
  if (!clean) return groups.slice();
  return groups.map((g) => (g.id === id ? { ...g, name: clean } : g));
}

/**
 * Move a node to a group page (target = group id) or back to Home (null).
 * Refuses non-Sparks and a 4th member, with a message for the user.
 */
export function moveNode(
  groups: readonly SparkGroup[],
  nodes: readonly GroupsNode[],
  nodeId: string,
  target: string | null,
  maxGroupSize = MAX_GROUP_SIZE,
): MoveResult {
  const node = nodes.find((n) => n.nodeId === nodeId);
  if (!node) return { ok: false, error: `Unknown node ${nodeId}.` };
  const from = groupOf(groups, nodeId);
  if ((from?.id ?? null) === target) return { ok: true, groups: groups.slice() };
  const without = groups.map((g) => (g.members.includes(nodeId) ? { ...g, members: g.members.filter((m) => m !== nodeId) } : g));
  if (target === null) return { ok: true, groups: without };
  const dest = without.find((g) => g.id === target);
  if (!dest) return { ok: false, error: `Unknown group ${target}.` };
  if (!node.spark) {
    return { ok: false, error: `${node.name} is not a GB10 Spark (${node.reason}). Only Spark nodes can join a group.` };
  }
  if (dest.members.length >= maxGroupSize) {
    return {
      ok: false,
      error: `${dest.name} already has ${dest.members.length} sparks. Groups are limited to ${maxGroupSize} over direct RoCE cables; a 4th needs a RoCE switch, which isn't supported yet.`,
    };
  }
  return { ok: true, groups: without.map((g) => (g.id === target ? { ...g, members: [...g.members, nodeId] } : g)) };
}

/** Make `nodeId` the head (rank 0) of its group. */
export function setHead(groups: readonly SparkGroup[], groupId: string, nodeId: string): SparkGroup[] {
  return groups.map((g) =>
    g.id === groupId && g.members.includes(nodeId) ? { ...g, members: [nodeId, ...g.members.filter((m) => m !== nodeId)] } : g,
  );
}

/** One-line RoCE summary for a group of `size` sparks. */
export function groupLinkSummary(size: number): string {
  if (size === 2) return "TP2 · 1 link @ 200G";
  if (size === 3) return "TP3 · 3 links @ 100G";
  if (size === 1) return "Add 1–2 more sparks";
  return "Empty page · not active";
}
