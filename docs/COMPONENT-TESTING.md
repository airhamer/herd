# Component dashboard test guide (COMP2 / RECIPE1 / RECIPE2)

This guide is the operator path for the dashboard: install a recipe on a Spark,
switch Hasso stock ↔ uncensored (same lane) or take-turn with flash, and opt
into content recording. It does **not** claim a live GPU run succeeded from CI.
Mocks cover the agent/server round-trip; a real Spark is required to load weights.

## Prerequisites on a fresh Spark

The dashboard can drive checkout + install, but the host must already provide:

- `git` (pinned clone/fetch/checkout of allowlisted remotes only)
- `docker` when the recipe's upstream scripts need it
- `sudo` that succeeds as `sudo -n` (passwordless or a still-valid timestamp)

Hasso `alzeo` `install.sh` (pin `01902c67709c4164c30ccf036422bfed6f172158`)
calls `sudo -n` and, if that fails, `sudo -v`. `sudo -v` needs a TTY; a
background node-agent **cannot** type a sudo password. That is an upstream
blocker (`install.sh` around the `sudo -n` / `sudo -v` pair), not a dashboard
stub. Preview reports it when `sudo -n true` fails.

`install.sh` accepts `--plan` (preview, no changes), `--no-start`, and
`--no-service`. There is no `--yes`. Do not pipe `curl | sh`; do not run
`get.sh` that way either.

## Install flow (dashboard)

1. Open Components and choose the recipe (`qwen38` stock, flash, or a TP=2
   group recipe).
2. Click **Install…**. The preview must list **two distinct side-effect
   groups**:
   - **Checkout** — allowlisted `git clone` / `git fetch` / `git checkout`
     of the pinned commit into the recipe workdir (default `~/dgx-spark-qwen38`
     for Hasso). Dirty or mismatched existing checkouts are refused; user
     files and secrets are not overwritten.
   - **Install** — `./install.sh --plan` in preview; confirmed run uses
     `./install.sh --no-start` (or the recipe's pinned entrypoint) only after
     `git rev-parse HEAD` equals the pin.
3. Confirm. Long downloads/builds are expected. The UI must not report
   success until the agent returns a successful outcome.
4. Start the component separately if the installer was invoked with
   `--no-start`.

Verified `install.sh` flags at pin
https://github.com/hasso5703/alzeo/blob/01902c67709c4164c30ccf036422bfed6f172158/install.sh
(`--plan`, `--no-start` “install everything but don't start the service now”,
`--no-service`).

## Variant switch flow

1. Select `stock` or `uncensored` (same 27B lane) or the flash lane variant
   that names a `switchTarget`.
2. **swap variant…** asks the agent for a dry-run plan. The plan binds to
   `./switch-model.sh <stock|uncensored|flash|flash-uncensored>` only
   (those four are in the pinned `switch-model.sh` case at
   https://github.com/hasso5703/alzeo/blob/01902c67709c4164c30ccf036422bfed6f172158/switch-model.sh#L60).
   Other upstream names (`fp8`, `flash-nvda`, …) are not bound to current
   herd variants and fail compatibility rather than running a guessed command.
3. Confirm downtime (model load can take many minutes). Port 8080 already
   belonging to *this* component, or to its exclusive peer that will be
   stopped first, must not block the coordinated stop-old → start-new path.
4. Success means `switch-model.sh` exited 0. While the engine is still
   loading the UI reports **loading**, not “now serving”. Failure leaves the
   desired variant metadata on the previous variant and does **not** claim
   the hardware was rolled back.

## Opt-in content recording

Default policy is **metadata**. Bodies are stored only when:

- the effective policy (stricter-wins across component / node / group / route)
  is `prompts` or `prompts+responses`, and
- an observer is actually present: an already-configured `LLM_PROXY`
  `listen:upstream` usage relay bound to that component's engine/guard port.
  `LITELLM_BASE_URL` alone is **not** an observer — LiteLLM spend-log pull
  is not implemented. The UI must show **not recording / unavailable**.

The dashboard never writes `LLM_PROXY` or changes user routing to turn
recording on. If the observer is missing, the UI shows
**not recording / unavailable** even if the desired policy is content.

To test:

1. Optionally set `LLM_PROXY` on the **agent** (already-used relay), not by
   hoping the dashboard will enable it.
2. On the component row, **enable content recording** (writes policy
   `prompts+responses` with observer `relay`).
3. Send a completion through the existing relay.
4. **view recordings** lists metadata only; opening one row shows
   prompt/response under the same dashboard auth used for other mutating
   APIs (`SPARKDASH_TOKEN` / `DASHBOARD_TOKEN`). Delete removes the row.
5. Retention (time) and quota (bytes / entry count) evict oldest records.
   Streaming keepalives (`: ping`) are dropped; aborted streams are marked
   incomplete. Headers and keys are never stored.
6. Disable content recording to return to metadata. Restart the agent and
   confirm recordings.json is still there.

## Capability discovery

**Probe capabilities** (GET `/api/fleet/nodes/:id/components/:cid/capabilities`)
scrapes the configured engine/guard endpoints through the existing llm
collector (`/get_server_info`, `/v1/models`, `/metrics`, `/health`). Declared
adapters stay separate from detected availability and freshness. TensorFold
is never a verified numeric source.

## TP=2 groups

GLM-5.3-Flash and DeepSeek-v4-Flash recipes talk to both group member
agents (checkout + health). Upstream launchers run from the **head**:

- GLM pin `02dac3879852b8c5713318d3d64a5a791002e954`: `WORKER` is an SSH
  target; `./start.sh` / `./stop.sh` on the head start/stop both ranks and
  discover the RoCE fabric from the route to `WORKER`. Do not fill `WORKER`
  from inventory LAN IP. https://github.com/MiaAI-Lab/GLM-5.3-Flash-DGX-Sparks-1104/blob/02dac3879852b8c5713318d3d64a5a791002e954/scripts/config.sh
- DeepSeek pin `a8b4636710068fd30edb98e1365d567086cc208e`: run
  `./start-deepseek-v4-flash-dspark.sh` and `./stop-deepseek-v4-flash-dspark.sh`
  from the head (scripts SSH to `WORKER_HOST`). Required data-plane env:
  `WORKER_HOST`, `MASTER_ADDR`, `MASTER_PORT`, `NCCL_IB_HCA`,
  `NCCL_SOCKET_IFNAME` — explicit overlay only, never inventory LAN.
  https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark/blob/a8b4636710068fd30edb98e1365d567086cc208e/start-deepseek-v4-flash-dspark.sh

Missing data-plane / interconnect values fail closed before any stop or
mutation. Preview lists management (inventory `lanIp:agentPort`) separately
from named control/data paths. CI and dashboard tests use mocks only — no
live GPU success is claimed. Live hardware is unverified.
