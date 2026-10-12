// ─── Fleet updates proxy (Batch 5, docs/SPEC-UPDATES.md §6, §9) ─────────────
//
// Fan-out GET http://<node endpoint>/updates to each registered node agent
// (parallel, per-node AbortSignal.timeout), and build one NodeUpdatesView
// (shared/types.ts §9) per node. Seam: agent/http.js GET /updates answers
// { snapshot, state, schedules } (agent/updates/dgx.js + scheduler.js);
// this module is the CONSUMER and derives the dashboard-side fields
// (display, graceElapsedMs, waveIndex) per the BATCH5 seam contract.
//
// Graceful degradation (mirrors fleet/connection.js): a node that is
// unreachable, times out, or answers malformed JSON keeps its LAST good view
// and is marked reachable:false. A snapshot is never fabricated — an agent
// that has never answered yields snapshot:null.
//
// Zero dependencies: node built-ins + globalThis.fetch only. ESM.
//
// ── Fleet plan store ─────────────────────────────────────────────────────────
// createPlanStore below owns config/fleet-update-plan.json with the same
// atomic tmp-file+rename discipline as fleet/registry.js: a crash mid-write
// leaves the old file, never a truncated one. Missing file → null (no plan),
// never an error.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

/** Live plan store path (gitignored); env override mirrors registry.js style. */
const DEFAULT_PLAN_PATH =
  process.env.FLEET_UPDATE_PLAN_PATH ||
  path.join(ROOT, "config", "fleet-update-plan.json");

/** Per-node HTTP timeout default (same as fleet/connection.js). */
const TIMEOUT_DEFAULT_MS = 5000;

/** Group reason the dashboard can attest to: the operator ordered the waves. */
const PLAN_REASON_DEFAULT = "manual";

// ── Shared helpers ─────────────────────────────────────────────────────────

/**
 * DgxUpdateState with every declared field present (§9). Used as the
 * "no evidence yet" default for a node that has never answered — fields are
 * null/false, never an invented outcome.
 * @returns {object}
 */
export function defaultUpdateState() {
  return {
    inProgress: false,
    stage: null,
    startedAt: null,
    finishedAt: null,
    bootId: null,
    lastOutcome: null,
    lastOutcomeDetail: null,
    events: [],
  };
}

/**
 * Node-agent /updates URL from a registry NodeRecord. Mirrors
 * fleet/connection.js nodeUrl(): endpoint preferred, lanIp:agentPort fallback,
 * null when unresolvable (never guess 127.0.0.1).
 * @param {import("./registry.js").NodeRecord} node
 * @returns {string | null}
 */
function nodeUpdatesUrl(node) {
  if (node.endpoint && String(node.endpoint).trim()) {
    return `http://${String(node.endpoint).trim()}/updates`;
  }
  if (node.lanIp && String(node.lanIp).trim()) {
    const port = Number.isInteger(node.agentPort) ? node.agentPort : 30091;
    return `http://${String(node.lanIp).trim()}:${port}/updates`;
  }
  return null;
}

/**
 * Per-request abort signal (same pattern as fleet/connection.js):
 * AbortSignal.timeout when available, AbortController fallback otherwise.
 * @param {number} ms
 * @returns {AbortSignal}
 */
function withTimeout(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new Error("timeout")), ms);
  return ctrl.signal;
}

/** First event whose stage mentions a reboot (the grace clock start), or null. */
function firstRebootEventMs(state) {
  const events = Array.isArray(state?.events) ? state.events : [];
  for (const ev of events) {
    if (ev && typeof ev === "object" && /reboot/i.test(String(ev.stage ?? ""))) {
      return Number.isFinite(ev.at) ? ev.at : null;
    }
  }
  return null;
}

// ── updatesProxy ────────────────────────────────────────────────────────────

/**
 * Create the fleet updates proxy.
 *
 * @param {object} [opts]
 * @param {import("./registry.js").NodeRecord[]} opts.nodes registry records
 * @param {(url: string, init?: object) => Promise<Response>} [opts.fetch]
 *   fetch override (tests); defaults to globalThis.fetch resolved at CALL time
 *   (same convention as fleet/connection.js)
 * @param {number} [opts.timeoutMs] per-node HTTP timeout, default 5000
 * @param {import("../../shared/types.ts").FleetUpdatePlan | null} [opts.plan]
 *   active fleet plan (for waveIndex derivation)
 * @param {() => number} [opts.now] clock (tests); default Date.now
 * @returns {{
 *   timeoutMs: number,
 *   getAllViews: () => Promise<object[]>,
 *   buildView: (node: object, raw: object) => object,
 * }}
 */
