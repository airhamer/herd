// ─── Spark groups (SC5d, issue #75) ─────────────────────────────────────────
//
// User-defined spark groups, edited on the Topology tab (Home page + group
// pages, like app folders on a phone home screen) and persisted to
// config/groups.json. This file is the source of truth for TopologyInfo
// groupId / role / rank / headId once it exists:
//
//   { "version": 1,
//     "switchPresent": false,          // RoCE switch flag — recorded only
//     "groups": [ { "id": "tp2", "name": "tp2",
//                   "members": ["gx10-102c", "gx10-25ed"] } ] }
//
// members[0] is the head (rank 0); the rest are workers, rank = index.
// A group with fewer than 2 members is a page in progress: it is persisted
// (so an empty page survives a reload) but is not active — its node stays
// standalone in the topology and keeps its own Fleet card.
//
// Rules: Sparks (GB10) only, at most MAX_GROUP_SIZE members, a node is in at
// most one group. More than 3 sparks needs a RoCE switch — `switchPresent`
// is stored but NOT implemented; the cap stays at 3 either way.
//
// First run (no groups.json): groups are seeded from the node registry's
// existing groupId designation (the tp2 head+worker pair carries over).
//
// Zero deps; atomic writes (temp + rename) like registry.js / updatesProxy.js.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

export const DEFAULT_GROUPS_PATH = process.env.GROUPS_JSON_PATH || path.join(ROOT, "config", "groups.json");

/** Two or three sparks over direct RoCE cables; a 4th needs a switch (later feature). */
export const MAX_GROUP_SIZE = 3;
/** Groups below this size are pages in progress, not active TP groups. */
export const MIN_ACTIVE_GROUP_SIZE = 2;
/** Hard cap on the number of group pages. */
export const MAX_GROUPS = 32;

const GROUP_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NAME_MAX = 64;
/** Spark naming used by this fleet (GX10 / DGX Spark / GB10). */
const SPARK_NAME_RE = /(^|[^a-z])(gx10|gb10|dgx[ _-]?spark|spark)([^a-z]|$)/i;

export const TOO_MANY_MESSAGE =
  `Groups are limited to ${MAX_GROUP_SIZE} sparks over direct RoCE cables. ` +
  "A group of 4 or more needs a RoCE switch, which is not supported yet.";

/**
 * Is this node a GB10 Spark? Live telemetry wins: a unified-memory GPU is a
 * GB10, an explicitly discrete one is not. Without telemetry, a node whose
 * LAN IP is in the Spark registry (sparks.json) or whose id/name follows the
 * Spark naming counts as one.
 *
 * @param {{ id: string, name?: string, lanIp?: string }} rec registry record
 * @param {{ gpu?: { unifiedMemory?: boolean } | null } | null | undefined} [snap]
 * @param {Set<string>} [sparkLanIps]
 * @returns {{ spark: boolean, reason: string }}
 */
export function sparkEligibility(rec, snap, sparkLanIps) {
  const unified = snap?.gpu?.unifiedMemory;
  if (unified === true) return { spark: true, reason: "GB10 unified-memory GPU" };
  if (unified === false) return { spark: false, reason: "discrete GPU host, not a GB10 Spark" };
  if (rec?.lanIp && sparkLanIps?.has(rec.lanIp)) return { spark: true, reason: "registered Spark" };
  if (SPARK_NAME_RE.test(rec?.id ?? "") || SPARK_NAME_RE.test(rec?.name ?? "")) {
    return { spark: true, reason: "Spark naming" };
  }
  return { spark: false, reason: "not a GB10 Spark" };
}

/**
 * Seed groups from the node registry's groupId designation: every groupId
 * shared by 2+ records becomes a group; head (role "head", else lowest rank)
 * first, then by rank. Members beyond MAX_GROUP_SIZE are left out.
 * @param {Array<object>} nodes registry records
 * @returns {{ version: 1, switchPresent: false, groups: Array<{id: string, name: string, members: string[]}> }}
 */
