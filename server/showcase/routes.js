/**
 * HTTP API for the fleet Prompt Showcase (SHOW1, #39).
 *
 *   GET    /api/fleet/showcase/targets          every LLM lane (SSH Sparks + agent nodes)
 *   POST   /api/fleet/showcase                  start { laneIds, prompts, maxTokens?, temperature?, thinking?, promptType? } → 202
 *   GET    /api/fleet/showcase                  { active, history, limits }
 *   DELETE /api/fleet/showcase                  clear finished history (409 while running)
 *   GET    /api/fleet/showcase/:sessionId?since=  live poll (appends since last poll) or archived run
 *   DELETE /api/fleet/showcase/:sessionId       cancel
 */

import { FLEET_SHOWCASE_LIMITS } from "./FleetShowcaseManager.js";

/**
 * @param {import("express").Express} app
 * @param {object} deps
 * @param {import("./FleetShowcaseManager.js").FleetShowcaseManager} deps.manager
 * @param {() => any[]} deps.listTargets
 * @param {(target: any) => { lane: any, provenance?: any }} deps.buildLane
 * @param {(target: any) => string | null} [deps.laneBusy]   reason the lane cannot run now, or null
 * @param {(sessionId: string, provenance: { lanes: Record<string, any> }) => void} [deps.noteStart]
 */
export function registerFleetShowcaseRoutes(app, { manager, listTargets, buildLane, laneBusy = () => null, noteStart = () => {} }) {
  app.get("/api/fleet/showcase/targets", (_req, res) => {
    try {
      res.json({ targets: listTargets(), limits: FLEET_SHOWCASE_LIMITS });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/fleet/showcase", (req, res) => {
    const body = req.body || {};
    const laneIds = Array.isArray(body.laneIds) ? body.laneIds.map(String) : null;
    if (!laneIds || laneIds.length === 0) return res.status(400).json({ error: "laneIds is required" });
    const byId = new Map(listTargets().map((t) => [t.laneId, t]));
    const unknown = laneIds.filter((id) => !byId.has(id));
    if (unknown.length) return res.status(400).json({ error: `Unknown lane: ${unknown.join(", ")}` });
    const targets = laneIds.map((id) => byId.get(id));
    for (const t of targets) {
      const reason = laneBusy(t);
      if (reason) return res.status(409).json({ error: `${t.nodeName}:${t.port} — ${reason}` });
    }
    /** @type {Record<string, any>} */
    const provenance = {};
    const lanes = targets.map((t) => {
      const built = buildLane(t);
      if (built.provenance) provenance[t.laneId] = built.provenance;
      return built.lane;
    });
    try {
      const result = manager.start({
        lanes,
        prompts: body.prompts,
        maxTokens: body.maxTokens,
        temperature: body.temperature,
        thinking: body.thinking,
        promptType: body.promptType,
      });
      noteStart(result.sessionId, { lanes: provenance });
      res.status(202).json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get("/api/fleet/showcase", (_req, res) => {
    res.json({ active: manager.getActive(), history: manager.getHistory(), limits: FLEET_SHOWCASE_LIMITS });
  });

  app.delete("/api/fleet/showcase", (_req, res) => {
    try {
      manager.clearHistory();
      res.json({ success: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get("/api/fleet/showcase/:sessionId", (req, res) => {
    const raw = req.query.since;
    const since = raw != null && raw !== "" ? parseInt(String(raw), 10) : null;
    const session = manager.getSession(req.params.sessionId, Number.isInteger(since) ? since : null);
    if (!session) return res.status(404).json({ error: "Fleet showcase session not found" });
    res.json(session);
  });

  app.delete("/api/fleet/showcase/:sessionId", (req, res) => {
    const session = manager.cancel(req.params.sessionId);
    if (!session) return res.status(404).json({ error: "Fleet showcase session not found" });
    res.json(session);
  });
}
