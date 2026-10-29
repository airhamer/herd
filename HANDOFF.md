# sparkDash — session handoff prompt (2026-10-29)

Paste the block below into a fresh session to continue dashboard work.

---

You are continuing work on **sparkDash**, a fleet dashboard (server + per-host node-agent) at
`/home/steve/.openclaw/workspace/projects/sparkDash` (branch `main`). Narthex (this host) runs the
server container `sparkdash` (`airhamer/herd:latest`, :5555) and a local node-agent
(`airhamer/sparkdash-node-agent:latest`, :30091). The prior session ended at commit `0530dd8`.

## Hard rules (do not violate)
- NEVER `git push`. Local commits only. Commit each milestone with a plain message.
- Gates must run ×3 and be identical before declaring any work DONE. Current baselines to
  re-measure first (agent count grew recently): fleet tests ~205, server tests ~509,
  agent tests ~306, vitest ~274, `tsc --noEmit` 0. After adding tests, re-pin the new numbers.
- No new npm dependencies anywhere. The agent stays dependency-free ESM + JSDoc.
- `docs/` is gitignored — use `git add -f` for docs.
- Agent version is `0.3.0`; bump only with a real protocol change.
- Node-agent containers must NOT be recreated by hand — always redeploy via
  `deploy/install-node-agent.sh` (it owns the mount set).

## Fleet
- gx10-1c2c 192.168.50.226 (head), gx10-102c 192.168.50.118, gx10-25ed 192.168.50.46 (TP2 pair,
  roce links, each ~85 GB vLLM VRAM), Narthex 192.168.50.150 (AMD RX 9060 XT, dev box).
- All four run agent 0.3.0 with NVML/ROCm mounts, `--pid host --privileged`, `/proc/meminfo`
  mounted at `/host/proc/meminfo`. VRAM reporting verified fleet-wide (per-process, incl.
  sglang::scheduler 98,819 MB on 1c2c).
- SSH: `steve@<ip>` with the ed25519 key; server container mounts ssh key + config.

## TASK 1 (start here): Network/IP/MAC/Tailscale model redesign
Owner direction from the last session (deliberately NOT implemented yet — design first, then build):

Facts from Narthex that drive the design:
- **`br0` is the interface that actually carries the LAN IP (192.168.50.150)** — it exists as a
  libvirt/VM bridge; the VM plumbing is currently unused but must stay functional.
- Virtual bridge pieces (br0, virbr*, taps) were previously filtered as "virtual" noise. WRONG:
  never hide an interface that owns a real address.
- The current collector fallback (`hostname -I` primary IP assigned to the first non-virtual
  iface in `agent/collectors/net.js`) MISattributes Narthex's IP to `enp16s0` instead of `br0`.
- Tailscale IPs are collected (`agent/collectors/tailscale.js` → `telemetry.tailscale`,
  e.g. Narthex 100.122.55.39 / gx10-1c2c 100.72.165.103) but the UI barely surfaces them.
  Owner: do not leave tailscale IPs out.
- MACs are already per-iface in telemetry; owner wants them visible (precursor to Wake-on-LAN).

Required model:
1. Per-interface row: name, kind tag (`physical | bridge | vm-bridge | wireless | link`),
   IPv4 (the TRUE owner from `ip -4 addr show` — drop the hostname-I misattribution fallback,
   or only use it when NO iface parsed an address), MAC, rx/tx speed, link speed.
2. Any iface with an IPv4 is shown, bridges included; kind tag explains why it's there
   ("vm-bridge" when br0/virbr with tap members). Disconnected wireless shows
   "wireless, disconnected", never borrows another iface's IP.
3. A Tailscale block per node: tailscaleIp(s), dnsName, online state, key expiry — from the
   existing `tailscale` telemetry field (already populated on 1c2c; 102c/25ed have no tailscale —
   render "not installed", not blank).
4. Node-level `wolMac` config slot in `config/nodes.json` / `sparks.json` (track MACs now; WoL
   send is a later task).
