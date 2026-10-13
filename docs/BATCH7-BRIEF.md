# Batch 7 — Deploy the updates subsystem to all three sparks

**Authorized by Steve 2026-10-13:** "Do the telemetry fix before deploying then go ahead and deploy." 6c accepted at `1a92a55` (fail-closed gap closed). Gate is open: deploy `1a92a55` build.

**Targets:** dashboard (sparkDash server) + node agent (`agent/`) on all three sparks:
- gx10-1c2c — 192.168.50.226 (ssh steve@…, key auth from this gateway host, verified working)
- gx10-102c — 192.168.50.118
- gx10-25ed — 192.168.50.46

**Step 0 — publish code:** `git push origin main` (origin = airhamer/sparkDash, ~14 ahead). Push refused/auth-fail → halt, report (do NOT force).

**Step 1 — discover the deployment mechanism from the repo, don't invent one:** read README/deploy docs, `docker-compose*.yml`, `Dockerfile`, install scripts, and any existing deploy notes in `docs/`. Check what's ALREADY running (systemd units / containers) on each host before changing anything — idempotent upgrade, not reinstall. Preserve existing env/config (tokens, bind hosts); never overwrite secrets files.

**Step 2 — deploy per node, in order 1c2c → 102c → 25ed:** code to the commit above, agent running with the new build, dashboard serving the new build wherever it lives. One node unreachable or broken → mark it FAILED with terminal evidence, continue to the next, report per-node. Never brick a live serving box: if a spark is mid-inference or the deploy would disturb production model serving, stop that node and report.

**Step 3 — READ-ONLY verification only:**
- dashboard `GET /api/fleet/updates` → `{views:[...]}` covering all deployed nodes, no 5xx
- agent `GET /updates` on each deployed spark → `{snapshot,state,schedules}` shape
- running build matches `1a92a55` (version/commit evidence per node)
- `GET /api/fleet` (or existing fleet endpoint) healthy; pre-existing features not regressed

**HARD FORBIDDEN:** any `POST /api/v1/update_reboot`; any real crontab mutation (`crontab -r`, install, etc.); triggering any wave/`trigger-now` POST; scheduling any actual update; touching model containers/services on the sparks; `git push --force`; destructive git. This batch deploys CODE; it performs ZERO updates.

**Code defect surfaces?** Halt that step, report as checkpoint — do not fix outside owned scope (this batch owns deployment, not source edits; trivial config is deployment).

**Report:** push result; per-node: deployed|failed|skipped + evidence (unit state, version, endpoint outputs); verification lines verbatim; honest DONE/NOT-DONE.
