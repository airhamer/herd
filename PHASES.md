# H.E.R.D. Cockpit Adoption — PHASES.md (Document-First High-Level Phases)

**Date:** 2026-10-30
**Purpose:** High-level phase breakdown for user review **before** any granular batch prompts or worker decomposition. This is part of the document-first approach preferred by the user.

This document discusses the overall approach, sequencing, and dependencies at a level suitable for discussion. Granular IMPLEMENTATION_PLAN.md batches, prompts, or dispatch happen only after review and agreement on this + the main IMPLEMENTATION_PLAN.md + updated DELEGATION_AUDIT.md.

## Overall Approach (per 2026-10-30 morning session + user directive)

We are adopting and generalizing Hasso's cockpit model (recipes for pinning, lifecycle for states/ETAs, panels for Lanes/Library/Traffic/Machine/Requests, vanilla reliability) to our multi-spark environment with the new **Components / Subcomponents / Stacks** terminology and model.

**Core principles from session:**
- Document-first: Planning docs (this, IMPLEMENTATION_PLAN.md, DELEGATION_AUDIT.md) reviewed by user before granular work.
- ONE tracked plan (root IMPLEMENTATION_PLAN.md).
- Stacks as first-class (new stacks.json, manual external retrieval).
- Resource estimation unlocked and multi-spark aware.
- Presentation and UX directly adopt Hasso strengths (memory display, filters, aggregated views, group cards).
- Downtime is a first-class sequenced preview + live flow.
- Proxy is the authoritative path for LLM traffic.
- Bootstrap data + real history for estimates/categories.
- Pre-defined stacks have specific TP/memory rules per single vs group.

**Why this order?** Data model and storage must come early (everything depends on stacks.json and types). Calculator + history enable categories and ETAs. Collectors provide the data. UI brings it to the user with filters and preview. Integration closes the loop. Presentation and bootstrap are cross-cutting but can be phased.

No work on deferred items (full topology/RoCE UI) until user says.

Legacy S1–S5 is considered done. Old D items are on GitHub issues for separate discussion.

## High-Level Phases

### Phase 0 — Planning, Reconciliation & Board Setup (Document-First Gate)
- Reconcile all prior plans (root, docs/, old S-series, handoff) into single root IMPLEMENTATION_PLAN.md (done in this step).
- Create/align PHASES.md, update DELEGATION_AUDIT.md and TEST_PLAN.md for new capabilities.
- Set up GitHub project board (labels already created; add issues for SC work if desired; fix token scopes for project).
- User review of planning documents.
- Update ORCHESTRATION.md with new standing orders/gates.
- Gate: All planning docs committed, user has reviewed and approved approach, board visible.

**Dependencies:** None (this is the starting point).
**Risk:** Drift if not reviewed.

### Phase 1 — Data Model, Storage & Terminology
- shared/types.ts: add Stack, Component, Subcomponent, category types (additive).
- New agent/catalog/stacks.js + stacks.json schema + validation (manual external retrieval with dedup, merge logic, user custom + pre-defined examples from github).
- Terminology sweep: Components (was lanes), Subcomponents, Stacks (with 4 categories: Proven/Calculated/Not recommended/Blocked) across code, docs, UI. Keep minimal internal "lane" compat if needed.
- Bootstrap initial stacks.json with examples (aeon7 TP=2 etc.).
- SC1 + SC2 + SC10 partial.

**Dependencies:** Phase 0.
**Seam:** stacks.json format (document exactly in spec).
**Hazard:** state-mutation (new storage).

### Phase 2 — Resource Calculator, Proven History & Bootstrap
- Extend MemoryBudget / recipes for multi-spark groups: TP=x calculation, per-spark memory, group total + breakdown.
- Proven history storage/query (build on stacks.json; 5-event avg rule for ETAs, independent of first).
- Hardcoded bootstrap data (TP=2 qwen38-27b aeon7 + Hasso model) + unlocked in UI.
- Category assignment logic (Proven/Calculated/etc.).
- SC3 + SC4 + SC10.