Touchpoints: `agent/collectors/net.js` (VIRTUAL_IFACE_RE filter, IP fallback),
`agent/telemetry.js`, `src/components/SparkPage/NodeDetail.tsx` (network panel), Fleet cards,
possibly `server/fleet/aggregate.js`.
Acceptance on Narthex: detail page shows 192.168.50.150 on **br0** (kind=bridge), enp16s0
no-ip-with-link, wlp17s0 "wireless, disconnected", tailscale 100.122.55.39 + dnsName, MAC on
every row. Then verify 1c2c/102c/25ed and redeploy fleet per procedure below.

## TASK 1b (same area, known bug): disk collector container-view
On the sparks the disk panel reports the container overlay (`/etc/hosts` device, 937 GB) instead
of host root; on Narthex it reported `/opt/rocm` (bind of root) instead of `/`. Fix: prefer real
host root (use `/host/proc/mounts` or add host `/` visibility; dedupe by device, prefer `/`),
then aggregate per-device in UI.

## Backlog (owner-asked, in rough priority; confirm ordering with owner after TASK 1)
1. CPU panel: temp sensor is now k10temp Tctl (fixed); a temp bar exists. Verify bar shows on
   Narthex CPU box like GPU's.
2. Make **Fleet** the default landing page instead of "sparks". (DONE — owner confirmed already fixed; no action.)
3. Lane/stack management UI on 1c2c: swap llm-tp1 (qwen38-flash-next) ↔ llm-tp2
   (qwen3.8-27b TP2) — recipes already feed `telemetry.lanes.pools`; build switch UI (owner
   referenced hasso's "lanes" approach).
4. Guard proxy status for 1c2c (Hasso's guard proxy is installed; `server/health/guardProbe.js`
   exists — surface per node).
5. Wake-on-LAN: MAC tracking (in TASK 1) then a wake action per node.
6. Containers: show internal + external port mappings when clicking services.
7. Settings: make the metrics-history toggle discoverable (owner can't find it).
8. Narthex models/services: ollama voice models (bolt/tts/asr) + searxng/litellm/redis/qdrant
   services not showing despite `installedModels` in telemetry.
9. Wireless detail: SSID/signal when connected (need `iw` mount or /sys scan fallback).

## Deploy procedure (used successfully 2026-10-29; script is idempotent)
From Narthex repo root:
1. `docker build -f deploy/Dockerfile.node-agent -t airhamer/sparkdash-node-agent:latest .`
   (local agent) then `bash deploy/install-node-agent.sh` (reinstalls local agent).
2. For each spark: `rsync -a --delete --exclude node_modules --exclude .tmp --exclude dist
   --exclude .git --exclude config/llm-daily.json ./ steve@<ip>:sparkDash/` (llm-daily.json is
   root-owned; exclude or rsync fails), then ssh: `cd ~/sparkDash && docker build -f
   deploy/Dockerfile.node-agent -t airhamer/sparkdash-node-agent:latest . && bash
   deploy/install-node-agent.sh`.
   (The fleet sparkDash copies have NO git repo — rsync is the sync mechanism.)
3. Server/UI changes: `docker build -t airhamer/herd:latest .` then recreate `sparkdash`
   (host network; mounts: config, ssh dir, nvsync key → id_ed25519).
4. Verify via `curl http://<ip>:30091/telemetry` per node before claiming done.
5. NOTE: an agent image tagged `:latest` does NOT prove freshness — compare build time; stale
   deployments were the root cause of the gx10-25ed VRAM=0 bug.

## Verification protocol
Every claim needs live evidence: per-node telemetry curl, UI screenshot/refresh only when asked.
Gate battery ×3 identical, then report counts honestly. No automatic wake/scheduler loops —
the owner ended the orchestration loop; act only on explicit instructions in-session.

Begin with TASK 1 design: read `agent/collectors/net.js`, NodeDetail network panel, and the
tailscale telemetry shape; present a short design (interface kind rules + display contract),
get owner nod if genuinely ambiguous, otherwise implement to the acceptance criteria above.
