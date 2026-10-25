# Batch 5b — dgx fullView defect fix (worker brief)

**Repo:** /home/steve/.openclaw/workspace/projects/sparkDash — branch main, start HEAD `b903d9b`.
**Why:** Gate-findings defect (logged e7f29fb): `createDgxUpdates` (agent/updates/dgx.js)
never returns `fullView`, but `agent/main.js` (~line 408) wires `fullView: () =>
scheduler.fullView()` and `scheduler.js:362` awaits `dgx.fullView()` → production
`GET /updates` would 500. Agent tests hide it by stubbing `fullView` on a fake dgx.
Must be fixed before Batch 7 deploys the agent.

## Files YOU OWN

1. `agent/updates/dgx.js` — EDIT: return block gains `fullView()` composing
   `{ snapshot, state, schedules }` exactly as `scheduler.js:362` consumes it
   (read the consumer FIRST; match its expectation, do not change scheduler).
2. `agent/updates/__tests__/dgx.test.js` — NEW: tests over the REAL `createDgxUpdates`
   with stubbed `fetch` only (no dgx stubbing!) — degraded (no creds) + happy +
   fetch-failure shapes.
3. `agent/updates/__tests__/fullView.integration.test.js` — NEW: wires the REAL
   scheduler + REAL dgx (fetch stubbed) through `scheduler.fullView()` → known-answer
   shape. This is the durable rule: one integration test exercising REAL module wiring.

## DO NOT TOUCH

Everything else, incl. scheduler.js (consumer wins), agent/main.js, server/**, shared/**,
config/**, docs/**. Zero new deps.

## Read-list (5)

1. `agent/updates/scheduler.js` — fullView consumer at ~362 + schedule table API
2. `agent/updates/dgx.js` — current return block, fullView-adjacent accessors
   (getSnapshot/getState/probe caching), degraded()
3. `agent/main.js` — the /updates wiring (~line 408) and http.js contract
4. `agent/http.js` — GET /updates handler shape
5. `agent/updates/__tests__/scheduler.test.js` — existing stub style to NOT repeat for dgx

## Gate (≥3×)

```bash
cd /home/steve/.openclaw/workspace/projects/sparkDash
node --test agent/updates/__tests__/*.test.js
node --test agent/__tests__/*.test.js agent/*/__tests__/*.test.js   # full agent suite, keep it green (was 264 pass pre-Batch-2-updates + scheduler.test)
```

Commit only your 3 files: -m "Batch 5b (updates): dgx fullView export + real-wiring integration test". No push. Report hash + test counts.
