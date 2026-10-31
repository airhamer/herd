# AEON concurrency ladder (BENCH3, #43)

Herd can run AEON Bench Pod's `aeon-perf-v1` perf grid so its throughput
numbers sit on the same scale as AEON's board. It is a DecodeBench protocol:
`POST /api/sparks/:id/llm/bench` or `POST /api/fleet/nodes/:id/llm/bench` with
`protocol: "aeon-perf-v1"`.

## Conditions (exactly AEON's)

| | |
|---|---|
| Ladder | c1, c4, c8, c16, c32 (`concurrencies` may pick a subset; default all) |
| Categories | Math, Reasoning, Coding, Prose, Instruction, run one after another |
| Prompts | 4 per category; the fourth is a ~1,500-token prompt |
| Requests per cell | max(4, c), tiled over the 4 prompts, each tagged `[measurement <nonce>-c<n>-<cat3>-<i>]` so no request hits the prefix cache |
| Waves | groups of c requests start together; the next wave starts when the previous one has drained |
| Body | `stream: true`, `temperature: 0`, `max_tokens: 256`, `stream_options.include_usage` — no top_p, thinking flags or ignore_eos |
| Warmup | none |
| Total | 320 requests (81,920 output tokens max) for the full ladder |

## Aggregates — two numbers, never merged

| Store metric | Definition | AEON field | Rule |
|---|---|---|---|
| `agg_window_tps` | `aeon.wave_peak_concurrent_window.v1` | `agg_decode_tps` | Per wave: Σ output tokens ÷ (max last-token time − min first-token time). The cell reports the peak wave; a one-request wave reports that request's decode rate. Level overall = best category cell (`peak_category_cell`). |
| `agg_sum_tps` | `aeon.agg_saturated_est.v1` | `agg_saturated_est` | round(decode_tps_mean) × c — the Σ of per-stream rates if every stream ran flat out. |

If no wave yields a window, the cell falls back as AEON does: c1 decode
peak, then the saturated estimate, then tokens per wall second
(`settings.agg_source` records which).

Per-request decode rate = (output tokens − 1) ÷ (last token − first token),
counting reasoning chunks as tokens. Percentiles use linear interpolation.

## Store records

One record per cell, id `decode:<benchId>:perf.direct.<category>.c<n>`, plus
`perf.direct.overall.c<n>` per level. `run.suite = "aeon-perf-v1"`,
`suite_version = "1"`, `conditions.prompt_set = "aeon-perf-v1/<category>"`,
`max_tokens 256`, `temperature 0`, `thinking null` (engine default — AEON
sends no flag). Other metrics: `decode_tps_stream`
(`aeon.decode_tps_mean.v1`), `prefill_tps` (`aeon.prefill_tps_mean.v1`),
`ttft_p50` (`herd.ttft.client_first_token.v1`), `ttft_p95`
(`aeon.ttft_p95_linear.v1`), `tpot_p95` (`aeon.tpot_p95_linear.v1`). A run
that completed with failed requests is stored as `partial`.

## Where it runs

- **Spark LLM panel** — **Run AEON ladder** (and **AEON** under **Remote**).
- **Fleet node** — the **LLM benchmarks** panel lists the node's running
  lanes and live LLM services; **AEON ladder** benches one over the LAN at
  `<lanIp>:<port>`. The server only accepts ports the node itself reports.

## Differences from AEON's pod

- Token counts come from the stream's `usage` (client), never engine
  `/metrics` deltas: `tokens_source` is always `client`.
- When a request fails, AEON re-slices the remaining successes into waves;
  Herd keeps each request in the wave it actually ran in.
- The cache-bust nonce is per job (AEON: per process).

Source: AEON Bench Pod `mvp/pod/perf_grid.py` (MIT, Copyright (c) 2026
AEON-7); licence text in `server/collectors/data/NOTICE.md`.
