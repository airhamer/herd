# B12d — System-enrollment evaluation (design input for H.E.R.D. S1)

Date: 2026-10-18 · Worker batch: B12d · Scope: research doc, no code.
Purpose: how other dashboards add & monitor new systems, distilled into a
decision for how a new machine gets into the H.E.R.D. fleet.

License note (owner ruling 2026-10-17, PIVOT-AGENTIC-PLATFORM.md §1/§4): the
repo stays MIT and we absorb **no** upstream sparkDash v2.0.0+ code. Upstream
post-1.8.8 sources below are Apache-2.0 and are read as **SPEC ONLY** — cited
by file/commit, never copied. Everything in §4 is a re-implementation brief.

---

## 1. Upstream MiaAI-Lab/sparkDash — SSH collectors (spec read)

Read live from the fetched `upstream/main` ref (tip `3e6d4ef`), 2026-10-18.
Key files: `server/collectors/ssh.js` (440 lines), `server/collectors/windowsMetrics.js`,
`server/collectors/SystemCollector.js` (macmon + platform dispatch),
`server/index.js` (registry routes), `server/auth.js`, `server/validate.js`,
`server/secretsStore.js`, `src/components/AddSparkDialog.tsx` +
`src/components/addSparkSteps.ts`.

### 1.1 Enrollment UX

- **3-step wizard** (`addSparkSteps.ts`): **Connect → Role → Services**.
  Connect = unit type (`linux`/`darwin`/`windows`, plus local toggle), LAN IP,
  CX7 IP (optional), SSH host/user/auth/port. Role = name + role cards
  (Standalone / Head / Worker; the role pick patches `workerNode` +
  `llmMonitoring` together). Services = LLM/Comfy ports + per-port API keys.
- **Ephemeral pre-test before persist**: `POST /api/sparks/test` builds a
  throwaway record (never written to the registry, never starts a monitor),
  runs a **capability matrix** (SSH reach, LLM `/v1/models` per port, ComfyUI
  `/system_stats`), rate-limits per principal, and returns per-capability
  pass/fail/skip with the raw message. The Add flow only persists after the
  operator sees this.
- **Persist + start**: `POST /api/sparks` validates the target, stores, and
  immediately `startMonitor(spark)` + records a `spark.added` event.
  `PATCH /api/sparks/:id` restarts the monitor on host/auth changes but
  **hot-applies password-only updates** without restart. `DELETE` stops the
  monitor and tears down every per-node subsystem (history, launchers,
  evaluators) — one owner per lifecycle.
- **Actionable errors at add-time**: `explainSshFailure()` translates the raw
  OpenSSH error — a Windows host added as Linux gets "set the Unit type to
  Windows PC…" appended to the cmd.exe error (`2578e51`); a refused
  administrator key gets the `administrators_authorized_keys` gotcha (`a50cfe4`).

**What this means for H.E.R.D.**: our Manage Nodes API (`POST /api/fleet/nodes`)
persists immediately; upstream's *ephemeral test → capability matrix → then
persist* is the single best UX pattern worth re-implementing, and the
platform selector chosen **at add-time** (not inferred later) is what makes
the per-OS collectors simple downstream. Error-explanation (name the fix in
the error) is cheap and prevents support loops.

### 1.2 Auth model

- **Key auth default**: `ssh -o BatchMode=yes`, identity from
  `SSH_IDENTITY_FILE` env or `/root/.ssh/id_ed25519` mounted read-only 0600 in
  Docker (`8306e1a`). Host trust is `StrictHostKeyChecking=accept-new`
  (trust-on-first-seen for LAN ops; pin known_hosts for stricter envs).
- **Password auth optional** via `sshpass -e` — password only ever in the
  child's env, never argv/process list. Passwords live in
  `config/sparks-secrets.json` **AES-256-GCM** encrypted (key from
  `SPARKDASH_SECRETS_KEY` or auto-generated `config/.secrets-key`), never in
  `sparks.json`, never returned by any API (`secretsStore.js`).
- **Privileged actions**: sudo password travels **on stdin only** for one
  action, never persisted (`41f3c92` asks for it in the dashboard on demand).
- **Attack-surface hygiene around the collectors**: command execution is
  `execFile` + argv arrays (no shell interpolation) with `--` before the
  destination; child env is a whitelist (PATH/HOME/USER/TERM/SSH_AUTH_SOCK) so
  host secrets like AWS_*/GITHUB_TOKEN never leak into ssh children;
  `isAllowedTargetHost()` blocks cloud-metadata/link-local targets (SSRF guard);
  `isValidSshUser()` rejects malformed users. The dashboard API itself is
  unauthenticated and loopback-bound; remote bind fails closed without
  `SPARKDASH_TOKEN`, with Host/Origin rebinding guards and Tailscale Serve
  recognized as a front door (`server/auth.js`, `docs/REMOTE-ACCESS.md`).
