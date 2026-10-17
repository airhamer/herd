# Pivot Brief — From sparkDash to the Agentic Infrastructure Platform

Date: 2026-10-16 · Status: DRAFT for owner sign-off · Author: Jarvis

Owner direction: reposition from "Spark dashboard" to **agentic-infrastructure
dashboard**, fold into elephant-ai, and treat everything previously classified
"not applicable" as in scope. This brief records the licensing ruling that makes
that safe and the staged shape of the work.

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

**Required action (Stage 0, before any port):** relicense commit —
- `LICENSE` → Apache-2.0 text; `LICENSE-MIT` retained (mirrors upstream's own
  pattern: MIT-era code, including all 50 of our commits, is dual-licensed).
- Add `NOTICE` (Mia's AI Lab attribution, "portions MIT-era"),
  `THIRD_PARTY_NOTICES.md`, and `server/collectors/data/NOTICE.md` (data).
- package.json `license` → `"Apache-2.0"`.
- Every port commit marks modified upstream files (§4b) in the message.

## 2. Target model — the four first-class objects

Today the dashboard knows **nodes** (registry) and, as data, containers/engines.
The pivot promotes inference itself to first-class:

1. **Unit** — any OS host: DGX Spark, Linux (Narthex!), macOS, Windows.
   Registry gains `os`; collectors fan out per-OS (upstream 2.x code supplies
   mac/win/linux paths; our agent stays the privileged Spark path).
2. **Lane** — hasso5703's idea, promoted to schema: one complete inference
   setup = docker container + engine (vLLM/SGLang/LightLLM/llama.cpp/ollama) +
   model + optional guard-proxy + resource budget. Lanes coexist when
   resources allow → coexistence check = Lane budgets vs. live SparkMonitor
   headroom, which the agent already collects.
3. **Guard** — per-lane keepalive/abort proxy (hasso5703 pattern: keepalives,
   aborts, start guard, requests held through a restart, crash timeline).
   Dashboard shows guard health + crash timeline per lane, not just engine up/down.
4. **Memory** — elephant-ai fact store + Qdrant + embedder as monitored
   services, plus the payoff view: **context saved** — tokens a request would
   have carried vs. tokens actually sent after memory recall, including
   frontier-API usage. That's the "frontier users reduce context" feature.

The existing LLM prompt dashboard (Showcase page, live streamed prompts)
survives the pivot as the Lane/prompt board — it's the demo surface for lanes.

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
- **S3 Lanes + LightLLM** — Lane schema in the agent catalog (container
  inventory already finds candidates), lane lifecycle actions via the existing
  agent action layer, LightLLM as engine kind (config integration only),
  coexistence/budget view.
- **S4 Guard proxy** — vendor hasso5703 proxy (MIT) as lane-optional
  sidecar; guard status + held-requests + crash timeline on the lane page.
- **S5 elephant-ai memory** — memory/embedder health panels + context-saved
  accounting (local *and* frontier), fed by the guard proxy's token accounting
  (it already sees every request).
- **S6 Identity** — rebrand/positioning under elephant-ai (naming = owner's
  call; repo can stay sparkDash internally until he names it).

Sequence notes: S1/S2 should go soon while the upstream seam is shallow —
their divergence rate is extreme (254 commits in 3.5 weeks). S3–S5 are
ours-only work, no upstream clock pressure.

## 4. Open decisions for the owner

1. Relicense to Apache-2.0 (S0) — yes/no. Required for any upstream port.
2. Product name under elephant-ai — his.
3. Guard proxy: vendor their code (MIT, fastest) vs. reimplement the pattern —
   recommendation: vendor, isolate behind our own interface.
4. Frontier context accounting needs the proxy in the path for frontier
   traffic too, or an OpenClaw/elephant hook — pick the integration point at
   S5 design.
