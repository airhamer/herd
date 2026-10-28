# H.E.R.D. Implementation Plan — overnight run 2026-10-21 (S-series)

Repo: `/home/steve/.openclaw/workspace/projects/sparkDash` · branch `main`
Owner brief (2026-10-21 20:55 EDT, quoted in ORCHESTRATION.md): "Yes, Queue S1
batches to be followed immediately by other S batches tonight."
Scope source: docs/PIVOT-AGENTIC-PLATFORM.md §3 stages + owner decisions §4
(2026-10-17); S1 decomposition = docs/EVAL-system-enrollment.md §4.4.
Prior run B12 closed 2026-10-18 (4/4) — see ORCHESTRATION.md.

## Register (overnight scope; strictly sequential, one worker at a time)

| id | stage | title | status | method | seam / consumers |
|---|---|---|---|---|---|
| S1.1 | S1 | Poller bearer-token support + per-node token registry field | **done — `10cbfc3` (worker timeout, orchestrator commit)** | code | server/fleet/connection.js sends `Authorization: Bearer <node.token>` when registry record carries `token`; Manage-Nodes API accepts/stores token; agent `http.js:24` is the consumer. Unblocks token hygiene everywhere (EVAL §4.4 item 1). |
| S1.2 | S1 | Claim token + pending/claimed node enrollment state (Netdata shape) | **done — `70b6586` (owner ruling option a: orchestrator in-house)** | code + ui | registry NodeRecord gains `status: pending\|claimed`, one-time claim token mint endpoint, fleet-tab enroll UI. Consumers: fleet tab, Manage Nodes flow. (EVAL §4.4 item 2.) |
| S1.3 | S1 | SSH transport behind `protocol:"ssh"` on NodeRecord | **done — `05498d2` + `33c7841` + `5233075` (worker timed out; orchestrator verified + finished wiring)** | code | exec wrapper + credential store (Secrets, not files) + multiplexing; seam: transport interface consumed by S1.4–S1.6 collectors. (EVAL §4.4 item 3.) |
| S1.4 | S1 | Linux SSH collector → normalized snapshot + capability report | **done — `785beb4` + `55c0f4a` + `56f7734` (attempt 3, run a7796425, 26m; after owner overrode the twice-rejected HALT). Root cause of attempts 1–2 was environment rediscovery eating the 60-min budget — fixed by prescriptive spec docs/S1.4-SPEC.md (embedded sshd :2222 recipe, injectable exec, code-first M1–M4 ordering). Orchestrator-verified: all commits ancestors of main, gate ×3 identical (fleet 178/0 incl. 10 new, test:server 325/0, tsc 0)** | code | emits normalized snapshot to existing fleet data path + ephemeral-test capability report; live-verify against Narthex agentless (SSH localhost) — do NOT touch the other fleet agents. (EVAL §4.4 item 4.) |
| S1.5 | S1 | macOS (macmon) SSH collector | **done — `565d49f` + `e5e9ba7` + `a228dcb` (attempt 1, ~28 min). Verified by orchestrator: ancestry, diffs, gate ×3 (fleet 189/0, server 325/0, tsc 0). Unverified-live by ruling.** | code | same normalized-snapshot seam; NO macOS hardware in fleet — gate is unit/ephemeral tests + capability report only; mark capability report "unverified-live". (EVAL §4.4 item 5.) |
| S1.6 | S1 | Windows (PowerShell-encoded) SSH collector | **done — `a60ea38` + `327884a` + `632185e` (attempt 1). Verified by orchestrator: ancestry, wiring diff, gate ×3 (fleet 196/0, server 325/0, tsc 0). Unverified-live by ruling.** | code | same seam; NO Windows host in fleet — tests-only gate, capability report "unverified-live". (EVAL §4.4 item 6.) |
| S2.1 | S2 | Prometheus `/metrics` endpoint | **done** | code | Verdict attempt 1 accepted (88572e3 renderer+tests, 0735f51 route). GET /metrics = pure renderFleetMetrics(buildFleetSnapshot()), text 0.0.4. Gate baseline now fleet 202, server 325, tsc 0. |
| S2.2 | S2 | Health findings + alert notifications | **done** | code + ui | Verdict 3-attempt chain accepted: 5d71341+df7fc7f+b548439 (ports of c4558d0/2c2a1af/51ced72). Channels unconfigured by ruling, no external send. Baselines: fleet 202, server 384, vitest 203, tsc 0. |
| S2.3 | S2 | Clock caps + history/Temps tiers + monthly energy (+ RoCE panel if telemetry exists) | **DONE** | code + ui | S2.3a SERVER ACCEPTED (765b6a0): 8995f65 clock-cap read + 03dc8c4 monthly energy + 2550f01 RoCE collector + c67859d history tiers. Setter EXCLUDED (read-only policy; would need explicit authorization). S2.3b UI ACCEPTED across two dispatches: 56fa2cc clock-cap display + 8cf481e RocePanel (+4 tests) + b385668 MonthlyEnergy (+3 tests) + b1ef313 cross-write dedupe + 77940a3/b5c2938 HistoryPanel+HistoryChart inline SVG (+19 tests). Gate baselines now fleet 202 / server 478 / **vitest 229** / tsc 0 (verdict gates independently re-run). History UI: 1h/6h/24h/7d/30d chips, browser-local time labels (no fork Settings→Time zone). |
| S3.1 | S3 | Lane schema in agent catalog + lane lifecycle actions | **done** | code | CLOSED 2026-10-28 by owner ruling A ("A and continue" 07:22 EDT) after attempt-2 lost dispatch: commits `93e551e` (M1 lane schema) + `dce9943` (M2+M3 deriveLanes, GET /lanes, lane-audit take-turn, server passthrough) — 16 fork-shape files. Orchestrator-measured gates ×3 identical: fleet 205 / server 478 / agent 271 / vitest 229 / tsc 0 (grow-only; new baselines fleet 205, agent 271). Attempt 1 rejected (phantom-tree confabulation, salvage .tmp only fa2b890). Spec docs/S3.1-SPEC.md. |
| S3.2 | S3 | LightLLM engine kind + coexistence/budget view | **done** | code + ui | CLOSED 2026-10-28. S3.2a `a29fd29`+`c3bde49` (engine kind + computeLaneBudgets pure fn + 9 tests; verified+gated ×3). S3.2b `9789429`+`0db70c7` (LaneBudgetPanel + 8 render tests + web-only lanes wiring; verified+gated ×3 — fleet 205/server 478/agent 271/vitest 246/tsc 0). Worker reports honest both rows. Config integration only, no LightLLM deployment. Spec docs/S3.2a-SPEC.md + S3.2b-SPEC.md. |
| S4.1 | S4 | Guard-proxy monitor/adaptor (external reference only — decision §4.2: do NOT vendor) | **in progress — S4.1a dispatched** | code + ui | monitor hasso5703-style proxy surface: guard status, held requests, crash timeline on lane page; graceful "not present" state. S4.1a = server probe + GET /api/guard (run 6d22d43f, spec docs/S4.1a-SPEC.md); S4.1b = GuardPanel UI (next). |
| S5.1 | S5 | elephant-ai memory health panels (memory/embedder health) | ready | code + ui | reads Qdrant :6333 / embedder health via server-side probe; **excludes** frontier context-saved accounting — parked (decision §4.5, owner). |

