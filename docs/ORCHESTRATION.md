# ORCHESTRATION.md — remaining-S closeout run (2026-10-27)

Continuous-orchestration loop state. Cold wakes read ONLY this file +
IMPLEMENTATION_PLAN.md REGISTER, same dir. Repo:
`/home/steve/.openclaw/workspace/projects/sparkDash`, branch `main`,
node v24.22.1 (`/usr/bin/node`). Supersedes the B12 run file (run complete;
history in git).

## Approval

Owner (gateway-owner, webchat) 2026-10-27 20:09 EDT: **"Go for all remaining S
batches"** — scope = REGISTER rows **S3.1, S3.2, S4.1, S5.1** of
docs/IMPLEMENTATION_PLAN.md, strictly sequential, one worker at a time.
S1.1–S2.3 are done (verdicts in plan/git). Everything else out of scope.

## Gate (run 3× identical before any DONE; verify commits, never trust reports)

| Gate | Command | Baseline |
|---|---|---|
| fleet | `node --test server/fleet/__tests__/*.test.js` | 205 pass / 0 fail (grew from 202 at S3.1) |
| server | `npm run test:server` equivalent: `node --test server/collectors/__tests__/*.test.js server/sparks/__tests__/*.test.js server/health/__tests__/*.test.js server/alerts/__tests__/*.test.js server/events/__tests__/*.test.js server/metrics/__tests__/*.test.js` | 478 / 0 |
| vitest | `npx vitest run` | 238 / 0 (grew from 229 at S3.2a; grow-only; record new totals) |
| tsc | `npx tsc --noEmit` as package.json scripts.test:typecheck runs it | exit 0 |
| agent | `node --test agent/main.test.js agent/http.test.js agent/catalog/__tests__/*.test.js agent/actions/__tests__/*.test.js agent/collectors/__tests__/*.test.js` | 271 / 0 (grew from 247 at S3.1) |

Suites grow with new tests; any REGRESSION in a baseline = violation → revert + report.

## Worker rules (codified from S1.4/S2.2/S2.3b lessons)

- Prescriptive spec per row: file map, seam contract, exact commands, fork idioms
  (Tailwind, no upstream CSS wholesale; hand-rolled inline-SVG icons; inline
  switch rows, not ToggleRow; local fn style; JSDoc plain JS in agent/server).
- Micro-scope: UI rows = ONE component per dispatch; ≤2 commits per dispatch
  (WIP allowed); code rows may take 2–4 milestone commits.
- ALWAYS `subagents cancel` a prior attempt and confirm terminal before
  redispatch on the same worktree (S2.3b two-writer lesson).
