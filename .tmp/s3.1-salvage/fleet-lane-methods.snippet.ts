// S3.1 — hunks for server/fleet/fleet.ts (apply onto the real S3.1-base tree; verify
// anchors from git first). Private names (#agentInvoker, snapshot helpers, addEvent)
// re-checked against the file when applied — these exact hunks measured green
// (fleet suite 211/0 incl. laneActions.test.js, server suite 478/0, tsc 0).

// ── constants, immediately after CONTAINER_UPDATES_MAX ────────────────────────
/** Lane cap per node — mirrors CONTAINERS_MAX on the agent side (S3.1). */
const LANES_MAX = 8;

/** Lane name → snapshot map key: lowercase, [a-z0-9._-], max 64 (S3.1). */
function laneNameOf(name) {
  if (typeof name !== "string") return null;
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 64);
  return slug || null;
}

// ── laneNameOf placement: next to containerName() helper ─────────────────────
// (the function above sits right beside containerName; keep them adjacent)

// ── snapshot hunk inside upsertFromAgentSnapshot ─────────────────────────────
// replaces: const dockerLane = snap.docker_lane ?? snap.docker_container_name ?? null;
const legacyLane = snap.docker_lane ?? snap.docker_container_name ?? null;
const lanes = snap.lanes ?? null;
const laneKey = lanes && Object.keys(lanes).length > 0 ? Object.keys(lanes)[0] : null;
const dockerLane = lanes && laneKey ? (lanes[laneKey]?.name ?? laneKey) : legacyLane;
// …node map keeps docker_lane: dockerLane, and gains: lanes: lanes ?? {},

// ── lane lifecycle methods: after containerUpdate() ──────────────────────────
async function laneCreate(id, opts = {}) {
  if (!requireOnline(id)) return notConnected(id, "lane create");
  const name = laneNameOf(opts.name);
  if (!name) return { id, ok: false, error: "invalid lane name (want [a-z0-9._-], max 64)" };
  const node = nodes.get(id);
  const existing = node?.snapshot?.lanes ?? {};
  if (Object.keys(existing).length >= LANES_MAX && !existing[name])
    return { id, ok: false, error: `lane limit reached (${LANES_MAX})` };
  const res = await call(id, "lane_create", {
    name,
    image: opts.image,
    ports: opts.ports,
    volumes: opts.volumes,
    cpu_limit: opts.cpu_limit,
    mem_limit: opts.mem_limit,
    gpu: opts.gpu,
  });
  await refreshOne(id).catch(() => {});
  return { id, name, ...res };
}

async function laneStart(id, name) {
  if (!requireOnline(id)) return notConnected(id, "lane start");
  const key = laneNameOf(name);
  if (!key) return { id, ok: false, error: "invalid lane name" };
  const res = await call(id, "lane_start", { name: key });
  await refreshOne(id).catch(() => {});
  return { id, name: key, ...res };
}

async function laneStop(id, name) { same shape as laneStart with "lane_stop" }

async function laneRemove(id, name) {
  if (!requireOnline(id)) return notConnected(id, "lane remove");
  const key = laneNameOf(name);
  if (!key) return { id, ok: false, error: "invalid lane name" };
  const res = await call(id, "lane_remove", { name: key });
  if (res.ok) {
    // Mirror the removal server-side: the agent emits lane_deleted and drops the
    // map key, but a dropped event must not strand the lane card (S3.1).
    const node = nodes.get(id);
    if (node?.snapshot?.lanes && node.snapshot.lanes[key]) {
      delete node.snapshot.lanes[key];
      if (node.snapshot.docker_lane === key) node.snapshot.docker_lane = null;
    }
  }
  await refreshOne(id).catch(() => {});
  return { id, name: key, ...res };
}

// ── routes: after the /containers/update route in the returned API object ────
"lane.create": async (id, body) => {
  const errors = [];
  if (typeof body?.node_id !== "string" || !body.node_id) errors.push("node_id required");
  if (typeof body?.name !== "string" || !body.name) errors.push("name required");
  if (typeof body?.image !== "string" || !body.image) errors.push("image required");
  if (errors.length) return { status: 400, error: errors.join("; ") };
  const r = await laneCreate(body.node_id, body);
  if (!r.ok) return laneActionError(r);
  return { status: 200, data: { node_id: r.id, name: r.name, ok: true, container_id: r.id ?? null } };
},
// lane.start / lane.stop: { node_id, name } required → 400 on missing; r.ok false → laneActionError(r)
// lane.remove: { node_id, name } → same guard; ok → { status: 200, data: { node_id, name, ok: true } }
// error mapping (mirrors containerActionError):
function laneActionError(r) {
  if (r.error === "node not connected") return { status: 400, error: `node ${r.id} is not connected` };
  if (r.error?.startsWith("lane limit")) return { status: 409, error: r.error };
  if (r.error?.includes("invalid lane name")) return { status: 400, error: r.error };
  return { status: 500, error: r.error ?? "lane action failed" };
}
// NOTE: verify final wiring against the file's existing route-object shape
// (key style, return contract) — containerUpdate's route is the template.
// Unknown agent request id → 404 was surfaced via { status: 404 } on r.error === "unknown request id" style — re-check exact string from nodeAgent call() path.
