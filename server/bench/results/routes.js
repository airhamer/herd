/**
 * HTTP API for the bench results store.
 *
 *   GET    /api/bench-results                 list + filter
 *   GET    /api/bench-results/definitions     metric/definition/source catalog
 *   GET    /api/bench-results/compare?baseline=&candidate=
 *   GET    /api/bench-results/references      the published reference registry (BENCH5)
 *   GET    /api/bench-results/upgrade[/runs]  "Upgrade worth it?" run compare (BENCH6, see ../upgrade/routes.js)
 *   GET    /api/bench-results/:id
 *   GET    /api/bench-results/:id/references  nearest published figures, same definition group
 *   POST   /api/bench-results                 add a reference / AEON-pod result
 *   DELETE /api/bench-results/:id
 */

import { makeResult, SCHEMA_VERSION } from "./schema.js";
import { METRICS, SOURCES, ORIGINS, listDefinitions } from "./definitions.js";
import { isRegistryId } from "../references/loader.js";
import { nearestReferences } from "../references/nearest.js";
import { registerUpgradeRoutes } from "../upgrade/routes.js";

const LIST_FILTERS = [
  "run_id",
  "bench",
  "suite",
  "origin",
  "node_id",
  "hw_bucket",
  "model_id",
  "engine",
  "quant",
  "metric",
  "definition",
  "concurrency",
  "context_tokens",
  "since",
  "until",
  "like",
  "limit",
  "offset",
];

function sendError(res, err) {
  res.status(err.status || 500).json({ error: err.message, ...(err.errors ? { errors: err.errors } : {}) });
}

/**
 * @param {import("express").Express} app
 * @param {{ store: import("./store.js").BenchResultsStore, registry?: any, energyWindow?: any }} deps
 *   `registry` is the parsed reference registry (server/bench/references), if loaded.
 *   `energyWindow(nodeId, startMs, endMs)` reads the fleet energy tracker (BENCH6).
 */
export function registerBenchResultsRoutes(app, { store, registry = null, energyWindow = null }) {
  app.get("/api/bench-results", (req, res) => {
    const filter = {};
    for (const k of LIST_FILTERS) {
      const v = req.query[k];
      if (typeof v === "string") filter[k] = v;
    }
    const out = store.list(filter);
    if (out.errors) return res.status(400).json({ error: out.errors.join("; "), errors: out.errors });
    res.json({ schema_version: SCHEMA_VERSION, read_only: store.readOnly, ...out });
  });

  app.get("/api/bench-results/definitions", (_req, res) => {
    res.json({
      schema_version: SCHEMA_VERSION,
      metrics: METRICS,
      sources: SOURCES,
      origins: ORIGINS,
      definitions: listDefinitions(),
    });
  });

  app.get("/api/bench-results/compare", (req, res) => {
    const baseline = typeof req.query.baseline === "string" ? req.query.baseline : "";
    const candidate = typeof req.query.candidate === "string" ? req.query.candidate : "";
    if (!baseline || !candidate) {
      return res.status(400).json({ error: "baseline and candidate result ids are required" });
    }
    try {
      const out = store.compare(baseline, candidate);
      // A refused comparison is a normal answer, not an error:
      // `comparable: false` with the reasons.
      res.json(out);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get("/api/bench-results/references", (_req, res) => {
    const results = [...store.byId.values()]
      .filter((r) => isRegistryId(r.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    res.json({
      loaded: registry !== null,
      registry_version: registry?.registry_version ?? null,
      retrieved_at: registry?.retrieved_at ?? null,
      not_seeded: registry?.not_seeded ?? [],
      entries: (registry?.entries ?? []).map((e) => ({
        id: e.id,
        source: e.source,
        title: e.title,
        url: e.url,
        measured_on: e.measured_on ?? null,
        figures: e.figures.length,
      })),
      total: results.length,
      results,
    });
  });

  registerUpgradeRoutes(app, { store, energyWindow });

  app.get("/api/bench-results/:id", (req, res) => {
    const rec = store.get(req.params.id);
    if (!rec) return res.status(404).json({ error: "Result not found" });
    res.json(rec);
  });

  app.get("/api/bench-results/:id/references", (req, res) => {
    const rec = store.get(req.params.id);
    if (!rec) return res.status(404).json({ error: "Result not found" });
    const limitRaw = typeof req.query.limit === "string" && req.query.limit !== "" ? Number(req.query.limit) : 3;
    if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 50) {
      return res.status(400).json({ error: "limit must be an integer from 1 to 50" });
    }
    res.json(nearestReferences(rec, [...store.byId.values()], { limit: limitRaw }));
  });

  app.post("/api/bench-results", (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Body must be a bench result object" });
    }
    const origin = body.run?.origin;
    if (origin === "herd") {
      return res.status(400).json({
        error: "herd results are recorded by Herd's own benches; POST is for reference or aeon-pod results",
      });
    }
    const runId = body.run?.run_id;
    const rec = makeResult({
      ...body,
      id: body.id ?? (typeof runId === "string" && runId ? `${origin}:${runId}` : null),
      recorded_at: undefined,
    });
    if (isRegistryId(rec.id)) {
      return res.status(409).json({ error: "ids under reference:registry: belong to the reference registry file" });
    }
    try {
      const { id, created } = store.upsert(rec);
      res.status(created ? 201 : 200).json(store.get(id));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.delete("/api/bench-results/:id", (req, res) => {
    if (isRegistryId(req.params.id)) {
      return res.status(409).json({ error: "registry references are managed by server/bench/references/registry.json" });
    }
    try {
      const removed = store.remove({ id: req.params.id });
      if (!removed) return res.status(404).json({ error: "Result not found" });
      res.status(204).end();
    } catch (err) {
      sendError(res, err);
    }
  });
}