## Parked / out of this run

- **Frontier context-saved accounting (S5)** — integration point is the owner's call (guard-proxy token accounting vs. OpenClaw/elephant hook, decision §4.5 still open). needs-decision.
- **S6 Identity/rebrand** — naming is owner's call; H.E.R.D. brand (B12a) stands until he says otherwise. Not code.
- **Intel Arc GPU collector** — no Arc hardware in fleet; deferred, not this run.
- elephant-os repo, GPU telemetry consolidation, AMD GPU telemetry on Narthex, mobile/PWA, S3 Lane *schema migrations beyond S3.1*, production dashboard container redeploy — all out (production redeploy requires owner OK mid-run).

## Gate (all code rows; run 3× identical before DONE)

```
node --test agent/updates/__tests__/*.test.js
node --test server/fleet/__tests__/*.test.js
npx tsc --noEmit
npx vitest run            # only when src/ touched
```

## Hard rules

- Local commits only; **never push to origin** (owner-gated).
- Never redeploy/restart the production `sparkdash` container or the live node-agent containers on the GX10s without owner OK mid-run. Narthex's own node-agent may be restarted only if the row brief says so.
- Baseline at plan time: updates+fleet tests green, `tsc` exit 0 (2026-10-21 21:05 EDT).

## Retained specifications (2026-09-22 plan)

The repo-root `IMPLEMENTATION_PLAN.md` was demoted as the action list on
2026-10-25. These items were not in this register or in
`docs/PIVOT-AGENTIC-PLATFORM.md`. They are not new S-rows. Do not delete the
root file; it is the long design record and the DGX-updates log.

- **Node-agent HTTP stays the action path.** The 2026-09-22 decision is
  per-node agent on `:30091` for start/stop/switch and telemetry, not SSH.
  S1.3–S1.6 add an agentless SSH *collector* transport. They do not replace
  `agent/http.js` actions. The agent spec is `docs/NODE-AGENT.md` plus
  `shared/types.ts`.
- **Media catalog.** The live record is `agent/config/media-recipes.json`
  and `agent/catalog/media.js`, not the 2026-09-22 table. That table named
  the video image `AEON-7/aeon-movie-maker`; the json now uses
  `AEON-7/comfyui-aeon-spark:latest` with model `ltx-2.3-22b`. Do not restore
  the table over the json. Music/radio-drama was explicitly v2 (root plan
  F1) and is still not an S-row.
- **Follow-ons never copied here, still not open work:**
  - F2 — auto-detect RoCE. v1 is manual designation.
  - F4 — extend sparkDash `/api/fleet-energy` onto node agents.
  - F5 — shutdown / Wake-on-LAN via the node agent.
  - F3 (node agent on Narthex) is already stated in `docs/NODE-AGENT.md`.
    Do not re-open it from the stale root register.
- **Security note that existed only in the root running log (2026-10-13):**
  node agents were seen without `NODE_AGENT_TOKEN`, bound `0.0.0.0:30091`.
  Not an S-row. Still unresolved here. Cockpit integration was parked as a
  Batch 8 candidate; the record is `docs/BATCH8-BRIEF.md`, not only the log.
- **DGX update program is closed.** Specs are `docs/BATCH5-BRIEF.md`,
  `BATCH5B-BRIEF.md`, `BATCH6-BRIEF.md`, `BATCH6C-BRIEF.md`, `BATCH7-BRIEF.md`.
  Do not re-dispatch those batches from the root plan.
- **Stale root register.** §3a still lists R1–R12 as Ready. They finished in
  September 2026. D3 (PR to MiaAI-Lab) was overridden on 2026-10-17:
  `docs/PIVOT-AGENTIC-PLATFORM.md` §4.1 keeps MIT and does not absorb upstream.
- **Dispatch shape.** The 2026-09-22 plan allowed two workers in one batch
  on disjoint directories. This S-series plan overrides that: one worker at
  a time.
