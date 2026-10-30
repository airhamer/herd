/**
 * lanes.js — derive the lane view from recipes + containers + versions (S3.1).
 *
 * NOTE (2026-10-29): New terminology: "Component" in UI/docs = former "lane" (a loadable serving unit).
 * "Stack" = group of Components. Internal code keeps "lane" for compatibility with deriveLanes etc.
 *
 * Lanes (Components) are LLM serving slots that take turns sharing one GPU pool
 * (docs/EVAL-system-enrollment.md §3/§4.3 — lanes are recipe attributes of
 * an enrolled unit, never systems of their own). This module joins the
 * recipe catalog (which lanes CAN run) with live container/version state
 * (which lane IS running) into the NodeLanes shape (shared/types.ts):
 *
 *   { pools: [ { id, lanes: [ { recipe, modelId, port, order, running,
 *       containerName, state } ] } ],
 *     candidates: [ { containerName, image, ports[], reason } ] }
 *
 * Lane state: running when a live version/container matches the recipe's
 * port/containerName. Candidates: containers NOT matching any lane recipe
 * whose name looks lane-like or whose exposed ports match a lane-recipe
 * port — ADVISORY ONLY, never actionable (a candidate is not a service).
 *
 * Pure function: takes data (arrays or a listRecipes-style getter), touches
 * no fs, no network. Style: dependency-free ESM + JSDoc (agent/catalog/).
 */

/** Schema mirror: RecipeLane.pool — ^[a-z0-9][a-z0-9-]{0,31}$ (recipes.js). */
const LANE_POOL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Candidate heuristic: names that look like lane/engine containers. */
const CANDIDATE_NAME_RE = /^(lane|lanes|vllm|sglang|llama?)[-_]/;

/**
 * The recipe's lane slot when it carries a VALID one. Only kind "llm"
 * recipes may be lanes (validator ignores lane on other kinds with a
 * warning — this mirrors that rule so a mislabeled file degrades the same
 * way in the derived view).
 * @param {unknown} recipe
 * @returns {{pool: string, order: number}|null}
 */
function laneSlotOf(recipe) {
  if (!recipe || typeof recipe !== "object" || recipe.kind !== "llm") return null;
  const lane = recipe.lane;
  if (!lane || typeof lane !== "object" || Array.isArray(lane)) return null;
  if (typeof lane.pool !== "string" || !LANE_POOL_RE.test(lane.pool)) return null;
  if (!Number.isInteger(lane.order) || lane.order < 0) return null;
  return lane;
}

/** Host-side port numbers from a ContainerInfo.ports entry ("8080:8080" | "8080" | text). */
function hostPortsOf(container) {
  const out = [];
  for (const p of Array.isArray(container?.ports) ? container.ports : []) {
    const head = String(p).split(":")[0].trim();
    const n = Number(head);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) out.push(n);
  }
  return out;
}

/**
 * Derive the lane view.
 * @param {{
 *   listRecipes?: import("./recipes.js").Recipe[] | (() => import("./recipes.js").Recipe[]),
 *   containers?: object[],
 *   versions?: object[]
 * }} [input]
 * @returns {{ pools: Array<{id: string, lanes: object[]}>, candidates: object[] }}
 */
export function deriveLanes({ listRecipes, containers = [], versions = [] } = {}) {
  const recipes = Array.isArray(listRecipes)
    ? listRecipes
    : typeof listRecipes === "function"
      ? listRecipes()
      : [];
  const live = Array.isArray(containers) ? containers : [];
  const versionsArr = Array.isArray(versions) ? versions : [];

  // Lane recipes only (kind "llm" + valid lane slot).
  /** @type {Array<{recipe: object, lane: {pool: string, order: number}}>} */
  const laneRecipes = [];
  for (const r of Array.isArray(recipes) ? recipes : []) {
    const lane = laneSlotOf(r);
    if (lane) laneRecipes.push({ recipe: r, lane });
  }
  const lanePorts = new Set(
    laneRecipes.map((e) => e.recipe.port).filter((p) => Number.isInteger(p))
  );

  // A container is claimed by a lane recipe when the recipe names it.
  // (Port collisions deliberately do NOT claim: an unregistered container
  // squatting a lane port is the advisory candidate the spec calls out —
  // its port still feeds the lane's running state below.)
  const claimedByLane = (container) =>
    laneRecipes.some(
      ({ recipe }) =>
        typeof recipe.containerName === "string" &&
        recipe.containerName !== "" &&
        container?.name === recipe.containerName
    );

  // ── pools: lane recipes joined with live state ──────────────────────────
  /** @type {Map<string, object[]>} pool id -> entries */
  const pools = new Map();
  for (const { recipe, lane } of laneRecipes) {
    const container =
      typeof recipe.containerName === "string" && recipe.containerName !== ""
        ? live.find((c) => c && c.name === recipe.containerName) ?? null
        : null;
    // Port-bound containers (not named by the recipe) still say whether the
    // lane port is up — state is "running when a live version/container
    // matches the recipe's port/containerName".
    const portContainers = live.filter((c) =>
      Number.isInteger(recipe.port) ? hostPortsOf(c).includes(recipe.port) : false
    );
    const version =
      versionsArr.find((v) => v && v.port === recipe.port) ?? null;
    const running =
      (container ? container.status === "running" : false) ||
      portContainers.some((c) => c.status === "running") ||
      (version ? version.state === "running" : false);

    const str = (v) => (typeof v === "string" && v !== "" ? v : null);
    const entry = {
      recipe: recipe.name,
      modelId:
        str(version && version.state === "running" ? version.modelId : null) ??
        str(recipe.modelId),
      port: Number.isInteger(recipe.port) ? recipe.port : null,
      order: lane.order,
      running,
      containerName:
        typeof recipe.containerName === "string" && recipe.containerName !== ""
          ? recipe.containerName
          : null,
      state: running ? "running" : "stopped",
    };
    if (!pools.has(lane.pool)) pools.set(lane.pool, []);
    pools.get(lane.pool).push(entry);
  }

  const derivedPools = [...pools.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, entries]) => ({
      id,
      lanes: entries.sort(
        (x, y) => x.order - y.order || String(x.recipe).localeCompare(String(y.recipe))
      ),
    }));

  // ── candidates: lane-like containers with no lane recipe (advisory) ─────
  const candidates = [];
  for (const c of live) {
    if (!c || typeof c !== "object" || typeof c.name !== "string" || !c.name) continue;
    if (claimedByLane(c)) continue;
    const nameLike = CANDIDATE_NAME_RE.test(c.name);
    const portHits = hostPortsOf(c).filter((p) => lanePorts.has(p));
    if (!nameLike && portHits.length === 0) continue;

    const reasons = [];
    if (nameLike) reasons.push("lane-like container name");
    if (portHits.length > 0) reasons.push(`exposes lane-recipe port ${portHits.join(",")}`);
    candidates.push({
      containerName: c.name,
      image: typeof c.image === "string" && c.image !== "" ? c.image : "unknown",
      ports: (Array.isArray(c.ports) ? c.ports : []).map(String),
      reason: reasons.join("; "),
    });
  }

  return { pools: derivedPools, candidates };
}
