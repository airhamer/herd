# B12c findings — 102c/25ed node-agent recipes corrected

Date: 2026-10-18. Worker: B12c retry #1. Scope: `~/sparkdash-node-agent/config/recipes.json`
on gx10-102c and gx10-25ed + this doc. No repo code changed.

## Claimed vs actual

Both boxes carried a copy of gx10-1c2c's recipes.json: `nodeId: "gx10-1c2c"`, recipes
`llm-tp1` (sglang :8080, container `qwen38-sglang`), `llm-tp2` (vllm/vllm-openai:v0.29.0,
container `qwen38-vllm-tp2`, tp2 local), and `comfyui` (:8188). **None of those containers
exist on either box.** No sglang, no comfyui, no local TP2 container named as claimed.

Actual (docker ps + docker inspect + curl, 2026-10-18):

| Box | Containers running | Reality |
|---|---|---|
| gx10-102c (192.168.50.118) | `tp2-node0`, `sparkdash-node-agent` (+ exited legacy `vllm_qwen38fn`) | **Head** of 2-node vLLM TP2 group `tp2`. Image `ghcr.io/aeon-7/aeon-vllm-ultimate:2026-09-18-v0.29.0-omni`, args `serve /model --served-model-name aeon --port 8000 --tensor-parallel-size 2 --nnodes 2 --node-rank 0 --master-addr 10.200.0.1 --max-model-len 1000000 --gpu-memory-utilization 0.70 --kv-cache-dtype fp8_e4m3 ...`. Live API on **:8000**. |
| gx10-25ed (192.168.50.46) | `tp2-node1`, `sparkdash-node-agent` | **Headless worker** (node-rank 1, `--headless`) of the same group. `ss`: no LLM API port listening; `/v1/models` on :8000 empty. API is served from 102c only. |

`/v1/models` on 102c:8000 → `{"id":"aeon","owned_by":"vllm","root":"/model","max_model_len":1000000}`.
Engine env: `VLLM_HOST_IP=10.200.0.1` (102c) / `10.200.0.2` (25ed), NCCL over `enp1s0f1np1` (200GbE links up).
`/get_server_info` is 404 on this build (old field path); quantization left `null` — unverified from live args.

## What was written

One LLM recipe per box, matching the container's actual args (full arg list copied from
`docker inspect .Config.Cmd`), `nodeId` = `gx10-102c` / `gx10-25ed`. Dropped `llm-tp1` and
`comfyui` (no such containers exist). Kept schema fields identical. On 25ed the recipe's
port 8000 is the configured-but-unlistened headless port; description says so.

Restarted only `sparkdash-node-agent` on each box.

## Telemetry proof (POST-restart)

`http://192.168.50.118:30091/telemetry`:
`"nodeId":"gx10-102c"`, containers `tp2-node0` running (image aeon-vllm-ultimate),
`services:[{"name":"llm-tp2","kind":"llm","engine":"vllm","port":8000,"status":"running","footprintMB":90000,"active":true}]`

`http://192.168.50.46:30091/telemetry`:
`"nodeId":"gx10-25ed"`, containers `tp2-node1` running,
`services:[{"name":"llm-tp2","engine":"vllm","port":8000,"status":"running","active":true}]`

Note (not in scope): each agent's `llm[]` poll block still probes hardcoded :8080 and
returns all-null; separate agent-code issue, not config. Also 102c shows exited
`vllm_qwen38fn` (vllm-openai cu129-nightly) — leftover container, left untouched.

## Gate

Gate is for repo code; this batch touched only remote config + docs. Not re-run to
"make green" — see worker report for repo test status.
