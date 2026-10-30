> Superseded as the action list by GitHub issues in airhamer/herd on 2026-10-30.
> Status is the issue label: `needs-decision`, `ready`, `in-progress`, or `done`.
> This file is design rationale only. Do not add open rows here.

# H.E.R.D. Cockpit Adoption — Stacks, Components, Library, Multi-Spark & Downtime (2026-10-30)

**Date:** 2026-10-30
**Revised:** 2026-10-30 (new master plan superseding all prior; root file overwritten per user instruction; morning session design/decisions now authoritative)
**Author:** Jarvis (orchestrator, following large-project-orchestrator Phase 0)
**Supersedes:** All prior IMPLEMENTATION_PLAN.md (root and docs/), old S-series register, 2026-09-22 multi-spark plan, and github-plan-migration of old D rows. The action list for legacy items is now on GitHub (see below). This is the single tracked plan and register (per large-project-orchestrator v7).

**Companion planning documents (document-first approach — review these before granular batch prompts):**
- PHASES.md (high-level phases)
- docs/COMPONENTS-DESIGN-PROPOSAL.md (initial Hasso + MiaAI research + multi-spark extension design — started 2026-10-30; POC steps build on it)
- DELEGATION_AUDIT.md (updated for new capabilities)
- TEST_PLAN.md (to be reconciled)
- ORCHESTRATION.md (standing orders)

**Key directive from user (injected + explicit):** Document-first project decomposition. The first steps are to discuss the approach through PHASES.md, DELEGATION_AUDIT.md, and this IMPLEMENTATION_PLAN.md (reviewed by user) before creating granular prompts or dispatching workers. None of the 2026-10-30 morning design/decisions were in prior plans; this document rectifies that.

## 0. How to read this file

This is the **master plan AND the open-action register** (ONE tracked plan per large-project-orchestrator). 

- Read top-to-bottom for current state, target design from the 2026-10-30 session, and high-level phases.
- Read §3a for the open register (SC1–SC12 priority; legacy items noted as migrated).
- Design decisions from the morning session (Hasso source review + explicit Q&A answers) are authoritative and supersede all prior.
- Running log is newest-first.
- External issue tracker (GitHub) is a discussion surface only — cross-linked; the register here + labels on issues are truth.
- This plan was created as part of Phase 0 planning. Granular batches/prompts come only after user review of the planning docs.

**Document-first rule (user preference):** Any decomposition must begin by producing/reviewing PHASES.md, updated DELEGATION_AUDIT.md, and this plan. No granular worker prompts until those are discussed.

## 1. Where We Are (verified 2026-10-30)

### 1.1 Live fleet (from prior session + recent collectors)
- Nodes: gx10-1c2c (192.168.50.226), gx10-102c (192.168.50.118, RoCE 10.200.0.1), gx10-25ed (192.168.50.46, RoCE 10.200.0.2).
- Hasso cockpit running on 1c2c (/home/steve/dgx-spark-qwen38/dashboard/cockpit.py).
- Proxy: qwen38-keepalive-proxy.py (port 8081 in practice; serving engine qwen38-flash/sglang on 8080).
- Library state: docker images (sglang/vllm/qwen/flash), HF cache for checkpoints (pinned/stray/DRAFT).
- Network fixes applied (little-endian route parsing, lanIp preference, NetworkPanel display).
- New collectors in agent: proxy.js, library.js (wired to telemetry).
- UI stub: src/components/Stacks/StackBuilder.tsx .
- GitHub migration completed for legacy items. Old D1/D2/D3 closed as no longer relevant (per user 2026-10-30). New SC work is the focus.

### 1.2 Base state before morning session
- Old terminology: Lanes, Library components.
- No stacks.json, no multi-spark group resource calc, no downtime sequencer/preview, limited filters, individual cards for group members, locked estimates, no Hasso memory viz or aggregated group memory.
- Proxy detection was incomplete (hardcoded port mismatch).
- Library collector not present.

