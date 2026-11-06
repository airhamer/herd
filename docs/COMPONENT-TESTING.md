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

## Variant switch flow

1. Select `stock` or `uncensored` (same 27B lane) or the flash lane variant
   that names a `switchTarget`.
2. **swap variant…** asks the agent for a dry-run plan. The plan binds to
   `./switch-model.sh <stock|uncensored|flash|flash-uncensored>` only.
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
- an observer is actually present: `LLM_PROXY` already configured (optional
  usage relay) or a LiteLLM base URL already configured.

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

From a group's Components tab, Install/Stop posts to
`/api/fleet/groups/:id/component-actions`. The server:

1. Requires exactly two registered members and probes both agents (`GET /health`).
   Either failure aborts the whole action (all-or-nothing).
2. Stops the previous component on head then worker (recipe `./stop.sh` /
   `./stop-deepseek-v4-flash-dspark.sh`).
3. Runs checkout on each member, then the pinned role entrypoint: GLM worker is
   checkout/readiness only (head `./start.sh` with already-configured `WORKER`);
   DeepSeek runs `./start-deepseek-v4-flash-dspark.sh` worker-first then head.
   Required NCCL/IF names come from the existing overlay — herd does not
   rewrite RoCE.

CI and dashboard tests mock both agents. No live GPU success is claimed.
