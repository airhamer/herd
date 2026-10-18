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

- runId: `8f762b9e-a175-409d-bb2f-937c750d8353`
- child session: `agent:main:subagent:9b64a40a-4bb9-4487-b7da-ea791341455d`
- taskName: `b12c_recipes_fix`
- row: B12c — fix 102c/25ed recipes.json to real engine/port/model
- expected commit subject: `B12c: 102c/25ed recipes fixed to reality`
  (docs/B12c-findings.md; no src changes expected)

## Loop job

- automation id `56bfafbc-de30-4400-8fb6-f843cbe1c673`, name
  `herd-overnight-b12`, every 10m paced 3m–45m, session-targeted, delivery
  none (notifications by design are sent explicitly, not by announce).

## Log

- 2026-10-17 23:58 — plan+state committed (`a24caa4`); loop
  `herd-overnight-b12` armed; B12c dispatched.
- 2026-10-17 23:59 — launch complete: worker runId + loop jobId recorded
  above. No next_check from launch turn (job-run-only action).
- 2026-10-18 00:48 — CONTEXT PAUSE (not a fault): wake measured context 86%
  (>70%). Dispatching/gates stop until `/compact`. B12c worker
  (`8f762b9e`) still running — on next wake: still running → back off; if
  finished → gate normally (worker outcomes are on disk; the pause blocks
  rulings, not workers). Next ready after B12c: B12b (Narthex + ollama).
  Owner notified; next_check 30m.
</content>