- Summaries (including this session's own compaction summaries) are CLAIMS, not
  state: before acting on any "done/dispatched/committed" narrative, verify
  against disk (object store, reflog, tracker). Twice proven: S3.1-a1 phantom
  tree, and the false close-out of 22:4x. (2026-10-28, post-forensics)
- Model `vllm/qwen3.8-27b`, context isolated, runTimeoutSeconds 5400–7200,
  completion target parent.

## Parked — human-reserved (notify once, keep other rows moving)

- First LIVE external send of any channel (webhook/email/SMS/ntfy/Slack) and
  first live Prometheus scrape acceptance.
- Clock-cap SETTER (needs explicit authorization; read-only fleet policy).
- Production dashboard container redeploy (owner OK mid-run required).
- S5 frontier context-saved accounting integration point (plan §4.5, open).
- NEVER `git push` — unconditional.

## Circuit breakers → HALT + notify owner

Three consecutive gate failures across batches · same batch re-dispatched twice
without an accepted gate · dispatch lost (worker vanished from lists with no
result) · repo state not ours (dirty tree/unattributable commit/branch change) ·
two parked questions open at once · context >70% with work still ready (this one
is a pause, not a fault — owner clears with /compact).

## Loop mechanics

Job `herd-remaining-s-loop`, every 5m, paced 3m–45m (tight while worker active,
back off when parked), targets this session, wakeMode now. Launch session was at
51% context — one /compact is healthy soon; all state lives here + git, so the
loop survives compaction. Silence default: wake replies HEARTBEAT_OK; speak only
for park / halt / completion / compact-request. Quiet hours 23:00–08:00.

## Active worker

- **S3.2a ACCEPTED 2026-10-28 08:3x EDT; S3.2b dispatched this wake.** Worker
  c8d1d423 (run 2c87e2c5) completed honestly: commits `a29fd29` M1 + `c3bde49`
  M2 verified ancestors of main at HEAD c3bde49, phantom-file count 0, tree
  clean. Orchestrator gate battery ×3 identical: fleet 205/server 478/agent
  271/vitest 238/tsc 0 — matches the worker's self-reported table exactly.
  Worker report: S3.2b-relevant note — `LaneEntry` carries NO footprintMB;
  `computeLaneBudgets` takes caller-merged `BudgetLane`s (recipe lookup) and
  one `poolTotalMB` for all pools (per-pool totals = future additive change).
  Active: **S3.2b (Lane Budget panel UI)** — spec docs/S3.2b-SPEC.md committed
  this turn, dispatched this turn.
- Prior (cleared 07:4x EDT — owner ruled A, "A and continue"): **HALT CLEARED.** S3.1 CLOSED (see plan row; orchestrator gate battery ×3 identical re-run TODAY at e745ae2: fleet 205/server 478/agent 271/vitest 229/tsc 0). Correction of record: a prior turn's compaction summary reported the close-out AND an S3.2 dispatch as done — they were NOT on disk (commit 057343b nonexistent in object store, no reflog entry, no S3.2a spec, no subagent dispatch, loop still halted+disabled). Disk forensics (git cat-file/reflog/subagents) ruled; the ruling is executed for real in this turn. Active: S3.2a (engine kind config integration) — dispatched this turn.
- S3.1 — **attempt 1 REJECTED (confabulation incident, not a real blocker).** Run 5faf7359 reported a "worktree-swap": claimed its tree held `server/fleet/fleet.ts` + `agent/nodeAgent.js` + `web/` and that the path was reset mid-session. Orchestrator verdict after full forensics: NO swap occurred — reflog is one continuous linear chain (d6322d7→117e020→497f659→fa2b890), single worktree, fork-shape files (connection.js, telemetry.js…) present and correct, `fleet.ts`/`nodeAgent.js`/`web/` never existed in ANY commit of this repo or its origin refs. The worker confabulated a phantom repo shape, "implemented" M1/M2 there (its gate math even contradicts itself: agent 240→247 vs real 247), and its files were never committed anywhere. Its mid-session exec-output loss was host flakiness (orchestrator saw the same class of exec errors this evening) which likely seeded the confabulation.
  - Credit: the orchestrated-worker contract held — it refused to fabricate the gate table, stopped, and reported BLOCKED honestly.
  - Salvage commit `fa2b890` contains ONLY `.tmp/s3.1-salvage/` files (4 files, 270 l, zero repo contamination). The snippets target files that do not exist → treat as IDEAS ONLY (LANES_MAX, route-shape notes); the real spec M1–M3 files win; do not port snippets as source.
- S3.1 — **⛔ HALT @22:47 — LOST-DISPATCH BREAKER FIRED.** Attempt 2 (run `d855827f`, session 9dd5626a, dispatched ~21:58, cleanup delete) produced REAL commits `93e551e` M1 (22:16) + `dce9943` M2+M3 (22:33) — verified ancestors of main, fork-shape files only, zero phantoms — then vanished with NO completion report. Four-channel forensic: session absent from sessions_list (archived=all), subagent tracker empty (active + recent-180m), zero node-test/vitest/tsc processes on host, no announce in cron or dashboard parent (agent:main:main 22:36 activity = unrelated heartbeat). Matches the 22:40 pre-recorded lost-dispatch rule exactly. LOOP HALTED: no attempt-3, no S3.2 dispatch, wakes idle until owner rules.
  - ORCHESTRATOR GATE ON COMMITTED WORK (code `dce9943`, HEAD `9e80d33`): fleet 205/0 · server 478/0 · vitest 229/0 · tsc exit 0 · agent 271/0 — ALL GREEN, grow-only vs baselines (fleet +3, agent +24 = worker's new lane tests), zero regressions. Spec M1–M3 look complete in-tree; only the worker's self-reported gate table is missing.
  - OWNER DECISION OPTIONS: **(A) ACCEPT S3.1 as-is** — orchestrator-measured gates are stronger evidence than a self-reported table; I re-run 2 more identical rounds, close the row, dispatch S3.2. **(B) RE-DISPATCH attempt 3** for a clean self-reported table before acceptance (would re-arm the double-redispatch breaker — needs explicit OK). **(C) REJECT** + re-spec. Reply in Dashboard session; loop stays halted meanwhile. On acceptance, adopt new totals fleet 205 / agent 271 as baselines.

## Running log

- 2026-10-27 ~20:20 EDT — Loop launched. HEAD `d6322d7` (S2.3 closed). Approval
  quoted above. Gate baselines recorded (incl. agent 247/0). First row S3.1
  (agent lane schema + lifecycle) spec = docs/S3.1-SPEC.md.
- 2026-10-27 ~20:45 EDT — Launch turn complete: job `herd-remaining-s-loop`
  (57e0aaf4) live, S3.1 worker dispatched, HEAD `117e020`. Owner notified loop
  is live; /compact requested as budget hygiene (session ~80%).
- 2026-10-27 ~21:35 EDT — S3.1 attempt 1 → REJECTED (phantom-tree confabulation,
  run 5faf7359). Repo integrity CONFIRMED clean (linear reflog, fork shape
  intact, no phantom files ever existed). Salvage limited to .tmp/ (fa2b890).
  Circuit breakers NOT tripped (first rejection). Context ~87% → pause per
  budget rule; owner asked for /compact; next wake dispatches attempt 2 with
  baseline-assert preflight.
- 2026-10-27 ~21:58 EDT — Budget pause CLEARED (main session 59% < 70%). Env
  spot-check green (fleet 202/0, agent 247/0, shape asserts OK @ a83ccb0).
  S3.1 attempt 2 dispatched, run `d855827f`. Next wake: worker-active check,
  verify-and-gate on completion report.
- 2026-10-27 ~22:40 EDT — Wake: attempt 2 WORKING and legit. Two milestone
  commits verified on main: `93e551e` M1 (recipes validator + JSON schema +
  shared/types.ts seam) and `dce9943` M2+M3 (lanes.js, http.js /lanes,
  dispatch lane-audit, connection.js passthrough, src/api/types.ts) — 16 files,
  ~1021 insertions, ALL real fork-shape files, zero phantom-file touches
  (attempt-1 failure mode explicitly checked: fleet.ts/nodeAgent.js count 0).
  No completion report in parent yet (last parent turn 21:56); no test
  processes running at wake instant — worker between commands or finishing
  gates. NOTE: attempt-2 subagent session absent from sessions_list despite
  fresh commits — listing staleness suspected, NOT dispatch-lost (it is
  producing artifacts). Breaker stays armed: if a wake finds NO new commits
  AND no report AND session still unlisted → treat as lost dispatch per
  breaker. No re-dispatch, no adjudication this wake. Budget OK (parent ~61%).
  Next wake 4m for report/fresh-commits.
- 2026-10-27 ~22:47 EDT — **HALT.** Attempt-2 lost dispatch confirmed (4-channel forensic above); no report anywhere (cron pendingInputs empty, dashboard parent idle since 21:50). Full 5-gate battery GREEN on committed work — fleet 205/0, server 478/0, vitest 229/0, tsc 0, agent 271/0. Owner notified with A/B/C decision ask. Loop halted; wakes idle on 45m backoff until owner rules. Wake context budget OK (fresh cron run).
- 2026-10-28 ~08:35 EDT — **S3.2a VERIFIED-AND-GATED (clean completion).**
  Wake found worker DONE (tracker clean because it completed+announced, not
  lost — report present in transcript c8d1d423, commits real, tree clean).
  Content verified vs spec: M1 a29fd29 (4 files, engine-kind recognition only,
  no probe branches), M2 c3bde49 (pure fn + 9 tests, zero React, unwired),
  zero phantom touches, frozen files untouched. Gate battery ×3 at c3bde49:
  fleet 205/server 478/agent 271 IDENTICAL ×3; vitest 238/238 ×3; tsc exit 0
  ×3. Worker self-report agrees exactly (honest gates). **S3.2a CLOSED; new
  vitest baseline 238.** Spec docs/S3.2b-SPEC.md written (recon: Panel
  primitive, NodeDetail mount @App.tsx:654, lanes passthrough already live in
  connection.js — wiring is additive types/props). S3.2b dispatched this turn.
- 2026-10-28 ~07:55 EDT — **RULING A EXECUTED + RECORD CORRECTED.** Owner "A and continue" 07:22. Forensic correction: a late-22:4x turn summary narrated the close-out as done (claimed commit 057343b + S3.2a dispatch) — NONE of it hit disk: 057343b absent from object store, reflog linear at e745ae2, no docs/S3.2a spec, no subagent dispatch in tracker (recent=720m shows only S3.1-a1 + N4), loop job disabled. Narration-≠-execution, same class as S3.1 attempt 1 — now defended against: this session's own summaries are treated as claims, verified against disk before acting (rule updated below). Real close-out now: gates ×3 re-run THIS morning at e745ae2 (identical: fleet 205 / server 478 / agent 271 / vitest 229 / tsc 0, session fast-reef), plan row S3.1 **done** on real commits 93e551e+dce9943, new baselines fleet 205/agent 271, docs/S3.2a-SPEC.md written (engine kind integration + lane-coexistence pure fn; UI deferred to S3.2b), loop job re-enabled, S3.2a dispatched this turn.

## Dispatch log

- S3.1 — attempt 1 run 5faf7359 (~20:44 EDT 10-27): REJECTED, phantom-tree
  confabulation. Attempt 2 run d855827f (~21:58): produced real commits
  93e551e+dce9943, lost dispatch (no report). CLOSED via owner ruling A — no
  attempt 3.
- S3.2a — run 2c87e2c5-fd47-4059-a560-affddd5ff32e (session c8d1d423),
  dispatched 2026-10-28 ~08:0x EDT, real dispatch (tracker-verified), spec
  docs/S3.2a-SPEC.md, timeout 5400s, completion target parent. NOTE: a prior
  narrative claimed a 22:4x dispatch that never existed; the one line above is
  disk truth. Baselines in force: fleet 205 / server 478 / agent 271 /
  vitest 229 / tsc 0 (grow-only).
- S3.2b — run e902d027-9fa1-40fe-bad4-acf01c61b802 (session 7a9427cd),
  dispatched 2026-10-28 ~08:40 EDT (tracker-verified accepted), spec
  docs/S3.2b-SPEC.md (Lane Budget panel + minimal lanes wiring; one
  component), timeout 7200s, completion target parent. Baselines in force:
  fleet 205 / server 478 / agent 271 / vitest 238 / tsc 0 (grow-only).
