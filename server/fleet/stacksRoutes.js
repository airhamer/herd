// /api/stacks (SC10 #19, SC5a #72): the pre-defined stacks per fleet scope,
// each with a live category per landing target, plus the user's saved stacks.
//
//   GET  /api/stacks         → { stacks: CategorizedStack[], facets, errors }
//   POST /api/stacks         → save a user-defined stack in config/stacks.json
//        body { id?, name, componentNames: string[], notes? } → 201 { stack }
//   GET  /api/stacks/export  → the stacks file { version: 1, stacks }
//   POST /api/stacks/import  → merge an external stacks file (incoming wins)
//        body { version, stacks } or Stack[] → merge report
//
// Storage (decision #5 on #72): the dashboard server's config/stacks.json is
// a StackStore (agent/catalog/stacks-catalog.js). On first run it is seeded
// with the bootstrap stacks. Copying it to the nodes is deferred.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { StackStore, validateStack } from "../../agent/catalog/stacks-catalog.js";
import { RECIPE_SOURCES } from "./componentCatalog.js";
import { bootstrapStacksForFleet } from "./stacksBootstrap.js";
import { LLM_PURPOSES, categorizeStacks } from "./stackCategories.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_DASHBOARD_STACKS_PATH =
  process.env.DASHBOARD_STACKS_PATH || path.join(ROOT, "config", "stacks.json");

/** Open the dashboard's stack store. Fail-soft: a read-only disk still serves the stacks. */
export function createDashboardStackStore(file = DEFAULT_DASHBOARD_STACKS_PATH) {
  const store = new StackStore(file, {});
  try {
    store.load();
  } catch (err) {
    store.writable = false;
    store.errors.push(`stacks file not writable: ${err.message}`);
  }
  return store;
}

/** Slug a stack name into a Stack.id. */
export function slugId(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

const union = (a, b) => [...new Set([...a, ...b])];

/**
 * @param {import("express").Express} app
 * @param {{
 *   store: StackStore,
 *   listNodes: () => object[],            // registry records, groups overlaid
 *   getSnapshot: (id: string) => object|null|undefined,
 *   loadComponents: () => object[],      // catalog joined with live state
 * }} deps
 */
export function registerStackRoutes(app, deps) {
  const { store, listNodes, getSnapshot, loadComponents } = deps;

  function view() {
    const nodes = listNodes();
    const components = loadComponents();
    const { stacks, facets } = categorizeStacks(bootstrapStacksForFleet(nodes, store.list()), {
      componentsById: new Map(components.map((c) => [c.id, c])),
      nodesById: new Map(nodes.map((n) => [n.id, n])),
      getSnapshot,
    });
    return {
      stacks,
      facets: {
        ...facets,
        // The full vocabulary is always offered, and seen values extend it.
        sources: union([...RECIPE_SOURCES, "unknown"], facets.sources),
        purposes: union(LLM_PURPOSES, facets.purposes),
      },
      errors: [...store.errors],
    };
  }

  app.get("/api/stacks", (_req, res) => {
    res.json(view());
  });

  app.get("/api/stacks/export", (_req, res) => {
    res.json(store.export());
  });

  app.post("/api/stacks", (req, res) => {
    const body = req.body ?? {};
    const stack = {
      id: typeof body.id === "string" && body.id.trim() ? body.id.trim() : slugId(body.name),
      name: typeof body.name === "string" ? body.name.trim() : "",
      componentNames: Array.isArray(body.componentNames) ? body.componentNames : [],
      category: "calculated",
      ...(typeof body.notes === "string" && body.notes.trim() ? { notes: body.notes.trim() } : {}),
    };
    const errors = validateStack(stack);
    if (errors.length) return res.status(400).json({ error: errors.join("; ") });
    if (!store.writable) return res.status(503).json({ error: "stacks file is not writable" });
    const saved = store.upsert(stack);
    res.status(201).json({ stack: saved });
  });

  app.post("/api/stacks/import", (req, res) => {
    if (!store.writable) return res.status(503).json({ error: "stacks file is not writable" });
    const report = store.mergeExternal(req.body);
    res.json({ added: report.added, replaced: report.replaced, skipped: report.skipped });
  });
}

export default { registerStackRoutes, createDashboardStackStore, slugId, DEFAULT_DASHBOARD_STACKS_PATH };
