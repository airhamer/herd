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

- runId: (dispatching B12c now — worker fills; orchestrator records at launch)
- row: B12c — fix 102c/25ed recipes.json to real engine/port/model

## Log

- 2026-10-17 23:58 — plan+state committed; loop `herd-overnight-b12` armed
  (every 10m, session-targeted, paced 5m–30m); B12c dispatched.
</content>
