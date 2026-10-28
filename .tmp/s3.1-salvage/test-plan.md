# S3.1 lane test plan (16 tests; all measured green in pre-loss tree: lanes 7/7, laneActions 9/9)

## agent/lanes.test.js — 7 tests (injected fake runner; NO network, NO docker CLI)
Use the same fake-runner injection pattern the existing nodeAgent tests use (mirror
containerStart's tests for constructor/event/state API — re-derive from the real nodeAgent.js).

1. laneCreate success: fake `run` returns 64-hex id; assert ok, res.id = first 12 chars,
   state.lanes["my-lane-1"] = {name, container_id: shortId, status:"running", updated_at},
   docker args contain ["run","-d","--pull","always","--label","sparkdash-managed=true",
   "-p","8080:80", …,"--gpus","all", image], event lane_created {id,name,container_id}.
   Input name "My Lane_1" → key "my-lane-1" (sanitizer proof).
2. laneCreate invalid name ("", whitespace-only, "///", non-ascii): ok:false
   "invalid lane name", ZERO docker calls.
3. LANES_MAX: 8 existing stopped lanes → 9th distinct name ok:false /lane limit/;
   re-create of an EXISTING name succeeds while full (replace, not cap-hit).
4. idempotent no-op: existing lane status "running" → ok:true, existing container_id,
   ZERO docker calls, name still sanitized before lookup ("alpha!" → "alpha").
5. laneStart/laneStop happy: runner records ["start",id]/["stop",id]; status flips
   running/stopped + updated_at; events lane_started/lane_stopped {id,name}; res.ok.
6. laneStart failure: runner throws → ok:false with error, event lane_start_failed
   {id,name,error}; lane status unchanged.
7. laneRemove: runner rm -f ok → map key DELETED, event lane_deleted {id,name};
   laneRemove of unknown name → ok:false "no lane X", zero runner calls.

## server/fleet/__tests__/laneActions.test.js — 9 tests
Pure laneNameOf (exported or via fleet api — mirror how containerName is tested;
if unexported, test via routes):
1. "My Lane_1" → "my-lane-1" (lowercase + runs → -)
2. 100-char input → exactly 64 chars
3. non-string / empty / all-junk ("///") → null
4. dots/underscores/hyphens preserved verbatim
5. internal junk runs collapse to single "-" (no leading/trail dedupe — spec: replace only)

Lifecycle via createFleet({ agentInvoker: fake }) — reuse updatesProxy.test.js fake shape:
6. lane.create ok: fake returns {ok:true,id:"ab12…"} → 200, node snapshot lanes keyed by
   sanitized name after snapshot carrying lanes {name:…}; legacy docker_lane still wins
   when both present (legacy precedence check on upsert).
7. lanes full (8 keys, distinct) → 409 "lane limit reached (8)"; existing-name create 200.
8. invalid name (""/404-style bad) → 400; node not connected → 400.
9. lane.remove accepted → server removes snapshot.lanes[key] even when no agent event
   arrives (dropped-event strand guard); unknown node → 400; bad name → 400.

Gate deltas measured: fleet 202→207 (M1) →211 (M2); agent 240→247; server 478 (no delta —
lane route coverage lives in the fleet suite). Vitest unchanged (UI out of row).
