// /api/events (issue #32): read and prune the fleet EventLog.
//
//   GET    /api/events?limit&sparkId&sinceId&beforeId&type&severity
//          → { events (newest first), oldestId, newestId, total }
//   DELETE /api/events?olderThanMs → { removed }
//
// `type` and `severity` take comma-separated lists; a type ending in "."
// is a prefix ("gpu." matches gpu.throttle.start, gpu.clock.capped, …).

export const MAX_EVENTS_LIMIT = 2000;
const SEVERITIES = new Set(["info", "warn", "error", "success"]);
const TYPE_RE = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*\.?$/;
const UNIT_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

const single = (v) => (Array.isArray(v) ? v[v.length - 1] : v);

/** Parse a non-negative integer query value; undefined when absent. */
function intParam(raw, name, issues) {
  const v = single(raw);
  if (v === undefined || v === "") return undefined;
  if (typeof v !== "string" || !/^\d{1,15}$/.test(v)) {
    issues.push(`${name} must be a non-negative integer`);
    return undefined;
  }
  return Number(v);
}

function listParam(raw) {
  const v = single(raw);
  if (typeof v !== "string" || v.trim() === "") return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validate GET /api/events query → { ok, filter } or { ok:false, error }.
 * @param {Record<string, unknown>} query
 */
export function parseEventsQuery(query = {}) {
  const issues = [];
  const limit = intParam(query.limit, "limit", issues);
  if (limit !== undefined && (limit < 1 || limit > MAX_EVENTS_LIMIT)) issues.push(`limit must be 1..${MAX_EVENTS_LIMIT}`);
  const sinceId = intParam(query.sinceId, "sinceId", issues);
  const beforeId = intParam(query.beforeId, "beforeId", issues);
  const rawSpark = single(query.sparkId);
  let sparkId;
  if (rawSpark !== undefined && rawSpark !== "") {
    if (typeof rawSpark !== "string" || !UNIT_RE.test(rawSpark)) issues.push("sparkId is not a valid unit id");
    else sparkId = rawSpark;
  }
  const types = listParam(query.type);
  for (const t of types) if (!TYPE_RE.test(t)) issues.push(`type "${t}" is not a valid event type or prefix`);
  const severities = listParam(query.severity);
  for (const s of severities) if (!SEVERITIES.has(s)) issues.push(`severity must be one of ${[...SEVERITIES].join("|")}`);
  if (issues.length > 0) return { ok: false, error: [...new Set(issues)].join("; ") };
  return {
    ok: true,
    filter: { limit: limit ?? 50, sparkId, sinceId, beforeId, types, severities },
  };
}

/**
 * @param {import("express").Express} app
 * @param {{ eventLog: import("./EventLog.js").EventLog }} deps
 */
export function registerEventRoutes(app, { eventLog }) {
  app.get("/api/events", (req, res) => {
    const parsed = parseEventsQuery(req.query);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    res.json({
      events: eventLog.list(parsed.filter),
      oldestId: eventLog.oldestId(),
      newestId: eventLog.newestId(),
      total: eventLog.size(),
    });
  });

  app.delete("/api/events", (req, res) => {
    const issues = [];
    const olderThanMs = intParam(req.query.olderThanMs, "olderThanMs", issues);
    if (issues.length > 0) return res.status(400).json({ error: issues.join("; ") });
    const removed = eventLog.clear(olderThanMs ? { olderThanMs } : {});
    res.json({ removed });
  });
}
