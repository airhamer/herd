# Pivot Brief — From sparkDash to the Agentic Infrastructure Platform

Date: 2026-10-16 · Status: DRAFT for owner sign-off · Author: Jarvis

Owner direction: reposition from "Spark dashboard" to **agentic-infrastructure
dashboard**, fold into elephant-ai, and treat everything previously classified
"not applicable" as in scope. This brief records the licensing ruling that makes
that safe and the staged shape of the work.

> **Terminology note (SC1, 2026-10-30 alignment):** "Lane" below is the former
> term for **Component** (a loadable serving unit). UI and current docs say
> Component/Subcomponent/Stack; internal code, the recipe schema, and this
> historical brief keep "lane" for compatibility.

## 1. Licensing ruling (verified live 2026-10-16)

| Source | License | Obligation when integrated |
|---|---|---|
| Upstream sparkDash **≤ 1.9.0** (our fork base is 1.8.8 `754f40a`) | MIT | attribution only; MIT permits sublicensing |
| Upstream sparkDash **≥ 2.0.0** (all 254 commits we'd port: RoCE, health findings, notifications, clock caps, macOS/Windows/Intel Arc collectors, Prometheus…) | **Apache-2.0** (their `5051a33`, 2026-10-09) | ship LICENSE+NOTICE, keep notices, state changes (§4b); patent grant + defensive termination |
| Upstream benchmark data (`gsm8k-200.json`, `mmlu-285.json`) | MIT (GSM8K © OpenAI; MMLU © Hendrycks) — `server/collectors/data/NOTICE.md` | notice travels with the data |
| Geist fonts (bundled in UI) | SIL OFL 1.1 (THIRD_PARTY_NOTICES.md) | fonts stay OFL; don't rename |
| npm deps (react, express, ws, undici…) | MIT/BSD | automatic, already tracked in their THIRD_PARTY_NOTICES.md |
| hasso5703/dgx-spark-qwen38 (keepalive proxy :30001, guards, crash timeline) — 227★, active today | **MIT** (gh license API) | copy LICENSE; vendor freely |
| ModelTC/lightllm | **Apache-2.0** (gh license API) | we consume as an *engine it runs*, and integrate configs only — no vendoring, zero obligation; vendor later under same terms if needed |
| macmon (upstream's macOS collector binary) | MIT (vladkens/macmon) | external binary invoked over SSH — no linking, no issue |
| Windows collectors (OpenSSH + PowerShell) | upstream's own code; PowerShell itself MIT | runs on the *target* machine; port upstream code with notice |
| elephant-ai memory, Qdrant, ollama embedder | ours / Apache-2.0 server-side, REST only | integration is client-side HTTP — no obligations land in this repo |

**Verdict: no copyleft anywhere.** Everything is MIT, Apache-2.0, or OFL. One
hard consequence: the moment the first v2.0.0+ upstream commit lands here, this
repo cannot stay MIT-only — Apache code cannot be redistributed under MIT alone.

**Owner decision (2026-10-17): the repo stays MIT.** Correct reading: we have
absorbed no Apache-licensed code — we only *depend on* upstream tools
(macmon, hasso5703's proxy, LightLLM engines) installed unmodified from
their own repositories, which imposes nothing here. The relicense step is
cancelled, and with it the "port upstream code" plan: Stage 1/2 features are
now **re-implementations from spec** (upstream commits read as documentation,
written fresh in our style). That is the honest price of keeping MIT and is
fine — their changelog is a free design spec.

## 2. Target model — the four first-class objects

Today the dashboard knows **nodes** (registry) and, as data, containers/engines.
The pivot promotes inference itself to first-class:

1. **Unit** — any OS host: DGX Spark, Linux (Narthex!), macOS, Windows.
   Registry gains `os`; collectors fan out per-OS (upstream 2.x code supplies
   mac/win/linux paths; our agent stays the privileged Spark path).
2. **Component** (hasso5703's idea, promoted to schema; term "Lane" until the
   2026-10-30 terminology alignment — internal code and the schema slot keep
   "lane" for compatibility): one complete inference
   setup = docker container + engine (vLLM/SGLang/LightLLM/llama.cpp/ollama) +
   model + optional guard-proxy + resource budget. Components coexist when
   resources allow → coexistence check = Component budgets vs. live SparkMonitor
   headroom, which the agent already collects.
3. **Guard** — per-component keepalive/abort proxy (hasso5703 pattern: keepalives,
   aborts, start guard, requests held through a restart, crash timeline).
   Dashboard shows guard health + crash timeline per component, not just engine up/down.
4. **Memory** — elephant-ai fact store + Qdrant + embedder as monitored
   services, plus the payoff view: **context saved** — tokens a request would
   have carried vs. tokens actually sent after memory recall, including
   frontier-API usage. That's the "frontier users reduce context" feature.

The existing LLM prompt dashboard (Showcase page, live streamed prompts)
survives the pivot as the Component/prompt board — it's the demo surface for
components (internal: lanes).

## 3. Stages

- **S0 Relicense** (prerequisite, ~1 commit; owner sign-off = go).
- **S1 Multi-OS units** — port upstream macOS (`ca6b9b0`,`82578ac`), Windows
  (`10385e0`), Intel Arc GPU (`8563cc2` + fix trio), Linux LLM-probe beyond
  Spark. First customer: Narthex joins the fleet with its LLMs visible
  (ollama embedder :11434, hermes gateway). Dry-run conflict sizes ≤2 hunks.
- **S2 Platform observability** — the validated Batch-11 list stands:
  Prometheus `/metrics` (1 hunk), RoCE panel (`fdd023f`), health findings
  (`c4558d0`), alert notifications (`2c2a1af`,`51ced72`), clock caps,
  history/Temps tiers, monthly energy.
- **S3 Components (Lanes) + LightLLM** — Lane schema in the agent catalog
  (kept internally; UI term = Component; container
  inventory already finds candidates), component lifecycle actions via the existing
  agent action layer, LightLLM as engine kind (config integration only),
  coexistence/budget view.
- **S4 Guard proxy** — vendor hasso5703 proxy (MIT) as component-optional
  sidecar; guard status + held-requests + crash timeline on the component page.
- **S5 elephant-ai memory** — memory/embedder health panels + context-saved
  accounting (local *and* frontier), fed by the guard proxy's token accounting
  (it already sees every request).
- **S6 Identity** — rebrand/positioning under elephant-ai (naming = owner's
  call; repo can stay sparkDash internally until he names it).

Sequence notes: S1/S2 should go soon while the upstream seam is shallow —
their divergence rate is extreme (254 commits in 3.5 weeks). S3–S5 are
ours-only work, no upstream clock pressure.

## 4. Decisions — RESOLVED 2026-10-17 by owner

1. **License: keep MIT.** No upstream code absorbed; external tools installed
   from their own repos; upstream features re-implemented from spec. (S0)
2. **Guard proxy: external reference only.** Do not vendor. Point to
   `github.com/hasso5703/dgx-spark-qwen38` (MIT) — it is an OpenAI-compatible
   proxy on :30001 with keepalive/abort/start-guard semantics; we monitor and
   operate it, we do not ship it. S4 becomes a *monitor/adaptor*, not a
   vendoring exercise.
3. **Product name: H.E.R.D. — Holistic Elephant-AI Resource Dashboard**
   (owner pick, 2026-10-17). The consolidation point for control and
   monitoring of all the pieces and parts needed by Elephant-AI.
4. **Fleet-tab per-member models shipped** — Batch 11 (`e9a0e60`): one Models
   row per LLM service per fleet card; multi-model components visible side by
   side. This is the first Component (Lane) primitive UI.
5. Frontier context accounting (S5) still open — integration point chosen at
   S5 design (guard-proxy token accounting vs. OpenClaw/elephant hook).
