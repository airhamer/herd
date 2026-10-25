# SPEC: Spark Update Subsystem

**Status:** Draft v3 (2026-10-08) — incorporates Steve's three directives from
v2 review (dual timer/cron substrate, strategic wave ordering, 6-minute grace
with no-intervention). Replaces the v1 update model in its entirety.
v1 §3.1 (unified registry) is retained, summarized in §7.

---

## 1. Goal

Let sparkDash see and drive the **same update backend that each DGX Spark's own
dashboard uses**: detect available DGX OS updates (Ubuntu packages + firmware +
GPU/CPU drivers), show them across all sparks in one place, and run or schedule
the update + reboot from sparkDash — strategically, so **LLM access stays
available**, and with the reboot window tracked instead of demanding a human
sit by the console.

Two benefits over the stock DGX Dashboard:
1. **One view over all spark backends** (the stock dashboard is single-node).
2. **Deferred, strategic execution**: schedule the update for later, group
   sparks that must go together, sequence groups so a serving stack is never
   fully offline longer than necessary, and track the reboot window.

Explicitly **not** in scope: updating the node agent, services/containers, or
the sparkDash dashboard itself as "update components". A spark update is a
spark update — DGX OS + firmware, full stop.

---

## 2. Findings: DGX Dashboard Backend (verified on gx10-1c2c)

### 2.1 Per-spark services

| Unit | Runs as | What it is | Reachable from Narthex? |
|---|---|---|---|
| `dgx-dashboard-admin.service` | root | D-Bus `com.nvidia.dgx.dashboard.admin1` (system bus). Policy-restricted: method calls from uid=1000 are rejected (`AccessDenied`). | No — local system bus, root-only. |
| `dgx-dashboard.service` | `dgx-dashboard-service-user` | Go binary `/opt/nvidia/dgx-dashboard-service/dashboard-service -port 11000 serve`. The actual API + web UI. | **No — binds `127.0.0.1:11000` only** (verified via `ss -ltnp`). |

Consequences:

- The **loopback-only** HTTP API is the update surface — there is no networked
  endpoint and the D-Bus admin interface is a non-starter for us.
- The central sparkDash dashboard (Narthex) therefore **cannot reach either
  directly**. The node-agent daemon already running on each spark (port 30091,
  bearer-token) is the natural bridge: it can hit `127.0.0.1:11000` locally.

### 2.2 API surface (`http://127.0.0.1:11000/api/v1`)

Auth: Bearer JWT. Login endpoint issues the token; `dashboard-admin`'s PAM logs
indicate username/password (PAM) authentication. Exact login payload/endpoint
shape is the first spike in §8 Batch 1 (probes of `GET/POST /login` 302-redirect
to the SPA login form).

Endpoints relevant to the update flow (verified status codes, unauth where noted):

| Endpoint | Purpose |
|---|---|
| `GET /updates` | OTA availability snapshot: `OTAAvailabilitySnapshot`, `OTAInfoData` (priority, releaseNotesUrl), `PackageUpdateData` (Ubuntu apt list), `FirmwareUpdateData`, `UpdateListData`. |
| `GET /updates/settings` | Whether updates are admin-disabled. |
| `POST /update_reboot` | Start the update + reboot sequence. |
| `GET /update_reboot/status` | `isUpdateRebootInProgress` (401 unauth — token required). |
| `GET /update_reboot/stream` | WebSocket progress stream. Stages: `update_cache`, `upgrade_packages`, `upgrade_firmware`, `operation`, `reboot`, `error`. |
| `GET /telemetry`, `GET /gpu_telemetry/stream` | Existing telemetry (out of scope, noted for reference). |

### 2.3 Update mechanism (what actually happens)

- **Content:** Ubuntu packages (apt), firmware via `fwupdmgr`, GPU/CPU drivers —
  the DGX OS "OTA" bundle. Not a plain `apt upgrade` (drivers + firmware make
  the stock one-liner unsafe); NVIDIA's documented recommendation is to use the
  dashboard flow.
- **Manual equivalent** (operator fallback only, not part of this subsystem):
  `sudo apt update && sudo apt dist-upgrade && sudo fwupdmgr refresh && sudo fwupdmgr upgrade && sudo reboot`
