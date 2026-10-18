# ORCHESTRATION.md — H.E.R.D. overnight run (B12)

State file for the overnight loop. Cold wakes read ONLY this file + the
REGISTER rows in IMPLEMENTATION_PLAN.md (same dir). Repo:
`/home/steve/.openclaw/workspace/projects/sparkDash`, branch `main`.

## Approval

Owner, 2026-10-17 23:57 EDT: "Continue work on H.E.R.D. to include adding
missing functionality, renaming to H.E.R.D. … Setup a loop so maximum progress
happens overnight to improve H.E.R.D. Add narthex monitoring of all installed
models. Add proper ports etc for the models running on 102c and 25ed so they
can be monitored." Scope = REGISTER in IMPLEMENTATION_PLAN.md (B12a–d).
Everything else is out of scope for this run.

## Loop standing order

Per wake:
0. `session_status`. Context >70% → write state to this file, commit, notify
   owner (Telegram chatId 8605740904) that a `/compact` is needed, set
   next_check 30m, stop.
1. If this file says **HALT** → reply HEARTBEAT_OK, stop.
2. Worker active (`subagents list` for runId in Current worker)? → next_check 5m,
   HEARTBEAT_OK, stop.
3. Worker finished → verify its commit is an ancestor of main (`git log`);
   run the IMPLEMENTATION_PLAN.md gate 3× identical; accept → mark row done in
   plan + log here, commit; reject → one re-dispatch max, then HALT + notify.
4. Dispatch next ready REGISTER row: sessions_spawn mode=run, context=isolated,
   brief = the plan row text + "read
   ~/.openclaw/agents/main/agent/workshop-skills/orchestrated-worker/SKILL.md
   first". Record runId here under "Active worker", next_check 5m.
5. Register empty → disable the automation job (name
   `herd-overnight-b12`, this session) and notify owner with a one-paragraph
   night summary. Then stop.
6. Nothing ready but work remains parked → next_check 30m, HEARTBEAT_OK.

Notifications: HALT, PARKED decision, context-compact request, completion only.
All other wakes reply HEARTBEAT_OK. Never push to origin. Never touch
elephant-os. Remote box writes limited to
`~/sparkdash-node-agent/config/recipes.json` + agent container restart.

## Active worker

- runId: `ad305025-4a6e-4d5e-8363-d6c5111b7e93`
- child session: `agent:main:subagent:be6685ef-13e0-4046-91ee-225330eea8e7`
- taskName: `b12c2_recipes_retry` (re-dispatch of B12c, the one retry)
- row: B12c — fix 102c/25ed recipes.json to real engine/port/model
- expected commit subject: `B12c: 102c/25ed recipes fixed to reality`
  (docs/B12c-findings.md; no src changes expected)
- prior run `8f762b9e` REJECTED 2026-10-18 02:08: timeout, produced nothing
  (no commit, no findings doc, recipes on both boxes verifiably unchanged via
  SSH re-check).

## Loop job

- automation id `56bfafbc-de30-4400-8fb6-f843cbe1c673`, name
  `herd-overnight-b12`, every 10m paced 3m–45m, session-targeted, delivery
  none (notifications by design are sent explicitly, not by announce).

## Log

- 2026-10-17 23:58 — plan+state committed (`a24caa4`); loop
  `herd-overnight-b12` armed; B12c dispatched.
- 2026-10-17 23:59 — launch complete: worker runId + loop jobId recorded
  above. No next_check from launch turn (job-run-only action).
- 2026-10-18 01:31 — still over budget (87%; owner ping already sent 00:48,
  not repeated). B12c run 8f762b9e has FINISHED (status=timeout — its report
  is unreliable; ruling must verify commits on disk + gate ×3 when unpaused).
  Ruling and B12b dispatch stay paused until /compact. next_check 30m.
- 2026-10-18 02:08 — unpaused by compaction (15%). DISK TRUTH: B12c run
  8f762b9e produced NOTHING (git log clean of it; no findings doc; SSH check
  shows both boxes still carry nodeId gx10-1c2c verbatim). REJECTED.
  Re-dispatched as b12c2_recipes_retry (runId above), tighter timeboxed brief
  + commit-early rule. next_check 5m.
</content>
