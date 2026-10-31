# Batch 8 (POC4) — live end-to-end test: switch on gx10-1c2c via the new UI seam

**Issue:** airhamer/herd#8 · **Branch:** `batch/8` @ `e3cebba` (POC1–3 merged) · **Date:** 2026-10-30
**Method (one, per brief):** exercise the POC seam — UI (Components tab) → server →
agent action → engine switch behind the keepalive proxy — on the real spark
`gx10-1c2c`, selecting a converted Hasso component from the catalog. Document
results, issues, verification. No fleet deploy (parked per `docs/ORCHESTRATION.md`:
production container/agent redeploy needs explicit owner OK).

## What was tested (read-only by construction)

Every live request carries either an impossible `serviceName` (the deployed v1
guard fires *before* the recipe lookup, so execution is structurally impossible)
or is a pure read. The node's engines, units, containers, recipes, and audit log
were verified unchanged after the run (`GET /audit` → `[]` throughout).

| leg | path | result |
|---|---|---|
| UI layer (deployed) | container `airhamer/herd:latest` :5555 | bundle `index-nxnjXIJS.js` — **pre-POC1–3**: no Components route, no `/api/components`. The deployed UI cannot run POC4. |
| UI layer (batch/8 build) | fresh server from `e3cebba` (loopback :5556, prod read-only config mounts, node agent untouched) | bundle `index-DwHAw9Ur.js` ships the Components tab + `POST /api/fleet/nodes/:id/component-actions`; `GET /api/components` returns **both converted Hasso components** with pins, `warnings: []`. |
| Server half | `buildComponentAction` (real module) on the exact browser payload | correct v2 envelope: server-minted `actionId`, `nodeId` pinned from route, version 2, all optional fields null — matches the §7 seam contract. |
| Server validation | bogus `componentId` / `type` via the live route | truthful `400` with per-field issues. |
| Agent action leg | v2 request → deployed agent v0.3.0 `POST /actions` | **502 `serviceName is required`** — the deployed agent runs the v1 dispatcher only; v2 verbs are refused at the envelope guard. Direct control (v1-legal envelope, impossible serviceName) → `404 unknown service`: agent action path alive, refusing *because the component is not materialized*, not broken. |
| Traffic seam | `telemetry.proxy` + `lanes` | proxy collector reports `running:false / state:"unknown"` while `systemctl is-active qwen38-keepalive qwen38-flash` → **active active** on the box (flash lane live on :8080, proxy answering :8081). Lanes report `llm-tp1:stopped`, `llm-tp2:stopped` — both stale. |

Evidence files in this directory (stable-fingerprint ×2 across re-runs, only the
server-minted `actionId` varies): `docs/poc4/evidence-agent-direct.json`,
`docs/poc4/evidence-fresh-server.json`. Drivers (runnable from a repo checkout
after `npm ci`; `docs/` is gitignored — these were added with `git add -f`):
`docs/poc4/driver-agent-direct.mjs` (legs A1–D, agent direct),
`docs/poc4/driver-fresh-server.mjs` (fresh-server legs, `TEST_PORT` env),
`docs/poc4/driver-browser-identical.mjs` (byte-for-byte the ComponentsPage
dry-run payload).

## Findings

1. **UI → server: PASS.** batch/8 serves the Components tab, catalog projects both
   Hasso-converted components, per-node start/stop/restart dialogs render, the
   dry-run-first flow works, server-side validation is truthful.
2. **Server → agent: PASS (as a boundary).** The proxy layer behaves exactly per
   §7.3 mapping (upstream non-ok → 502 with the agent's own error verbatim).
3. **Agent v2 dispatch: NOT YET DEPLOYED — the blocker.** `agent/actions/dispatch.js`
   §7.8 already flagged "v2 verb handling … not in this POC — needs the SC10
   catalog loader", and the fleet runs agent 0.3.0 (v1 dispatcher). The live end
   to end switch therefore **cannot** be performed through the new UI today. This
   is a truthful BLOCKED, not a regression: nothing regressed; the seam's
   lower two segments have a producer/consumer gap.
4. **Catalog live-join is blind on 1c2c.** `/api/components` shows `nodes: []` for
   both components because `joinComponentState` matches on live `versions`, and
   1c2c reports `versions: []` — its serving engine is managed by hand-installed
   `qwen38-*` systemd units outside `LLM_PORTS` probing, and the node's
   `recipes.json` is stale (models its slots as `qwen38-sglang` /
   `qwen38-vllm-tp2` containers that no longer exist; the live one is the
   `qwen38-flash` container under `qwen38-flash.service`).
5. **Proxy telemetry is wrong on 1c2c today** (finding #4-adjacent, pre-existing,
   not introduced by POC1–3): `proxy.running:false` / `state:"unknown"` and
   `servingContainer:"qwen38-"` (truncated) while the proxy is verifiably active
   and serving. §7.1 fact 2 ("traffic-check proves the change is visible behind
   the proxy") is unprovable on this node until the proxy collector is fixed —
   it must be fixed before the traffic-check step of a v2 start means anything.
6. **Recipe drift is a real switch-hazard precedent:** dispatching v1 `start` at
   the stale `llm-tp1` recipe on 1c2c would `docker start qwen38-sglang`, which no
   longer exists — silent no-op at best, wrong-engine start at worst. A live
   take-turn (stop flash → start 27B → canary, boot ~60 s at mem_fraction 0.50)
   is otherwise mechanically feasible on this node **once SC10 materialization
   lands and the node recipe catalog is re-materialized from the component files.**

## What unblocks the full end-to-end (next batches, flagged — not built here)

1. **SC10 dispatch wiring** (agent): materialize component→recipe (§5 map), honor
   `exclusiveWith` take-turn, dry-run plan + confirm tokens, traffic-check step —
   the §7.8 line item that says this dispatch batch is required.
2. **Fleet deploy** of the agent + dashboard builds — parked question
   (`ORCHESTRATION.md`); the deployed :5555 container and all node agents are
   pre-POC. Owner ruling needed before any production redeploy.
3. **gx10-1c2c node-state hygiene:** re-materialize `recipes.json` (or adopt
   catalog materialization), fix the proxy collector false-negative, add live
   `versions` for unit-managed engines.

## Honest scope statement

The issue's "verify it works" on real hardware cannot be marked done: the switch
leg terminates at a deployed agent that rejects v2 by contract, and the only UI
that exists as "deployed" predates the Components tab. Everything the seam can
truthfully be exercised for today was exercised on real hardware, with the node
provably untouched. No code changes were made; the tree carries only this
document, its drivers, and the captured evidence.
