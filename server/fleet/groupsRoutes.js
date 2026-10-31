// /api/fleet/groups (SC5d, issue #75): the spark grouping edited on the
// Topology tab, plus the computed RoCE plan and its (stubbed) apply.
//
//   GET  /api/fleet/groups             → GroupsView
//   PUT  /api/fleet/groups             → validate, persist config/groups.json → GroupsView
//        body { groups: [{ id, name?, members: string[] }], switchPresent?: boolean }
//   POST /api/fleet/groups/roce-apply  → apply the RoCE plan. Dry run by default:
//        body { dryRun?: boolean = true, confirm?: boolean }
//        dryRun:true  → 200, the plan + the exact per-node commands (none yet)
//        dryRun:false → needs confirm:true (else 400), then 501 "not implemented"
//
// GroupsView = { version, switchPresent, groups, maxGroupSize,
//                nodes: [{ nodeId, name, spark, reason }], plan }

import { buildTopology } from "./topology.js";
import { MAX_GROUP_SIZE, sparkEligibility, validateGroups } from "./groups.js";
import { computeRocePlan, interfacesByNode } from "./rocePlan.js";
import { applyLinkPlan, NOT_IMPLEMENTED_MESSAGE } from "../../agent/actions/roceLinks.js";

/**
 * @param {import("express").Express} app
 * @param {{
 *   store: { read: (nodes: object[]) => object, write: (doc: object) => object },
 *   listNodes: () => Array<{ id: string, name?: string, lanIp?: string, links?: object[] }>,
 *   getSnapshot?: (id: string) => ({ gpu?: { unifiedMemory?: boolean } | null } | null | undefined),
 *   sparkLanIps?: () => Set<string>,
 *   onChange?: (doc: object) => void,
 * }} deps
 */
export function registerGroupRoutes(app, deps) {
  const { store, listNodes } = deps;
  const getSnapshot = deps.getSnapshot ?? (() => null);
  const sparkLanIps = deps.sparkLanIps ?? (() => new Set());

  function context() {
    const nodes = listNodes();
    const ips = sparkLanIps();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const eligibility = new Map(nodes.map((n) => [n.id, sparkEligibility(n, getSnapshot(n.id), ips)]));
    const isSpark = (id) =>
      eligibility.get(id) ?? (byId.has(id) ? { spark: false, reason: "not a GB10 Spark" } : { spark: false, reason: "unknown node" });
    return { nodes, eligibility, isSpark };
  }

  function view(doc, ctx) {
    const plan = computeRocePlan({
      groups: doc,
      links: buildTopology(ctx.nodes).links,
      isSpark: (id) => ctx.isSpark(id).spark,
    });
    return {
      ...doc,
      maxGroupSize: MAX_GROUP_SIZE,
      nodes: ctx.nodes.map((n) => ({
        nodeId: n.id,
        name: n.name || n.id,
        spark: ctx.eligibility.get(n.id).spark,
        reason: ctx.eligibility.get(n.id).reason,
      })),
      plan,
    };
  }

  app.get("/api/fleet/groups", (_req, res) => {
    const ctx = context();
    res.json(view(store.read(ctx.nodes), ctx));
  });

  app.put("/api/fleet/groups", (req, res) => {
    const ctx = context();
    const v = validateGroups(req.body, { nodes: ctx.nodes, isSpark: ctx.isSpark });
    if (!v.ok) {
      res.status(400).json({ error: v.errors.join("; "), errors: v.errors });
      return;
    }
    let saved;
    try {
      saved = store.write(v.value);
    } catch (err) {
      res.status(err.httpStatus ?? 500).json({ error: err.message });
      return;
    }
    try {
      deps.onChange?.(saved);
    } catch (err) {
      console.warn("[Groups] onChange failed:", err.message);
    }
    res.json(view(saved, ctx));
  });

  app.post("/api/fleet/groups/roce-apply", (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
      res.status(400).json({ error: "dryRun must be a boolean" });
      return;
    }
    const dryRun = body.dryRun !== false;
    const ctx = context();
    const doc = store.read(ctx.nodes);
    const { plan } = view(doc, ctx);
    if (!dryRun && body.confirm !== true) {
      res.status(400).json({ error: "applying the RoCE plan to hardware needs confirm: true" });
      return;
    }
    const perNode = [];
    for (const [nodeId, interfaces] of interfacesByNode(plan)) {
      const r = applyLinkPlan({ interfaces, dryRun });
      perNode.push({ nodeId, status: r.status, ...r.body });
    }
    if (!dryRun) {
      res.status(501).json({ ok: false, dryRun: false, implemented: false, error: NOT_IMPLEMENTED_MESSAGE, plan, nodes: perNode });
      return;
    }
    res.json({
      ok: true,
      dryRun: true,
      implemented: false,
      plan,
      nodes: perNode,
      commands: perNode.flatMap((n) => (n.commands ?? []).map((c) => `${n.nodeId}: ${c}`)),
      message: `dry run: no commands would run — ${NOT_IMPLEMENTED_MESSAGE}`,
    });
  });
}
