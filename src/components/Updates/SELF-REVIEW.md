# Batch 6 — Updates page UI: Pre-Gate Self-Review

Reviewer: batch-6 resume worker (tests+gate+commit). Commit under review: the
uncommitted Batch-6 working tree (steps 1–6 by the implementer), gate 3× identical
green: `npx vitest run` 154/154 (25 files), `npm run typecheck` exit 0,
`node --test server/fleet/__tests__/*.test.js` 106/106.

## Expected inputs / outputs (restated)

- **Inputs:** server §6.1 routes via `src/api/client.ts` (7 updates endpoints,
  ApiError carries status); §9 seam shapes (`NodeUpdatesView`,
  `DgxUpdateSnapshot.sizeBytes` in **bytes**, `FleetUpdatePlan`,
  `ScheduleUpdateRequest`) exactly as emitted by `server/fleet/updatesProxy.js`.
- **Outputs:** Updates table + row expander + ScheduleDialog + PlanDialog + fleet
  badge; refresh cadence 60 s idle / 5 s active; no client-side re-derivation of
  update state; zero new npm deps; zero Date.now() in render paths.
- **Why it matters:** the UI must mirror server truth (a re-derived state would
  contradict the wave sequencer and mislead an operator mid-wave).

## Binding UI Rule → implementation → pinning test

1. **Render server `display`/`graceElapsedMs`, never re-derive.**
   `format.ts:statusLabel` (pure display switch), `UpdateRow` renders it verbatim.
   Pinned: `format.test.ts` "statusLabel — server display passthrough" (stage
   passthrough + fixed labels + *negative*: a current view with a grace value
   still says "current", no SLOW/REBOOTING); `UpdatesPage.test.tsx` "negative: a
   current view never renders SLOW".
2. **Grace copy `REBOOTING 4:12`; at/past 6 min `SLOW 22:41 — firmware may run long`.**
   `format.ts:graceLabel` + `RECOVER_GRACE_MS=360_000` (mirrors server).
   Pinned: `format.test.ts` (known answers 1:00/4:12/22:41; boundary flip at
   exactly 360 000 → SLOW; server-flagged `slow` flips below the window; null
   grace → `…` never a fake number) and `UpdatesPage.test.tsx`
   "graceElapsedMs 252000 renders 'REBOOTING 4:12'" with the injected clock.
3. **409 from trigger → inline notice, exact string.**
   `format.ts:WAVE_LOCK_NOTICE`; `UpdatesPage.runUpdateNow` branches on
   `errStatus(err)===409` (ApiError.status from client.ts); PlanDialog's
   `errText` does the same. Pinned: `format.test.ts` exact-string test;
   `UpdatesPage.test.tsx` "409 → inline WAVE_LOCK_NOTICE (exact string), not the
   server body" (a distinct 409 body string is asserted ABSENT) and "non-409 →
   the server's own message" (message shown, notice absent — both directions).
4. **Schedule dialog: At | Cron toggle, live preview, mirrorCron, list + cancel.**
   `ScheduleDialog.tsx` (aria-pressed toggle, `cron-preview` from
   `describeCron`, recurring auto-suggests mirrorCron, pending-only list,
   per-row cancel). Pinned: `ScheduleDialog.test.tsx` — toggle starts At;
   preview updates live on each keystroke (`0 3 * * 0`→"weekly Sun 03:00",
   `*/15 * * * *`→"every 15 minutes"); invalid cron shows the rejection line and
   disables save (4- and 5-field out-of-range cases) with a negative control
   (valid cron re-enables); cron payload `{kind:"cron",cron,mirrorCron:true}`,
   at payload `{kind:"at",at:Date.parse(same literal),mirrorCron:false}` (exact
   `ScheduleUpdateRequest` shape); checkbox flips mirrorCron→false; list renders
   pending only (cancelled hidden), Cancel DELETEs the right id.
   Cron-preview known answers (every field class + invalid→null): `describeCron.test.ts`,
   15 known-answer cases.
5. **Plan dialog: derive/fetch waves, ordered cards, ▲▼ (no drag lib), Run now =
   POST plan THEN wave-1 triggers, Start-at = wave-1 schedules, DELETE disabled
   while a wave is open.** `PlanDialog.tsx` (`deriveGroups` pure, `storeAndAct`
   awaits `saveUpdatePlan` before acting, `OPEN_WAVE_STATES`).
   Pinned: `PlanDialog.test.tsx` — deriveGroups known answers (lone standalone =
   one wave; tp pair = ONE wave, head first; head/standalone waves sort before
   worker-led); Run now asserts the **call order** (plan POST index < every
   now-POST index), wave-1-only scope (wave-2 `solo` asserted absent), then
   onChanged+onClose; Start-at asserts same ordering with `{kind:"at",at}` bodies
   on wave-1 members only; delete-guard covers all three open states (running /
   rebooting / slow) plus a negative control (all-closed plan → enabled and the
   DELETE actually fires).
6. **Refresh: mount; 60 s idle; 5 s active; ONE interval recreated on mode flip;
   cleared on unmount; fake timers.** `UpdatesPage` single
   `setInterval(…, anyActive ? 5000 : 60000)` effect keyed on `[anyActive, reload]`.
   Pinned: `UpdatesPage.test.tsx` seed-and-diff with `vi.useFakeTimers` —
   idle: no refetch at 5 s, exactly one at 60 s; each of updating/rebooting/slow
   switches to 5 s; full idle→active→idle cycle counts every tick (no double
   interval); unmount → 75 s of advancing produces zero fetches. Zero real
   timers/clocks in any test; all fetches through the recording router.