**Dependencies:** Phase 1 (types + stacks storage).
**Seam:** Updated memory budget output + history format.
**Hazard:** numeric + state (estimates affect actions).

### Phase 3 — Collectors, Telemetry & Backend Integration
- Finalize proxy collector: reliable detection of serving inference process (ps + systemctl + docker ps), correct port probing, state/version/requests.
- Full library collector: docker images, HF cache scans (size/status pinned/stray/DRAFT), pins from recipes.
- Wire into telemetry.js + assembleSnapshot.
- Extend recipes/catalog for stack pinning (Hasso-style) and lifecycle states/ETAs.
- SC6 + SC11 partial + proxy fixes.

**Dependencies:** Phase 1 (types), Phase 2 (estimates for categories).
**Seam:** telemetry snapshot additions (library, proxy fields); recipe/stack format.
**Hazard:** both (new data + state).

### Phase 4 — UI: Selector, Filters, Presentation, Downtime Preview
- StackBuilder / selector with all filters (tp=x, source, engine, purpose, pre-defined).
- Live categories in list.
- Downtime preview: sequence list (shutdown to free first, parallel startups), total ETA, live progress/logs during execute.
- Presentation: Hasso memory display, aggregated group memory single line on fleet, group cards only (no individuals), components listed on group cards.
- Sub-tabs in detail: Components (with stack filter + grouped cards), Library, new Traffic (proxy + engine).
- Pre-defined behavior: tp=1 fit for single; tp=x default for groups.
- SC5 + SC7 + SC8 + SC9 + SC10 + SC11.

**Dependencies:** Phase 1–3 (data, calc, collectors).
**Seam:** UI ↔ server API for stacks/components/estimates/downtime.
**Hazard:** state-mutation (execute flow).

### Phase 5 — Full Multi-Spark, Bootstrap, External & Polish
- Complete group stack support (distributed components, per-spark addons if mem fits).
- Full bootstrap data + pre-defined examples (sourced from our github).
- External stack retrieval (manual + merge).
- End-to-end integration (proxy-only LLM traffic, fleet views, recipes).
- SC7 + SC10 + SC11 + SC12.

**Dependencies:** All prior.
**Hazard:** both.

### Phase 6 — Test, Verify, Gate & Hand-off
- Full gates per updated TEST_PLAN (numeric: known-answer; state: seed-and-diff; seam: invariant checks).
- Live verification on 3-spark fleet (1c2c, 102c, 25ed).
- Update docs, progress card, GitHub board.
- SC12 + close loop.

**Dependencies:** Phase 5 complete.
**Gate:** ≥3 green runs, live data matches design.

## Sequencing & Parallelism Notes

- Strictly sequential for shared scaffolding (types, telemetry wiring, core recipes).
- UI work (Phase 4) can overlap backend (Phase 3) if seams are pinned early.
- No parallel on storage or calculator until seams are specified.
- Deferred: full topology tab grouping + RoCE test/setup (user explicit TBD).
- GitHub issues for any new needs-decision that arise.

## Document-First Checkpoints

Before starting Phase 1:
- User has reviewed and provided feedback on PHASES.md, this plan, and DELEGATION_AUDIT.md.
- Agreement on overall approach, terminology, and what is in/out of scope.

After each phase (or major seam), update the running log in IMPLEMENTATION_PLAN.md and re-review high-level docs if scope changes.

## Risks to Approach

- Under-specifying seams (e.g. stacks.json format, downtime sequence output) — will cause worker thrash.
- Moving too fast to granular prompts before document review.
- Forgetting Hasso memory viz or aggregated views in UI.

This document is for discussion. Once reviewed, the root IMPLEMENTATION_PLAN.md can be updated with more precise batch methods/seams if needed, and then decomposition proceeds.