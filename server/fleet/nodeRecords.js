// ─── GRP1 (#82): one resolution path for a node's spark group ───────────────
//
// config/groups.json (SC5d, server/fleet/groups.js) is the source of truth
// for a node's groupId / groupName / role / rank / headId. The registry
// (config/nodes.json) still stores those keys, but they are only the seed
// read once when groups.json is first created.
//
// Every reader of fleet node records goes through resolvedNodes(): the
// topology build, /api/stacks, GET /api/fleet/nodes, the update-plan waves
// and the Updates rows (both fed by that GET), and Manage Nodes.
//
// GET /api/fleet/nodes returns the records with the resolved values in place
// of the raw ones (same keys, no second copy beside them), so every client
// reads the same group as Topology and Fleet.
//
// Writes: POST / PUT /api/fleet/nodes drop the group keys (withoutGroupFields)
// so the registry can never be edited into disagreeing with groups.json.
// Groups are edited only on the Topology tab (PUT /api/fleet/groups).

import { applyGroupsToNodes } from "./groups.js";

/** Registry keys owned by config/groups.json once it exists. */
export const GROUP_FIELDS = Object.freeze(["role", "rank", "groupId", "headId", "groupName"]);

/**
 * Registry records with the persisted spark groups overlaid.
 * @param {object[]} nodes raw registry records
 * @param {{ read: (nodes: object[]) => any }} groupStore createGroupStore()
 */
export function resolvedNodes(nodes, groupStore) {
  return applyGroupsToNodes(nodes, groupStore.read(nodes));
}

/**
 * Drop the group keys from a node add / update body.
 * @param {Record<string, any> | null | undefined} body
 * @returns {{ body: Record<string, any>, ignored: string[] }}
 */
export function withoutGroupFields(body) {
  const src = body && typeof body === "object" ? body : {};
  const out = { ...src };
  const ignored = [];
  for (const k of GROUP_FIELDS) {
    if (k in out) {
      ignored.push(k);
      delete out[k];
    }
  }
  return { body: out, ignored };
}

/**
 * GET /api/fleet/nodes → { nodes } with the groups overlay applied.
 * @param {import("express").Express} app
 * @param {{ listNodes: () => object[], groupStore: { read: (nodes: object[]) => any } }} deps
 */
export function registerNodeListRoute(app, { listNodes, groupStore }) {
  app.get("/api/fleet/nodes", (_req, res) => {
    res.json({ nodes: resolvedNodes(listNodes(), groupStore) });
  });
}