### 1.3 Gap analysis — morning session decisions (Hasso + user Q&A)
Hasso source review (DESIGN.md, CAPABILITIES.md, recipes.py, lifecycle.py) showed:
- Exact pinning in recipes (image, revision, drafter, flags: mem_fraction, context, etc.).
- Lifecycle states + historical ETAs for downtime.
- Panels: Lanes (load), Library (recipes/pins/checkpoints/drift), Traffic (table+stats), Machine (detailed memory breakdown), Requests.
- Vanilla reliability; SSE; explicit confirms.

**User decisions (Q&A answers, supersede all prior):**
1. **Storage**: New `stacks.json`. No auto-fetch on install. Manual download from github/web to extend/replace (dedup). Merge/export/import in setup menu. User can add custom stack definitions.
2. **Estimates**: UI unlocked (we will become the source of initial estimates in future). Bootstrap with hardcodes (TP=2 qwen38-27b aeon7 startup data + Hasso model). Update from real-world testing/runs (average after 5 historical events, independent of first run).
3. **Topology / RoCE grouping + test/setup**: TBD later (explicitly deferred).
4. **Parallel startups**: Defined by recipe/stack.
5. **Pre-defined stacks**:
   - Single spark or non-spark system: only tp=1 components that can conceivably fit in available memory.
   - Multi-spark group: default show tp=x where x = number of GPUs in the multi-spark group (user can change).
6. **Presentation**:
   - Adopt Hasso's memory display (flash export, system, page cache, free, swap, floor, KV guard — better visualization).
   - Fleet page: multi-spark groups show **aggregated memory in a single line** across all sparks.
   - Fleet Overview: no multiple cards for members of a group (groups configured in topology tab TBD). Group cards list components (where models listed now). Aggregated multi-CPU/GPU temp lines.
   - On card select: Services tab has three sub-tabs — Components (stacks as filter, components grouped in stack card), Library (Hasso equivalent + stacks), **new Traffic tab** (proxy + engine, most accurate).
   - Filters at top of presented list: tp=x (based on target GPUs), recipe source (hasso vs mia-ai-lab etc.), inference engine, LLM purpose (code/embed/decision/image/video/audio/tts), pre-defined stacks (selectable/creatable in bar).
   - Group stack is distributed; some components may only run on one spark in the group.
7. **Group stack model**: Default select the spark group then compatible components for that group. Main component(s) for TP=x across group; then options that can fit in remaining memory on individual sparks in the group. Free memory calculated.
8. **Downtime on execute**: Preview sequence list (shutdown to free resources first, then startups; parallel per recipe/stack). Total ETA (recipe estimates until 5 history avg). Live during execution (progress + logs).
9. **Resource calculation**: New (Hasso lacks multi-spark). Follow Hasso lane/recipe estimation model, expanded to spark group with per-spark estimates + group total/breakdown. Bootstrap as above; refine via real testing.
10. **Pre-defined/external**: Support storage/retrieval of stack definitions from external sources (manual for now). Examples in component recipe config sourced from our github on install (AEON-7 as examples only; his designs are old).