- **Reboot:** `/opt/nvidia/dgx-dashboard/dgx-dashboard-reboot.sh` = sleep 10 s →
  `systemctl reboot`, logging to `/var/log/dgx-dashboard-reboot.log`.
- **Release state:** `/etc/dgx-release` — `DGX_SWBUILD_VERSION` + one
  `DGX_OTA_VERSION`/`DGX_OTA_DATE` per applied OTA. Current on 1c2c: SWBUILD
  7.2.3, latest OTA 7.6.0 (2026-09-17).

### 2.4 Fleet state

- **2026-10-09 re-verify (Batch 1): all three sparks — enabled + active, 127.0.0.1:11000 listening.**
- **“Stopped by design” finding (10-08) still valid**: `dgx-dashboard.service` is intentionally kept (enabled) and must be started; it is **not GNOME-dependent** (~30 MB RSS, loopback only). Currently running on all three sparks because GNOME is still active (not yet stopped on any spark). If GNOME is stopped on a spark, the service must be started independently (`systemctl restart dgx-dashboard.service`).
- Passwordless `sudo` confirmed for steve on all three sparks (not required for the HTTP path).

### 2.5 Batch-1 spike findings (2026-10-09, read-only; no trigger fired)

- Route discovery via **401 vs 302 signal**: real API paths answer JSON `401 {"error":"missing or invalid Authorization header"}`; unknown paths 302-redirect to `/` (SPA fallback). All routes live under `/api/v1/*` except login.
- **Login:** `POST /api/login` with JSON `{username, password}` (PAM). Wrong password → **500** `{"error":"Failed to run authenticate operation"}` (not 401). Success token field name TBD — needs real credentials (agent caches token, re-login once on 401).
- **Confirmed present (401 unauth):** `GET /api/v1/hostname` · `GET /api/v1/updates/available` · `GET /api/v1/updates/list` · `POST /api/v1/update_reboot` (the trigger — POST, body TBD) · `GET /api/v1/update_reboot/status` · `GET /api/v1/update_reboot/stream` (401 JSON unauth; WS vs SSE TBD once authed — client must auto-detect via `Content-Type`) · `POST /api/v1/logout`.
- **Public (no token):** `GET /api/v1/updates/enabled` → `{"updatesEnabled":true}`.
- **D-Bus `com.nvidia.dgx.dashboard.admin1` is policy-denied even to root** (introspection rejected from uid 0) — dead end confirmed; HTTP + JWT is the path, per §3.

---

## 3. Architectural Decision

```
┌─ Narthex (sparkDash dashboard, :5555) ──────────────────────────────┐
│  Updates page ──> thin proxy routes ──> WaveSequencer (gate only)    │
│                            ▲                                        │
│                            │ existing FleetConnection 2-s poll     │
└────────────────────────────┼────────────────────────────────────────┘
                             │ bearer token, :30091 (existing channel)
        ┌────────────────────┼─────────────────────┐
        ▼                    ▼                     ▼
   spark 1c2c           spark 102c            spark 25ed
   ┌────────────────┐   ┌────────────────┐    ┌────────────────┐
   │ node agent     │   │ (same)         │    │ (same)         │
   │  /updates      │   └────────────────┘    └────────────────┘
   │  /actions      │
   │  scheduler ────┼── in-process timers (persisted, re-armed)
   │  (mirror)  ────┼── host cron entries for long-horizon/recurring
   └───────┬────────┘
           ▼
   127.0.0.1:11000   (DGX dashboard backend, loopback-only)
```

- **The node agent owns its own timing.** Schedules (one-shot `at` and
  recurring `cron`) live on the agent: persisted table + in-process armed
  timers, re-armed on start so they survive reboots. For long-horizon and
  recurring schedules the agent can additionally **mirror a real host crontab
  entry** (via its existing host-access deploy) so the plan is visible in
  `crontab -l` and survives even a full agent-reinstall; the in-process table
  remains the source of truth and the idempotency guard makes double-fire
  harmless.
