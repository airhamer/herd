/**
 * HTTP API for the bench results store.
 *
 *   GET    /api/bench-results                 list + filter
 *   GET    /api/bench-results/definitions     metric/definition/source catalog
 *   GET    /api/bench-results/compare?baseline=&candidate=
 *   GET    /api/bench-results/:id
 *   POST   /api/bench-results                 add a reference / AEON-pod result
 *   DELETE /api/bench-results/:id
 */

import { makeResult, SCHEMA_VERSION } from "./schema.js";
import { METRICS, SOURCES, ORIGINS, listDefinitions } from "./definitions.js";

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
 * @param {{ store: import("./store.js").BenchResultsStore }} deps
 */
export function registerBenchResultsRoutes(app, { store }) {
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

  app.get("/api/bench-results/:id", (req, res) => {
    const rec = store.get(req.params.id);
    if (!rec) return res.status(404).json({ error: "Result not found" });
    res.json(rec);
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
    try {
      const { id, created } = store.upsert(rec);
      res.status(created ? 201 : 200).json(store.get(id));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.delete("/api/bench-results/:id", (req, res) => {
    try {
      const removed = store.remove({ id: req.params.id });
      if (!removed) return res.status(404).json({ error: "Result not found" });
      res.status(204).end();
    } catch (err) {
      sendError(res, err);
    }
  });
}
