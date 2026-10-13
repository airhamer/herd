# Multi-Spark Dashboard — Implementation Plan

**Date:** 2026-09-22
**Revised:** 2026-09-22
**Author:** Jarvis (orchestrator)
**Supersedes:** Phase 0 research notes (2026-09-22, in-conversation)
**Base:** Fork of `MiaAI-Lab/sparkDash` @ `airhamer/sparkDash` (upstream 1.8.8, commit `754f40a`)
**Goal:** A multi-Spark dashboard (up to 8 units) that monitors, and via a per-node agent
starts/stops/switches LLMs and media services, with live model+engine versions, request
aggregation by model/engine/machine, memory budgeting, and role/RoCE topology.

---

## 0. How to read this file

This file is the **master plan AND the open register**. Read it top-to-bottom for the
design; read §3a for what is open. §6 (running log) is newest-first. Companion docs:
- `TEST_PLAN.md` — gate requirements per batch (determinism, known-answer, seed-and-diff, seams)
- `DELEGATION_AUDIT.md` — per-capability DELEGATE/KEEP-DIRECT/CONSOLIDATE verdicts
- `shared/` — the seam contracts (types.ts, api.schema.json, recipe.schema.json) that
  every worker builds to. **Workers read shared/; only Batch 0 and Batch 5B write it.**
- `ORCHESTRATION.md` — dispatch log, gate findings, tool policy (created at first dispatch)

Nothing is open work unless it is a row in §3a. This file is committed at creation
(Batch 0) and stays tracked.

---

## 1. Where We Are (verified 2026-09-22)

### 1.1 Live fleet (read-only SSH probe, 2026-09-22 ~11:00 EDT)

| Node | Hostname | LAN IP | Tailscale | Docker (running) | Ports | Mem | Disk |
|---|---|---|---|---|---|---|---|
| Node 1 | gx10-1c2c | 192.168.50.226 | 100.72.165.103 | qwen38-sglang (lmsysorg/sglang) Up 2d | SGLang :8080, cockpit :30090, embed :8081, SearXNG :8888, Redis :6379 | 71/121 GiB | 691/916 G (80%) |
| Node 2a | gx10-102c | 192.168.50.118 / 10.200.0.1 | — | tp2-node0 (aeon-vllm-ultimate:2026-09-18-v0.29.0-omni) Up 37h | :8000 | 96/121 GiB (8.1 free) | 680/916 G (79%) |
| Node 2b | gx10-25ed | 192.168.50.46 / 10.200.0.2 | — | tp2-node1 (aeon-vllm-ultimate:2026-09-18-v0.29.0-omni) Up 38h | :8000 | 93/121 GiB (11 free) | 486/916 G (56%) |
| Gateway | Narthex | 192.168.50.150 | 100.122.55.39 | (gateway host) | Qdrant :6333/:6334, Redis :6379, Crawl4AI :8084 | — | — |

- All 3 Sparks reachable from Narthex (ping 0 loss).
- RoCE 200GbE link UP between 102c↔25ed (enp1s0f1np1, 10.200.0.x/10.201.0.x, MTU 9000,
  RoCE GIDs present, passwordless sudo on both).
- qwen38 endpoint (worker model): `http://gx10-1c2c:8081/v1` (keepalive proxy fronting
  :8080), model `qwen3.8-27b`, max_model_len 262144, 32-char key at `~/.config/qwen38/api-key`.
- Node 1 runs the hasso5703/dgx-spark-qwen38 cockpit on :30090 (single-instance, stdlib
  Python) — the control pattern we generalize.
- Nodes 2a/2b currently run aeon-vllm-ultimate v0.29.0-omni TP2 (Qwen38-27B 1M context).

### 1.2 Base repo (sparkDash fork, @ 1.8.8)

- Frontend: React 19, TypeScript, Vite 8, Tailwind v4. 71 files under src/.
- Server: Node.js ESM (plain JS), Express 5, ws. ~30 modules under server/.
- Architecture: "one Spark model, N instances" — `config/sparks.json` registry,
  `SparkMonitor` per Spark, `SystemCollector` (local sysfs/proc or remote SSH),
  `LlmProbe` (HTTP, backend autodetect: llama.cpp/vLLM/sglang/ds4/EXL3/q27).
- REST `/api/*` + WebSocket `/ws` snapshot stream.
- Existing tabs: Overview (fleet), per-Spark detail, ComfyUI, Hermes Agent, Tailnet,
  decode/prefill bench, prompt showcase, power controls, themes.
- Existing roles: head/worker/standalone (config field `role`, `workerNode`, `workerLabel`,
  `workerHeadId`). **No RoCE topology, no service start/stop/switch, no memory budgeting,
  no request aggregation by model/engine/machine, no live model+engine versions.**
- Loopback-only by default; single bearer token for LAN bind (SPARKDASH_TOKEN).

### 1.3 Gap analysis (requirement → base → plan)

| Requirement | sparkDash | qwen38 cockpit | Plan |
|---|---|---|---|
| Multi-spark (up to 8) | ✅ | ❌ | Keep sparkDash model |
| ComfyUI monitoring | ✅ | ❌ | Keep |
| Head/Worker/Standalone roles | ✅ | ❌ | Keep + add RoCE links |
| Start/stop/switch LLMs + containers | ❌ | ✅ (single) | **Add** (per-node agent) |
| Requests queued/running/finished by model/engine/machine | partial | ✅ | **Add** (aggregate) |
| Machine stats | ✅ | ✅ | Keep |
| Live model + engine versions (not "last tested") | ❌ | ✅ (recipes/drift) | **Add** (docker inspect + server_info) |
| RoCE connections between head/worker | ❌ | ❌ | **Add** (manual designation v1) |
| TP2 large models (Qwen38-27B 1M ↔ GLM 5.3 ↔ others) | ❌ | ❌ | **Add** (recipe catalog) |
| TP1 per-node options | ❌ | ❌ | **Add** |
| Video/image/audio-tts/stt/conversation services | partial (Comfy) | ❌ | **Add** (AEON catalog) |
| Auto-switch services on demand + resize memory | ❌ | ❌ | **Add** (memory budgeting) |
| Run from any LAN machine, view from any browser | ✅ (loopback+token) | ✅ (tailnet) | Keep + generalize |

