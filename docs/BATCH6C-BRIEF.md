# Batch 6c — WaveSequencer update-state from the proxy cache (telemetry fail-closed fix)

**Authorized by Steve 2026-10-13 08:5x EDT:** "Do the telemetry fix before deploying then go ahead and deploy."
**Depends on:** Batch 6 accepted (`6a9ff85`, docs `f74ebc8`). **Blocks:** Batch 7 (deploy).
**Design ruling (orchestrator, option b of the parked decision):** dashboard-side only. The agent's `/telemetry` payload does NOT carry update state, so `snapshot.updates.state` is always absent in production and the wave gate fails closed forever → trigger-now permanently 409. Fix: the sequencer takes its per-member update state from the dashboard's OWN `/updates` fan-out (updatesProxy), which already fetches exactly that data on every UI refresh. No agent changes.

## Binding design (worker implements exactly this)

1. **`server/fleet/updatesProxy.js`** — cache the fan-out:
   - Every successful fetch of a node's `/updates` view (inside `getAllViews()` and any per-node path) stores that node's view in a `lastViews` map: `nodeId → {state, snapshot, schedules, fetchedAt}`. Failures do NOT clear or overwrite the last good entry for that node.
   - New method on the proxy instance: `getCachedStates()` → plain object `{ [nodeId]: view }` (empty `{}` before any successful fan-out). Sync, no fetch, no throw.

2. **`server/fleet/waveSequencer.js`** — injectable state source, precedence fixed:
   - Seam becomes `createWaveSequencer({ nodes, connection, plan, now, graceMs, updateStates })` where `updateStates` is an OPTIONAL zero-arg function returning `{ [nodeId]: viewLike }` (`viewLike.state` is one of `"idle"|"updating"|"rebooting"|"slow"|"error"|...` per agent contract).
   - Per-member state resolution: `const v = updateStates?.()[nodeId]; state = (v && v.state) ?? snapshot?.updates?.state ?? null`.
   - `null` state keeps ALL existing fail-closed semantics byte-identical (§3.1: absence of evidence never opens the gate). Snapshot-only behavior (when `updateStates` absent or returns empty) must be UNCHANGED — the 106 existing fleet tests must not need edits.
   - Update the header comment block: evidence now comes primarily from the dashboard `/updates` proxy cache; the telemetry-mount fallback stays for a future agent build.

3. **`server/index.js`** — wiring, minimal:
   - `createWaveSequencer({ nodes, connection: fleetConnection, plan, updateStates: () => updatesProxy.getCachedStates() })` (proxy already constructed immediately before the sequencer).
   - Before each production decision point that calls `waveSequencer.isWaveOpen()` (trigger-now and plan-start routes), `await updatesProxy.getAllViews()` once so the cache is fresh at decision time, then run the existing sync checks. Fan-out failure → proceed with last-known cache (fail-closed path already covers it). Keep the diff here under ~15 lines.

4. **Tests** (`server/fleet/__tests__/`):
   - Extend `waveSequencer.test.js`: (a) `updateStates` present, all members `idle` → gate behavior identical to snapshot-available; (b) cache says one member `rebooting` → wave open even when snapshot has no `updates` mount; (c) cache absent + snapshot absent → still fails closed (no evidence); (d) cache STALE-GOOD wins over empty snapshot; (e) precedence: cache state beats snapshot state when both present.
   - `updatesProxy.test.js` (or its existing test file): `getCachedStates()` empty before first fan-out; populated after; failed fan-out keeps previous entries; shape is `{nodeId:{state,...}}`.
   - **Real-wiring integration test** (durable rule — real module wiring, no stubbed exported shapes): import the REAL `createUpdatesProxy` + `createWaveSequencer`, fake node fetch serving `/updates` views, drive `getAllViews()` once, then assert the sequencer's gate uses the cached evidence (open on rebooting, closed on all-idle). No HTTP server needed; inject fetch as Batch 5 tests already do.
   - No real crontab, no real `/api/v1/update_reboot`, no timers beyond existing fake-timer conventions.

## Owned files (touch nothing else)
- `server/fleet/updatesProxy.js`
- `server/fleet/waveSequencer.js`
- `server/index.js`
- `server/fleet/__tests__/waveSequencer.test.js` (+ new `server/fleet/__tests__/updatesWiring.integration.test.js` if cleaner, + updatesProxy test file)
- `docs/BATCH6C-FINDINGS.md` (short: decisions taken, deviations, SELF-REVIEW line per ruling)

FORBIDDEN: `agent/**`, `src/**`, `shared/types.ts`, `config/**`, `package.json`, lockfile, ORCHESTRATION.md, IMPLEMENTATION_PLAN.md. Zero new deps. No destructive git. No push.

## Gate (run 3×, identical, flaky=failed)
`cd repo && node --test server/fleet/__tests__/*.test.js && npx tsc --noEmit`
Fleet count WILL grow beyond 106 (new tests) — every pre-existing test must still pass; report exact counts ×3.

## Commit
`git add <owned paths> && git commit -m 'Batch 6c (updates): sequencer reads update state from proxy fan-out cache (closes telemetry fail-closed gap)'`

## Report format
Commit hash; gate counts ×3; precedence table (cache/snapshot/none) each pinned by which test; any deviation from this brief = NOT-DONE with reason; honest checkpoint if context runs short (finish implementation OR tests, never both half).
