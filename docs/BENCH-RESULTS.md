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
| Single-stream greedy median | `hasso.single_stream_greedy_median.v1` |
| Per-stream mean | `herd.decode.stream_mean.v1` (DecodeBench), `aeon.decode_tps_mean.v1` (AEON ladder); Showcase has its own estimated variant |
| Prefill | `herd.prefill.single_request.v1` (cold, salted); `herd.decode.prefill_window.v1` (concurrent); `aeon.prefill_tps_mean.v1` (per-request mean) |
| Latency | `herd.ttft.client_first_token.v1` (p50), `…_p95.v1`, `herd.tpot.client_stream.v1`; AEON ladder p95s `aeon.ttft_p95_linear.v1`, `aeon.tpot_p95_linear.v1` |
| Engine counter | `herd.engine.generation_tps_counter.v1` |
| Quality / energy | `herd.quality.item_pass_rate.v1`, `reference.accuracy_published.v1`, `herd.energy.gpu_power_wave.v1` |
| Quality, mean of categories | `herd.quality.category_mean.v1` (Quality bench overall, see [QUALITY-BENCH.md](./QUALITY-BENCH.md)) |

The AEON ladder (DecodeBench `protocol: "aeon-perf-v1"`) stores one record per
cell, `perf.direct.<category>.c<n>` and `perf.direct.overall.c<n>`, with suite
`aeon-perf-v1`. See [AEON-LADDER.md](./AEON-LADDER.md).

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
| GET | `/api/bench-results/:id` | |
| POST | `/api/bench-results` | reference / aeon-pod results only. Missing fields become `null`; `id` defaults to `<origin>:<run_id>`. 201 created, 200 replaced, 400 with `errors[]` |
| DELETE | `/api/bench-results/:id` | |

## Writers

- **DecodeBench, PrefillBench, Showcase and QualityBench:**
  - When a run starts, `server/index.js` captures provenance from the live
    snapshot (`provenance.js`).
  - The managers call `resultSink` when the run reaches history
    (`recorder.js`).
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
