/**
 * POST /api/bench-results/import/aeon-pod — import one AEON Bench Pod run
 * (BENCH7, runbook in docs/AEON-POD.md).
 *
 * Body:
 *   run              the pod's GET /api/runs/<id> JSON (raw_output may be dropped)
 *   node_id          Herd node the pod benched (Spark id or agent node id)
 *   port             that node's LLM lane port (needed when it has several)
 *   board_status     not_submitted (default) | self_reported | attested
 *   board_url        https link to the run on the AEON board (required for attested)
 *   pod_url          the pod dashboard base URL, kept as the reference link
 *   client_location  local | network (default network: the pod usually runs off-box)
 *   dry_run          true: return the records without storing them
 *
 * Re-importing a pod run replaces its records.
 */

import { fromAeonPodRun } from "./importer.js";
import { validateResult } from "../results/schema.js";

const CLIENT_LOCATIONS = new Set(["local", "network"]);

/**
 * @param {import("express").Express} app
 * @param {{ store: import("../results/store.js").BenchResultsStore,
 *           provenanceFor?: ((nodeId: string, port: number|null) => any) | null }} deps
 *   `provenanceFor` returns Herd's host + lane provenance for a node lane, or
 *   throws an error with `status` (404 unknown node, 400 bad port).
 */
export function registerAeonPodRoutes(app, { store, provenanceFor = null }) {
  app.post("/api/bench-results/import/aeon-pod", (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "Body must be { run, node_id, port?, board_status?, board_url? }" });
    }
    const clientLocation = body.client_location ?? "network";
    if (!CLIENT_LOCATIONS.has(clientLocation)) return res.status(400).json({ error: "client_location must be local or network" });
    let port = null;
    if (body.port != null && body.port !== "") {
      port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: "port must be 1–65535" });
    }
    let provenance = null;
    if (body.node_id != null && body.node_id !== "") {
      if (typeof body.node_id !== "string") return res.status(400).json({ error: "node_id must be a string" });
      if (!provenanceFor) return res.status(501).json({ error: "node provenance is not available on this server" });
      try {
        provenance = provenanceFor(body.node_id, port);
      } catch (err) {
        return res.status(err.status || 400).json({ error: err.message });
      }
    }
    let out;
    try {
      out = fromAeonPodRun(body.run, {
        provenance,
        clientLocation,
        boardStatus: body.board_status ?? undefined,
        boardUrl: body.board_url ?? null,
        podUrl: body.pod_url ?? null,
      });
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
    const invalid = [];
    for (const rec of out.records) {
      const v = validateResult(rec);
      if (!v.ok) invalid.push({ id: rec.id, errors: v.errors });
    }
    if (invalid.length) return res.status(422).json({ error: "pod run produced invalid records", rejected: invalid });
    const summary = {
      run_id: out.run_id,
      suite: out.suite,
      bench: out.bench,
      board_status: out.records[0].settings.aeon_pod.board_status,
      pod_trust_tier: out.records[0].settings.aeon_pod.pod_trust_tier,
      ids: out.records.map((r) => r.id),
      skipped: out.skipped,
      warnings: out.warnings,
    };
    if (body.dry_run === true) return res.json({ ...summary, dry_run: true, records: out.records });
    try {
      const keep = new Set(summary.ids);
      const stale = store.list({ run_id: out.run_id, limit: 1000 }).results.filter((r) => !keep.has(r.id));
      for (const r of stale) store.remove({ id: r.id });
      const written = store.upsertMany(out.records);
      if (written.rejected.length) return res.status(422).json({ error: "store rejected records", rejected: written.rejected });
      res.status(written.added > 0 ? 201 : 200).json({ ...summary, added: written.added, updated: written.updated, removed: stale.length });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
}
