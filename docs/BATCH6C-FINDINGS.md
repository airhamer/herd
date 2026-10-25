# Batch 6c — FINDINGS (sequencer reads update state from proxy fan-out cache)

Worker: sparkDash Batch 6c telemetry-fix (subagent). Date: 2026-10-13.
Gate (3×, identical): `node --test server/fleet/__tests__/*.test.js` → **120 tests / 120 pass / 0 fail**; `npx tsc --noEmit` → exit **0**. Baseline before work (verified): 106/106 + tsc 0 at f74ebc8. New tests: 6 (waveSequencer) + 4 (updatesProxy) + 4 (integration) = +14.

## SELF-REVIEW — one line per binding ruling: where implemented + pinning test

1. **updatesProxy lastViews cache + getCachedStates()** — cache write in `getAllViews()` fulfilled branch stores `{...view, fetchedAt: clock()}`; failure branches never touch a node's entry; `getCachedStates()` is sync, plain-object, `{}` pre-fan-out (`server/fleet/updatesProxy.js`). Pinned by: updatesProxy.test.js "6c: getCachedStates surface; empty {} before the first fan-out", "populated after one fan-out; entry shape {state, snapshot, schedules, fetchedAt}", "failed fan-out KEEPS previous entries untouched", "never answered node has NO cache entry".
2. **waveSequencer optional `updateStates`, order cache→snapshot→null, null fails closed byte-identically** — `updateStateOf()` applies the brief's resolution verbatim (`(v && v.state) ?? snapshot?.updates?.state ?? null`) with Batch 5's non-object→null normalization preserved; snapshot-only behavior untouched (106 legacy tests unedited). Pinned by: waveSequencer.test.js 6c(a)–(e) + guard test; legacy fail-closed test "snapshot WITHOUT update state fails CLOSED" still green.
3. **index.js wiring** — `updateStates: () => updatesProxy.getCachedStates()` in `refreshUpdatesLayer()` (arrow re-reads current proxy); one `try { await updatesProxy.getAllViews(); } catch { /* keep last-known */ }` before each of the TWO production `isWaveOpen()` decision points (trigger-now; plan-abandon/DELETE). Diff: 15 insertions / 2 deletions — inside "~15 lines" counting insertions; incl. deletions 17 (flagged below). Pinned by: updatesWiring.integration.test.js (real `createUpdatesProxy`+`real` `createWaveSequencer`, index.js-style wiring, fake fetch; open-on-rebooting / healthy-and-advanceable / fail-closed-when-empty / stale-good-survives-later-failure).
4. **Tests incl. real-wiring integration** — all four files as owned; real modules only, fetch injected per Batch 5 convention; zero timers, zero HTTP servers, zero real endpoints. Pinned by: the full 120/120 gate.

## Precedence table (cache / snapshot / none)

| Cache | Snapshot mount | Resolved state | Pinned by |
|---|---|---|---|
| present view `.state` | any | **cache wins (both directions)** | waveSequencer 6c(e) |
| absent / entry without `.state` | present | snapshot mount | 6c(e) fall-through case + all 106 legacy tests |
| present | absent (production reality) | cache | 6c(a),(b),(d) + integration 1–2 |
| absent | absent | **null → fails CLOSED** | 6c(c), proxy "no cache entry", integration 3 |
| out-of-contract state (string / non-object) | — | normalized to null → fails CLOSED | waveSequencer guard test |

## Deviations & flags (honest ledger)

- **FINDINGS file not in the commit (forced by repo policy, NOT-DONE-by-enforcement):** `docs/` is gitignored repo-wide (`.gitignore:22`); `git add docs/BATCH6C-FINDINGS.md` is rejected without `-f`, and forcing it would contradict the repo's own convention (all batch briefs/findings live on disk only; Batch 5 precedent `b903d9b`). File exists on disk at the owned path for the orchestrator to read.
- **Start condition note (flagged at dispatch, unresolved by design):** HEAD was `f74ebc8` ("Batch 6 ACCEPTED") — the literal start condition expected an 'orchestrator: Batch 6c authorized' commit, which **does not exist in this repo's convention** (orchestrator authorizes via disk-dropped gitignored briefs; no prior batch has an authorize commit). Substantive conditions all verified true (clean tree, brief present, Batch 6 code present at 6a9ff85, authorized base = HEAD). Proceeded on the substantive reading.
- **"plan-start routes" (brief ruling 3):** no start-plan route calls `isWaveOpen()`; the two actual production decision points are trigger-now and plan-abandon (DELETE). Both now refresh the cache — the spirit (every 409-capable decision) is fully covered.
- **Brief seam text `updateStates?.()[nodeId]` vs `state = (v && v.state) ?? …`:** if `updateStates()` returned a non-object, the former throws. Implemented with the safe normalization (null views = no evidence → fails CLOSED); the wiring always returns a plain object from `getCachedStates()`. Pinned negative-tested in 6c(c) (`() => null`).
- **Diff budget 17 touched lines vs "~15":** 15 inserted (all additions; 2 deletions are just the two lines the additions rewrap). Flagged, not stretched.
- **Incidental (not touched):** integration test carries its own minimal fake-node helpers (test files export nothing importable; same self-containment as the existing fleet test files).

## Known-answer / negative-case proof (o-worker rules 7–9)

- fetchedAt stamping: injected clock 500 → cached 500; second fan-out at 900 → re-stamped 900 (known answers).
- Negative cases every where: unresolvable node → no cache entry; all-throw fan-out → empty cache + closed gate end-to-end; string state → closed; no-evidence → closed; blind-wiring regression witnesses inside 6c(b) and integration 1 prove the gate WAS blind pre-fix and is not now.
