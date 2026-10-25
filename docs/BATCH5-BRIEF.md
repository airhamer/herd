# Batch 5 — Dashboard Routes + WaveSequencer (worker brief)

**Repo:** /home/steve/.openclaw/workspace/projects/sparkDash
**Branch:** main (clean tree at 6559a1d)
**Model:** vllm/qwen3.8-27b
**Spec:** docs/SPEC-UPDATES.md (source of truth; docs/ is gitignored)

## Goal

Build the dashboard-side (Narthex) half of the DGX-update subsystem: a thin
proxy that fans out `GET /updates` to each node agent, a fleet-plan store, and
a WaveSequencer that gates wave-advance on FleetConnection snapshots. Wire the
seven SPEC §6 routes into server/index.js. Unit-test the gate-advance logic and
grace transitions.

## Files YOU OWN (create/edit only these)

1. `server/fleet/updatesProxy.js` — NEW
2. `server/fleet/waveSequencer.js` — NEW
3. `config/fleet-update-plan.json` — NEW (live store; gitignored)
4. `config/fleet-update-plan.example.json` — NEW (committed example)
5. `server/index.js` — EDIT (wire the 7 routes; do not restructure existing routes)
6. `server/fleet/__tests__/updatesProxy.test.js` — NEW
7. `server/fleet/__tests__/waveSequencer.test.js` — NEW
8. `.gitignore` — EDIT (add config/fleet-update-plan.json)

## Files YOU DO NOT TOUCH (seams — read-only)

- `shared/types.ts` — single source of truth for cross-boundary types (§9 already added in 387502a)
- `config/nodes.json` — live registry (gitignored)
- `agent/**` — Batch 2's territory (already done, commit bd34472)
- `server/fleet/connection.js` — FleetConnection (read to understand the seam)
- `server/fleet/registry.js` — NodeRecord CRUD (read to understand the seam)

## Read-list (enumerate before writing)

- `server/fleet/connection.js` — createFleetConnection(nodes): 2s poll, fetch
  injection, onSnapshot/onStatus events, getAllSnapshots(), isOnline(nodeId),
  getSnapshot(nodeId). Per-node timeout 5s.
- `server/fleet/registry.js` — loadNodes(), listNodes(), getNode(id),
  registryPath(). Atomic fs writes. NodeRecord shape.
- `server/index.js` — fleetConnection init (~line 320), buildFleetSnapshot()
  (~line 345), route insertion point (~line 565 "Fleet (node-agent) API").
  Existing /api/fleet/nodes/:id/actions proxy (~line 615) is the fetch pattern
  to mirror.
- `agent/http.js` — GET /updates → updates.fullView() → { snapshot, state, schedules }
- `agent/updates/dgx.js` — fullView shape, degraded() when no credentials,
  probe caching <60s, getSnapshot/getState.
- `agent/updates/scheduler.js` — createUpdateScheduler(opts), parseCron,
  nextCronFire, fullView().
- `shared/types.ts` — DgxUpdateSnapshot, DgxUpdateState, NodeUpdateSchedule,
  NodeUpdatesView, UpdateGroup, FleetUpdatePlan.

## Seam contracts (input/output)

### updatesProxy.js

```js
// Fan out GET /updates to each registered node agent, in parallel, per-node timeout.
// Returns NodeUpdatesView[] (one per registered node).
export function createUpdatesProxy({
  nodes,          // NodeRecord[] from registry.listNodes()
  fetch,          // fetch override (tests); defaults to globalThis.fetch
  timeoutMs,      // per-node HTTP timeout, default 5000
  plan,           // FleetUpdatePlan | null (from fleet-update-plan.json)
  now,            // () => number (tests); default Date.now
}) {
  return {
    // Fetch /updates from each node, build NodeUpdatesView per node.
    // A node that is unreachable, times out, or returns malformed JSON
    // keeps its last view and is marked reachable:false (graceful degradation).
    getAllViews: () => Promise<NodeUpdatesView[]>,
    // Build one NodeUpdatesView from a node record + raw /updates body.
    buildView: (node, raw) => NodeUpdatesView,
  };
}
```

NodeUpdatesView shape (from shared/types.ts):
```ts
{
  nodeId: string;
  reachable: boolean;
  snapshot: DgxUpdateSnapshot | null;
  state: DgxUpdateState;
  schedules: NodeUpdateSchedule[];
  display: "current" | "available" | "updating" | "rebooting" | "slow" | "stale" | "failed";
  graceElapsedMs: number | null;
  waveIndex: number | null;
}
```

