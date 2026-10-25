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
| S1.4 | S1 | Linux SSH collector → normalized snapshot + capability report | ready | code | emits normalized snapshot to existing fleet data path + ephemeral-test capability report; live-verify against Narthex agentless (SSH localhost) — do NOT touch the other fleet agents. (EVAL §4.4 item 4.) |
| S1.5 | S1 | macOS (macmon) SSH collector | ready | code | same normalized-snapshot seam; NO macOS hardware in fleet — gate is unit/ephemeral tests + capability report only; mark capability report "unverified-live". (EVAL §4.4 item 5.) |
| S1.6 | S1 | Windows (PowerShell-encoded) SSH collector | ready | code | same seam; NO Windows host in fleet — tests-only gate, capability report "unverified-live". (EVAL §4.4 item 6.) |
| S2.1 | S2 | Prometheus `/metrics` endpoint | ready | code | server route; consumers: external scrapers (owner's Prometheus, not deployed here). Batch-11 validated list. |
| S2.2 | S2 | Health findings + alert notifications | ready | code + ui | findings model + notification surface (UI first, no external send). |
| S2.3 | S2 | Clock caps + history/Temps tiers + monthly energy (+ RoCE panel if telemetry exists) | ready | code + ui | history store consumers; RoCE panel renders only when a node reports RoCE counters (Node 2 offline — degrade gracefully). |
| S3.1 | S3 | Lane schema in agent catalog + lane lifecycle actions | ready | code | agent catalog container-inventory finds lane candidates; lifecycle actions ride existing agent action layer; consumers: lane board (Showcase). |
| S3.2 | S3 | LightLLM engine kind + coexistence/budget view | ready | code + ui | config integration only (engine kind), no LightLLM deployment. |
| S4.1 | S4 | Guard-proxy monitor/adaptor (external reference only — decision §4.2: do NOT vendor) | ready | code + ui | monitor hasso5703-style proxy surface: guard status, held requests, crash timeline on lane page; graceful "not present" state. |
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
