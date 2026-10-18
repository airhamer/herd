# H.E.R.D. Implementation Plan — overnight batch B12

Repo: `/home/steve/.openclaw/workspace/projects/sparkDash` · branch `main`
Owner brief (2026-10-17 23:57): continue H.E.R.D. — add missing functionality,
rename to H.E.R.D., evaluate other dashboards' methods before implementing,
run an overnight loop, add Narthex model monitoring, fix 102c/25ed model ports.

## Register (overnight scope)

| id | title | status | method | seam / consumers |
|---|---|---|---|---|
| B12c | Fix agent config on gx10-102c + gx10-25ed so services/ports reflect reality | **done — `db8f4c2`** (retry #1 after first run timed out with zero artifacts; gate ×3 green) | SSH discovery (`docker ps`, container inspect, `/v1/models` probes) → rewrite each box's `config/recipes.json` to the real engine/port/model → restart agent container → verify `/telemetry` reports correct ServiceInstance rows | agent recipe config; consumed by FleetCard Models + versions |
| B12b | Narthex joins the fleet: agent on Narthex + ollama support in agent probe | **done — `514c61d` + `d202379`** (retry #1 after attempt 1 delivered recon-only; gate ×3 green: 29+127+tsc0+llm15; live: narthex online in fleet, ollama v0.32.1, 3 models) | code + deploy | agent `collectors/llm.js` gains ollama detection (`/api/version`, `/api/tags` = ALL installed models, not just loaded); ollama currently mis-detects as vllm via `/v1/models` owned_by=library. Deploy agent container (amd64, host net, docker.sock) on Narthex; register in nodes.json via Manage Nodes API |
| B12a | Rename to H.E.R.D. (Holistic Elephant-AI Resource Dashboard) | **done — `6198ade`** (gate ×3 green: vitest 164 ×3 + tsc0 + updates0 + fleet0; App.tsx has zero old-brand strings) | ui/docs | index.html title, header brand, README; package/npm names stay (deployment contract); changelog entry |
| B12d | Evaluation: how other dashboards add & monitor systems | **done — `d376b2b`** (docs-only; gate ×3 green) | research doc | upstream sparkDash SSH collectors (read-only, cite as spec), Netdata/Glances/Cockpit node enrollment patterns, hasso5703 cockpit → `docs/EVAL-system-enrollment.md`; feeds S1 re-implementation choices. No code. |

Deferred, NOT this run (do not touch): elephant-os repo (clean, `53def2c`), Prometheus `/metrics`, GPU telemetry consolidation, AMD GPU telemetry on Narthex, mobile/PWA, S3 Lane schema, S5 memory panels.

## Gate (all code rows; run 3× identical before DONE)

```
node --test agent/updates/__tests__/*.test.js
node --test server/fleet/__tests__/*.test.js
npx tsc --noEmit
npx vitest run            # only when src/ touched
```

## Hard rules

- Local commits only; **never push to origin** (owner-gated).
- Never touch elephant-os, model containers' *runtime state* (config files only where a row says so), frontier/credentials.
- Remote box edits limited to `~/sparkdash-node-agent/config/recipes.json` + agent container restart (that is exactly what B12c was commissioned to do).
- Upstream ≥2.0.0 code is never copied (MIT ruling); upstream changelog is spec only.
- 102c/25ed registry role facts: 102c=head, 25ed=worker of group `tp2`, 2×200GbE RoCE links (see nodes.json); current reported services on all three Sparks are identical (llm-tp1 :8080 + llm-tp2 :8000) which is the known lie B12c fixes — 102c runs `tp2-node0`, 25ed runs `tp2-node1`.
</content>