export function seedGroupsFromNodes(nodes) {
  /** @type {Map<string, object[]>} */
  const byGroup = new Map();
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (!n || typeof n.id !== "string") continue;
    const gid = typeof n.groupId === "string" ? n.groupId.trim() : "";
    if (!gid) continue;
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid).push(n);
  }
  const groups = [];
  for (const [gid, recs] of byGroup) {
    if (recs.length < MIN_ACTIVE_GROUP_SIZE || !GROUP_ID_RE.test(gid)) continue;
    const rankOf = (r) => (Number.isInteger(r.rank) ? r.rank : Number.MAX_SAFE_INTEGER);
    const sorted = recs.slice().sort((a, b) => {
      const ha = a.role === "head" ? 0 : 1;
      const hb = b.role === "head" ? 0 : 1;
      return ha - hb || rankOf(a) - rankOf(b) || a.id.localeCompare(b.id);
    });
    groups.push({ id: gid, name: gid, members: sorted.slice(0, MAX_GROUP_SIZE).map((r) => r.id) });
  }
  return { version: 1, switchPresent: false, groups };
}

/**
 * Validate + normalize a groups document (PUT body or file contents).
 *
 * @param {unknown} doc
 * @param {{ nodes?: Array<{id: string}>, isSpark?: (id: string) => { spark: boolean, reason: string } }} [ctx]
 *   nodes: known registry records (unknown members are rejected when given);
 *   isSpark: eligibility lookup (non-Sparks are rejected when given).
 * @returns {{ ok: true, value: { version: 1, switchPresent: boolean, groups: Array<{id: string, name: string, members: string[]}> } } | { ok: false, errors: string[] }}
 */
export function validateGroups(doc, ctx = {}) {
  const errors = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, errors: ["body must be an object"] };
  if (!Array.isArray(doc.groups)) return { ok: false, errors: ["groups must be an array"] };
  if (doc.switchPresent !== undefined && typeof doc.switchPresent !== "boolean") {
    errors.push("switchPresent must be a boolean");
  }
  if (doc.groups.length > MAX_GROUPS) errors.push(`at most ${MAX_GROUPS} groups`);
  const known = Array.isArray(ctx.nodes) ? new Set(ctx.nodes.map((n) => n.id)) : null;
  const ids = new Set();
  const owner = new Map();
  const groups = [];

  doc.groups.forEach((g, i) => {
    const where = `groups[${i}]`;
    if (!g || typeof g !== "object" || Array.isArray(g)) {
      errors.push(`${where} must be an object`);
      return;
    }
    const id = typeof g.id === "string" ? g.id.trim() : "";
    if (!GROUP_ID_RE.test(id)) {
      errors.push(`${where}.id must be 1-64 chars of a-z, 0-9, ".", "_" or "-"`);
      return;
    }
    if (ids.has(id)) errors.push(`group id "${id}" is used twice`);
    ids.add(id);
    let name = g.name === undefined || g.name === null ? id : g.name;
    if (typeof name !== "string" || name.trim() === "" || name.length > NAME_MAX) {
      errors.push(`group "${id}": name must be 1-${NAME_MAX} chars`);
      name = id;
    }
    if (!Array.isArray(g.members)) {
      errors.push(`group "${id}": members must be an array`);
      return;
    }
    const members = [];
    for (const m of g.members) {
      if (typeof m !== "string" || m === "") {
        errors.push(`group "${id}": member ids must be non-empty strings`);
        continue;
      }
      if (members.includes(m)) {
        errors.push(`group "${id}": ${m} is listed twice`);
        continue;
      }
      if (owner.has(m)) {
        errors.push(`${m} is already in group "${owner.get(m)}"; a node can be in only one group`);
        continue;
      }
      if (known && !known.has(m)) {
        errors.push(`group "${id}": unknown node ${m}`);
        continue;
      }
      if (ctx.isSpark) {
        const e = ctx.isSpark(m);
        if (!e.spark) {
          errors.push(`${m} cannot join group "${id}": only GB10 Spark nodes can be grouped (${e.reason})`);
          continue;
        }
      }
      owner.set(m, id);
      members.push(m);
    }
    if (members.length > MAX_GROUP_SIZE) errors.push(`group "${id}" has ${members.length} sparks. ${TOO_MANY_MESSAGE}`);
    groups.push({ id, name: name.trim(), members });
  });

  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  return { ok: true, value: { version: 1, switchPresent: doc.switchPresent === true, groups } };
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o644 });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

