# Bench results store (BENCH1, #41)

Every benchmark number Herd keeps lives in `config/bench-results.json`
(`BENCH_RESULTS_PATH` overrides it). Each number carries its **metric
definition** and **full provenance**, so we only ever compare like with like.

Code: `server/bench/results/`. Types: `shared/types.ts` (`BenchResult`…).

## Record (schema_version 1)

One record is one measured **cell**: a run under one fixed set of
conditions, e.g. one DecodeBench concurrency level or one PrefillBench
context size. Records from the same run share `run.run_id`.

| Section | Fields |
|---|---|
| `run` | `run_id, started_at, completed_at, status, suite, suite_version, bench, bench_version, origin (herd \| reference \| aeon-pod), reference_url, imported_from` |
| `host` | `node_id, node_name, hw_bucket ("Single DGX Spark", "2× DGX Spark", "Single <GPU>"), gpu, gpu_count, mem_class, clock_cap_mhz, power_cap_w` |
| `lane` | `engine, engine_version, image_digest, model_id, weights_hash, quant, recipe_flags, spec_decode, kv_dtype, ctx_len, parallel` |
| `conditions` | `concurrency, context_tokens, max_tokens, temperature, thinking, prompt_set, client_location (local \| network)` |
| `settings` | free-form bench settings (top_p, warmup, port, prompt tokens…) |
| `metrics[]` | `metric, value, unit, n, ci_low, ci_high, source, tier, window_s, approximate, valid, definition` |
| `quality` | `null` or `{ items: [{ id, pass }] }`, a per-item vector (for McNemar between runs) |
| `raw` | the bench output the record was derived from (lossless import) |

Rules:

- Every field is present. Unknown is `null`, never guessed and never `0`.
- An unmeasured metric has `value: null, valid: false`.
- `definition` must name a registered definition for that metric.
  - `unit` follows the metric.
  - `tier` follows the source: counter 1, native 2, proxy 3, client 4, reference none.
- `herd` results need `host.node_id` and may not use the `reference` source.
- `reference` results need `reference_url` and use the `reference` source.
- Validation runs on every write. A write with an unknown field is rejected.

## Definitions

The registry is `definitions.js`, served at `GET /api/bench-results/definitions`.
Names are append-only (`owner.what.vN`). Only definitions in the same
`comparable` group are diffed.

