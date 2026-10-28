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

- S3.1 — (set at dispatch; launch turn writes runId immediately after spawn)

## Running log

- 2026-10-27 ~20:20 EDT — Loop launched. HEAD `d6322d7` (S2.3 closed). Approval
  quoted above. Gate baselines recorded (incl. agent 247/0). First row S3.1
  (agent lane schema + lifecycle) spec = docs/S3.1-SPEC.md.