export function createUpdatesProxy(opts = {}) {
  const { nodes } = opts;
  if (!Array.isArray(nodes)) {
    throw new TypeError("createUpdatesProxy: nodes must be an array");
  }
  const fetchOverride = typeof opts.fetch === "function" ? opts.fetch : null;
  const timeoutMs =
    Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : TIMEOUT_DEFAULT_MS;
  const plan = opts.plan && typeof opts.plan === "object" ? opts.plan : null;
  const clock = typeof opts.now === "function" ? opts.now : () => Date.now();

  /** @type {Map<string, object>} nodeId -> last good NodeUpdatesView */
  const lastViews = new Map();

  /** waveIndex: index of the plan group containing nodeId, else null. */
  function waveIndexFor(nodeId) {
    const groups = Array.isArray(plan?.groups) ? plan.groups : [];
    const idx = groups.findIndex(
      (g) => g && Array.isArray(g.nodeIds) && g.nodeIds.includes(nodeId)
    );
    return idx === -1 ? null : idx;
  }

  /** Display derivation (BATCH5 seam contract, in precedence order). */
  function deriveDisplay(reachable, state, snapshot) {
    if (!reachable) return "stale";
    if (state.inProgress && state.stage === "reboot") return "rebooting";
    if (state.inProgress) return "updating";
    if (state.lastOutcome === "error") return "failed";
    if (snapshot && snapshot.otaAvailable != null) return "available";
    return "current";
  }

  /** graceElapsedMs: now - (first reboot event | startedAt) while rebooting. */
  function graceElapsedFor(state) {
    const base = firstRebootEventMs(state) ?? state.startedAt;
    return Number.isFinite(base) ? clock() - base : null;
  }

  /**
   * Build one NodeUpdatesView from a registry record + raw GET /updates body.
   * THROWS TypeError on a malformed body (not an object / missing state) —
   * getAllViews treats that as unreachable-and-keep-last, per the contract.
   * @param {object} node NodeRecord
   * @param {object} raw { snapshot, state, schedules } from the agent
   * @returns {object} NodeUpdatesView (shared/types.ts §9 shape)
   */
  function buildView(node, raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError("updatesProxy: /updates body is not a JSON object");
    }
    if (!raw.state || typeof raw.state !== "object" || Array.isArray(raw.state)) {
      throw new TypeError("updatesProxy: /updates body is missing its DgxUpdateState");
    }
    const snapshot =
      raw.snapshot && typeof raw.snapshot === "object" && !Array.isArray(raw.snapshot)
        ? raw.snapshot
        : null;
    const state = { ...defaultUpdateState(), ...raw.state };
    if (!Array.isArray(state.events)) state.events = [];
    const schedules = Array.isArray(raw.schedules) ? raw.schedules : [];
    const display = deriveDisplay(true, state, snapshot);
    return {
      nodeId: node.id,
      reachable: true,
      snapshot,
      state,
      schedules,
      display,
      graceElapsedMs: display === "rebooting" ? graceElapsedFor(state) : null,
      waveIndex: waveIndexFor(node.id),
    };
  }

  /**
   * Fetch /updates from every node in parallel (never rejects); build one
   * NodeUpdatesView per registered node. A node that is unreachable, times
   * out, or answers malformed/unparsable JSON keeps its last good view with
   * reachable:false, display:"stale" (re-derived), and its waveIndex fresh.
   * @returns {Promise<object[]>}
   */
  async function getAllViews() {
    const f = fetchOverride || globalThis.fetch;
    if (typeof f !== "function") {
      throw new Error("createUpdatesProxy: no fetch implementation available");
    }
    const settled = await Promise.allSettled(
      nodes.map(async (node) => {
        const url = nodeUpdatesUrl(node);
        if (!url) throw new Error(`no resolvable endpoint for node ${node.id}`);
        const res = await f(url, {
          signal: withTimeout(timeoutMs),
          headers: { Accept: "application/json" },
        });
        if (!res || !res.ok) {
          throw new Error(`GET /updates responded ${res ? res.status : "no response"}`);
        }
        let body;
        try {
          body = await res.json();
        } catch (err) {
          throw new Error(`GET /updates returned malformed JSON: ${err.message}`);
        }
        return buildView(node, body);
      })
    );

    return nodes.map((node, i) => {
      const r = settled[i];
      if (r.status === "fulfilled") {
        lastViews.set(node.id, r.value);
        return { ...r.value };
      }
      const prev = lastViews.get(node.id);
      const base = prev
        ? { ...prev }
        : {
            nodeId: node.id,
            snapshot: null,
            state: defaultUpdateState(),
            schedules: [],
          };
      return {
        ...base,
        reachable: false,
        display: "stale",
        graceElapsedMs: null,
        waveIndex: waveIndexFor(node.id),
      };
    });
  }

  return { timeoutMs, getAllViews, buildView };
}

