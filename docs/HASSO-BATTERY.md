# Hasso battery v1 (BENCH4, #44)

Herd can run the two decode instruments of
[hasso5703/dgx-spark-qwen38](https://github.com/hasso5703/dgx-spark-qwen38)
(`bench.sh` and `bench-matrix.sh`) so its single-stream numbers sit on the
same scale as Hasso's `BENCHMARKS.md`. It is a DecodeBench protocol:
`POST /api/sparks/:id/llm/bench` or `POST /api/fleet/nodes/:id/llm/bench` with
`protocol: "hasso-battery-v1"` and optional `parts: ["bench", "matrix"]`
(default both, in that order). `maxTokens` is rejected: every probe has its
own. UI: **Run Hasso battery** (and **Remote → Hasso**) in a Spark's LLM
panel, **Hasso battery** per lane in a fleet node's **LLM benchmarks** panel.

## bench.sh — single-stream streaming decode

| | |
|---|---|
| Probes | `code` (temp 0, 1200 tok), `reasoning` (temp 0, 1200 tok), `math_peak` (temp 0.6, 2048 tok), `prose` (temp 0, 800 tok) — prompts unchanged from upstream |
| Runs | 2 per probe, one after another, single stream |
| Body | `stream: true`, `stream_options.include_usage`, model from `/v1/models` (or the lane's model) — no top_p, no thinking flags |
| Per run | (out − 1) ÷ (t_last − t_first), out = `usage.completion_tokens` or the chunk count; reasoning chunks count as tokens. A run that cannot be timed is "not timed" and left out |
| Headline | **greedy median** = median (Python `statistics.median`) of the timed code + reasoning runs. math (temp 0.6) and prose (worst case) are reported, never in the median |

## bench-matrix.sh — engine vs engine, decode net of prefill

| | |
|---|---|
| Battery | frozen `BATTERY_VERSION = 1`: 8 workloads — math (EN), code (EN), code (DE), technical explain (FR), reasoning (FR), free prose (EN/FR/DE) |
| Body | not streamed, `temperature: 0`, no thinking flags |
| Warm-up | one discarded call, "Say OK." at 24 max tokens |
| Two-call delta | each workload is sent at 80 then 680 max tokens; tok/s = round((tokens₆₈₀ − tokens₈₀) ÷ (wall₆₈₀ − wall₈₀), 1). Prefill and connection overhead cancel |
| Refusal | Δtok < 50 or Δt < 2.0 s → the sample is **refused** (short answer, cold start or cache artifact): no value is printed or stored |
| Errors | an HTTP error or a reply without `usage.completion_tokens` fails the run, as the script exits |

Full battery = 25 requests (8 streamed + 17 matrix calls), at most 16,600
output tokens; the DecodeBench output-token cap applies to that sum.

## Store records (suite `hasso-battery-v1`, `suite_version "1"`)

| Record id `decode:<benchId>:…` | Definition | Notes |
|---|---|---|
| `hasso.bench.greedy_median` | `hasso.single_stream_greedy_median.v1` | `n` = timed greedy runs; prompt_set `hasso-battery-v1/bench/greedy` |
| `hasso.bench.<probe>` | `hasso.bench_probe_median.v1` | per probe; temperature and max_tokens of that probe; `settings.in_greedy_median` |
| `hasso.matrix.<workload>` | `hasso.matrix_two_call_delta.v1` | max_tokens 680, temp 0; `settings` keep Δtok, Δt, both calls and `reliable`. A refused sample is stored with `value: null`, `valid: false` and `settings.refused_reason` |

All rows: concurrency 1, `thinking: null` (engine default — no flags are
sent), `settings.battery_version = 1`, `settings.parts`. Each definition has
its own `comparable` group: a greedy median is never diffed against a
two-call delta or a single probe, nor against Herd's or AEON's means.

## Differences from the scripts (deliberate)

- The `>90 tok/s` ceiling warning and the CPU-hog check in `bench.sh` are
  specific to Hasso's box and are not reproduced.
- `bench.sh` does not version its probes; Herd freezes them as part of
  battery v1. A change to either script's prompts means a new suite version.
- Values are rounded to one decimal, Hasso's published precision.
- Requests go from the dashboard host over the LAN, like every DecodeBench.

## Licence

The prompts, sampling settings, two-call delta and reliability guard are
adapted from Hasso's scripts under the MIT licence (Copyright (c) 2026
hasso5703); see `server/collectors/data/NOTICE.md`.
