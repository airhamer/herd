/**
 * HTTP API for the "Upgrade worth it?" view (BENCH6, #46).
 *
 *   GET /api/bench-results/upgrade/runs?node_id=&hw_bucket=&bench=&limit=
 *   GET /api/bench-results/upgrade?baseline=<run_id[,run_id]>&candidate=<run_id[,run_id]>
 *
 * Registered before /api/bench-results/:id so "upgrade" is never read as a
 * result id. A refused comparison is a 200 with verdict.code "refused".
 */

import { upgradeCompare } from "./compare.js";
import { listUpgradeRuns } from "./runs.js";

/**
 * @param {import("express").Express} app
 * @param {{ store: any, energyWindow?: ((nodeId: string, startMs: number, endMs: number) => any) | null }} deps
 */
export function registerUpgradeRoutes(app, { store, energyWindow = null }) {
  app.get("/api/bench-results/upgrade/runs", (req, res) => {
    const q = (k) => (typeof req.query[k] === "string" && req.query[k] !== "" ? req.query[k] : undefined);
    const limitRaw = q("limit");
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return res.status(400).json({ error: "limit must be a positive integer" });
    }
    res.json(listUpgradeRuns(store, { node_id: q("node_id"), hw_bucket: q("hw_bucket"), bench: q("bench"), limit }));
  });

  app.get("/api/bench-results/upgrade", (req, res) => {
    const baseline = req.query.baseline;
    const candidate = req.query.candidate;
    if (!baseline || !candidate) {
      return res.status(400).json({ error: "baseline and candidate run ids are required" });
    }
    try {
      res.json(upgradeCompare(store, { baseline, candidate }, { energyWindow }));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
}