| Group | Definitions |
|---|---|
| Aggregate, concurrent window | `herd.decode.agg_window.v1`, `sparkdash.agg_window.v1`, `aeon.wave_peak_concurrent_window.v1` |
| Aggregate, sum of stream rates | `herd.decode.agg_sum.v1`, `aeon.agg_saturated_est.v1`, `mia.agg_sum_per_request.v1` |
| Published-only aggregates, one group each | `hasso.vllm_bench_serve_output.v1` (vLLM `bench serve` output throughput), `hasso.real_jobs_in_all.v1` (Hasso's "in all" on five real jobs), `aeon.agg_tokens_per_cell_wall.v1` (AEON's legacy tokens ÷ cell wall) |
| Single-stream greedy median | `hasso.single_stream_greedy_median.v1` |
| Hasso per-probe median | `hasso.bench_probe_median.v1` (one bench.sh probe; math at temp 0.6, prose worst case) |
| Single-stream two-call delta | `hasso.matrix_two_call_delta.v1` (decode net of prefill, 80 vs 680 tokens; refused samples stored with `valid: false`) |
| Per-stream mean | `herd.decode.stream_mean.v1` (DecodeBench), `aeon.decode_tps_mean.v1` (AEON ladder); Showcase has its own estimated variant |
| Prefill | `herd.prefill.single_request.v1` (cold, salted); `herd.decode.prefill_window.v1` (concurrent); `aeon.prefill_tps_mean.v1` (per-request mean); `mia.sparkdash_prefill.v1` (published only, own group) |
| Latency | `herd.ttft.client_first_token.v1` (p50), `…_p95.v1`, `herd.tpot.client_stream.v1`; AEON ladder p95s `aeon.ttft_p95_linear.v1`, `aeon.tpot_p95_linear.v1` |
| Engine counter | `herd.engine.generation_tps_counter.v1` |
| Quality / energy | `herd.quality.item_pass_rate.v1`, `reference.accuracy_published.v1`, `herd.energy.gpu_power_wave.v1` |
| Energy over a run window | `herd.energy.node_tracker_run.v1` (fleet energy tracker estimate for the node over the whole run ÷ the run's output tokens; own group; BENCH6) |
| Quality, mean of categories | `herd.quality.category_mean.v1` (Quality bench overall, see [QUALITY-BENCH.md](./QUALITY-BENCH.md)) |

The AEON ladder (DecodeBench `protocol: "aeon-perf-v1"`) stores one record per
cell, `perf.direct.<category>.c<n>` and `perf.direct.overall.c<n>`, with suite
`aeon-perf-v1`. See [AEON-LADDER.md](./AEON-LADDER.md).

The Hasso battery (DecodeBench `protocol: "hasso-battery-v1"`) stores
`hasso.bench.greedy_median`, one `hasso.bench.<probe>` per bench.sh probe and
one `hasso.matrix.<workload>` per battery workload, with suite
`hasso-battery-v1` and `suite_version "1"` (`settings.battery_version 1`). See
[HASSO-BATTERY.md](./HASSO-BATTERY.md).

## Compare

`GET /api/bench-results/compare?baseline=<id>&candidate=<id>`

- Two results compare only when their `hw_bucket`, `suite` and
  `suite_version`, and every condition field are equal. Unknown hardware is
  never assumed equal.
- Lanes may differ; that is the point of a comparison.
- For each metric, the definitions must share a group. Otherwise the metric
  appears under `refused`.
- A refused comparison is `200 { comparable: false, reasons }`.
- When both records carry a `quality.items` vector, the response adds
  `quality`: an exact McNemar test on the paired items (`p`,
  `within_noise` = p ≥ 0.05, discordant counts). Otherwise `quality` is `null`.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/bench-results` | filters: `run_id, bench, suite, origin, node_id, hw_bucket, model_id, engine, quant, metric, definition, concurrency, context_tokens, since, until, like=<id>, limit (≤1000), offset`; newest first |
| GET | `/api/bench-results/definitions` | metrics, sources and tiers, origins, definitions |
| GET | `/api/bench-results/compare` | see above |
| GET | `/api/bench-results/references` | the reference registry: entries, `not_seeded`, and its stored rows |
| GET | `/api/bench-results/upgrade/runs` | runs grouped from records (`herd`, `aeon-pod`), newest first; filters `node_id, hw_bucket, bench, limit` (≤500) |
| GET | `/api/bench-results/upgrade` | `baseline=<run_id>[,<run_id>]&candidate=…`: "Upgrade worth it?" verdict, see below |
| GET | `/api/bench-results/:id` | |
| GET | `/api/bench-results/:id/references` | nearest published figures, same definition group only, `limit` 1–50 (default 3) |
| POST | `/api/bench-results` | reference / aeon-pod results only. Missing fields become `null`; `id` defaults to `<origin>:<run_id>`. 201 created, 200 replaced, 400 with `errors[]` |
| DELETE | `/api/bench-results/:id` | |

Ids under `reference:registry:` belong to the registry file: POST and DELETE
on them answer 409.

## Reference registry (BENCH5, #45)

`server/bench/references/registry.json` holds figures other projects
published. Herd did not measure them. At startup Herd syncs them into the
store:

- Each figure is stored as `reference:registry:<entry>:<figure>`, with
  `run.origin: "reference"`, `run.bench: "Reference"`, `source: "reference"`
  on every metric row, no node, and `run.reference_url` set to the page the
  figure was read from. `run.imported_from` names the registry file, entry and
  figure.
- Every metric row names the definition its publisher used. The registry may
  not use a Herd definition, and the published-only definitions sit in groups
  of their own, so the store never diffs them against Herd runs.
- `run.started_at` is the measurement date when the source gives one
  (`settings.reference.date_basis: "measured_on"`); otherwise it is the date the
  figure was read (`"retrieved_at"`).
- The sync adds new figures, replaces edited ones (keeping their first
  `recorded_at`), and removes registry ids no longer in the file. It never
  touches Herd results or references you POSTed yourself. When nothing has
  changed it writes nothing.
- An invalid registry file is refused whole: Herd logs a warning and seeds
  nothing.
- A reference is shown beside a Herd result, never as one:
  `GET /api/bench-results/:id/references` returns, for each metric of the
  result, the published figures in the same definition group. They are ranked
  by how close the setup is (hardware bucket, concurrency, model, then the
  other conditions), and each one lists what still differs.

Seeded figures (registry version 1, read 2026-10-31):

| Entry | Figures | Definition |
|---|---|---|
| MiaAI-Lab GLM-5.3-Flash EXL3, 2× DGX Spark, TensorFold, sparkDash over the network | Prose 60.4 / 108.8 and Structured 114.7 / 227.9 tok/s at c1 / c4; prefill 1,952.2 tok/s at 8,219 tokens; GSM8K 98.8 % (250), HumanEval 95.7 % (164), thinking off | `mia.agg_sum_per_request.v1`; `mia.sparkdash_prefill.v1`; `reference.accuracy_published.v1` |
| MiaAI-Lab Qwen3.8-Flash-Next FP4, 1× DGX Spark, TensorFold v1.1.4, local | Prose 55.6 / 156.1 (temperature 0.7, thinking on) and Code 110.5 / 217.6 (temperature 0, thinking off) at c1 / c5; prefill 3,050 tok/s at 4,134 tokens | `mia.agg_sum_per_request.v1`; `mia.sparkdash_prefill.v1` |
| Hasso Qwen3.8-27B NVFP4 + DFlash2, ASUS Ascent GX10 | 71.4 tok/s greedy median (bench.sh, the v1.14.0 campaign); GSM8K 94.0 % (200) | `hasso.single_stream_greedy_median.v1`; `reference.accuracy_published.v1` |
| Hasso Kolibri-1 FP8 on vLLM, GX10 (2026-10-14) | 48.0 / 121.9 / 165.8 / 202.0 tok/s at c1 / 4 / 8 / 16 | `hasso.vllm_bench_serve_output.v1` |
| Hasso Ornith 1.5 122B NVFP4 on vLLM, GX10 | 41.2 / 68.1 / 90.0 tok/s in all at c1 / 4 / 8; GSM8K 98.8 % (250, on the second GX10) | `hasso.real_jobs_in_all.v1`; `reference.accuracy_published.v1` |
| AEON-7 peak16 cell at c8 (2026-09-11) | decode mean 23.55; × 8 = 188.4; old board aggregate 66.66, a definition gap. AEON's locked definition is the concurrent window, which this doc does not measure | `aeon.decode_tps_mean.v1`; `aeon.agg_saturated_est.v1`; `aeon.agg_tokens_per_cell_wall.v1` |

Nothing is seeded for the sparkDash Quality bench or the aeon-bench.com
leaderboard. Neither has been read; the registry lists both under
`not_seeded`. To add a figure, add it to `registry.json` with its URL and
definition (add a new definition first if none fits). Then run
`node --test server/bench/references/__tests__/*.test.js`.

## Upgrade worth it? (BENCH6, #46)

`GET /api/bench-results/upgrade?baseline=<run_id>[,<run_id>]&candidate=<run_id>[,<run_id>]`,
code in `server/bench/upgrade/`, UI **Upgrade worth it?** in the Spark LLM
panel and in a fleet node's **LLM benchmarks** panel
(`src/components/UpgradeCompare/`).

- **Sides.** Each side is one or more runs, at most one per bench (typically a
  decode, AEON or Hasso run, plus an optional quality run). Runs pair by
  bench; a bench on one side only is refused. Cells pair by the id suffix
  after the run id (`c4`, `perf.direct.overall.c8`, a quality category).
  Cells without a partner are listed under `unpaired` and left out.
- **Refusal.** Every paired cell must pass the compare rules above:
  `hw_bucket`, suite and suite version, and every condition. The headline
  metric's definitions must share a group. A single mismatch refuses the
  whole view: `200 { comparable: false, verdict.code: "refused", reasons }`.
  Unknown runs give 404. Two runs of one bench on a side, the same run on both
  sides, or a reference id give 400.
- **Throughput.** The headline metric per cell is the first of
  `agg_window_tps`, `decode_tps_stream`, `agg_sum_tps`, `prefill_tps`.
  Δ% = (candidate − baseline) ÷ baseline. AEON per-category cells are shown
  as detail and do not vote; the level's `overall` cell votes.
- **Noise band.** The spread of repeated runs is (max − min) ÷ mean, using
  one value per run of the same cell on the same lane. The other side's run
  is never counted as a repeat. The band is the larger of the two sides'
  spreads, floored at 3%. With no repeats on either side it is **15%**
  (MiaAI-Lab's single-stream spread on one Spark, cited in #46). A cell is a
  gain above +band, a loss below −band, and noise otherwise.
- **Quality.** Each category (and the overall record) is compared with an
  exact McNemar test on the item vectors. p ≥ 0.05 is within noise; p < 0.05
  is better or worse by the discordant counts.
- **Verdict:**
  - **refused:** any mismatch, or nothing to compare.
  - **regression:** a quality category is significantly worse, or a voting
    throughput cell is a loss.
  - **worth it:** at least one voting cell is a gain, and there is no loss or
    quality regression. Without quality runs on both sides the reasons say
    quality was not measured.
  - **within noise:** otherwise.
  - Cost is shown but does not vote.
- **Cost.**
  - Energy is `settings.run_energy` and a `wh_per_1k_tokens` row
    (`herd.energy.node_tracker_run.v1`, approximate), written by the recorder
    when a run finishes:
    - It comes from `FleetEnergyTracker.windowEnergy(node, start, end)`, which
      prorates the edge minutes, then scales up by sample coverage and divides
      by the run's output tokens (decode waves, AEON overall levels).
    - The figure is skipped under 50% coverage, and for nodes that the
      tracker does not cover (agent nodes, custom hosts).
    - For older runs, the view reads the tracker for the run window on demand
      (31-day retention, `from: "tracker_now"`).
  - Memory headroom (`settings.run_memory`) is the lower of the unified-memory
    `available` readings at run start and end. It is not a minimum over the
    run.
- **Reference.** The nearest published figure (BENCH5) for the candidate's
  voting cells is shown beside the verdict, ranked by score. It is never
  diffed.
- **Open:** a quality run is ~755 requests per side. Pick an existing
  quality run, or run one only when throughput says the upgrade is worth it.

## Writers

- **DecodeBench, PrefillBench, Showcase and QualityBench:**
  - When a run starts, `server/index.js` captures provenance from the live
    snapshot (`provenance.js`).
  - The managers call `resultSink` when the run reaches history
    (`recorder.js`).
  - The recorder adds the run's energy (fleet energy tracker over the run
    window) and memory headroom (read at start and finish) to every record of
    the run (BENCH6).
  - A failing sink never affects a bench.
- **Legacy history:**
  - At startup, Herd imports `bench-history.json`,
    `prefill-bench-history.json` and `showcase-history.json`.
  - The import is idempotent by result id and leaves the source files
    untouched.
  - Imported records have only `node_id` and `model_id` as provenance.

## Versioning

- The file is `{ format: "herd.bench-results", schema_version, results }`.
- `MIGRATIONS[n]` upgrades a document from version n to n+1. Version 0 is
  the pre-release bare array.
- After a migration, Herd keeps a `.v<n>.bak` copy of the old file.
- A file from a newer Herd is loaded read-only and never overwritten.
- An unreadable file is moved aside as `.corrupt-<ts>`.
