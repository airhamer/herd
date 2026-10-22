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

- none — register empty; loop retired 2026-10-18 03:46 (job removed, night
  summary sent). BATCH B12 COMPLETE 4/4.

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
- 2026-10-18 02:20 — B12c retry ACCEPTED at `db8f4c2` (independent verify:
  commit on main, docs-only diff; my own gate ×3: updates 29 pass / fleet 127
  pass / tsc exit 0, ×3). Reality: 102c=head tp2-node0 vllm :8000 model
  `aeon` max-len 1M; 25ed=headless worker tp2-node1 (no local API port —
  dashboard should read head node; noted). Register row marked done.
- 2026-10-18 03:12 — B12b retry ACCEPTED at `514c61d` + `d202379`
  (independent verify: commits on main; live agent Up 7m on Narthex;
  registry contains narthex; telemetry nodeId=narthex + backend=ollama;
  my own gate ×3: updates 0 / fleet 0 / tsc 0 / llm 0 exit codes, ×3).
  Reality per worker: ollama v0.32.1, 3 installed models incl.
  qwen38-27b-iq4xs; env name deviation LLM_PORTS (not NODE_AGENT_LLM_PORTS),
  arch amd64 (recon typo fixed) — both correct adaptations.
  B12a dispatched (`58d6c9cd`). next_check 5m.
- 2026-10-18 03:20 — B12a ACCEPTED at `6198ade` (independent verify: 12-file
  diff on main, index.html title shows H.E.R.D., zero sparkDash strings in
  App.tsx; my gate ×3: vitest 164 passed / tsc 0 / updates 0 / fleet 0,
  ×3). Deploy contract preserved per report (package/image/env/storage keys
  unchanged). B12d dispatched (`b36f7305`) — last row. next_check 5m.
- 2026-10-18 03:46 — B12d ACCEPTED at `d376b2b` (docs-only, 284 lines
  verified on disk; tree clean; my gate ×3: updates 0 / fleet 0 / tsc 0).
  Flagged finding worth a follow-up batch: connection.js poller sends no
  Authorization header although the agent supports bearer tokens (evidence
  in docs/EVAL-system-enrollment.md §recommendation).
  REGISTER EMPTY → step 5 executed: loop herd-overnight-b12 removed, night
  summary sent. BATCH B12 COMPLETE 4/4 (B12c db8f4c2 · B12b 514c61d+d202379
  · B12a 6198ade · B12d d376b2b); 2 retries used, 0 halts, nothing pushed.
- 2026-10-20 23:25 — STALE DELIVERY ECHO CLOSED: Batch 10-A (run `cc020c1e`,
  pre-B12 batch, worker `95774c7f`). Result suspended with no requester
  continuation; delivery re-armed three times. Orchestrator verification:
  `a34aadc` present and ANCESTOR of HEAD (work shipped 2026-10-15; B11/B12 +
  rename built on top of it). Spot gate re-run at 23:22: vitest Updates
  64/64 ×1 (worker evidence 64/64 ×3 identical) + tsc exit 0. ACCEPTED —
  no re-dispatch; nothing to do. Batches from the pre-continuation era now
  fully reconciled; any further 10-A echo is post-closure noise.
- Also fixed: stray `</content>` literal at former line 94 (artifact of a
  failed edit during B12b logging) removed in this pass.

---

# Overnight run 2026-10-21 — S-series (orchestrator state)

- **Loop job:** `orchestrator-loop-herd-s` (every 5m, pacing 3m–45m, agentTurn
  → session `agent:main:dashboard:d3982d76-ceee-43c9-8e6b-9134c205ed3e`).
  Disable/remove when register empties (step 7).
- **Approval (verbatim, 2026-10-21 20:55 EDT):** "Yes, Queue S1 batches to be
  followed immediately by other S batches tonight." Scope = register in
  docs/IMPLEMENTATION_PLAN.md (S1.1 → S5.1, sequential); sources PIVOT §3/§4 +
  EVAL §4.4. Context at launch: 12%. Baseline gate green at plan time.
- **Per-wake procedure:** 0 context-budget check (session_status; >70% →
  state-to-disk + notify Steve "/compact to resume", next_check max) → 1 HALT?
  HEARTBEAT_OK → 2 worker active? HEARTBEAT_OK, next_check min → 3 worker
  finished? verify commit ON DISK, gate ×3 identical, accept/reject in
  register, commit log → 4 dispatch lost? HALT + notify → 5 next ready row:
  ONE isolated mode=run worker (reads
  workshop-skills/orchestrated-worker/SKILL.md first action), log, next_check
  min → 6 parked-only: next_check max → 7 register empty: disable job, report
  summary.
- **Stop conditions (halt + notify human):** 3 consecutive gate failures; same
  row re-dispatched twice without accept; dispatch lost; unattributable commit
  or dirty tree not mine; context >70% with work ready; any worker escalation
  while another question is already parked.
- **Human-reserved (park, never decide in-loop):** pushes to origin;
  production `sparkdash`/GX10-agent redeploy; security-posture changes; S5
  frontier-accounting integration point (decision §4.5); anything scope-
  external.
- **Speak only for:** park (once), halt, completion, >8h silence, context halt.
  Quiet hours 23:00–08:00 EDT except halt/park-critical.

## Wake log

- 2026-10-21 21:1x (launch turn) — plan written+committed, loop job created,
  S1.1 dispatched. Baseline: git clean, updates+fleet tests green, tsc 0.
- 2026-10-21 — Batch 10-A stale echo re-armed a 4th time; post-closure noise
  per 2026-10-20 23:25 close (`a34aadc` ancestor of HEAD, spot gate green). No
  reply, no re-dispatch; future echoes ignored the same way.
- 2026-10-21 21:4x — wake (loop ctx 12%, no real HALT — matches are procedure text only). Worker herd-s1-1 running (S1.1, ~14m). 5th 10-A echo re-armed; ignored per close rule. next_check 3m.
- 2026-10-21 21:50 — wake: worker herd-s1-1 running (~20m), no verdict yet; 10-A echo still suspended, ignored. next_check 3m.
- 2026-10-21 21:56 — wake: herd-s1-1 still running (~25m). No verdict. next_check 3m.