- **The dashboard owns sequencing, not timing.** It holds no per-node schedule
  and runs no scheduler loop — v1's 30-second `config/schedules.json` poll on
  Narthex is deleted. It does hold a **WaveSequencer**: a small gate that
  advances fleet-wide update plans by reading fleet state FleetConnection
  already polls every 2 s (no new interval). When the current wave's members
  are all fully healthy, it fires the next wave. If the dashboard was down at
  the moment a wave finished, it re-evaluates on restart and proceeds.
- **Between events there is no polling for updates anywhere.** The only
  periodic traffic on the updates path is the pre-existing 2 s `/health`
  telemetry poll and UI refresh on an open page (§6.3).

### 3.1 Update groups and waves (strategic execution)

An **update group** is a set of sparks that must update **together** — they
serve one stack and are half-alive-or-fully-dead anyway. A **wave** is one
group's turn; waves run **sequentially**: wave N+1 starts only after every
member of wave N is *fully available*.

**Grouping derivation** (topology-driven, manual override allowed):

| Signal | Grouping |
|---|---|
| Serving pair from the **live launch recipe** (AEON TP2 = 102c head `tp2-node0` + 25ed worker `tp2-node1`; the registry `headId` for 25ed is stale — says 1c2c, registry batch must correct) | The head+worker pair is one group. Updating a TP pair one node at a time doubles the partial-failure window with zero availability benefit — they go together. |
| Node with no worker relationship and role `head`/`standalone` | Standalone group of one. |
| RoCE link graph | **Not** used for grouping (the 200 GbE links form a full triangle across all three — every pair is "linked"). Grouping follows the serving topology (`headId`/`groupId`), not the fabric. |

**Fleet example (current configuration, live `config/nodes.json`):**

- Group A: `{ gx10-1c2c }` (standalone — single-node sglang
  `qwen3.8-flash-next` on :8080)
- Group B: `{ gx10-102c, gx10-25ed }` (AEON TP2 pair — 1M-context `aeon` on
  :8000; live-verified 2026-10-09: `tp2-node0` on 102c, `tp2-node1` on 25ed,
  head `/health` 200)
- Default wave order: **A then B.** Rationale: while 1c2c updates, the AEON
  pair keeps the primary 1M-context LLM up; while the pair updates, 1c2c is
  back and its flash-next carries serving. The fleet ends in full health.
  Order is editable in the wave-plan UI before scheduling.

**"Fully available" gate (per member, all must pass):**
1. Agent reachable (`/health` OK) with a new boot id since the trigger.
2. Last update outcome = `success` (from the agent's persisted event log).
3. No update in progress on that node.
4. If the node has LLM monitoring: its LLM endpoint answers healthily
   (existing collectors already probe this — no new probe type).

A group advances only when **all** its members pass; the next wave fires via
the same `dgx-update-now` action on each member.

### 3.2 No-interference rules (firmware safety)

While any node is inside an update window (trigger → back online → gate
pass), the dashboard and agents:

1. Never trigger another wave (WaveSequencer enforces; direct triggers get
   409).
2. Never run actions that could reboot or interrupt: no agent redeploy, no
   node/service restart actions, no DGX-dashboard-service restart, no
   cancel/modify of the in-flight schedule.
3. Never auto-act on a slow recovery (§6.2): a node taking longer than the
   grace window is displayed and reported, **not** touched. Firmware updates
   legitimately run long; the gate simply does not open.
4. Fleet-wide scheduling is safe by construction: waves are serial and the
   gate is conditional (state-based), not clock-based.

---

## 4. Update Lifecycle

```
probe ──> notify (badge) ──> list (details dialog) ──> approve
                                                       │ now     │ scheduled (at | cron)
                                                       ▼         ▼
                                                   trigger   timer/cron fires
                                                       └────┬────┘
                                                            ▼
                                        update_cache → packages → firmware
                                                            ▼
                                                  stream: reboot  →  agent lost
                                                            ▼
                                          REBOOTING (grace 6 min, counted)
                                       │                        │
                                  back ≤ 6 min             > 6 min elapsed
                                       ▼                        ▼
                              confirm outcome        SLOW (no action, keep waiting;
                              (success → OTA x.y      gate stays shut; UI shows
                               applied / error)       elapsed + "firmware may
                                                      run long" note)
                                                            ▼
                                                   eventual back-online → confirm
```

- **Probe:** agent `GET /updates` (+ `/updates/settings`) — on demand and on a
  slow agent-side cadence (default hourly).
- **Notify:** "Update available" badge on the spark's fleet card.
- **List:** package table, firmware table, OTA version/priority, release-notes
  link — all from the 11000 snapshot; no GitHub re-fetch anywhere.
- **Approve:** immediate ("Update now", confirm dialog) or scheduled —
  one-shot datetime (`at`) or recurring cron expression (`cron`).
- **Run:** agent `POST /update_reboot`, consumes the WebSocket stream into a
  persisted event log (the machine reboots; the agent's local ring buffer is
  the progress source of truth).
- **Recovery:** dashboard marks the spark `REBOOTING` counting against a
  6-minute expected-recovery window. Exceeding it changes **display and
  reporting only** (`SLOW`, elapsed time, suggested attention) — no
  automated action, ever (§3.2). The agent's first `/health` after boot (new
  boot ID) confirms back-online and the last streamed outcome is reported.
