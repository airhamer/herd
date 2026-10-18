# B12b — ollama detection + Narthex joins the fleet

Date: 2026-10-18 · Agent build: 0.3.0 · Retry #1 (recon pre-verified by prior run)

## Part 1 — ollama detection (`agent/collectors/llm.js`)

Detection order now:

1. `GET /get_server_info` → sglang (unchanged, first)
2. `GET /api/version` (+ `/api/tags`, `/api/ps`) → **ollama** — MUST run before
   the OpenAI-compat branch: ollama also serves `/v1/models` with
   `owned_by=library`, which mis-detects as vllm (this was the bug).
3. `GET /v1/models` → vllm (unchanged, incl. `/metrics` tiles)

Ollama entry fields: `backend:"ollama"`, `version` from `/api/version`,
`installedModels` = ids from `/api/tags`, `loadedModels` = subset in
`/api/ps` (both `null` on non-ollama backends), `modelId` = loaded model
else first installed. `/api/version` failure falls through to the vllm path
byte-for-byte unchanged. Tags/ps failure with version alive → ollama with
empty sets (degradation test).

Tests: `agent/collectors/__tests__/llm.test.js` +5 cases on **live fixtures**
captured from Narthex 11434 (`__tests__/fixtures/ollama-{version,tags,ps}.json`):
detection with installed+loaded sets, ollama-wins-over-`owned_by=library`,
negative (ollama dead → vllm unaffected), tags/ps-dead degradation,
sglang-first. **15/15 pass.**

Note: the ps fixture captured `qwen3-embedding:4b` loaded (recon had noted
`qwen38-27b-iq4xs:latest` — ollama unloads idle models, so the loaded set is
time-dependent; fixtures pin whatever was live at capture, tests assert against
fixtures).

## Part 2 — deploy (run contract = deploy/install-node-agent.sh)

- Image: `docker build --platform linux/amd64 -t airhamer/sparkdash-node-agent:latest -f deploy/Dockerfile.node-agent .`
  from repo root (recon wrote `linux/am64` — typo; valid arch string used).
  `agent/Dockerfile` does **not** exist; `deploy/Dockerfile.node-agent` is the artifact. Image NOT pushed.
- Host config `~/sparkdash-node-agent/`:
  - `config/recipes.json` — minimal ollama recipe (kind llm, engine ollama,
    port 11434, systemdUnit `ollama.service`, footprintMB 14000) written
    BEFORE running the install script (the script leaves an existing
    recipes.json untouched; it never fell back to recipes.example.json).
  - `agent.env` (mode 600): `LLM_PORTS=11434`, `NODE_ID=narthex`, `NODE_NAME=Narthex`.
    **Deviation:** recon said env `NODE_AGENT_LLM_PORTS=11434`; the agent
    reads **`LLM_PORTS`** (agent/main.js:130) and install-node-agent.sh's env
    allow-list carries `LLM_PORTS`, not `NODE_AGENT_LLM_PORTS`. Literal recon
    env would have probed nothing; the working name was used.
- `./deploy/install-node-agent.sh` → container `sparkdash-node-agent`
  (host network, config dir rw at /app/agent/config, docker.sock + docker/
  systemctl/nvidia-smi binaries, /run/systemd, tailscale mounts; GPU device
  warning expected — Narthex is AMD). Dashboard container `sparkdash` untouched.

Verification:

```
$ curl -s http://127.0.0.1:30091/telemetry | jq '.nodeId, .llm[0], .services[0]'
"narthex"
{ "port":11434, "backend":"ollama", "version":"0.32.1",
  "modelId":"qwen38-27b-iq4xs:latest",
  "installedModels":["qwen38-27b-iq4xs:latest","qwen3-embedding:4b","qwen3-embedding:8b"],
  "loadedModels":[] }
{ "name":"ollama", "engine":"ollama", "port":11434, "status":"running",
  "modelId":"qwen38-27b-iq4xs:latest", "engineVersion":"0.32.1" }
```

(live `loadedModels` was `[]` at verification time — model unloaded; the
modelId-else-first-installed fallback produced `qwen38-27b-iq4xs:latest`.)

## Part 3 — registration (server API only; config/nodes.json never hand-edited)

`server/fleet/connection.js` `nodeUrl()` uses `endpoint` verbatim
(`http://<endpoint>/telemetry`), so `endpoint` = `"127.0.0.1:30091"` host:port form.

```
$ curl -s -X POST http://127.0.0.1:5555/api/fleet/nodes -H 'Content-Type: application/json' \
    -d '{"id":"narthex","name":"Narthex","endpoint":"127.0.0.1:30091",
         "lanIp":"127.0.0.1","role":"standalone","agentPort":30091,"isLocal":true}'
{ "success": true, "node": { "id":"narthex", ..., "isLocal":true } }
```

`GET /api/fleet` (post restartFleetConnection): node entry
`nodeId:"narthex"`, `online:true`, versions row
`{ serviceName:"llm:11434", engine:"ollama", engineVersion:"0.32.1",
modelId:"qwen38-27b-iq4xs:latest", state:"running" }`, services row `ollama`
running. No server/ change was needed.

## Gate

`node --test agent/updates/__tests__/*.test.js` (29 pass) &&
`node --test server/fleet/__tests__/*.test.js` (127 pass) && `npx tsc --noEmit` (0 errors) — run 3×, identical; plus llm.test.js 15/15.

## Commits

- Part 1 + tests + fixtures: `B12b: ollama detection + Narthex joins fleet` (see git log)
- This doc + deploy/registration record: follow-up commit.