- **Connection economics**: OpenSSH **ControlMaster multiplexing** per unit
  (`63dfe8a`): one authenticated transport reused across pollers instead of a
  login per poll; control sockets in a `0700` private tmp dir named by a salted
  SHA-256 digest of `(sparkId,user,host,port,auth,identityFile,password)` —
  credentials only in the digest so two password records can't share a
  transport, secret never in path/argv; `%C` expanded manually to fit
  `sun_path` (`3aff819`); `ControlPersist` clamp 0–3600 s (default 60); a
  shared readiness gate so concurrent pollers don't race establishing the
  master; any transport failure invalidates cached readiness.

**What this means for H.E.R.D.**: if we re-implement SSH collectors, this is
the security checklist we must match (argv-only exec, env whitelist,
encrypted-at-rest credentials, stdin-only sudo, SSRF target validation) —
upstream earned it through hardening rounds. ControlMaster multiplexing is
the difference between a usable and unusable poll loop (login-per-poll was a
real perf bug). Trust-on-first-seen is acceptable for our LAN; known_hosts
pinning is an optional knob, not v1.

### 1.3 Collector layout (per-OS dispatch over one transport)

- One central `sshExec(spark, cmd)`; the **unit's `platform` field** selects
  the remote script shape, so every panel above it is OS-agnostic:
  - **Linux**: bash pipelines over `/proc`, `nvidia-smi`, etc. (our existing
    Spark path).
  - **macOS** (`platform:"darwin"`, ~`SystemCollector.js:2205-2260`):
    `/proc` absent → Apple-Silicon metrics come from the external **macmon**
    binary (MIT, vladkens/macmon): discovery scans
    `/opt/homebrew/bin`, `/usr/local/bin`, `$HOME/.cargo/bin`, `command -v`;
    one `macmon pipe` call sampled with ~1.5 s TTL so a Mac costs **one SSH
    call per poll cycle**; absence is logged once and re-checked at 1-minute
    cadence, not every poll.
  - **Windows** (`platform:"windows"`, `windowsMetrics.js`): OpenSSH lands in
    cmd.exe, so every script is sent as
    `powershell -EncodedCommand <base64 UTF-16LE>` — quoting-safe under any
    default shell, scripts kept short (8191-char cmd.exe cap); output is
    plain `---`-delimited sections parsed into the **same shapes as Linux**,
    so no panel branches on OS; no-nvidia-smi machines (AMD iGPU) fall back to
    GPU Engine perf counters; PowerShell's stdin wait is closed explicitly.
- Non-system probes ride the same registry: LLM/Comfy probes go direct HTTP
  (`llmHost`) or via SSH `-N` tunnels (`llmTunnel.js`); benches run remotely
  over the same `sshExec` (`e03b9d6`).
- Notable commits: `8b32be3` (Windows units), `b1f3b7a` (review hardening),
  `e78247c` (honor SSH settings consistently), `29153a6` (transport reuse).

**What this means for H.E.R.D.**: the design principle to steal is *one
transport, per-OS script dispatch, OS-neutral normalized shapes*. Our agent
already normalizes via `NodeAgentSnapshot`; an SSH collector should emit the
same normalized shape (gpu/cpu/mem/disk/net) so the fleet UI never learns
what an OS is. macmon (MIT, static binary) remains our macOS metrics answer;
Windows is PowerShell-encoded (no vendoring needed — it runs on the target).

---

## 2. Vendor enrollment patterns — comparison

Sources: Netdata repo README (fetched; Parent/Child streaming confirmed,
`learn.netdata.cloud/docs/streaming/streaming-configuration-reference`; the
Cloud claim/Nodes flow is per Netdata Cloud docs — their deep page URLs moved,
described here from the Cloud docs model), Glances README.rst (fetched;
client/server + REST confirmed), Cockpit README (fetched; per-user browser
sessions + SSH login model confirmed) — 2026-10-18.

