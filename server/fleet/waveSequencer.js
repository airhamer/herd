// ─── WaveSequencer (Batch 5, docs/SPEC-UPDATES.md §3.1/§6.2) ────────────────
//
// The wave gate for fleet update plans. Pure derivation: the state source is
// FleetConnection's EXISTING 2-s /telemetry snapshots — this module adds no
// interval, no poller, no cache. Clocks never open gates: a wave advances
// only when ALL its members pass the "fully available" checks (§3.1), so a
// dashboard that was down when a wave finished re-evaluates correctly on
// restart (derived state, not event bookkeeping).
//
// Seam (docs/BATCH5-BRIEF.md §"Seam contracts"):
//   createWaveSequencer({ nodes, connection, plan, now, graceMs }) →
//     getWaveStates(): string[]   // "pending"|"running"|"rebooting"|"slow"|"healthy"
//     isWaveOpen():    boolean    // any member updating / rebooting / slow
//     getCurrentWave(): number|null
//     canAdvance():    boolean    // current wave passed the gate, a wave remains
//     isFullyAvailable(nodeId): boolean
//
// Per-member update state is read from snapshot.updates.state — the mount
// point where the agent's /updates view ({snapshot, state, schedules}) is
// merged into the /telemetry snapshot (SPEC §6.2: "FleetConnection's existing
// 2 s snapshots (agent health, update state, LLM health)"). When the mount is
// absent (telemetry build that predates the updates merge) the gate FAILS
// CLOSED: "fully available" requires evidence, and absence of evidence never
// opens a gate on a possibly-bricked box. LLM health (§3.1 check 4) uses the
// snapshot's existing `llm` metrics (backend != null ⇒ the endpoint answered
// healthily); no llm entries → the check is vacuous ("if available").
//
// Grace (SPEC §6.2, no-intervention): reboot detection is stream stage
// "reboot" OR mid-update reachability loss. graceElapsedMs counts from the
// first reboot event (fallback: update startedAt). At graceMs (default 6 min)
// the wave state flips "rebooting" → "slow". Nothing is ever timed out,
// aborted, or retried — SLOW is display + reporting only.
//
// Zero dependencies; deterministic pure function of (connection, plan, now).

/** Recovery grace window: 6 minutes (SPEC-UPDATES §11 decision 3). */
export const RECOVER_GRACE_MS = 6 * 60_000;

/** Wave states considered "in flight" for the trigger guard (§6.2). */
const OPEN_STATES = ["updating", "rebooting", "slow"];

/**
 * @param {object} [opts]
 * @param {import("./registry.js").NodeRecord[]} [opts.nodes] registry records
 * @param {{ getSnapshot: (id: string) => object | null, isOnline: (id: string) => boolean }} opts.connection
 *   FleetConnection (seam: fleet/connection.js)
 * @param {object | null} [opts.plan] FleetUpdatePlan (shared/types.ts §9)
 * @param {() => number} [opts.now] clock (tests); default Date.now
 * @param {number} [opts.graceMs] grace window, default RECOVER_GRACE_MS
 * @returns {{
 *   getWaveStates: () => string[],
 *   isWaveOpen: () => boolean,
 *   getCurrentWave: () => number | null,
 *   canAdvance: () => boolean,
 *   isFullyAvailable: (nodeId: string) => boolean,
 * }}
 */
