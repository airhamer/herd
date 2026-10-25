# Batch 6 — Updates Page UI (worker brief)

**Repo:** /home/steve/.openclaw/workspace/projects/sparkDash
**Branch:** main (start HEAD `b903d9b` — Batch 5 landed: 7 routes live in server/index.js)
**Model:** vllm/qwen3.8-27b
**Spec:** docs/SPEC-UPDATES.md §6.3 (UI), §6.1 (routes), §6.2 (grace semantics). docs/ is gitignored — expected.

## Goal

Build the Updates page per SPEC §6.3: a fleet table of spark update backends plus a
wave planner. NOT a component matrix — table + dialogs, reusing existing sparkDash UI
patterns (dialogs, toasts, tabs).

## Files YOU OWN

1. `src/components/Updates/**` — NEW directory: `UpdatesPage.tsx`, row component(s),
   `ScheduleDialog.tsx`, `PlanDialog.tsx`, plus `*.test.tsx` vitest tests. Internal
   decomposition is yours.
2. `src/api/client.ts` — EDIT: add the updates API functions
   (`fetchFleetUpdates`, `triggerUpdateNow`, `scheduleUpdate`, `cancelSchedule`,
   `saveUpdatePlan`, `fetchUpdatePlan`, `abandonUpdatePlan`). Mirror existing
   fetchJson/error-surfacing pattern in the file.
3. `src/api/types.ts` — EDIT: add `NodeUpdatesView`, `FleetUpdatePlan`, plan-response
   types mirroring shared/types.ts §9 shapes the server actually returns.
4. `src/hooks/useRoute.ts` — EDIT: add `/updates` route (follow the `topology` pattern).
5. `src/App.tsx` — EDIT: render UpdatesPage on the route + add the tab to the nav.
6. `src/components/OverviewPage/FleetCard.tsx` — EDIT: single "DGX update available"
   badge (from view.display === "available"), click → /updates. Replace nothing else.
7. `src/components/Updates/SELF-REVIEW.md` — NEW: self-review artifact.

## DO NOT TOUCH

`server/**` (Batch 5 just landed — the routes are the seam), `agent/**`,
`shared/types.ts`, `config/**`, `package.json` / lockfile (**zero new npm deps**).

## Read-list (enumerate before writing)

1. `docs/BATCH6-BRIEF.md` (this file)
2. `docs/SPEC-UPDATES.md` — §6.1–§6.3 only (lines ~291–352)
3. `server/index.js` — the 7 updates routes ONLY (~lines 615–810): exact paths, request
   bodies, response shapes, 409 semantics. This is truth over any prose.
4. `server/fleet/updatesProxy.js` — the `{ views: [...] }` response + NodeUpdatesView
   fields (display, graceElapsedMs, waveIndex) as actually emitted
5. `shared/types.ts` — §9 updates types
6. `src/api/client.ts` — existing API-call pattern
7. `src/App.tsx` — page switch + tab nav wiring (see TopologyPage precedent ~lines 14–17, 577)
8. `src/hooks/useRoute.ts` — route union + path mapping
9. `src/components/Topology/TopologyPage.tsx` — page-level structural exemplar
10. `src/components/AddSparkDialog.tsx` — dialog pattern + tests style

## Binding UI rules (from §6.3, trimmed to decisions you must not re-litigate)

- Render server-derived `display` + `graceElapsedMs` — do NOT re-derive state client-side.
- Grace display: `REBOOTING 4:12`; at/past 6 min: `SLOW 22:41 — firmware may run long`.
- 409 from trigger → inline notice "a wave is open; single-node updates are locked until it completes".
- Schedule dialog: mode toggle **At** (one-shot datetime) | **Cron (recurring)** with
  live human-readable preview of the 5-field expression (small pure function + tests —
  e.g. `0 3 * * 0` → "weekly Sun 03:00"; cover every field class + at least one invalid).
  "also install as system cron entry" checkbox → `mirrorCron: true`. Shows resulting
  schedule list + per-schedule cancel.
- Plan dialog ("Update all"): fetch GET plan or derive groups from node roles (tp pairs
  = one group), render wave cards ordered, reorder with ▲▼ buttons (NO drag library),
  "Run now" (POST plan then trigger wave 1 via per-node now routes) or "Start at…"
  (schedule each wave-1 member). DELETE plan button disabled while any wave open
  (waveStates contains running/rebooting/slow).
- Refresh: on mount; 60 s interval while everything idle; 5 s while any view is
  updating/rebooting/slow. ONE interval, recreated on mode change, cleared on unmount.
  Tests must use fake timers.
- Detail expander: package/firmware tables from snapshot fields (render what exists;
  absent → "probe stale/unreachable" line).

## Constraints

- TypeScript strict, plain React (existing hooks/patterns), zero new npm deps.
- Tests: vitest (repo `npx vitest run`), deterministic — vi.useFakeTimers + mocked fetch;
  NEVER hit the real server. Known-answer cron-preview tests. Seed-and-diff for the
  refresh-mode switch (idle→active→idle).
- Deterministic render (no Date.now() in components — take now from a prop/hook injectable in tests).

## Gate (≥3× identical green)

```bash
cd /home/steve/.openclaw/workspace/projects/sparkDash
npx vitest run
npx tsc --noEmit
node --test server/fleet/__tests__/*.test.js   # unchanged; proves you broke nothing server-side
```

Then commit ONLY your owned files: `git add src/components/Updates src/api/client.ts src/api/types.ts src/hooks/useRoute.ts src/App.tsx src/components/OverviewPage/FleetCard.tsx` → commit -m "Batch 6 (updates): Updates page UI + schedule/plan dialogs + fleet badge". No push. Report hash. No DONE (orchestrator's authority).