| | **Netdata** | **Glances** | **Cockpit** |
|---|---|---|---|
| Enroll friction | install script (one-liner) → paste a **Space claim token** (or `netdatacli claim <token>`); with **approver mode** the node lands *pending* and an admin approves in the Nodes list | `pip install glances; glances -s` on the target — nothing on the hub side except pointing a client/hub at `host:6123` | install the package on the target, open port 9090; "enrollment" = logging in with the machine's own account |
| Auth model | token = membership in a Space; per-node crypto identity afterwards; parent↔child streaming uses its own API keys over 19999 | effectively none in-band — REST/JSON on :6123 trusts the network; CORS is open; docs push TLS/VPN/reverse-proxy | local **PAM** per user, socket-activated per-user sessions; polkit for privilege elevation; self-signed TLS per host |
| Discovery | none — claim is paste-the-token; Cloud's **Nodes status list** (pending/pending-approval/connected/disconnected) *monitors enrollment itself* | none (manual URLs); a broadcast "servers on your network" helper exists but isn't a registry | none — you must know the hostname/IP; multi-host is a logged-in user jumping host-to-host |
| Firewall assumption | **outbound** 443 (Cloud); inbound only for parent streaming | **inbound** 6123 from hub | **inbound** 9090 from operators' browsers |
| Agent vs agentless | agent required (push/relay model) | the monitored box runs the same binary as a server (pull REST) | no central agent; per-host daemon, per-user on-demand sessions |

Take-aways per vendor, then combined:

- **Netdata** splits the problem in two: a *claim token* carries out-of-band
  authorization once, and the *node-status list* makes "who has actually
  shown up" a first-class monitored view (pending vs connected). That status
  surface is as important as the token.
- **Glances** is our pull-poll model with no enrollment ceremony at all —
  zero friction, zero auth. Fine for a hobby LAN; exactly the model our
  agent+poller should *not* stay at once the fleet leaves a trusted segment.
- **Cockpit** has no fleet registry at all — auth is the host's own account
  system (PAM), and sessions are socket-activated per user. Elegant for
  interactive admin, useless for a *monitoring* fleet: there is no machine
  identity, only human identity, and nothing to aggregate.

**What this means for H.E.R.D.**: adopt the Netdata shape on our existing pull
plumbing — a **pre-registration token minted by the Manage Nodes API**,
consumed by `install-node-agent.sh` via `agent.env`, and a fleet view that
shows *registered-but-never-seen* vs *online* as distinct states. Skip
Glances' no-auth default (see §4.1: our poller doesn't even send the bearer
the agent supports today) and skip Cockpit's human-session model entirely —
fleet monitoring needs machine identity, which all three handle by "install
something on the box, authorize it with one secret."

---

## 3. hasso5703/dgx-spark-qwen38 — guard-proxy pattern (external reference)

Fetched README 2026-10-18 (repo MIT, 227★ per PIVOT §1). Verified facts:

- Per lane: the engine binds **`127.0.0.1:30000`** (box-local only); a
  **keepalive proxy (`keepalive-proxy.py`) serves the OpenAI-compatible API
  and the Anthropic protocol on `:30001`** for every text lane, "built for
  agent CLIs". Keepalive/abort/start-guard/held-through-restart semantics and
  a crash timeline live in that proxy (PIVOT §1/§2.3 description).
- Lane lifecycle is scripts + systemd: `lanes.sh`, `prepare-lane.sh`,
  `vllm-lane.sh`, `qwen38-keepalive.service.template`; a browser "cockpit"
  drives seven lanes over one 128 GB pool ("lanes that take turns").

**Integration pattern for us (owner ruling: monitor/operate, never vendor —
PIVOT §4.2)**: a guard-proxy never *enrolls* as a system — it is a **lane
attribute**. It enters our fleet the way any service does: a recipe in the
node-agent catalog (port `:30001`, systemd unit `qwen38-keepalive*`), which
makes it visible in `/versions` + `/services` with zero new registration
surface, and the LLM probe sees it as an OpenAI-compat backend. What it means
for H.E.R.D.: enrollment for guards = a recipe entry + port; S4 work is a
**monitor/adaptor** (guard up/down, held requests, crash timeline per lane),
not a new node type.

---

## 4. Recommendation — how a new machine gets into the H.E.R.D. fleet

### 4.1 Keep agent + Manage Nodes API as the primary path; close its two gaps

The flow we proved today on Narthex (B12b-findings.md Part 2/3) already works
end-to-end: idempotent `deploy/install-node-agent.sh` → container on host
network serving `/telemetry` → `POST /api/fleet/nodes
{id,name,endpoint,lanIp,role,agentPort,isLocal}` → poller (2 s) marks online.
Two gaps to close in S1, both cheap:

1. **Bearer asymmetry.** The agent supports `NODE_AGENT_TOKEN`
   (`agent/http.js:24`) but `server/fleet/connection.js` sends **no
   Authorization header** — a token-protected agent is unreachable from the
   dashboard. Either implement server-side bearer (store per-node token in the
   registry record, send on poll) or document the token as "unset in H.E.R.D.
   deployments until server support lands." Implement; don't document around.
