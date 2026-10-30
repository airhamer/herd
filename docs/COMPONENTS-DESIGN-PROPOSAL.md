# Components Design Proposal — component definition catalog (SC2/SC10 POC, batch 5)

**Date:** 2026-10-30 · **Status:** POC (owner-approved 2026-10-30) · **Issue:** airhamer/herd#5 · **PR:** airhamer/herd#22

This is the data-model half of the 2026-10-30 Stacks/Components adoption
(`docs/IMPLEMENTATION_PLAN.md` SC2/SC10). It defines the **component definition
format** — the seam between the data model (SC2) and bootstrap/UI (SC10, SC5) —
and proves it by converting two Hasso cockpit recipes into it.

## 1. What a Component file is

`agent/catalog/components/<id>.json` — one file per Component. A **host-
independent definition**: what to serve, pinned to the commit, with the memory
profile that was *measured* for one (tp, machine-class). It is a catalog entry,
not a node config:

- The **catalog** (this directory) is what stacks pick Components from, what the
  Library shows, and what bootstrap hardcodes as the initial definitions
  (decision #10: examples sourced from our github on install).
- The **per-node instance file** (`agent/config/recipes.json`,
  `shared/recipe.schema.json`) stays what the node agent validates and serves.
  A component file is *materialized* onto a node into a Recipe (mapping in §5).
  Files here are additive; nothing consumes them until SC10's loader lands.

## 2. Schema (fields)

| Field | Meaning |
|---|---|
| `id` | slug `^[a-z0-9][a-z0-9-]{0,31}$`, = file name; carries the scope suffix (§3) |
| `name` | human name for UI |
| `purpose` | filter dimension (SC5): `code` / `embed` / `decision` / `image` / `video` / `audio` / `tts` |
| `kind` | recipe kind enum (`llm` …) — alignment with `shared/recipe.schema.json` |
| `tp` | tensor-parallel size the definition was measured at (1 …) |
| `machineClass` | inference-machine the definition was measured on (`dgx-spark-gb10-128g`, …) |
| `memory_estimate_mb` | `{ perSpark, basis: measured\|estimated, notes }` — the SC3 calculator's bootstrap input (decision #2: unlocked estimates, bootstrapped from these hardcodes, refined after 5 history runs) |
| `engine`, `image`, `imageAlias` | engine kind + **pinned digest** (alias tag is informational; a moving tag is never a pin, per Hasso's rule) |
| `model` / `drafter` | repo + 40-hex revision pins, served name, quantization; drafter algorithm/repo/revision/params |
| `flags` | normalized serving flags (Hasso's `serve` keys) + `switches` (value-less flags as booleans) + `rawArgs` (verbatim launch args) + tier pins |
| `ports` | upstream default port + notes; bind/port stay per-box (Hasso's host placeholders) |
| `memoryProfile` | docker caps, host-mem floor, context modes, offload (PLE) block, env pins — the Hasso memory-visualization inputs (decision #6) |
| `multi_spark` | `{ supported, rule, … }` — the copy-on-… rule, machine-readable (§3) |
| `source` | provenance: origin repo, upstream commit, files read, upstream recipe id, license, retrieved date |

## 3. The copy-on-TP-or-inference-machine-change rule

A definition is scoped to **(tp, machineClass)**. `mem_fraction`, context mode,
docker caps, boot time, and `memory_estimate_mb` are *measurements of that
shape* — the GB10 memory trap (docs `gb10-memory.md` upstream: >0.50 fraction
with the autotuner on freezes a 128 GB box) is why the numbers are not
parameters. Therefore:

- Running the same model at a different `tp`, or on a different machine class,
  means **copying the file** (id gains `-tp2`, `-gx10-64`, …), then re-pinning
  flags and re-measuring `memory_estimate_mb` on the new shape.
- The loader never reinterprets one file at another TP/machine; the
  `multi_spark.rule` field states this so bootstrap/UI can surface it instead
  of silently offering the component at the wrong shape.
- This also matches decision #5/#7: pre-defined stacks pick tp=1 components on
  a single spark and tp=x on a group — the picker filters on the scope fields,
  it does not transform definitions.

## 4. The two converted Hasso recipes (POC deliverable)

Input: `hasso5703/dgx-spark-qwen38` @ `43a3597fdeab4b408fcc62ff663cff9ccc79a158`
(shallow-cloned 2026-10-30, MIT). Extracted from `dashboard/recipes.py`
(recipe structure, FLAGS/SWITCHES vocabulary, pin parsing), `install.sh`
(pinned image/model/drafter revisions and defaults), the unit/launcher
templates (verbatim flags, env, docker caps), and `docs/flash-lane.md` /
`docs/gb10-memory.md` / `docs/context-1m.md` (measured memory/boot numbers).

1. **`agent/catalog/components/qwen38-27b-stock-sglang-tp1-gx10.json`** —
   27B-style. From Hasso builtin `stock` (native context mode):
   `RadixArk/Qwen3.8-27B-NVFP4` @ `52d1adc5…` + DFlash2 draft
   `maurienne-ai/Qwen3.8-27B-DFlash2-NVFP4-RTNcal` @ `bd7a9342…`,
   image `lmsysorg/sglang@sha256:e3a4f06…` (= v0.5.22), mem-fraction 0.50,
   8 running requests, 100g docker cap, context modes native/1m(0.76)/64
   recorded as *modes in one file* (same shape, install-time switch — unlike
   TP, changing context mode does not change the machine).

2. **`agent/catalog/components/qwen38-flash-next-sglang-tp1-gx10.json`** —
   flash-style. From Hasso builtin `flash`, concurrency tier:
   `RadixArk/Qwen3.8-Flash-Next-NVFP4` @ `7b719225…`,
   image `lmsysorg/sglang@sha256:3e79541…` (= nightly-cu134-20261011-53295c6),
   mem-fraction 0.85, 110g cap, 96 GiB host floor, the 47.7 GiB file-backed
   PLE table + ATS requirement + 12-15 min boot all captured in
   `memoryProfile.ple`. Tier flags pinned; alternatives recorded as notes so a
   tier copy is explicit. `multi_spark.singleSparkOnly=true`: the fit
   mechanism is GB10-specific, so it is not copy-and-run onto another class.

Both carry full `source` provenance and pass `jq` parse; both are outside the
`agent/catalog/*.js` loader's reach until SC10 wires it (no gate risk to the
existing agent suite, which loads `agent/config/recipes.json` only).

## 5. Materialization map (component → node recipe / RecipeFile)

For SC10: `id→name`, `model.repo→modelPath`, `model.revision→modelRevision`,
`image+digest→image+imageDigest`, `flags.mem_fraction→memFraction`,
`tp→tpSize`, `flags.context_length→contextLength`, quantization normalized to
the recipe enum, `rawArgs→args`, `memoryProfile.env→env`,
`memory_estimate_mb.perSpark→footprintMB`, `ports.engine→port`,
`kind→kind`; `purpose/machineClass/memoryProfile/multi_spark` are catalog-side
and dropped at materialization (recipe schema v1 is frozen).

## 6. Deviations & rulings

- **One method only** (per brief): the format chosen is one-JSON-per-component
  with scope in the id + `multi_spark` block. Hasso's one-file-per-recipe JSON
  custom-recipe layout (`~/.config/qwen38/recipes/*.json`) is what we mirrored;
  no second design is proposed.
- Hasso's `validate()` regexes (id, image, repo, 40-hex revision) were adopted
  as the de-facto pin quality bar; SC2's formal `shared/component.schema.json`
  should encode them when it lands. **Out of scope here** (files-listed rule:
  `shared/` untouched).
- Context mode: kept *inside* one file (`memoryProfile.contextModes`) rather
  than as a copy trigger — it does not change tp or machine, and Hasso treats
  it as a per-install switch. If the owner rules context mode is a copy axis
  too, the 27B file splits into `-native`/`-1m`/`-64` copies; nothing else
  changes. This is the only open design question; flagged, not dual-ruled.

---

## 7. The action seam — using the components (batch 6, issue #6)

**Status:** POC method (owner-approved phase) · **Seam contract:**
`shared/types.ts` (ComponentActionRequest / ComponentActionResult) ·
**Producer reference:** `agent/actions/component.js` · **Server half:**
`server/fleet/componentActions.js` + `POST /api/fleet/nodes/:id/component-actions`.

This section designs **one method** for acting on component/lane changes:
dashboard-initiated start/stop/switch over the v2 action seam, with the
guard/keepalive proxy as the sole LLM traffic path, integrated with the
existing agent actions (docker/systemd/llm-switch/audit) and the §1–§5
component definitions. Everything below is that one method; §7.9 lists what
deliberately is NOT in it.

## 7.1 The three facts the method stands on

1. **The component definition is the action's address.** A dashboard action
   names a component *id* (§1), never a container, unit, or port. Ports,
   handles, flags, and pins are resolved on the node by materializing the
   definition (§5's map) into a recipe — the node already validates and serves
   recipes; the action layer already dispatches against recipes. Component
   actions add exactly one step in front of that: *materialize, then act*.
2. **The proxy is the traffic seam.** All LLM traffic enters through the
   guard/keepalive proxy (external reference per PIVOT §4.2 — monitored, not
   vendored; `agent/collectors/proxy.js` already reports it). Clients never
   learn engine ports. An action therefore never rewires traffic: it changes
   what answers *behind* the proxy, and the result carries proxy evidence
   (`traffic.servingModels`) proving the change is visible on the traffic
   path, not just in docker.
3. **State answers "what is running", intent answers "what should run".**
   v1 `switch` let the agent *guess* the victim by scanning live snapshots.
   v2 never guesses: the caller states `exclusiveWith` or issues explicit
   stop/start. The agent's job shrinks to goal-state verbs + canary + audit.

## 7.2 The exact actions the agent supports

Three verbs, per `ComponentActionType` (the full list; anything else is a
400 from `validateComponentActionRequest`):

| verb | meaning | mechanics (existing modules) |
|---|---|---|
| `start` | make componentId the served component on the target spark | materialize recipe if absent (idempotent: already materialized → step `skipped`) → if `exclusiveWith` set: stop its recipe (llm-switch's stop step) → start → canary → traffic-check |
| `stop` | take componentId out of service | stop its recipe via docker/systemd handle (already-stopped = success, `canaryState:"stopped"` — the idempotent tolerances from llm-switch.js carry over) |
| `restart` | relaunch in place | stop → start on the SAME recipe; no materialize, no pin change. This is how a context-mode switch inside one definition (§6, open question) is executed: the mode is a launch-flag change → `recipeName` override + `restart` |

**`switch` is not a v2 verb.** A dashboard "switch component A → B" is
*composed by the dashboard server*, in this order, as two seam calls:
`start B (exclusiveWith: A, after confirm)` — the take-turn path, which is
atomic inside the agent (stop old → start new → canary, the S3.1 lane
semantics already implemented) — or, when the UI shows both lanes coexisting
(no exclusive pool), plain `start B` + `stop A`. The agent never sees the
word `switch`. This is the single method for handoffs: stated intent +
take-turn, one request, one atomic window.

`restart` also absorbs v1's other switch use (relaunch same service) without
reintroducing state-guessing.

## 7.3 How the dashboard sends them

Browser → **dashboard server only** (the node agent is never contacted from
the browser; same trust shape as the existing `/actions` and updates
proxies):

```
POST /api/fleet/nodes/:id/component-actions     ← browser
  body: { componentId, type, groupRef?, exclusiveWith?,
          confirmationToken?, dryRun, recipeName?, timeoutMs? }
  → server: buildComponentAction() pins version=2, actionId (server-minted
    UUID), nodeId (from the ROUTE — body cannot retarget), actor (session).
  → proxyComponentAction() → agent POST /actions (v2 body verbatim)
  ← ComponentActionResult (status, canaryState, steps, state, traffic, plan, logs)
GET  /api/fleet/nodes/:id/audit?limit=N         ← logs: the audit trail
```

**Outputs, per the seam:** `status` (success|failure|running), `logs` (the
engine/container log tail, surfaced when an action fails; `GET audit` for
the durable trail — AuditEntry already carries it), and *updated state*
(`state: VersionInfo` re-read from live `/versions` after the action, plus
`traffic` from the proxy collector — the Traffic tab's data, proving the
proxy now answers the new component). `status:"running"` covers boot-class
durations (12–15 min flash lane): the agent accepts the action, the client
polls — the seam carries no push channel; polling the fleet snapshot stays
the dashboard's existing pattern.

**Group (tp=x) targets:** one seam call always names ONE spark (`nodeId`)
plus `groupRef` for the group it belongs to. A group action is a *fan-out
plan* the server builds from topology (SC7/SC8's sequencing engine): one
request per member with the same `groupRef`, wave ordering, downtime
preview = sum/max of the per-member `plan.estDowntimeMs`. The action schema
does not encode waves; plans do. (That is SC8's brief; this seam carries
the `groupRef` + plan fields it needs and no more.)

## 7.4 Confirmation — two classes, one token

A dry run (`dryRun: true`, mandatory first leg of every UI change) returns
`plan` with a **confirm class**:

- **`none`** — cannot interrupt anything answering traffic: `start` with
  `exclusiveWith:null` where the stack category is calculated/proven and no
  lane pool conflict exists. Executes in one call, no token.
- **`required`** — anything that stops or displaces a RUNNING component
  (`stop`, `start` with `exclusiveWith`, `restart` of a serving component)
  or crosses the §3 scope rule. The UI must show the plan (downtime ETA,
  displaced component, in-flight request count, memory delta), the user
  confirms, and the real call replays the minted `confirmationToken`.

The token binds to the *exact plan* — HMAC over
`componentId|type|nodeId|exclusiveWith|recipeName|issuedAt`
(`mintConfirmationToken`/`verifyConfirmationToken` in
`agent/actions/component.js`). Same plan within TTL → accepted; any field
drift (user confirms, then the selection changes) → `mismatch`; TTL
elapsed (live state may have moved) → `expired` → UI re-runs the dry run.
Fail-closed on every token anomaly; the agent refuses a token-less
confirm-required action (409-class).

Confirmation is *server-side intent*, not a security boundary: the agent
bearer token remains the authority; the token proves the human saw *this*
plan seconds ago.

## 7.5 Tie to the component definitions (§1–§5)

- **Resolution:** `componentId` → catalog file → §5 materialization map →
  recipe (name, port, image+digest, flags, env, footprintMB) written into
  the node's recipe store and validated by the existing
  `shared/recipe.schema.json` validator. The recipe store stays the single
  instance file — components never bypass it, so the existing dispatch
  path (`containerName`/`systemdUnit` verbs, canary, audit) is reused
  unchanged. `recipeName` in the request exists for re-acting on an
  already-materialized recipe without a catalog round-trip.
- **Scope check executes §3:** before planning, the agent compares the
  component's `tp`/`machineClass` against the target node (class from the
  fleet registry's node capability report) and honors
  `multi_spark.singleSparkOnly`. Mismatch → `plan.scopeBlocked` (reason
  string), `willDo: []`, confirm class `required` (surfacing, never silent —
  the rule §3 states so "bootstrap/UI can surface it instead of silently
  offering the component at the wrong shape").
- **Memory math is §3's calculator, not the action layer's:** the dry-run
  `plan.memoryDeltaMB`/`estDowntimeMs` come from the definition's measured
  `memory_estimate_mb` + boot notes (SC3 refines them later; the seam
  fields are plain numbers either way). A `blocked` category is just
  `scopeBlocked` from the calculator's verdict — one refusal channel.
- **Canary stays engine-shaped:** the v2 result's `canaryState` reuses the
  words `ready|loading|stopped|wedged` exactly as `llm-switch.js` derives
  them today. §7 changes who picks the old/new pair (the caller), not the
  probe.
- **Audit stays one place:** every executed action appends the existing
  JSONL AuditEntry (extended with `componentId`/`groupRef` when present);
  dry runs never audit.

## 7.6 Copy-on-change for recipes (the §3 rule, in the action path)

The rule: a definition is a *measurement* of (tp, machineClass); changing
shape means **copying the file and re-pinning/re-measuring** — never
editing, never reinterpreting. In the action path that becomes mechanical:

1. **An action can only reference an existing definition.** The dashboard
   picker lists ids; there is no "start this model at tp2" affordance that
   mutates a file in flight. The copy IS the new definition (`…-tp2.json`),
   authored offline (by a human or SC10's bootstrap), and only then
   startable.
2. **Scope check refuses the shortcut:** starting `…-tp1-gx10` against a
   tp2-pair target returns `scopeBlocked` naming the rule — the machine's
   way of saying "copy on change", closing the hole §3 left open at the UI.
   `singleSparkOnly` components (flash lane) refuse *any* group target the
   same way.
3. **The recipe copy follows automatically:** materialization keys recipes
   by component id, so the `-tp2` definition materializes as its own recipe
   (`llm-qwen38-27b-tp2`), coexisting with the tp1 instance if both are
   catalog-shapes this box legitimately runs. Nothing "migrates": old
   recipe stays until explicitly stopped; the copy-on-change discipline
   propagates file → recipe without any edit-in-place code path existing.
4. **Context mode is the one sanctioned in-place knob** (§6 ruling): it
   lives inside one definition (`memoryProfile.contextModes`) and executes
   as `restart` with a mode-selected `recipeName` — because Hasso's
   measurement says the machine doesn't change. If the owner later rules
   mode a copy axis, modes become ids and this path narrows; the seam
   doesn't move.

## 7.7 Idempotency, replay, and failure semantics

- **actionId is the idempotency key** (server-minted per user intent, so
  a double-click or a retry after a dropped connection replays the stored
  result instead of re-executing — v1's `withIdempotency` in systemd.js
  already proves the pattern; SC10 extends its scope to the v2 envelope).
- Verbs are goal-state: re-`start` of a running component → success with
  `steps:[start:skipped]`; re-`stop` of a stopped one → success,
  `canaryState:"stopped"`. Canaries never upgrade failures to successes
  (llm-switch's fetch-failure-degrades-to-loading rule is unchanged).
- **Failure keeps the old answer:** in a take-turn, if the canary reports
  the new component wedged/stopped, the action fails and the audit says
  so; the proxy then answers nothing on that pool until a follow-up
  `start` (old or new). v2 does not auto-rollback — a rollback would be a
  second guess. The failure result carries the log tail so the retry
  decision is human (or SC8's, later, with history). This is honest: the
  downtime window is exactly what `plan.estDowntimeMs` promised.
- The proxy is fail-soft by design: while a lane is down, clients queue /
  retry against the proxy front (keepalive semantics), so a failed action
  degrades traffic to *waiting*, never to *wrong model*.

## 7.8 POC code landed with this design (issue #6)

| piece | file | status |
|---|---|---|
| seam contract (v2 request/result/plan) | `shared/types.ts` | additive; v1 marked deprecated, untouched otherwise |
| agent-side pure primitives: validation, plan-bound confirm tokens, v2→v1 downgrade, result envelope | `agent/actions/component.js` | reference impl, 12 tests (all fail-closed paths known-answer tested) |
| server-side build (route-pinned nodeId, server-minted actionId) + proxy (501/502 mapping, boot-class timeout) | `server/fleet/componentActions.js` + route in `server/index.js` | 9 tests, fetch injected |
| v2 verb handling in dispatch (materialize step, exclusiveWith take-turn, traffic-check step, dry-run short-circuit) | `agent/actions/dispatch.js` | **not in this POC** — needs the SC10 catalog loader; the primitives exist so it lands without seam churn |
| UI (Components/Library dialogs, plan preview, token confirm) | `src/**` | not in this POC (files-listed rule) |

## 7.9 Explicitly not this method (one method, per brief)

- No new verb for stacks (a stack is a *plan* of component actions, SC8),
  no bulk/"apply" action, no auto-rollback, no push/webhook result channel
  (polling stays), no proxy reconfiguration action (the proxy front is
  fixed; engine changes only), no second confirmation channel (e.g. email
  approval), no agent-side model download (materialize validates pins;
  pulling a missing pinned checkpoint is a preflight finding, not an
  action).