export function createWaveSequencer(opts = {}) {
  const { nodes = [], plan = null } = opts;
  if (!Array.isArray(nodes)) {
    throw new TypeError("createWaveSequencer: nodes must be an array");
  }
  const connection = opts.connection;
  if (
    !connection ||
    typeof connection.getSnapshot !== "function" ||
    typeof connection.isOnline !== "function"
  ) {
    throw new TypeError(
      "createWaveSequencer: connection must expose getSnapshot + isOnline"
    );
  }
  const clock = typeof opts.now === "function" ? opts.now : () => Date.now();
  const graceMs =
    Number.isFinite(opts.graceMs) && opts.graceMs > 0 ? opts.graceMs : RECOVER_GRACE_MS;

  const activePlan = plan && typeof plan === "object" && Array.isArray(plan.groups) ? plan : null;
  const groups = activePlan ? activePlan.groups : [];

  /** The agent's DgxUpdateState for a node, or null when evidence is absent. */
  function updateStateOf(nodeId) {
    const snap = connection.getSnapshot(nodeId);
    const updates = snap && typeof snap === "object" ? snap.updates : null;
    const state = updates && typeof updates === "object" ? updates.state : null;
    return state && typeof state === "object" && !Array.isArray(state) ? state : null;
  }

  /**
   * §3.1 check 4: LLM endpoint healthy, from the snapshot's existing llm
   * metrics (no new probe). No llm entries on this node → nothing to check.
   */
  function llmHealthy(nodeId) {
    const snap = connection.getSnapshot(nodeId);
    const llm = Array.isArray(snap?.llm) ? snap.llm : [];
    if (llm.length === 0) return true;
    return llm.every((e) => e && typeof e === "object" && e.backend != null);
  }

  /**
   * The four "fully available" checks (BATCH5 seam contract, §3.1):
   *  1. agent reachable (isOnline)
   *  2. last update outcome === "success"
   *  3. no update in progress
   *  4. LLM endpoint healthy (if the node has LLM metrics)
   * Absent update-state evidence fails checks 2/3 (gate fails closed).
   */
  function isFullyAvailable(nodeId) {
    if (!connection.isOnline(nodeId)) return false; // 1
    const st = updateStateOf(nodeId);
    if (!st) return false; // 2/3: no evidence → not available
    if (st.inProgress === true) return false; // 3
    if (st.lastOutcome !== "success") return false; // 2
    if (!llmHealthy(nodeId)) return false; // 4
    return true;
  }

  /** First reboot event time (grace clock start), fallback startedAt, else null. */
  function rebootBaseMs(st) {
    const events = Array.isArray(st.events) ? st.events : [];
    for (const ev of events) {
      if (ev && typeof ev === "object" && /reboot/i.test(String(ev.stage ?? ""))) {
        return Number.isFinite(ev.at) ? ev.at : null;
      }
    }
    return Number.isFinite(st.startedAt) ? st.startedAt : null;
  }

  /** Is a terminal outcome attributable to this plan (vs an older update)? */
  function outcomeFromThisPlan(st) {
    if (!activePlan || !Number.isFinite(activePlan.startedAt)) return true;
    if (!Number.isFinite(st.finishedAt)) return true; // terminal, untracked → be safe
    return st.finishedAt >= activePlan.startedAt;
  }

  /** Has this member produced an outcome (success OR error) for this plan? */
  function hasOutcomeThisPlan(nodeId) {
    const st = updateStateOf(nodeId);
    return Boolean(st && st.lastOutcome != null && outcomeFromThisPlan(st));
  }

  /**
   * One member's live phase: "updating" | "rebooting" | "slow" | "failed" | "idle".
   * reboot-like = stream stage "reboot" OR reachability loss while inProgress
   * (SPEC §6.2); flips to "slow" once the grace window has elapsed.
   */
  function memberPhase(nodeId) {
    const st = updateStateOf(nodeId);
    const online = connection.isOnline(nodeId);
    if (st && st.inProgress === true) {
      if (st.stage !== "reboot" && online) return "updating";
      const base = rebootBaseMs(st);
      if (base != null && clock() - base >= graceMs) return "slow";
      return "rebooting";
    }
    return "idle";
  }

  /**
   * Live state of one wave. Order matters: a member past grace dominates,
   * then rebooting, then updating; a wave whose members have all passed the
   * gate is "healthy". A wave where a member has produced an outcome for
   * THIS plan but the gate has not opened (failed update, LLM still
   * recovering, outcome unconfirmed) stays "running" — the gate stays shut;
   * the truth about a failure lives in the per-node updates view ("failed").
   * "pending" means untouched by this plan (fireable, or a later wave).
   */
  function waveStateFor(group) {
    const memberIds = Array.isArray(group?.nodeIds) ? group.nodeIds : [];
    if (memberIds.length === 0) return "pending";
    const phases = memberIds.map(memberPhase);
    if (phases.includes("slow")) return "slow";
    if (phases.includes("rebooting")) return "rebooting";
    if (phases.includes("updating")) return "running";
    if (memberIds.every((id) => isFullyAvailable(id))) return "healthy";
    if (memberIds.some((id) => hasOutcomeThisPlan(id))) return "running";
    return "pending"; // nothing of this plan has happened on this wave yet
  }

  /**
   * waveStates for the plan (BATCH5 contract). A stored-but-not-started plan
   * is all "pending" (planned, not running); the trigger guard (isWaveOpen)
   * is member-derived independently, so an update window is still protected.
   * @returns {string[]} one entry per group, same order
   */
  function getWaveStates() {
    if (!activePlan) return [];
    if (!Number.isFinite(activePlan.startedAt)) return groups.map(() => "pending");
    return groups.map((g) => waveStateFor(g));
  }

  /** Trigger guard (§6.2): any member of any wave updating/rebooting/slow. */
  function isWaveOpen() {
    if (!activePlan) return false;
    return groups.some((g) =>
      (Array.isArray(g?.nodeIds) ? g.nodeIds : []).some((id) =>
        OPEN_STATES.includes(memberPhase(id))
      )
    );
  }

  /** Which wave is in flight right now (null if none). */
  function getCurrentWave() {
    if (!activePlan) return null;
    for (let i = 0; i < groups.length; i++) {
      const ids = Array.isArray(groups[i]?.nodeIds) ? groups[i].nodeIds : [];
      if (ids.some((id) => OPEN_STATES.includes(memberPhase(id)))) return i;
    }
    return null;
  }

  /**
   * Can the next wave fire? True iff the plan is started, waves remain, and
   * every wave before the first non-healthy one is "healthy" — i.e. the
   * gate for the next wave is open. A stuck wave ("running" with a failed
   * member, or a member awaiting outcome confirmation) never advances:
   * gates are conditional, not clock-based (§6.2).
   */
  function canAdvance() {
    if (!activePlan || !Number.isFinite(activePlan.startedAt)) return false;
    const states = getWaveStates();
    const idx = states.findIndex((s) => s !== "healthy");
    if (idx === -1) return false; // every wave done — nothing to advance
    return states[idx] === "pending";
  }

  return { getWaveStates, isWaveOpen, getCurrentWave, canAdvance, isFullyAvailable };
}