2. **Claim-token + pending state (Netdata shape).** Mint a one-time
   `ENROLL_TOKEN` in `POST /api/fleet/nodes` response; the install script
   presents it on first contact; the registry flips the node from `pending`
   to `claimed` on first authenticated poll. The fleet tab then monitors
   enrollment itself (registered-never-seen / claimed-offline / online).

### 4.2 SSH-collector re-implementation: yes, as the agentless fallback tier

Trade-offs, decided: agent where Docker exists (every Spark, Narthex, Node 2 —
richer: docker inventory, catalog, audited actions, tailscale); SSH where it
doesn't or shouldn't (macOS laptops, Windows PCs, guest Linux boxes). Costs we
accept from §1: credential custody (adopt upstream's encrypted-at-rest
pattern), trust-on-first-seen host keys, and per-OS script maintenance —
offset by zero install friction on the target. Re-implement, spec-only:

- 3-step add (Connect→Role→Services) with **ephemeral capability test before
  persist**; platform chosen at add-time.
- One `sshExec` (execFile+argv, env whitelist, `--`, SSRF/user validation),
  ControlMaster multiplexing with digest-named sockets in a 0700 dir,
  ControlPersist ~60 s, AES-GCM credential store, stdin-only sudo.
- Output **normalized to `NodeAgentSnapshot` shape** so the fleet UI is
  platform-blind (`connection.js` and `registry.js` stay untouched; an SSH
  node is just another poll transport).

Spec pointers per OS (upstream files to read, not copy):
- macOS: `SystemCollector.js` macmon block — macmon discovery paths, `pipe`
  JSON, ~1.5 s sample TTL, one SSH call/cycle, absent-binary backoff.
  Binary: vladkens/macmon (MIT), installed from upstream's own repo.
- Windows: `windowsMetrics.js` — `-EncodedCommand` base64 UTF-16LE scripts,
  `---` section format, 8191-char cap, stdin-close, AMD perf-counter
  fallback; `ssh.js:explainSshFailure` for the cmd.exe and
  `administrators_authorized_keys` error hints.
- Linux: existing Spark bash pipelines + stdin-sudo for privileged reads
  (`41f3c92`).

### 4.3 Guards and lanes do not enroll as systems

Per §3, a guard-proxy (hasso5703 or ours) enters as a **recipe + port** in the
node-agent catalog on an already-enrolled unit. Node enrollment, lane
registration, and guard monitoring stay three distinct flows that converge on
the fleet card.

### 4.4 S1 landing order (for the orchestrator's decomposition)

1. Poller bearer-token support + registry field (smallest, unblocks token
   hygiene everywhere). 2. Claim token + pending/claimed status in registry +
   fleet tab. 3. SSH transport (exec wrapper + credential store +
   multiplexing) behind `protocol:"ssh"` on the NodeRecord. 4. Linux SSH
   collector → 5. macOS (macmon) → 6. Windows (PowerShell-encoded), each
   emitting the normalized snapshot and its own ephemeral-test capability
   report. 7. Guard-proxy recipe monitoring rides along in 4–6.

---

## Sources

- Upstream (fetched `upstream/main` @ `3e6d4ef`, read-only spec study):
  `server/collectors/ssh.js`, `windowsMetrics.js`, `SystemCollector.js`,
  `server/{index,auth,validate,secretsStore}.js`, `docs/REMOTE-ACCESS.md`,
  `src/components/AddSparkDialog.tsx`, `addSparkSteps.ts`; commits `63dfe8a`,
  `3aff819`, `e78247c`, `8b32be3`, `2578e51`, `b1f3b7a`, `a50cfe4`, `41f3c92`,
  `8306e1a`, `e03b9d6`, `29153a6`. Apache-2.0 — spec only, zero code copied.
- This repo: `docs/PIVOT-AGENTIC-PLATFORM.md` (§1 license ruling, §2 model,
  §4 owner decisions), `docs/NODE-AGENT.md`, `docs/B12b-findings.md` (today's
  registration flow), `server/fleet/{connection,registry}.js`,
  `server/index.js` (fleet routes), `agent/http.js`.
- Web (fetched 2026-10-18): netdata/netdata README (Parent/Child streaming;
  claim + Nodes-approver flow per Netdata Cloud docs, learn.netdata.cloud);
  nicolargo/glances README (client/server + REST, no in-band auth);
  cockpit-project/cockpit README (per-user browser sessions, SSH logins;
  socket-activated per-user design per cockpit-project.org);
  hasso5703/dgx-spark-qwen38 README (`keepalive-proxy.py`, :30001/:30000,
  lane scripts, systemd template).