- **Gate:** for fleet plans, the member passes the §3.1 "fully available"
  checks before the next wave may fire.

---

## 5. Node Agent (per spark)

New module `agent/updates/`:

| File | Responsibility |
|---|---|
| `agent/updates/dgx.js` | 11000 client: login (JWT cache), `probe()`, `status()`, `trigger()`, `streamToLog()` (WS consumer → event ring buffer, persisted). |
| `agent/updates/scheduler.js` | Schedule table (`agent/config/schedules.json`), in-process armed timers, 5-field cron-expression next-fire computation, re-arm on start, fire → `trigger()` + record; optional host-cron mirror. |
| `agent/updates/cronMirror.js` | Idempotent host crontab entry management (marker-commented, removed on cancel) via existing host access. |
| `agent/config/dgx.json` | `{ host: "127.0.0.1", port: 11000, username, password }` (or token file). Not committed; `.gitignore` + example file. |

### 5.1 New agent endpoints (existing bearer auth on :30091)

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/updates` | — | `{ snapshot, state, schedules }` (cached probe, current update state incl. event log, schedules incl. next fire). |
| POST | `/actions` | `{ action: "dgx-update-now" }` | 202 `{ ok }` — starts trigger + stream consumption. |
| POST | `/actions` | `{ action: "schedule-update", kind: "at", at: <epoch ms>, mirrorCron?: bool }` | `{ schedule }` |
| POST | `/actions` | `{ action: "schedule-update", kind: "cron", cron: "<5-field>", mirrorCron?: bool }` | `{ schedule }` |
| POST | `/actions` | `{ action: "cancel-schedule", scheduleId }` | `{ ok }` (removes timer + host cron mirror). |
| POST | `/actions` | `{ action: "fire-schedule", scheduleId }` | `{ ok }` — idempotent guard; used by host-cron mirror and WaveSequencer alike. |

Rules:

- Idempotent: re-`trigger` while `inProgress` returns 409. `fire-schedule`
  checks schedule status first; a one-shot fires at most once no matter how
  many substrates nudge it (timer + cron double-fire safe).
- Event log: capped ring (e.g. 200 entries), persisted to
  `agent/config/update-events.json` so the outcome survives the reboot.
- One pending schedule per agent; a second `schedule-update` returns 409
  unless `replace: true`.

### 5.2 Scheduler semantics (dual substrate)

- **One-shot (`at`):** in-process `setTimeout` armed to the exact time;
  persisted table; re-armed on agent start (past-due fires immediately,
  marked fired). Survives reboots because state is on disk and the agent is a
  service.
- **Recurring (`cron`):** standard 5-field cron evaluated in-process against
  the agent clock (zero deps); after each fire, `nextFire` is recomputed.
  A recurring DGX-update schedule probes first: if no newer OTA is available
  the fire is a logged no-op (`skipped: current`).
- **Long-horizon / durability option (`mirrorCron`):** when set (and by
  default offered in the UI for schedules beyond ~48 h or recurring), the
  agent writes a marker-commented crontab entry for its user:
  `# sparkdash:<scheduleId>` + a curl POSTing `fire-schedule` to
  `127.0.0.1:30091/actions`. Removed on cancel/replace. Visibility in
  `crontab -l`; harmless if it double-fires.