7. **Detail expander: package/firmware tables; absent snapshot → stale line.**
   `UpdateRow.tsx`. Pinned: `UpdatesPage.test.tsx` — collapsed row hides package
   names (negative), expand shows Package/Firmware tables with versions and the
   2 MiB size known-answer; snapshot-less view → "probe stale/unreachable".
8. **Determinism: no Date.now() in render; injectable clock.**
   `UpdatesPage({now})`→`UpdateRow(now)`; `format.ts`/`describeCron.ts` read no
   clock; `formatEpoch` takes the epoch. Pinned: every component test passes the
   FIXED_NOW prop and asserts exact probe/state text under fake timers.
9. **Badge: single "DGX update available" from display==='available', click → /updates.**
   `FleetUpdatesContext.tsx` + `FleetCard.tsx` button; App wires
   `openUpdates=fleetNavigate({page:"updates"})`. Pinned:
   `FleetCardBadge.test.tsx` (available→badge+click calls openUpdates,
   *negative* current→no badge, plus the route seam both directions:
   `parseFleetPath("/updates")`/`fleetViewToPath`).

## The implementer's 4 declared deviations — verified

1. **describeCron alias-init rewrite** (`DOW_ALIASES`/`MONTH_ALIASES` built via
   forEach over the name arrays instead of literal maps): functionally identical
   (keys uppercase, Sun=0…Sat=6, Jan=1…Dec=12); proven by
   `describeCron.test.ts` name/range cases (`SUN`, `MON,WED`, `SUN-SAT`,
   `FEB-MAR`, bad token → null). **Acceptable.**
2. **types.ts local import** (`export type … from` re-exports do not introduce
   local bindings, so the wrapper interfaces additionally `import type`
   `FleetUpdatePlan`/`NodeUpdatesView`): correct TS semantics, no duplicate type
   source — both come from `shared/types` §9. tsc exit 0 across all 3 gate
   passes. **Acceptable.**
3. **Heredoc rewrites** (files landed by full-content rewrite rather than
   targeted patches): the working tree is the artifact; the committed tree is
   verified by the 3× gate, and diffs vs HEAD touch only the 5 owned
   modified files + the new `src/components/Updates/` directory. **Acceptable.**
4. **Gate wording** (brief gate says `npx tsc --noEmit`; the run uses
   `npm run typecheck`): package.json maps `typecheck` to `tsc --noEmit` — same
   command, repo-canonical spelling. Same exit code semantics used. **Acceptable.**

## Minimal fixes made by this worker (each justified by its test)

1. **`UpdateRow.tsx bytes()` unit bug (the only component fix).** Seam contract:
   §9 `DgxPackageUpdate.sizeBytes` is **bytes**; the shipped helper treated the
   value as MB — the expander test's 2 MiB fixture rendered "2048.0 GB"
   (failing-then-passing witness: fail output quoted in this worker's report).
   Fix: convert bytes→MB inside `bytes()`, one function, call-site unchanged.
   Pinned by "expander renders package and firmware tables" known answer "2.0 MB".
2. **Test-only:** `PlanDialog.test.tsx` `mountDialog` router now consults the
   per-test `extra` route first (the built-in 200 handler was shadowing the 409
   override). Test harness, not component code.

## Seven-point pass

1. **Inputs endangering the project goal:** none beyond the sizeBytes unit bug
   above (wrong-unit display would mislead operators; fixed + pinned).
2. **Inputs breaking this code / seam conformance:** malformed cron → null +
   disabled save (never accommodated); 4-field/6-field/out-of-range crons are
   rejected, not "handled"; `graceElapsedMs:null` renders `…`, not a fabricated
   zero; snapshot-less view shows the stale line. All conform to the §9/§6.1
   contracts — nothing in the components tolerates an out-of-contract shape.
3. **Outputs detrimental across situations:** every fetch is a relative
   same-origin `/api/fleet/...` path via the existing `apiFetch` (auth headers
   inherited); the 5 s cadence only applies while the server itself says active.
4. **Outputs breaking the next package:** client.ts bodies match the server
   routes exactly (`{groups}` plan POST, `{kind,at|cron,mirrorCron}` schedule
   POST) — asserted byte-exactly against `ScheduleUpdateRequest`; wave ordering
   uses server-echoed `saved.plan.groups[0].nodeIds` (falls back to local
   `groups[0]` only if the echo lacks it, mirroring the route contract).
5. **Optimal → optimal:** single interval, single provider fetch, pure
   `deriveGroups` reused by both derive and delete-reset paths.
6. **Degenerate input → no bad output:** zero views → "No fleet nodes
   registered."; empty groups → "No fleet nodes to plan." + disabled Run now;
   NaN at → Start-at disabled (asserted).
7. **Out-of-bounds → explanatory error:** API failures render their message in
   role=alert before any further action (loadError banner + row/dialog notices);
   the badge fetch failure degrades silently by design (best-effort comment in
   FleetUpdatesContext).

## Honest notes

- The brief's gate note expected "~260-ish" pre-existing tests; the repo's full
  vitest suite is 154 total (58 new + 96 pre-existing). Identical across all
  3 gate passes; reported as-is, not explained by anything I touched.
- No `@testing-library` in the repo (zero new deps allowed): tests use the
  repo's own `src/testing/render` harness + `act`, which is the established
  style (AddSparkDialog.test.tsx precedent).
- DONE is the orchestrator's call; this artifact + commit is the evidence.