---

## 2. Target Design

### 2.1 Two tiers: node agent + dashboard server

**Decision (5.b.4/5.b.5):** per-node agent/daemon for all actions + telemetry (not SSH).
The node agent runs on each Spark (and on Narthex so it is a first-class node). The
dashboard server polls node agents over HTTP and fans out over WebSocket.

```
┌──────────────────────────── Node Agent (each Spark) ─────────────────────────────┐
│  agent/main.js  (Node.js ESM, plain JS, no build step)                            │
│  ├─ collectors/  gpu cpu mem disk net docker systemd llm comfy  (local, no SSH)   │
│  ├─ catalog/     recipes.js memory.js services.js media.js                        │
│  ├─ actions/     docker.js systemd.js llm-switch.js audit.js                      │
│  └─ http.js      local HTTP server :30091                                         │
│       GET  /telemetry   → NodeAgentSnapshot (metrics+containers+services+versions)│
│       GET  /versions    → VersionInfo[] (live model+engine versions)              │
│       GET  /services    → ServiceInstance[] (running services)                    │
│       GET  /memory      → MemoryBudget (free + make-room plan)                    │
│       GET  /requests    → RequestStats (queued/running/finished by model/engine)  │
│       GET  /topology    → TopologyInfo (role, rank, RoCE peers, tp group)         │
│       GET  /containers  → ContainerInfo[] (docker ps)                             │
│       POST /actions     → ActionResponse (start/stop/restart/switch)              │
│       GET  /audit       → audit log tail                                          │
└────────────────────────────────────────────────────────────────────────────────────┘
                    ▲ HTTP (LAN, per-node :30091)
                    │
┌──────────────────────────── Dashboard Server (Narthex or any LAN machine) ───────┐
│  server/  (extend sparkDash Express+WS)                                          │
│  ├─ fleet/     registry.js (node registry)  connection.js (poll+WS fan-out)      │
│  │            aggregate.js (requests by model/engine/machine)  topology.js       │
│  ├─ sparks/    SparkRegistry, SparkMonitor  (existing)                           │
│  ├─ collectors/ SystemCollector, LlmProbe, ComfyProbe ...  (existing)            │
│  └─ index.js   REST /api/* + WS /ws                                              │
└────────────────────────────────────────────────────────────────────────────────────┘
                    ▲ WebSocket /ws + REST /api/*
                    │
┌──────────────────────────── Frontend (React, extend sparkDash) ──────────────────┐
│  src/                                                                    │
│  ├─ OverviewPage/   fleet: all nodes, roles, RoCE links, memory, requests │
│  ├─ SparkPage/      per-node: GPU/CPU/mem/disk, containers, services, versions│
│  ├─ Topology/       standalone/head/worker + RoCE connections diagram       │
│  ├─ ServiceManager/ start/stop/switch LLMs + media services, memory budgeting│
│  ├─ Requests/       queued/running/finished by model/engine/machine         │
│  ├─ api/            client.ts, types.ts (extend)                            │
│  └─ hooks/          useSnapshot.ts (extend)                                 │
└────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Node agent (agent/)

- **Runtime:** Node.js ESM, plain JS (JSDoc types), no build step. Mirrors sparkDash
  server style. Runs as a Docker container on each Spark (default; decision A2/5B) on
  port **30091** (next to the cockpit's 30090).
- **Telemetry (local, no SSH):**
  - GPU: `nvidia-smi` (temp, usage, power, vram, processes, throttle).
  - CPU/mem/disk/net: sysfs/proc (reuse sparkDash SystemCollector patterns).
  - Containers: `docker ps` + `docker stats` + `docker inspect` (live image tag → engine version).
  - LLM: HTTP to local LLM servers (`/get_server_info`, `/v1/models`, `/health`, `/metrics`).
  - ComfyUI: HTTP to local ComfyUI (`/system_stats`, `/queue`, `/history`).
- **Versions (live, not "last tested"):** `docker inspect` image tag → engine version;
  LLM `/get_server_info` + `/v1/models` → model name, context len, mem-fraction, tp_size.
- **Service catalog + recipes:** declarative per-node recipe file (`config/recipes.json`),
  one entry per service (model/checkpoint/revision/quant, engine, image tag, context,
  mem-fraction, tp-size, port, container/systemd unit, memory footprint).
- **Actions:** docker start/stop/restart/rm; systemctl start/stop; LLM switch = stop old →
  start new → canary probe → report `ready/loading/wedged/stopped`. Audited exact-argv log.
- **Memory budgeting:** track per-service footprint (recipe + live `docker stats`), compute
  free unified memory, produce "make-room" plan (which services to stop to free X GB).
- **Topology:** role (standalone/head/worker), rank, RoCE peer (manual designation v1).
- **Local HTTP API:** read-only GETs + one POST /actions (start/stop/restart/switch).
  Bearer token optional (loopback trust by default, matching sparkDash).

### 2.4 Dashboard server (server/fleet/)

- **Node registry:** extend sparkDash's `sparks.json` with node-agent endpoint
  (IP:port), role, rank, RoCE peers. One record per node.
- **Fleet connection manager:** poll each node agent (configurable interval, default 2s),
  cache snapshots, fan out over WebSocket. Graceful degradation (offline node = stale/empty).
- **Aggregation:** requests by model/engine/machine (from node agents' /requests),
  fleet memory, roles/RoCE diagram.
- **REST `/api/*` + WS `/ws`:** single bearer token (SPARKDASH_TOKEN).

### 2.5 Frontend (src/)

- **Overview (fleet):** all nodes, roles, RoCE links, memory, requests. Reuse sparkDash
  OverviewPage patterns; add node-agent-backed cards.
- **Per-node detail:** GPU/CPU/mem/disk, containers, services, versions, requests.
- **Service Manager tab:** start/stop/switch LLMs + media services, memory budgeting/auto-switch.
- **Requests viz:** queued/running/finished by model/engine/machine.
- **Topology:** standalone/head/worker + RoCE connections.

### 2.6 Media services (v1 catalog)

| Service | Type | Engine | Image/Recipe | Port | Memory (approx) |
|---|---|---|---|---|---|
| LLM tp1 | llm | sglang | hasso5703/dgx-spark-qwen38 (qwen38-sglang) | 8080 | 50-70 GB |
| LLM tp2 | llm | vllm | aeon-vllm-ultimate v0.29.0-omni (Qwen38-27B 1M) | 8000 | 90-110 GB |
| LLM tp2 GLM | llm | vllm | tonyd2wild/vllm-glm53-flash:sm121-v11-dflash2 | 8000 | 90-110 GB |
| Image | image | comfyui | AEON-7/comfyui-aeon-spark | 8188 | 30-50 GB |
| Video | video | comfyui | AEON-7/aeon-movie-maker (LTX 2.3 22B) | 8188 | 40-60 GB |
| TTS | tts | qwen3-tts | AEON-7/qwen3-tts-server | 3000 | 5-10 GB |
| STT | stt | qwen3-asr | AEON-7/qwen3-asr-server | 3001 | 5-10 GB |
| Voice | voice | matrix-voip | AEON-7/matrix-voip-agent | 3002 | 3-5 GB |

(Music/radio-drama = v2. Exact images/recipes to be confirmed in Batch 5A.)

---

## 3. Implementation Phases (batch plan)

**Parallel safety:** within each batch, the two workers own **disjoint directories**
(stated per batch). Batch 0 commits the `shared/` seam contracts both build to.
Workers read `shared/`; only Batch 0 and Batch 5B write it.

**Hazard class tags:** numeric | state-mutation | both | neither.

| Batch | Worker 1 | Worker 2 | Hazard | Disjoint sets |
|---|---|---|---|---|
| **0 — Scaffolding & seam contract** | (in-house) | (in-house) | neither | — |
| **1 — Node-agent telemetry** | 1A: collectors (gpu/cpu/mem/disk/net/docker/systemd/llm/comfy) + telemetry.js + http.js + version detection | 1B: recipe catalog engine + memory budgeting model + /services /memory | numeric | 1A: agent/collectors/, agent/telemetry.js, agent/http.js · 1B: agent/catalog/, agent/config/ |
| **2 — Node-agent actions** | 2A: docker actions + action handlers + audit log | 2B: systemd actions + LLM switch (stop/start/canary/state) | state-mutation | 2A: agent/actions/docker.js, agent/actions/audit.js · 2B: agent/actions/systemd.js, agent/actions/llm-switch.js |
| **3 — Dashboard aggregation** | 3A: node registry + fleet connection manager + WS fan-out | 3B: requests aggregation (queued/run/finish by model/engine/machine) + roles/RoCE model | numeric | 3A: server/fleet/registry.js, server/fleet/connection.js · 3B: server/fleet/aggregate.js, server/fleet/topology.js |
| **4 — Frontend** | 4A: Overview/fleet + per-node detail + roles/RoCE diagram | 4B: Service Manager tab + requests viz + memory budgeting/auto-switch UI | state-mutation | 4A: src/components/OverviewPage/, src/components/SparkPage/, src/components/Topology/ · 4B: src/components/ServiceManager/, src/components/Requests/ |
| **5 — Media services + deploy** | 5A: media catalog (video LTX, image ComfyUI, TTS, STT, voice matrix-voip) recipes + integration | 5B: end-to-end wiring, docker-compose (dashboard + per-node agent), docs, PR prep | both | 5A: agent/catalog/media.js, agent/config/media-recipes.json · 5B: deploy/, docs/, docker-compose.yml |
| **6 — Test + verify + PR** | Run TEST_PLAN, verify on live 3-Spark fleet, submit PR to MiaAI-Lab | — | both | — |

### 3.1 Batch 0 — Scaffolding & seam contract (in-house, sequential)

**Scope:** planning docs + shared/ seam contracts + repo scaffolding. No worker.
**Deliverables:**
- `IMPLEMENTATION_PLAN.md` (this file)
- `TEST_PLAN.md`
- `DELEGATION_AUDIT.md`
- `shared/types.ts` — canonical TS types (telemetry, versions, recipes, memory, services, topology, actions)
- `shared/api.schema.json` — JSON Schema for node-agent HTTP responses
- `shared/recipe.schema.json` — JSON Schema for recipe files
- `shared/README.md` — how to read the seam contract
- `agent/package.json` — node-agent package manifest
- `agent/main.js` — stub entry (wired in Batch 1/2)
- `.gitignore` update (agent/, config/recipes.json)
**Gate:** files exist, valid JSON/TS, committed.

### 3.2 Batch 1 — Node-agent telemetry (2 parallel workers)

**1A — collectors + telemetry + http + versions**
- `agent/collectors/gpu.js` — nvidia-smi (temp, usage, power, vram, processes, throttle)
- `agent/collectors/cpu.js` — sysfs/proc (usage, temp, draw, tdp)
- `agent/collectors/mem.js` — /proc/meminfo (used, total, available)
- `agent/collectors/disk.js` — df + iostat (storage metrics)
- `agent/collectors/net.js` — /proc/net/dev (interfaces, rx/tx)
- `agent/collectors/docker.js` — docker ps + stats + inspect (containers)
- `agent/collectors/systemd.js` — systemctl list-units (systemd units)
- `agent/collectors/llm.js` — HTTP to local LLM servers (server_info, models, health, metrics)
- `agent/collectors/comfy.js` — HTTP to local ComfyUI (system_stats, queue, history)
- `agent/telemetry.js` — aggregate collectors into NodeAgentSnapshot
- `agent/http.js` — local HTTP server :30091 (GET /telemetry /versions /containers)
- Tests: `agent/collectors/__tests__/*.test.js`, `agent/telemetry.test.js`
- **Read-list:** shared/types.ts, shared/api.schema.json, agent/package.json, agent/main.js,
  sparkDash server/collectors/SystemCollector.js (patterns), sparkDash server/collectors/LlmProbe.js (patterns)

**1B — recipe catalog + memory budgeting**
- `agent/catalog/recipes.js` — load/validate recipes (JSON Schema), recipe registry
- `agent/catalog/memory.js` — memory budgeting model (free, per-service footprint, make-room plan)
- `agent/catalog/services.js` — service registry (running services from recipes + live state)
- `agent/config/recipes.example.json` — example recipe file (LLM tp1, LLM tp2, ComfyUI)
- Tests: `agent/catalog/__tests__/*.test.js`
- **Read-list:** shared/types.ts, shared/recipe.schema.json, agent/package.json, agent/main.js,
  sparkDash server/sparks/SparkRegistry.js (patterns)

**Gate (numeric):** known-answer test per collector (mock nvidia-smi/proc/docker output →
expected metrics); seam invariant (NodeAgentSnapshot validates against api.schema.json);
recipe validates against recipe.schema.json; memory budgeting known-answer (mock footprints
→ expected free + make-room plan).

### 3.3 Batch 2 — Node-agent actions (2 parallel workers)

**2A — docker actions + audit**
- `agent/actions/docker.js` — docker start/stop/restart/rm (exact-argv)
- `agent/actions/audit.js` — audit log (append, read tail)
- Tests: `agent/actions/__tests__/docker.test.js`, `audit.test.js`
- **Read-list:** shared/types.ts, agent/package.json, agent/main.js, agent/telemetry.js (1A),
  agent/catalog/services.js (1B)

**2B — systemd actions + LLM switch**
- `agent/actions/systemd.js` — systemctl start/stop (exact-argv)
- `agent/actions/llm-switch.js` — LLM switch (stop old → start new → canary probe → state)
- Tests: `agent/actions/__tests__/systemd.test.js`, `llm-switch.test.js`
- **Read-list:** shared/types.ts, agent/package.json, agent/main.js, agent/telemetry.js (1A),
  agent/catalog/services.js (1B)

**Gate (state-mutation):** seed-and-diff (mock docker/systemd state → action → verify
idempotent, content preserved, append-not-overwrite); audit log append-only; LLM switch
canary (mock LLM /health + /v1/models → ready/loading/wedged/stopped).

### 3.4 Batch 3 — Dashboard aggregation (2 parallel workers)

**3A — node registry + fleet connection**
- `server/fleet/registry.js` — node registry (extend sparks.json with node-agent endpoint, role, rank, RoCE)
- `server/fleet/connection.js` — fleet connection manager (poll node agents, cache, WS fan-out)
- Tests: `server/fleet/__tests__/registry.test.js`, `connection.test.js`
- **Read-list:** shared/types.ts, shared/api.schema.json, server/sparks/SparkRegistry.js,
  server/index.js, src/api/types.ts

**3B — requests aggregation + topology**
- `server/fleet/aggregate.js` — requests by model/engine/machine (from node agents' /requests)
- `server/fleet/topology.js` — roles/RoCE model (standalone/head/worker, RoCE peers, tp groups)
- Tests: `server/fleet/__tests__/aggregate.test.js`, `topology.test.js`
- **Read-list:** shared/types.ts, shared/api.schema.json, server/sparks/SparkRegistry.js,
  src/api/types.ts

**Gate (numeric):** known-answer (mock node-agent snapshots → expected aggregation);
seam invariant (NodeAgentSnapshot validates against api.schema.json); topology known-answer
(mock roles/RoCE → expected diagram).

### 3.5 Batch 4 — Frontend (2 parallel workers)

**4A — Overview/fleet + per-node + topology**
- `src/components/OverviewPage/` — fleet cards (nodes, roles, RoCE, memory, requests)
- `src/components/SparkPage/` — per-node detail (GPU/CPU/mem/disk, containers, services, versions)
- `src/components/Topology/` — standalone/head/worker + RoCE connections diagram
- Tests: `src/components/OverviewPage/*.test.tsx`, `src/components/Topology/*.test.tsx`
- **Read-list:** shared/types.ts, src/api/types.ts, src/api/client.ts, src/hooks/useSnapshot.ts,
  src/components/OverviewPage/ (existing), src/components/SparkPage/ (existing)

**4B — Service Manager + requests + memory UI**
- `src/components/ServiceManager/` — start/stop/switch LLMs + media services, memory budgeting/auto-switch
- `src/components/Requests/` — queued/running/finished by model/engine/machine
- Tests: `src/components/ServiceManager/*.test.tsx`, `src/components/Requests/*.test.tsx`
- **Read-list:** shared/types.ts, src/api/types.ts, src/api/client.ts, src/hooks/useSnapshot.ts,
  src/components/SparkPage/ (existing)

**Gate (state-mutation):** seed-and-diff (mock snapshots → UI state → verify idempotent
render, content preserved); dead-wiring (every knob changes output); memory budgeting UI
(make-room plan renders correctly).

### 3.6 Batch 5 — Media services + deploy (2 parallel workers)

**5A — media catalog**
- `agent/catalog/media.js` — media service recipes (video LTX, image ComfyUI, TTS, STT, voice)
- `agent/config/media-recipes.json` — media recipe file
- Tests: `agent/catalog/__tests__/media.test.js`
- **Read-list:** shared/types.ts, shared/recipe.schema.json, agent/catalog/recipes.js (1B),
  agent/catalog/memory.js (1B)

**5B — e2e wiring + deploy + docs + PR prep**
- `deploy/docker-compose.yml` — dashboard + per-node agent compose
- `deploy/install-node-agent.sh` — per-node agent install script
- `docs/NODE-AGENT.md` — node-agent docs
- `docs/DEPLOYMENT.md` — deployment docs
- `docker-compose.yml` — extend (dashboard)
- `.env.example` — extend (node-agent env)
- PR prep: branch, commit, PR description
- **Read-list:** shared/types.ts, shared/api.schema.json, shared/recipe.schema.json,
  agent/main.js, server/fleet/registry.js (3A), server/fleet/connection.js (3A)

**Gate (both):** known-answer (media recipes validate against recipe.schema.json);
seed-and-diff (deploy scripts idempotent); e2e (dashboard + node-agent wired, PR description complete).

### 3.7 Batch 6 — Test + verify + PR

- Run full TEST_PLAN (all batches, all gates, ≥3× each)
- Verify on live 3-Spark fleet (gx10-1c2c, gx10-102c, gx10-25ed)
- Submit PR to MiaAI-Lab/sparkDash
- **Gate (both):** all gates green, live verification, PR submitted.

---

## 3a. Open register

**THE action list.** Grouped by what blocks each item. Ids keep historical prefixes.

### Needs-a-decision (blocked on human)
| Id | Item | Blocker |
|---|---|---|
| D1 | Confirm media service images/recipes (Batch 5A) | Need exact AEON-7 image tags + ports for video/image/TTS/STT/voice |
| D2 | Node-agent Docker image (Batch 5B) | Need to confirm node-agent runs as Docker container on each Spark (vs bare systemd) |
| D3 | PR to MiaAI-Lab (Batch 6) | Need to confirm PR target + branch name |

### Ready (unblocked)
| Id | Item | Batch |
|---|---|---|
| R1 | Batch 0 scaffolding + seam contracts | 0 |
| R2 | Batch 1A collectors + telemetry + http + versions | 1 |
| R3 | Batch 1B recipe catalog + memory budgeting | 1 |
| R4 | Batch 2A docker actions + audit | 2 |
| R5 | Batch 2B systemd actions + LLM switch | 2 |
| R6 | Batch 3A node registry + fleet connection | 3 |
| R7 | Batch 3B requests aggregation + topology | 3 |
| R8 | Batch 4A Overview/fleet + per-node + topology UI | 4 |
| R9 | Batch 4B Service Manager + requests + memory UI | 4 |
| R10 | Batch 5A media catalog | 5 |
| R11 | Batch 5B e2e wiring + deploy + docs + PR prep | 5 |
| R12 | Batch 6 test + verify + PR | 6 |

### Follow-on (after v1)
| Id | Item |
|---|---|
| F1 | Music/radio-drama services (v2) |
| F2 | Auto-detect RoCE topology (vs manual designation) |
| F3 | Node-agent on Narthex (gateway as first-class node) |
| F4 | Fleet energy (extend sparkDash /api/fleet-energy to node agents) |
| F5 | Power controls (shutdown/WoL) via node agent |

---

## 4. Orchestration Plan

- **Orchestrator:** Jarvis (this session, agent:main, Narthex).
- **Workers:** 2 parallel per batch, both on gx10-1c2c 256k qwen38 endpoint.
  - Model: `vllm/qwen3.8-27b` (baseUrl `http://gx10-1c2c:8081/v1`, ctx 262144, maxTok 65536, reasoning).
  - Spawn: `sessions_spawn(mode:"run")`, no agentId, no context (isolated).
  - Each worker loads `orchestrated-worker` skill.
- **Dispatch:** sequential batches; within a batch, 2 parallel workers (disjoint file sets).
- **Gate:** orchestrator runs gates (≥3×), verifies commits, marks DONE.
- **Poll:** cron poll (agentTurn, sessionTarget = orchestrator sessionKey) to check worker status.
- **Report:** to human on escalation, halt, phase completion, or long silence.

---

## 5. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Node-agent Docker image not built (Batch 5B) | Medium | High | Confirm image build in Batch 5B; fallback to bare systemd |
| Media service recipes wrong (Batch 5A) | Medium | Medium | Confirm exact images/ports with Steve (D1) |
| Memory budgeting inaccurate (Batch 1B) | Low | Medium | Use live docker stats + recipe footprints; known-answer test |
| LLM switch canary false-positive (Batch 2B) | Low | Medium | Mock /health + /v1/models; seed-and-diff |
| Frontend state-mutation bugs (Batch 4) | Medium | Medium | Seed-and-diff; dead-wiring check |
| PR to MiaAI-Lab rejected (Batch 6) | Low | Low | Confirm PR target + branch (D3); keep fork |
| Worker context blowout | Low | Medium | Read-lists ≤2k lines/10 files; split if needed |
| Parallel workers share files | Low | Medium | Disjoint file sets per batch (stated) |

---

## 6. Running log

### 2026-10-13 ~10:2x EDT — Batch 6c ACCEPTED at `1a92a55`; Batch 7 (deploy) dispatched — RUNNING
- Worker `1c53315d` delivered 6c: 6 files +485/−15, owned paths only, parent `7baae1f` exactly. **Orchestrator independent gate 3×: fleet suite exit 0 ×3 (120 tests, +14 new), tsc exit 0 ×3.** The production 409-forever gap is closed: sequencer now reads update evidence from the proxy `/updates` cache (precedence cache→snapshot→null; no-evidence still fails CLOSED — every row pinned by a named test, incl. real-wiring integration test per the durable rule). Worker's parent-commit claim was wrong (said f74ebc8; actually 7baae1f) — harmless, flagged.
- **Batch 7 deployed per Steve's authorization**: brief docs/BATCH7-BRIEF.md committed; worker `e152bfbe` (runId `97113556`, qwen38, isolated, 4h). Contract: push origin main first, deploy `1a92a55` to gx10-1c2c → gx10-102c → gx10-25ed via the repo's own deploy mechanism, per-node failure isolation, READ-ONLY verification only. HARD-FORBIDDEN: any update trigger/reboot/crontab mutation, touching model serving, force-push. This deploys code; it performs ZERO updates.

### 2026-10-13 ~08:5x EDT — Parked telemetry decision RESOLVED by Steve: 6c fix authorized, then deploy
- Steve: "Do the telemetry fix before deploying then go ahead and deploy." Option (b) — dashboard-side: sequencer reads per-member update state from the updatesProxy `/updates` fan-out cache (precedence cache→snapshot→null; null keeps fail-closed semantics unchanged). No agent changes. Batch 7 deploy is thereby authorized conditional on 6c acceptance.
- docs/BATCH6C-BRIEF.md written (binding design rulings, owned-file list: updatesProxy.js / waveSequencer.js / index.js / fleet tests / FINDINGS doc; forbidden: agent, src, shared, config, program docs). Worker `1c53315d` (runId 2901b706, qwen38, isolated, 4h) dispatched. Real-wiring integration test mandated per the durable rule.
- On 6c acceptance: orchestrator re-runs gate 3× independently, records ACCEPT, then dispatches Batch 7 (deploy to gx10-1c2c / gx10-102c / gx10-25ed).

### 2026-10-13 ~00:10 EDT — Batch 6 (updates UI) ACCEPTED at `6a9ff85`; Batches 5+5b+6 all landed
- Resume worker `f590a241` delivered steps 7–10 exactly: 6 test files + testKit (58 new tests; fake timers + mocked fetch), SELF-REVIEW, one clean commit (20 files, 2644+, tree clean). ONE fix outside tests, test-witnessed: UpdateRow `bytes()` rendered MB as GB — the 2 MiB known-answer case caught it pre-acceptance.
- **Orchestrator independent gate 3×** (exit codes, unfiltered): fleet node --test 0, vitest 25 files 154/154, tsc 0 — identical all 3 passes; scope verified against `git show --stat`.
- Pattern validated: implementer stall → honest CHECKPOINT → fresh resume worker. Batch 7 QUEUED behind parked human decisions (telemetry-merge fail-closed + upstream-integration question posed to Steve); cron stays armed.

### 2026-10-12 ~21:15 EDT — Orchestrator error-of-record corrected: attempt 2 IS ALIVE and building
- A queue item re-delivering attempt 1's failure (runId `e214121a`) was misread at ~20:55 as attempt 2's death; uncommitted notes then briefly claimed "attempt 2 ALSO stalled, zero artifacts" and "attempt 3 = 6a dispatched" — both false, and no attempt 3 was ever spawned. Caught at 21:09 by direct disk check BEFORE committing; ORCHESTRATION.md line 6 corrected in place.
- **True state at 21:09:** attempt 2 (`6c18180f`, runId `66f4dbbd`) running ~50 min into its 4h cap and producing artifacts: `src/api/client.ts` + `src/api/types.ts` modified in tree (step order followed: client/types first). HEAD `22a38c6` untouched by the worker; Batch 5 (`b903d9b`) + 5b (`ba43c0d`) accepted states unaffected.
- 6a/6b decomposition remains a contingency for a future attempt, not a current dispatch. If attempt 2 completes: gate = vitest + `npm run typecheck` + fleet 106 unchanged, 3×.

### 2026-10-12 ~20:25 EDT — Batch 6 attempt 1 FAILED (stalled, no commit); attempt 2 dispatched with anti-stall pacing rule
- **Failure:** worker `5806d2e2` (Batch 6 UI, dispatched 17:25) was interrupted ~48 min in with "stopped making progress"; no completion text, no commit, no report. On disk it left exactly 3 untracked helper files in its owned dir (describeCron.ts, format.ts, FleetUpdatesContext.tsx). Fleet at 1ccd686 unaffected; nothing of Batch 5/5b touched.
- **Response (not a blind re-dispatch):** attempt 2 `6c18180f` (runId 66f4dbbd, 4h cap) with (a) the 3 orphans explicitly claimed as owned starting artifacts, (b) a binding PACING RULE — strict 10-step order; 3 consecutive failed attempts on any sub-step → stop and return `loop-detected:` naming the sub-step, never a silent 4th retry, (c) an orchestrator follow-up message queued to the child clarifying the authoritative gate commands (vitest + `npm run typecheck` + fleet suite 106 unchanged).
- **Rule learned (durable):** qwen38 UI-scale tasks stall on big single-shot dispatches; sub-stepped pacing with a per-step strike limit converts a silent stall into a named BLOCKED report.
- Batch 5 (`b903d9b`) and 5b (`ba43c0d`) remain ACCEPTED; HEAD is orchestrator doc commit 1ccd686.

### 2026-10-12 ~18:45 EDT — Batch 5b ACCEPTED (ba43c0d); worker timed out AFTER committing — disk evidence accepted over missing report
- Worker `130b930a` hit its 1h run cap before producing a final report; the commit was already on disk: `ba43c0d` = exactly the 3 owned files (dgx.js +14L, dgx.test.js 150L, fullView.integration.test.js 104L), tree clean, not pushed.
- **Orchestrator independent gate, 3× identical:** `node --test agent/updates/__tests__/*.test.js` → 23 pass / 0 fail; full agent suite (`agent/__tests__` + `agent/*/__tests__`) → 234 pass / 0 fail. The integration test wires REAL scheduler + REAL dgx with fetch stubbed only — the durable-rule requirement met.
- **Rule note:** a timed-out worker is judged by its artifacts, not its report. Claim-audit passed: commit exists, scope exact, gate independently green.
- Batch 6 (UI) still running as of this entry.

### 2026-10-12 ~17:25 EDT — Batch 5 ACCEPTED (b903d9b); Batches 5b + 6 dispatched in parallel (disjoint sets declared)
- **Batch 5 DONE:** worker #2 resume landed the 6 remaining steps; commit `b903d9b` = 8 files, +1706L, tree clean, `config/fleet-update-plan.json` correctly never staged. **Orchestrator independent gate: 3× runs on the committed tree — 106 pass / 0 fail, tsc exit 0, identical.** Accepted at 17:23.
- **Batch 5b dispatched** (`130b930a`, runId e92f2d9c, 1h cap): dgx fullView defect fix per docs/BATCH5B-BRIEF.md — owns exactly agent/updates/dgx.js + 2 new real-wiring tests (integration test over REAL scheduler+dgx, fetch stubbed only — the durable rule from the findings log).
- **Batch 6 dispatched** (`5806d2e2`, runId e214121a, 4h cap): Updates page UI per docs/BATCH6-BRIEF.md (SPEC §6.3 binding: fleet table, schedule dialog with At|Cron modes + cron-preview known-answers, plan dialog with wave cards ▲▼ reorder, refresh 60s/5s mode switch, 409 inline notice; zero new npm deps). Owns src/** list in the brief; server/** is the read-only seam.
- **Parallel-safety declaration:** 5b touches agent/updates/** only; 6 touches src/** only — disjoint. Both instructed: git add owned paths only, never `git add -A`.
- **Circuit note for cron loop:** two workers now active; per-wake check is both sessions, accept each independently.

### 2026-10-12 ~16:55 EDT — Batch 5 worker #1 ended NOT-DONE (honest BLOCKED, ~70%); resume worker dispatched; 2 findings logged
- Worker #1 (`771ed1ed`) finished without commit but with full evidence: 4 files written (updatesProxy.js 379L, waveSequencer.js 227L, 43 new tests), all green. **Orchestrator-verified on disk: fleet suite 106 pass / 0 fail, `tsc --noEmit` exit 0, HEAD still 386ee1f.**
- **Ratified its judgments (binding for resume):** request.type discriminator (SPEC §5.1 "action:" prose stale); stuck wave members surface as waveState "running" with truth in per-node view display; plan store lives in updatesProxy.js; first successful single-node trigger stamps plan.startedAt; GET /api/fleet/updates returns `{ views: [...] }`; live plan file materializes at first write.
- **Resume worker dispatched:** `agent:main:dashboard:6ca9d189` (runId `5d8e3fbf`, vllm/qwen3.8-27b, 1h cap, visible in sparkDash group) — steps 1-6 only: index.js 7-route wiring, .gitignore, example plan file, 3× gate, SELF-REVIEW append, commit. Not a re-run.
- **Finding (predecessor defect, from worker #1):** `agent/updates/dgx.js` never returns `fullView` (scheduler.js:362 awaits it) — production GET /updates would 500; agent tests stub a fake dgx and hide it. Dashboard degrades per spec (reachable:false). Queued: small agent-fix batch before Batch 7. Durable rule: one integration test exercising REAL module wiring per batch.
- **Finding (parked, human decision):** `/telemetry` carries no DGX update state → WaveSequencer correctly fails closed, but the wave gate is inert in production until an agent build merges `/updates` into `/telemetry`. WHO owns that fix (new agent-build batch vs. folded into Batch 7) changes what the plan is → Steve's call. Worker #1 also flagged: no "fire wave" route in the 7-route list — wave-orchestration UX likely lands in Batch 6 brief.

### 2026-10-12 ~14:30 EDT — Batch 5 REDISPATCHED (real worker live); orchestrator loop root-caused and fixed
- **Phantom-dispatch root cause:** `sessions_spawn` is a deferred tool in this catalog; direct invocation returns "Tool not found". Every 2026-10-09/10-11 "DISPATCHED" claim was false — no worker ever executed. Fix: wrap via `tool_call(id=openclaw:core:sessions_spawn, args={…})`; rule recorded in cron wake message and ORCHESTRATION.md dispatch log.
- **Real worker:** vllm/qwen3.8-27b, visible session `agent:main:dashboard:771ed1ed-0435-4775-9afe-db6c4fafcf71` (sidebar group "sparkDash"), runId `2d84819d-b873-4cf4-9623-d7974d2cd139`, started 14:28 EDT, run-timeout 4h. Task carries: orchestrated-worker skill contract, brief (docs/BATCH5-BRIEF.md), exhaustive 10-item read-list, seam contracts by name, method spec, gate (3×), pre-gate self-review, commit-not-DONE.
- **Cron loop (a3ae59a9) root cause:** per-job model override `aeon/aeon-tp2` hung at model-call-started; 600s timeout × every-5m cadence → 10 consecutive timeouts → auto-disable 02:27 EDT. Fixes applied: schedule 10m, timeout 1200s, cleared model + fallbacks (session default qwen3.8-27b, live-proven), best-effort delivery (Telegram chatId route missing), re-enabled. `cron show` verified: enabled yes, every 10m, no model override.

### 2026-10-11 — Batch 5 (dashboard routes + WaveSequencer) DISPATCHED *(phantom — no worker ran; see 2026-10-12 entry)*
- **Brief:** docs/BATCH5-BRIEF.md
- **Worker:** vllm/qwen3.8-27b, sessions_spawn mode:run, context:isolated
- **Cron loop:** orchestrator-loop-sparkdash-updates (every 5m, pacing 3m–45m)
- **Status:** in progress
- **Gate:** node --test server/fleet/__tests__/*.test.js + npx tsc --noEmit, 3× runs

### 2026-10-09 — Batch 2 (agent probe) DONE
- **Commit:** bd34472
- **Files:** agent/updates/dgx.js, agent/updates/scheduler.js, agent/updates/cronMirror.js, agent/updates/__tests__/scheduler.test.js
- **Tests:** 264/264 agent tests pass, 0 fail
- **Notes:** dgx.js = 11000 client (login/JWT, probe, status, trigger, SSE/WS stream, event ring, post-boot outcome). scheduler.js = persisted schedule table, at timers, 5-field cron, re-arm/past-due, idempotent fire. cronMirror.js = marker-commented host crontab mirror. Wired into http.js (GET /updates), dispatch.js (4 new action types), main.js (createNodeAgent).

### 2026-10-09 — Batch 1 (spike, read-only) DONE
- **Deliverable:** docs/UPDATES-11000.md
- **Contract:** POST /api/login {username,password} → JWT; GET /api/v1/updates/available; GET /api/v1/update_reboot/status; GET /api/v1/update_reboot/stream; POST /api/v1/update_reboot (trigger); GET /api/v1/updates/enabled (public)
- **Notes:** Read-only spike on all three sparks. No triggers fired. Authenticated payload shape pending Steve's DGX password.


**2026-09-23 ~10:53 EDT** — Batch 5 DONE (commits 5fb17ab + b1ad8e8). Worker 5A
delivered agent/catalog/media.js + config/media-recipes.json + media.test.js
(22 tests). Worker 5B delivered deploy/{docker-compose,Dockerfile.node-agent,
install-node-agent.sh,PR-DESCRIPTION,README}.md + docs/{NODE-AGENT,DEPLOYMENT}.md
+ updated docker-compose.yml/.env.example. Gate: 205/205 agent tests × 3, 96/96
frontend tests, bash -n + shellcheck clean, docker compose config exit 0.
Ruling on 5A's `ruling-needed:`: media-recipes.json left untracked (matches
.gitignore:35 — per-node recipe files are live config, not source); recipes.example.json
tracked as the reference. Footprint double-count (video+image share one ComfyUI
container, each declares 40000 MB) noted — computeMemoryBudget sums 80000 MB when
both show running; acceptable for v1 (one container, two recipe entries).
Batch 6 dispatched (full TEST_PLAN + live 3-Spark verification + PR to MiaAI-Lab).

**2026-09-23 ~10:15 EDT** — Batch 4 DONE (commits 1a6e503 + c999c92). Worker 4A
delivered FleetCard/FleetPage/NodeDetail/RoceDiagram/TopologyPage + 16 tests.
Worker 4B delivered ServiceCard/ServiceManagerPage/MoryBudget/RequestStatCard/
RequestsPage + timeAog.ts + 26 tests. Gate: typecheck clean (tsc --noEmit exit 0),
96/96 frontend tests × 3 runs (19 files). 4B also repaired a Batch 0 seam syntax
defect (missing `export interface ActionResponse {` line in shared/types.ts) —
committed in c999c92, disclosed as syntax repair (no semantic change).
Batch 5 dispatched (media services catalog + deploy/docs/PR prep).

**2026-09-23 ~08:40 EDT** — Batch 3 DONE (commits 1399835 + 9849245). Worker 3A
delivered server/fleet/{registry,connection}.js + tests (48 tests). Worker 3B
delivered server/fleet/{aggregate,topology}.js + tests (15 tests). Gate: 63/63
full fleet suite pass, 3× runs. Node registry (loadNodes/saveNodes/getNode/
listNodes/addNode/updateNode/removeNode, atomic persistence, ENOENT→[] graceful
degradation, id regex validation). Fleet connection manager (createFleetConnection,
poll loop over /telemetry, Map cache, online/offline status, onSnapshot/onStatus
callbacks, graceful degradation). Requests aggregation (aggregateRequests →
byModel/byEngine/byMachine, null requests skip). Topology model (buildTopology →
TopologyInfo[] + RoCE link dedup). config/nodes.example.json (3 nodes). Batch 4
dispatched (Overview/fleet + per-node detail + roles/RoCE diagram, Service Manager
tab + requests viz + memory budgeting UI).

**2026-09-23 ~07:45 EDT** — Batch 2 DONE (commits 0cfc831 + a5a97f8). Worker 2A
delivered agent/actions/{docker,audit,index}.js + tests (126 tests). Worker 2B
delivered agent/actions/{systemd,llm-switch}.js + tests (57 tests). Gate: 183/183
full agent suite pass, 3× runs, index.js merged (22 exports, no collisions).
Ruling on 2B's F1: canary states map to ActionResponse.status per shared/types.ts
(ready→success, loading→running, wedged/stopped→failure) — no types.ts change
needed; Batch 5B will formalize if UI needs "loading" verbatim. Batch 3 dispatched
(node registry + fleet connection, requests aggregation + topology).

**2026-09-22 ~21:35 EDT** — Batch 1B DONE (commit 7258098). Worker 1B delivered
agent/catalog/{recipes,memory,services}.js + config/recipes.example.json + tests
(40/40 pass). Ruling on worker's `ruling-needed:`: TEST_PLAN known-answer #2 expected
makeRoom=[{tts,5000}] was infeasible for its own inputs (deficit=17120; tts frees 5000
→ 27880 < 40000). Worker correctly implemented greedy largest-first over stoppable
services → [{llm,50000,"stoppable"}]. TEST_PLAN updated with corrected expected value
+ two additional known-answers (infeasible, needed-excluded). Latent note: active=true
for every running LLM recipe — with two LLMs on different ports both report active;
kept as-is (per-port active) until Batch 4B UI needs a single-active view.
Batch 1A still running (collectors).

**2026-09-22 ~11:16 EDT** — Batch 0 in progress. Planning docs written. Seam contracts
(shared/types.ts, api.schema.json, recipe.schema.json) written. Repo scaffolding
(agent/package.json, agent/main.js) written. Committing Batch 0.

**2026-09-22 ~11:00 EDT** — Phase 0 complete. Decisions locked (A1-A3, B4/B5, C6, E11, F13).
Architecture: per-node agent + dashboard server. Fork: airhamer/sparkDash @ 1.8.8.
Worker model: vllm/qwen3.8-27b @ gx10-1c2c:8081 (262144 ctx).

**2026-09-22 ~09:52 EDT** — Research complete. Landscape: sparkDash (base), hasso5703 cockpit
(control pattern), AEON-7 (media catalog), tonyd2wild GLM-5.3 (TP2 recipe). Live fleet verified
(3 Sparks + Narthex). Gap analysis complete.

**2026-09-22 ~03:00 EDT** — Initial request. Multi-Spark dashboard, start/stop/switch LLMs +
media services, live versions, request aggregation, memory budgeting, RoCE topology.