- Between fires there is **no periodic check of anything** — timers fire,
  they don't poll.

---

## 6. Dashboard (Narthex)

### 6.1 New routes (thin proxies + the wave gate)

| Method | Path | Proxies to / does |
|---|---|---|
| GET | `/api/fleet/updates` | `GET /updates` on each agent (parallel, per-node timeout). |
| POST | `/api/fleet/nodes/:id/updates/now` | agent `dgx-update-now` (409 if another wave is open). |
| POST | `/api/fleet/nodes/:id/updates/schedule` | agent `schedule-update` `{ kind, at|cron, mirrorCron }`. |
| DELETE | `/api/fleet/nodes/:id/updates/schedule/:sid` | agent `cancel-schedule`. |
| POST | `/api/fleet/updates/plan` | Fleet plan: `{ groups: [[nodeId,…], …] }` (ordered waves). Stored in `config/fleet-update-plan.json`. |
| GET | `/api/fleet/updates/plan` | Current plan + wave states (`pending/running/rebooting/slow/healthy/done`). |
| DELETE | `/api/fleet/updates/plan` | Abandon plan (only while no wave is in-flight). |

### 6.2 WaveSequencer + grace

- **State source:** FleetConnection's existing 2 s snapshots (agent health,
  update state, LLM health). No new interval, no polling of anything new.
- **Gate:** a wave advances only when all its members pass the §3.1
  "fully available" checks. Clocks never open gates — this is conditional
  sequencing ("done separately and after the other is fully available").
