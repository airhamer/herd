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
| fleet | `node --test server/fleet/__tests__/*.test.js` | 202 pass / 0 fail |
| server | `npm run test:server` equivalent: `node --test server/collectors/__tests__/*.test.js server/sparks/__tests__/*.test.js server/health/__tests__/*.test.js server/alerts/__tests__/*.test.js server/events/__tests__/*.test.js server/metrics/__tests__/*.test.js` | 478 / 0 |
| vitest | `npx vitest run` | 229 / 0 (grow-only; record new totals) |
| tsc | `npx tsc --noEmit` as package.json scripts.test:typecheck runs it | exit 0 |
| agent | `node --test agent/main.test.js agent/http.test.js agent/catalog/__tests__/*.test.js agent/actions/__tests__/*.test.js agent/collectors/__tests__/*.test.js` | 247 / 0 |

Suites grow with new tests; any REGRESSION in a baseline = violation → revert + report.

## Worker rules (codified from S1.4/S2.2/S2.3b lessons)

- Prescriptive spec per row: file map, seam contract, exact commands, fork idioms
  (Tailwind, no upstream CSS wholesale; hand-rolled inline-SVG icons; inline
  switch rows, not ToggleRow; local fn style; JSDoc plain JS in agent/server).
- Micro-scope: UI rows = ONE component per dispatch; ≤2 commits per dispatch
  (WIP allowed); code rows may take 2–4 milestone commits.
- ALWAYS `subagents cancel` a prior attempt and confirm terminal before
  redispatch on the same worktree (S2.3b two-writer lesson).
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

- S3.1 — **attempt 1 REJECTED (confabulation incident, not a real blocker).** Run 5faf7359 reported a "worktree-swap": claimed its tree held `server/fleet/fleet.ts` + `agent/nodeAgent.js` + `web/` and that the path was reset mid-session. Orchestrator verdict after full forensics: NO swap occurred — reflog is one continuous linear chain (d6322d7→117e020→497f659→fa2b890), single worktree, fork-shape files (connection.js, telemetry.js…) present and correct, `fleet.ts`/`nodeAgent.js`/`web/` never existed in ANY commit of this repo or its origin refs. The worker confabulated a phantom repo shape, "implemented" M1/M2 there (its gate math even contradicts itself: agent 240→247 vs real 247), and its files were never committed anywhere. Its mid-session exec-output loss was host flakiness (orchestrator saw the same class of exec errors this evening) which likely seeded the confabulation.
  - Credit: the orchestrated-worker contract held — it refused to fabricate the gate table, stopped, and reported BLOCKED honestly.
  - Salvage commit `fa2b890` contains ONLY `.tmp/s3.1-salvage/` files (4 files, 270 l, zero repo contamination). The snippets target files that do not exist → treat as IDEAS ONLY (LANES_MAX, route-shape notes); the real spec M1–M3 files win; do not port snippets as source.
- S3.1 **ATTEMPT 2 ACTIVE** — run `d855827f-36ce-4cfb-87e8-bfb85bffbea3` (session 9dd5626a), dispatched 2026-10-27 ~21:58 EDT; same spec + baseline-assert preflight + anti-confabulation rules in the brief (stop-and-report on lost exec output / phantom files; snippets ideas-only). Timeout 7200s; completion target parent; cleanup delete. Orchestrator pre-verified fleet 202/0 + agent 247/0 + fork-shape asserts at HEAD `a83ccb0` immediately before dispatch. Budget gate cleared: main session context 59% (<70%).
- If attempt 2 is also rejected → circuit breaker "same batch re-dispatched twice without accepted gate" fires: HALT + notify owner. Do not dispatch attempt 3.

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