**Additional design constraints (user 2026-10-30 clarification):**
- A component/recipe definition is bound to a specific TP and inference machine. Changing the TP number or the inference engine/machine **requires copying the definition into a new recipe** (prevents implementation problems across sparks). Multiple similar models may share the same base recipe (following Hasso's pattern).
- The dashboard must handle model lifecycle smartly: download a model once on one host, then copy it to other local instances as needed (no repeated full downloads).
- Concrete example: AEON-7 Qwen38-27b was selected for the dual-spark setup because following MiaAI GLM-5.3 instructions did not succeed.

11. **Ideas from Hasso for implementation**:
    - recipes.py style for pinning exact components/stacks (extend our recipes/catalog).
    - lifecycle.py for states/ETAs (adapt for shutdown + startup sequence preview + live).
    - Panels + filters for efficiency (adopt/extend in ServiceManager/Fleet + new views).
    - Library for checkpoints (pinned/stray/status), engine images, pins (enhance catalog/recipes + new collector).
12. **Other**:
    - Proxy collector: focus on serving inference process (not just keepalive); detect via ps + systemd + docker ps; probe correct port.
    - Library collector: scan docker images (sglang/vllm/qwen/flash), HF cache dirs for checkpoints with size/status (pinned/stray/DRAFT); placeholder for pins from recipe imageDigest.
    - 5 historical events threshold before averaging downtime (independent of first run).
    - Pre-defined initially limited by memory/TP rules above.

**Additional session work completed**:
- Proxy collector created + wired.
- Library collector created + wired (library field in telemetry).
- StackBuilder.tsx stub.
- Network/collector fixes (RoCE, lanIp, display).
- Progress card for "Full Cockpit Adoption".
- GitHub plan migration for legacy items.
- Plan supersede text in docs/ (now reconciled here).

## 2. Target Design

Adopt and generalize Hasso's cockpit for multi-spark groups + our stack model.

**Core concepts (renamed per user):**
- **Components** (formerly Lanes): the loadable units.
- **Subcomponents** (formerly Library components).
- **Stacks**: groups of components (with 4 categories: Proven, Calculated, Not recommended, Blocked).
- Group stacks are distributed; some subcomponents may run on only one spark in the group.

**Architecture updates:**
- Per-node agent collects proxy (serving process) + library (checkpoints/images/pins) + existing telemetry.
- Server aggregates for fleet/group views.
- UI: Fleet shows group cards only (aggregated memory, temps, components list). Detail view has Components/Library/Traffic sub-tabs + filters + stack selector.
- Resource budgeting: multi-spark aware (TP=x default for group + per-spark singles).
- Downtime sequencer: preview + live (shutdown first to free, then parallel startups per stack/recipe).
- Storage: stacks.json (manual external extend/replace + dedup; user custom + pre-defined examples).
- Estimates: unlocked + bootstrapped + refined from history.

**Integration points:**
- Proxy is the only path for LLM traffic.
- Stacks filter + pre-defined in UI.
- History for proven category + ETA averaging.
- Extend existing recipes/catalog for stacks/pinning.
- Hasso memory viz in Machine/ detail views.

## 3. Implementation Phases (high-level, document-first)

**Parallel safety:** Disjoint file sets where possible. Shared scaffolding (shared/types.ts, telemetry, recipes) counts as shared — sequential for those.

Hazard tags: numeric | state-mutation | both | neither.

High-level phases (detailed batches only after user review of this plan + PHASES.md + DELEGATION_AUDIT.md):

- **Phase 0: Planning & reconciliation** (this document + PHASES.md + updated DELEGATION_AUDIT + TEST_PLAN reconciliation). Commit planning docs. GitHub board setup. User review.
- **Phase 1: Data model, storage, terminology** (stacks.json schema, shared/types.ts additions, stacks catalog, terminology alignment across code/docs/UI).
- **Phase 2: Resource calculator + proven history** (multi-spark/TP/group per-spark estimates, bootstrap hardcodes, history tracking for categories/ETAs).
- **Phase 3: Collectors & backend** (proxy enhancements for serving process, library collector full, integration with telemetry/recipes).
- **Phase 4: UI — selector, filters, presentation, downtime** (Stack/Component selector with all filters, Hasso memory viz, aggregated group views, sub-tabs including new Traffic, downtime preview/sequence/live, pre-defined behavior).
- **Phase 5: Integration, bootstrap, multi-spark** (full group support, per-spark addons, proxy-only traffic, pre-defined external examples, bootstrap data).
- **Phase 6: Test, verify, gate** (on live fleet; gates per TEST_PLAN).

### Initial Proof-of-Concept Steps (prioritized early validation on single-spark first)

These concrete steps are the entry point for implementation. They provide working proof on gx10-1c2c before expanding the full catalog or multi-spark complexity. They map to SC2, SC5, SC6, SC10, SC11 (and supporting parts of SC3/SC8).

1. Pull two Hasso recipes (one 27b-style and one flash-style) and convert them into our component definition format (respecting the "copy on TP or inference machine change" rule).
2. Design the method for acting on component/lane changes (dashboard-initiated start/stop/switch, using the proxy as the sole LLM traffic path, integrated with agent actions and recipes).
3. Design, implement, and deploy the dashboard pages + functionality to consume the component data and perform lane/component changes.
4. Test end-to-end by using the new UI to switch what is running on gx10-1c2c.
5. Review the results on 1c2c and identify any obvious changes needed before scouring/gathering large amounts of additional recipe data (to minimize churn on definitions).

This POC-first approach validates the core loop quickly.

(See PHASES.md for more detail on sequencing and dependencies. SC1–SC12 below map to these phases. The POC steps above are the concrete starting work.)

Legacy S1–S5 work is done (per prior run). Old D1/D2/D3 issues closed and removed from board as no longer relevant (2026-10-30 user directive). Focus is now exclusively on SC1–SC12 from the morning session (starting with the POC steps).

## Open register — migrated, not the action list

The list is GitHub. This table only translates old ids.

| Old id | Issue |
|---|---|
| POC1 | https://github.com/airhamer/herd/issues/5 |
| POC2 | https://github.com/airhamer/herd/issues/6 |
| POC3 | https://github.com/airhamer/herd/issues/7 |
| POC4 | https://github.com/airhamer/herd/issues/8 |
| POC5 | https://github.com/airhamer/herd/issues/9 |
| SC1 | https://github.com/airhamer/herd/issues/10 |
| SC2 | https://github.com/airhamer/herd/issues/11 |
| SC3 | https://github.com/airhamer/herd/issues/12 |
| SC4 | https://github.com/airhamer/herd/issues/13 |
| SC5 | https://github.com/airhamer/herd/issues/14 |
| SC6 | https://github.com/airhamer/herd/issues/15 |
| SC7 | https://github.com/airhamer/herd/issues/16 |
| SC8 | https://github.com/airhamer/herd/issues/17 |
| SC9 | https://github.com/airhamer/herd/issues/18 |
| SC10 | https://github.com/airhamer/herd/issues/19 |
| SC11 | https://github.com/airhamer/herd/issues/20 |
| SC12 | https://github.com/airhamer/herd/issues/21 |

Already done in the plan, no issue opened: Legacy S1–S5 (prior run), old D1/D2/D3 (closed as irrelevant), high-level phases (planning only).

Follow-on items (RoCE topology, auto-fetch, production redeploy) not migrated as open rows.

## 4. Orchestration Plan

See ORCHESTRATION.md (to be updated with new gate commands, standing orders for SC work, GitHub board reference).

Gate (typical for numeric/state batches): node --test ... ; npx tsc --noEmit ; npx vitest run (exact per batch in TEST_PLAN).

GitHub project board: in setup (see separate walkthrough). Status labels on issues + this register.

## 5. Risks

- Document drift (mitigated by ONE plan + demotion of superseded).
- Scope creep on "TBD later" items (topology).
- Memory calc accuracy without real history (mitigated by bootstrap + 5-event rule).
- Port mismatches in proxy (already encountered; fix in SC6/SC11).
- User review of planning docs (this + PHASES + DELEGATION) required before granular work.

## 6. Running log (newest first)

- 2026-10-30: github-plan-migration for legacy items. Old D1/D2/D3 closed and removed from board as no longer relevant (user directive). New plan focuses on SC1-SC12 morning decisions. Board now has only Orchestration.
- 2026-10-30: Proxy collector adjusted for serving inference process; library collector wired. StackBuilder stub. Terminology + design decisions captured in docs/ (now reconciled here).
- 2026-10-30: Full morning session Q&A decisions recorded (storage, estimates, pre-defined behavior, presentation, group model, downtime, resource calc, Hasso ideas). New priority SC1-SC12 register.
- 2026-10-30: User directed POC-first approach: (1) pull two Hasso recipes into our format (respect TP/machine copy rule + smart model copy), (2) design method for acting on lane/component changes, (3) design/implement/deploy dashboard UI + actions, (4) test switch on gx10-1c2c, (5) review before more data. Added to plan as prioritized early validation steps (maps to SC2/SC5/SC10/SC11). Design constraint on recipe copying and model distribution added.

**Next:** Execute the Initial Proof-of-Concept Steps (pull 2 Hasso recipes, design lane change method, implement dashboard UI + actions, test switch on gx10-1c2c, review). Use docs/COMPONENTS-DESIGN-PROPOSAL.md as starting point for the data model. Update this plan and PHASES.md with lessons after the 1c2c test.

---

**End of plan. This is now the authoritative single source.** 

(Old content from prior versions has been superseded and is retained only in git history for reference.)