- **Recovery display:** on stream `reboot` event or mid-update reachability
  loss → `REBOOTING` with elapsed count against `RECOVER_GRACE_MS = 6 *
  60_000`. At 6 min → `SLOW`: prominent elapsed display + a notification to
  the operator ("102c recovery exceeds 6 min — firmware updates can take
  longer; no automated action taken"). **No timeout, no abort, no retry.**
- **Trigger guard:** while any wave is open (any member updating, rebooting,
  or slow), single-node triggers return 409.

### 6.3 UI — Updates page (revised meaning of "updates page")

Not a component-matrix (v1's mistake). It is a **fleet table of spark update
backends plus a wave planner**:

- **Rows:** one per spark — SWBUILD version, latest applied OTA, available OTA
  (version + priority + release-notes link), package count, firmware count,
  last-probe age, state (`current` / `update available` / `updating: <stage>`
  / `REBOOTING 4:12` / `SLOW 22:41 — firmware may run long` / `probe stale`),
  and its group + wave position.
- **Row actions:** "Update now" (confirm dialog; 409 message shown when a
  wave is open), "Schedule…", detail expander (package/firmware tables).
- **Schedule dialog:** mode toggle — **"At" (one-shot datetime)** and
  **"Cron (recurring)"** (expression input + human-readable preview, e.g.
  `0 3 * * 0` → "weekly Sun 03:00"). Checkbox: "also install as system cron
  entry" (mirrors; auto-suggested for horizons > 48 h / recurring). Shows the
  resulting schedule with cancel button.
- **Fleet plan dialog** (from "Update all"): auto-derived groups shown as
  wave cards (current fleet: `1c2c` → `102c + 25ed`), drag/reorder, then
  either "Run now" (wave 1 triggers immediately) or "Start at…" (wave 1 gets
  an `at` schedule on each member; the sequencer handles the rest).
- **Progress:** updating rows show the current stage from the agent event log;
  on back-online a one-shot "Update completed → OTA 7.6.0 applied" /
  "Update failed" summary.
- **Refresh:** on mount + 60 s while all idle, 5 s while any node is
  updating/rebooting (UI refresh, not scheduling).

Fleet card / spark page: single "DGX update available" badge replacing old
component badges; click → updates page row.

---

## 7. Unified Registry (retained from v1 §3.1)

Unchanged: merge `config/sparks.json` + `config/nodes.json` into one
`NodeRecord` schema (spark-monitoring fields + fleet-polling fields),
auto-sync on add/edit/delete, `endpoint` derived from `lanIp`+`agentPort`.
Tracked as its own implementation batch (independent of the update subsystem).
Wave grouping reads `role`/`headId`/`groupId` from this record; manual group
override lands here too.

---

## 8. Implementation Plan

| Batch | Work | Verification |
|---|---|---|
| **1. Spike (read-only)** | Identify the login endpoint/payload + JWT; verify steve's token can call `GET /updates` and `GET /update_reboot/status` on 1c2c. Do **not** trigger anything. | Documented payload + sample `GET /updates` response in `docs/UPDATES-11000.md`. |
| **2. Agent probe** | `agent/updates/dgx.js` (auth + probe + status + event buffer), `GET /updates` endpoint, `agent/config/dgx.json` + example. | Unit tests (mocked HTTP/WS); live probe on 1c2c. |
| **3. Agent trigger** | `dgx-update-now` + `fire-schedule` actions, WS stream → persisted event log, 409 guards, post-boot outcome via boot ID. | Unit tests; live dry-run on a spark **only with explicit go** (it reboots the box). |
| **4. Agent scheduler** | `scheduler.js` + `cronMirror.js`: persisted table, `at` timers, 5-field cron next-fire, re-arm/past-due, host crontab marker entries, cancel. | Unit tests incl. restart, past-due, double-fire, cron expression parse; live schedule-cancel round-trip (no trigger). |
| **5. Dashboard routes + WaveSequencer** | `shared/types.ts` additions; the seven routes; fleet-plan store; wave gate on FleetConnection snapshots; grace display state. | Unit tests incl. gate-advance logic, grace transitions; typecheck. |
| **6. UI** | Updates page, schedule dialog (At + Cron modes), fleet plan dialog (group cards + reorder), stage/grace/slow display, fleet-card badge. | Component tests; full suite ×3. |
| **7. Deploy** | Drop-in `WantedBy=multi-user.target` for `dgx-dashboard.service` on 102c + 25ed; redeploy agent to all three sparks; live end-to-end on 1c2c (probe only). | All three sparks report snapshots on the updates page. |

Batches 3/7 include actions that reboot real machines; each requires an
explicit Steve go-ahead at that point — the plan itself does not cover it.

---

## 9. Data Model (additions to `shared/types.ts`)

```typescript
/** One apt package in an available DGX update. */
export interface DgxPackageUpdate {
  name: string;
  currentVersion: string;
  availableVersion: string;
  sizeBytes: number | null;
}

/** One firmware item in an available DGX update. */
export interface DgxFirmwareUpdate {
  component: string; // UEFI, EC, USB-PD, TPM, SoC, …
  currentVersion: string;
  availableVersion: string | null;
}

/** OTA bundle metadata (from 11000 /updates). */
export interface DgxOtaInfo {
  version: string;
  date: string | null;
  priority: "Critical" | "Normal" | null;
  releaseNotesUrl: string | null;
}

/** Agent-side cached probe snapshot. */
export interface DgxUpdateSnapshot {
  probedAt: number;
  agentReachable: boolean;
  swBuild: string | null;        // /etc/dgx-release DGX_SWBUILD_VERSION
  latestOtaApplied: { version: string; date: string } | null;
  otaAvailable: DgxOtaInfo | null;
  packages: DgxPackageUpdate[];
  firmware: DgxFirmwareUpdate[];
  updatesDisabled: boolean;
}

/** Stage tokens from the 11000 WebSocket stream. */
export type DgxUpdateStage =
  | "update_cache" | "upgrade_packages" | "upgrade_firmware" | "reboot";

/** Agent-side update state (incl. persisted event log). */
export interface DgxUpdateState {
  inProgress: boolean;
  stage: DgxUpdateStage | null;
  startedAt: number | null;
  finishedAt: number | null;
  bootId: string | null;         // post-boot confirmation marker
  lastOutcome: "success" | "error" | null;
  lastOutcomeDetail: string | null;
  events: Array<{ at: number; stage: string; message: string }>;
}

/** One schedule entry, stored on the node agent. */
export interface NodeUpdateSchedule {
  id: string;
  action: "dgx-update";
  kind: "at" | "cron";
  at: number | null;             // kind === "at"
  cron: string | null;           // kind === "cron" (5-field)
  nextFire: number;              // computed; recomputed after each fire (cron)
  status: "pending" | "fired" | "done" | "cancelled"; // cron stays pending
  mirrorCron: boolean;           // host crontab entry installed
  createdAt: number;
  firedAt: number | null;
  lastFireResult: "triggered" | "skipped-current" | "error" | null;
}

/** What GET /api/fleet/updates returns, per node. */
export interface NodeUpdatesView {
  nodeId: string;
  reachable: boolean;            // agent reachable
  snapshot: DgxUpdateSnapshot | null;
  state: DgxUpdateState;
  schedules: NodeUpdateSchedule[];
  // dashboard-derived:
  display: "current" | "available" | "updating" | "rebooting" | "slow" | "stale" | "failed";
  graceElapsedMs: number | null; // set while rebooting/slow
  waveIndex: number | null;      // membership in the active fleet plan
}

/** A set of sparks updated together (one wave). */
export interface UpdateGroup {
  nodeIds: string[];
  reason: "tp-pair" | "standalone" | "manual";
}

/** Ordered fleet plan (wave 0 runs first). */
export interface FleetUpdatePlan {
  groups: UpdateGroup[];
  createdAt: number;
  startedAt: number | null;      // null = planned, not started
  waveStates: Array<"pending" | "running" | "rebooting" | "slow" | "healthy">;
}
```

---

## 10. Deleted from v1 (explicit)

- All "update component" modeling for Hermes agent / node agent / services /
  dashboard (v1 §3.2–3.5, §4.1 `UpdateComponent`).
- Dashboard-side `config/schedules.json`, `server/updates/schedule.js` 30-s
  loop, and `server/updates/detect.js` / `list.js`.
- `LATEST_AGENT_VERSION` comparison, service image-tag diffing, dashboard
  self-update endpoint, "Update All" cross-component batching.
- The four per-component update dialogs.

## 11. Resolved decisions (Steve, 2026-10-08)

1. **Timer substrate:** both. In-process timers for simple/short-horizon;
   real host-cron entries mirrored for long-horizon/recurring. UI offers "At"
   alongside "Cron". → §5.2.
2. **Strategic application:** update groups from serving topology — the TP
   pair updates together (minimum downtime for that stack); the standalone
   spark is a separate wave. Waves run sequentially; the next
   starts only after the previous is fully available. → §3.1.
3. **Grace window:** 6 minutes of expected recovery when the connection drops
   — display/reporting only. Nothing automated may ever touch a node inside
   its update window; slow firmware updates are waited out. → §3.2, §6.2.

## 12. Remaining open questions

1. **Login shape** — Batch 1 spike decides it (likely PAM username/password →
   JWT; exact endpoint, and whether steve's token may call `POST
   /update_reboot`).
2. **Probe cadence** — agent-side hourly + on-demand when the page is open.
   Confirm or tune.
3. **Wave-order override granularity** — per-plan reorder in the UI is
   assumed; per-node manual group override (e.g. force a node into either
   group) deferred to the unified-registry batch.

## 13. Success Criteria

1. All three sparks report a live probe snapshot on the updates page,
   including 102c/25ed running `dgx-dashboard.service` under
   `multi-user.target`.
2. "Update now" on one spark shows staged progress, survives the reboot, and
   confirms back-online with the outcome; recovery display switches from
   `REBOOTING` to `SLOW` after 6 min **without taking any action**.
3. A one-shot schedule fires at the chosen time with zero dashboard-side
   scheduler involvement; a recurring cron schedule fires per expression,
   skipping logged no-ops when already current; both are cancellable; long
   schedules are visible in `crontab -l` when mirrored.
4. A fleet plan runs wave-by-wave: pair members trigger together, the
   standalone waits until the pair is fully available (or vice versa per
   chosen order); a second wave cannot fire while any member is updating,
   rebooting, or slow.
5. No schedule state, no scheduler loop, no component-level update model
   exists on the dashboard (v1 deletions hold).
6. Full test suite green ×3; typecheck clean; unified-registry batch
   unaffected.