/**
 * The groups store over config/groups.json.
 *   read(nodes) — the stored document; when the file is missing it is seeded
 *                 from `nodes` (and persisted once the registry has nodes).
 *                 A corrupt / out-of-shape file reads as the seed, unpersisted.
 *   write(doc)  — validate (shape only; callers validate eligibility) + persist.
 * @param {{ path?: string }} [opts]
 */
export function createGroupStore(opts = {}) {
  const target = opts.path || DEFAULT_GROUPS_PATH;

  function read(nodes = []) {
    let raw;
    try {
      raw = fs.readFileSync(target, "utf-8");
    } catch (err) {
      if (err.code !== "ENOENT") console.warn(`[Groups] Failed to read ${target}: ${err.message}`);
      const seed = seedGroupsFromNodes(nodes);
      if (err.code === "ENOENT" && Array.isArray(nodes) && nodes.length > 0) {
        try {
          atomicWrite(target, JSON.stringify(seed, null, 2) + "\n");
        } catch (e) {
          console.warn(`[Groups] Failed to persist seeded groups: ${e.message}`);
        }
      }
      return seed;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(`[Groups] Ignoring corrupt ${target}: ${err.message}`);
      return seedGroupsFromNodes(nodes);
    }
    const v = validateGroups(parsed);
    if (!v.ok) {
      console.warn(`[Groups] Ignoring out-of-shape ${target}: ${v.errors.join("; ")}`);
      return seedGroupsFromNodes(nodes);
    }
    return v.value;
  }

  function write(doc) {
    const v = validateGroups(doc);
    if (!v.ok) throw Object.assign(new Error(v.errors.join("; ")), { httpStatus: 400 });
    atomicWrite(target, JSON.stringify(v.value, null, 2) + "\n");
    return v.value;
  }

  return { read, write, path: () => target };
}

/** Active groups only (2..MAX members). */
export function activeGroups(doc) {
  return (doc?.groups ?? []).filter((g) => g.members.length >= MIN_ACTIVE_GROUP_SIZE);
}

/**
 * Overlay the groups onto registry records: members of an active group get
 * groupId = group id, role head (members[0]) / worker, rank = index,
 * headId = members[0] for workers. Every other node becomes standalone
 * (rank/groupId/headId null). Records are copied, never mutated.
 * @template {{ id: string }} T
 * @param {T[]} nodes
 * @param {{ groups: Array<{id: string, members: string[]}> } | null | undefined} doc
 * @returns {T[]}
 */
export function applyGroupsToNodes(nodes, doc) {
  if (!Array.isArray(nodes)) return [];
  if (!doc) return nodes.slice();
  const where = new Map();
  for (const g of activeGroups(doc)) g.members.forEach((m, i) => where.set(m, { g, i }));
  return nodes.map((n) => {
    if (!n || typeof n !== "object") return n;
    const hit = where.get(n.id);
    if (!hit) {
      const { groupName: _drop, ...rest } = n;
      return { ...rest, role: "standalone", rank: null, groupId: null, headId: null };
    }
    const head = hit.g.members[0];
    return {
      ...n,
      role: hit.i === 0 ? "head" : "worker",
      rank: hit.i,
      groupId: hit.g.id,
      groupName: hit.g.name || hit.g.id,
      headId: hit.i === 0 ? null : head,
    };
  });
}