// ── Fleet plan store ────────────────────────────────────────────────────────

/**
 * Validate + normalize a FleetUpdatePlan (shared/types.ts §9 + BATCH5 store
 * shape). Throws on anything the store would not be able to serve back.
 * @param {object} raw
 * @returns {object} normalized plan
 */
function normalizePlanStrict(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("fleet-update-plan: plan must be an object");
  }
  if (!Array.isArray(raw.groups) || raw.groups.length === 0) {
    throw new TypeError("fleet-update-plan: plan.groups must be a non-empty array");
  }
  const groups = raw.groups.map((g, i) => {
    if (!g || typeof g !== "object" || !Array.isArray(g.nodeIds) || g.nodeIds.length === 0) {
      throw new TypeError(`fleet-update-plan: groups[${i}] needs a non-empty nodeIds array`);
    }
    const nodeIds = g.nodeIds.map((id) => {
      if (typeof id !== "string" || id.trim() === "") {
        throw new TypeError(`fleet-update-plan: groups[${i}] has a non-string node id`);
      }
      return id.trim();
    });
    const reason =
      g.reason === "tp-pair" || g.reason === "standalone" || g.reason === "manual"
        ? g.reason
        : PLAN_REASON_DEFAULT;
    return { nodeIds, reason };
  });
  if (!Number.isFinite(raw.createdAt) || raw.createdAt <= 0) {
    throw new TypeError("fleet-update-plan: plan.createdAt must be a positive epoch-ms number");
  }
  const startedAt = Number.isFinite(raw.startedAt) && raw.startedAt > 0 ? raw.startedAt : null;
  const waveStates = Array.isArray(raw.waveStates)
    ? raw.waveStates.map((s) =>
        ["pending", "running", "rebooting", "slow", "healthy"].includes(s) ? s : "pending"
      )
    : groups.map(() => "pending");
  return { groups, createdAt: raw.createdAt, startedAt, waveStates };
}

/**
 * Atomic JSON write (tmp file + rename), mirroring fleet/registry.js.
 * @param {string} filePath
 * @param {string} content
 */
function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o644 });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* tmp already gone */
    }
    throw err;
  }
}

/**
 * Create the fleet-update-plan store (config/fleet-update-plan.json).
 * Missing/corrupt file → null ("no plan"), never an error (registry.js
 * discipline). write(null) removes the file. Writes are atomic and validated.
 *
 * @param {object} [opts]
 * @param {string} [opts.path] store path (tests: tmp dir)
 * @returns {{ read: () => object | null, write: (plan: object | null) => void, planPath: () => string }}
 */
export function createPlanStore(opts = {}) {
  const target = opts.path || DEFAULT_PLAN_PATH;

  /** @returns {object | null} the stored plan, or null when absent/corrupt */
  function read() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(target, "utf-8"));
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.warn(`[FleetUpdatePlan] Failed to load ${target}: ${err.message}`);
      }
      return null;
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.groups)) {
      if (parsed !== null) {
        console.warn(`[FleetUpdatePlan] Ignoring out-of-shape plan file ${target}`);
      }
      return null;
    }
    return parsed;
  }

  /**
   * Persist (or remove, for null) the plan atomically.
   * @param {object | null} plan
   */
  function write(plan) {
    if (plan === null || plan === undefined) {
      try {
        fs.unlinkSync(target);
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
      return;
    }
    const normalized = normalizePlanStrict(plan);
    atomicWrite(target, JSON.stringify(normalized, null, 2) + "\n");
  }

  return { read, write, planPath: () => target };
}