Deriving `display`:
- unreachable → "stale"
- state.inProgress and stage === "reboot" → "rebooting"
- state.inProgress (other stages) → "updating"
- state.lastOutcome === "error" → "failed"
- snapshot.otaAvailable != null → "available"
- else → "current"

Deriving `graceElapsedMs`:
- while rebooting/slow: now - state.startedAt (or first reboot event time)
- null otherwise

Deriving `waveIndex`:
- if plan and node is in a group: index of that group in plan.groups
- null if no plan or node not in any group

### waveSequencer.js

```js
// The wave gate. State source = FleetConnection's existing 2s snapshots.
// No new interval, no polling of anything new.
// A wave advances only when ALL its members pass the "fully available" checks.
// Grace: RECOVER_GRACE_MS = 6 * 60_000; at 6 min flip display to "slow".
// Trigger guard: while any wave is open, single-node triggers return 409.
export function createWaveSequencer({
  nodes,          // NodeRecord[]
  connection,     // FleetConnection (for getSnapshot/isOnline)
  plan,           // FleetUpdatePlan | null
  now,            // () => number
  graceMs,        // default 6 * 60_000
}) {
  return {
    // Compute waveStates for the current plan.
    // waveStates[i] = "pending" | "running" | "rebooting" | "slow" | "healthy"
    getWaveStates: () => string[],
    // Is a wave currently open (any member updating/rebooting/slow)?
    isWaveOpen: () => boolean,
    // Which wave index is currently running (null if none)?
    getCurrentWave: () => number | null,
    // Can the next wave advance? (all members of current wave fully available)
    canAdvance: () => boolean,
    // The "fully available" check for one node:
    // 1. Agent reachable (isOnline)
    //  2. Last update outcome = success (from snapshot)
    //  3. No update in progress (state.inProgress === false)
    //  4. LLM endpoint healthy (from snapshot, if available)
    isFullyAvailable: (nodeId) => boolean,
  };
}
```

### fleet-update-plan.json

```json
{
  "groups": [
    { "nodeIds": ["gx10-1c2c"], "reason": "standalone" },
    { "nodeIds": ["gx10-102c", "gx10-25ed"], "reason": "tp-pair" }
  ],
  "createdAt": 0,
  "startedAt": null,
  "waveStates": ["pending", "pending"]
}
```

## The 7 routes (SPEC §6) — wire into server/index.js

1. `GET /api/fleet/updates` → updatesProxy.getAllViews()
2. `POST /api/fleet/nodes/:id/updates/now` → agent dgx-update-now (409 if a wave is open)
3. `POST /api/fleet/nodes/:id/updates/schedule` → agent schedule-update { kind, at|cron, mirrorCron }
4. `DELETE /api/fleet/nodes/:id/updates/schedule/:sid` → agent cancel-schedule
5. `POST /api/fleet/updates/plan` → store { groups: [[nodeId,…], …] }
6. `GET /api/fleet/updates/plan` → current plan + waveStates
7. `DELETE /api/fleet/updates/plan` → abandon plan (only while no wave in-flight)

## Constraints

- Zero npm dependencies; Node built-ins + global fetch/WebSocket only. ESM.
- Plain JS (no TypeScript in server/).
- Mirror the existing /api/fleet/nodes/:id/actions proxy pattern (line 615) for
  the fetch-to-agent routes.
- Unit tests must NOT touch the real crontab or real agents — stub the
  fetch/HTTP layer. Use injected now() for time-dependent tests.
- Grace window: 6 minutes (RECOVER_GRACE_MS = 6 * 60_000).
- Event log: capped ring buffer (~200), persisted, survives reboot (agent-side).
- Schedules: one pending dgx-update per agent; second → 409.
- Degradation: 11000 down/unauth → retain last snapshot, never fabricate.
- Wave gate is state-based (conditional), not clock-based.
- Trigger guard: while any wave is open, single-node triggers return 409.

## Gate (run ≥3× before reporting DONE)

```bash
cd /home/steve/.openclaw/workspace/projects/sparkDash
node --test server/fleet/__tests__/*.test.js
npx tsc --noEmit
```

All tests pass, tsc clean, 3× runs. Then commit.

## Deliverable

A self-review artifact (SELF-REVIEW.md in server/fleet/) documenting:
- What was built
- Gate results (test counts, tsc exit)
- Any rulings needed
- Any deviations from the brief
