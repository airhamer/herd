# AEON Bench Pod against a Herd lane (BENCH7)

How to run [AEON Bench Pod](https://github.com/AEON-7/Aeon-Bench-Pod) (MIT) against an LLM lane
Herd already serves, and how to bring the results into Herd's bench results store
([BENCH-RESULTS.md](./BENCH-RESULTS.md)) as `origin: "aeon-pod"` records.

The pod pulls a model from Hugging Face, checks each weight file against HF's sha256, serves it,
runs AEON's suites, signs the bundle with an ed25519 device key and submits it to the AEON board.
Against a lane Herd already runs it skips the pull and serve and benches the endpoint.

What it can run against a lane:

| Suite | Pod flag | What Herd imports |
|---|---|---|
| `aeon-suite-v4`: 174 text cases (Coding 36, Reasoning 35, Prose 35, Math 34, Instruction 34). 141 are Tier 0 (deterministic checkers) and 33 are Tier 1 (need a frontier `--judge`) | default text pass | one record per category plus `overall`, each with a per-case pass vector |
| `aeon-agentic-v2.5`: 31 tasks run through **Hermes, OpenClaw or OpenCode** | `--harness hermes,openclaw,opencode` (needs Docker on the pod host) | one record per harness run |
| `aeon-perf-v1`: the direct concurrency ladder × 5 categories | `--perf [--perf-max-conc N]` | `perf.direct.<scope>.c<n>` cells, the same ids and definitions as Herd's own AEON ladder ([AEON-LADDER.md](./AEON-LADDER.md)) |

Not imported (listed under `skipped` with a reason): harness timing (`perf.harness.*`), sustained
load (`perf.sustained.*`), and the vision, audio, video and arena boards. None of them has a Herd
metric.

## 1. Pick the trust tier first

The AEON board labels every run, and **only the board grants `attested`**:

| Board tier | How the pod earns it against a Herd lane | Board label | Ranked |
|---|---|---|---|
| `self_reported` | `--target http://<lane>/v1 --model <served id>`: any endpoint. The bundle is signed, but the model identity is **not** verified | `local` | never |
| `attested` | `--hf-link org/model@rev --serve-url http://<lane>/v1 --remote-host user@<spark>` plus `--verify-endpoint` and/or deep-verify (on by default with `--serve-url`). The pod sha256-checks the **served** weight files over ssh against HF's per-file hashes, and/or logprob-fingerprints the endpoint. The board then re-fetches HF and re-checks | `✓ verified` | yes, for a full comprehensive pass |

A mismatch in either check drops the run to `self_reported`. The public board runs attested-only
ingest and refuses `self_reported` bundles. Those runs stay on the pod
(`~/.aeon/pending_submits/`) unless you point `--mothership` at your own board.

**Default for Herd (the open question in #47): keep runs local.** A Herd lane is usually a
Spark serving a model under its own name and recipe, so the `--target` path is the one that
always works, and it can never rank. Submit only when you want a public, attested number. That
needs the HF-pull or `--serve-url` + `--remote-host` flow with the lane's weights at a pinned
HF commit, plus ssh access from the pod to the Spark.

Herd stores the **board status you state** (`board_status`, below), not the pod's own
`trust_tier` column. The pod's local mirror of perf and agentic runs always writes
`trust_tier = "attested"` and `model_verified = "verified"`, even for a `--target` run (seen
in the test below). Herd keeps that value as `settings.aeon_pod.pod_trust_tier` for the
record, but it is not the board's verdict.

## 2. Find the lane in Herd

On the Spark page's LLM panel (or `GET /api/sparks`), note:

- **node id**: the Spark id (e.g. `spark-1`) or the agent node id (Fleet);
- **lane port**: one of the Spark's `llmPorts` (or the agent's reported lane);
- **served model id**: what `GET http://<spark-ip>:<port>/v1/models` lists. Pass it to `--model`
  exactly as listed;
- the Spark's LAN IP.

Don't start a Herd bench on the lane while the pod runs. Both would share the GPU and both sets
of numbers would be wrong.

## 3. Run the pod

From a clone of the pod (`git clone https://github.com/AEON-7/Aeon-Bench-Pod && cd Aeon-Bench-Pod/mvp`,
Python 3.11+; or the `ghcr.io/aeon-7/aeon-pod` image with `--network host`):

### 3a. Local / self_reported (recommended)

```bash
cd Aeon-Bench-Pod/mvp
python3 -m pod.aeon_pod \
  --target http://<spark-ip>:<port>/v1 --model <served model id> \
  --preset none --perf --perf-max-conc 32 \
  --modalities none --arena 0 \
  --concurrency 8 --max-tokens 2048 \
  --hardware "NVIDIA DGX Spark GB10 128GB" --engine vllm \
  --mothership http://127.0.0.1:9          # keep it local: nothing listens there
```

- `--preset none` turns off the comprehensive bundle (all harnesses, vision, audio, video, arena
  and perf). Add the parts you want back: `--perf` for the speed ladder and
  `--harness hermes,openclaw,opencode` for agentic. The harnesses run in Docker on the pod host.
- `--mothership http://127.0.0.1:9` keeps the run off every board. The pod logs
  `mothership unreachable … results persisted` and goes on. Each mothership call retries with
  backoff for about 30 s, so expect a minute or two of stalls. Drop the flag (or set
  `AEON_MOTHERSHIP`) only when you mean to submit.
- `--limit 10` is a quick smoke run first. A limited run hashes to a different `suite_hash`, so
  Herd never compares it with a full run.
- Reasoning models need `--max-tokens` headroom, because truncated answers score 0.
- Without `--judge`, the 33 Tier-1 cases stay `needs_frontier_judge`. Herd leaves them out of the
  mean and counts them under `unscored_by_status`.

Each suite lands as **its own pod run** in `~/.aeon/pod.db` (env `AEON_DB`): the text pass, one
perf run and one run per harness. List them with the pod dashboard (`:8091`, role `pod`) or
the import script's `--list`.

### 3b. Attested (only if you will submit)

```bash
python3 -m pod.aeon_pod \
  --hf-link Qwen/Qwen3-30B-A3B-FP8@<commit> \
  --serve-url http://<spark-ip>:<port>/v1 --remote-host <user>@<spark-ip> --verify-endpoint \
  --preset comprehensive --hardware "NVIDIA DGX Spark GB10 128GB"
```

The served files must be byte-identical to `repo@commit`, and the pod's ssh key must be
authorised on the Spark. The pod files the run under the Spark's hardware (probed over ssh), not
its own. If the run is accepted, copy its board URL for the import.

## 4. Import into Herd

Use the zero-dependency script (Node 18+), run from the Herd checkout:

```bash
node scripts/aeon-pod-import.mjs --pod http://<pod-host>:8091 --list
node scripts/aeon-pod-import.mjs --pod http://<pod-host>:8091 --run <text run id> --run <perf run id> \
  --herd http://<herd-host>:5555 --node spark-1 --port 8888 \
  [--board-status self_reported|attested --board-url https://aeon-bench.com/…] \
  [--client-location local] [--dry-run]
# no dashboard? export the run row from pod.db as JSON and pass --file run.json
```

Behind it is `POST /api/bench-results/import/aeon-pod` with
`{ run, node_id, port?, board_status?, board_url?, pod_url?, client_location?, dry_run? }`:

- `run` is the pod's `GET /api/runs/<id>` body. The script trims it (`slimPodRun`) to the
  fields the importer reads, because a full text run is about 1 MB of model output and Herd's
  JSON body limit is 100 kB.
- `node_id`/`port` choose the Herd lane. Host and lane provenance (hardware bucket, GPU, engine,
  context, power cap) are **Herd's view of the lane at import time**. If the lane now serves a
  different model than the pod benched, the records keep the pod's model, the other lane fields
  are blanked, and a warning comes back.
- `board_status` is `not_submitted` (default), `self_reported` or `attested`. `attested` needs
  an https `board_url`, which then becomes the record's `reference_url`. Otherwise the reference
  is the pod run URL.
- `client_location` defaults to `network`, because the pod usually runs off the Spark.
- Re-importing a pod run replaces its records and drops cells the new import no longer has.

### Mapping

| Pod | Herd record |
|---|---|
| run id `c74769be8b` | `run.run_id` `aeon-pod:c74769be8b`; record ids `aeon-pod:<run>:<cell>` |
| `suite_id` | `run.suite`. `run.bench` is `AEONPodPerf`, `AEONPodSuite` or `AEONPodAgentic` |
| `suite_hash` (text, agentic) | `run.suite_version`, so only identical case sets compare. Perf uses Herd's `aeon-perf-v1` version `1` |
| perf evidence `agg_decode_tps`, `agg_saturated_est`, `decode_tps_mean`, `prefill_tps_mean`, `ttft_ms_p50/p95`, `tpot_ms_p95` | same metrics and definitions as Herd's AEON ladder (`aeon.wave_peak_concurrent_window.v1`, …). Max tokens is 256, the pod perf default, which pod.db doesn't store |
| case `score` (0–1, partial credit) | `accuracy_pct` = 100 × mean score over scored cases (`aeon.suite_case_mean_score.v1`, agentic `aeon.agentic_task_mean_score.v1`) |
| case pass for McNemar | `quality.items[].pass` = score ≥ 0.5; unscored → `null` |
| `params_json` concurrency, max_tokens, temperature | `conditions` |
| everything else (`trust_tier`, `model_verified`, `hf_repo`, `harness`, `judge_model`, `env.hardware`, …) | `settings.aeon_pod` |

### Using the records

- **Upgrade worth it?** (BENCH6) lists pod runs beside Herd's. Pod text and agentic runs pick as
  quality runs (McNemar per category). A pod perf run pairs with a DecodeBench run, so a pod
  ladder can be checked against Herd's own AEON ladder (`protocol: "aeon-perf-v1"`) on the same
  lane. A plain `herd.decode` run is refused, because the suites differ.
- `GET /api/bench-results?origin=aeon-pod` lists them, and `/compare` pairs them record by record.

## 5. Test run (2026-10-31)

The runbook was run once end to end against one Herd lane:

- **Pod:** AEON Bench Pod `20e87a0` (2026-09-11), from source, `HOME` in a scratch dir.
- **Lane:** Herd demo lane `spark-1:8891` (`Qwen3-30B-A3B-FP8`, vLLM-shaped OpenAI API). This is
  a **stub server, not a GPU**: it streams filler tokens at about 240 tok/s per stream. The test
  checks the flow and the bookkeeping, not model quality or Spark speed.
- **Command:** 3a with `--perf-max-conc 4 --max-tokens 512`.
- **Pod result:** text run `c74769be8b` (aeon-suite-v4, 174/174 scored, `suite_hash`
  `7cfb2aea7c9b7f74`, 143 s, every case 0 because filler answers nothing). Perf run
  `85994d5f23` (12 cells, c1 and c4).
- **Board status: `self_reported` path, not submitted.** The text run's `trust_tier` is
  `self_reported` (`model_verified: declared`). The perf mirror claims `attested`/`verified`, as
  noted above, with the same `--target`. Both submissions were deferred (`open_run failed …
  results persisted`), because the mothership pointed at a closed local port. Nothing reached
  aeon-bench.com.
- **Import:** `node scripts/aeon-pod-import.mjs --file … --node spark-1 --port 8891
  --client-location local` on Node 18 stored 6 + 12 valid records (`board not_submitted, pod says
  self_reported / attested`).
- **Cross-check:** Herd's own AEON ladder on the same lane (`DecodeBench`, `protocol:
  "aeon-perf-v1"`, c1/c4, 256 tokens) against the pod perf run in Upgrade worth it?: all 12
  cells within ±1.5 % (`perf.direct.overall.c4` 855.84 vs 848.25 tok/s `agg_window_tps`, −0.89 %),
  verdict "within noise". Two implementations of the same definition agree.

Not exercised here: the attested flow (no HF weights, GPU or ssh-reachable Spark on the test box)
and the agentic harnesses (no Docker). The importer covers both with unit tests on
pod-shaped rows.

## Licence

AEON Bench Pod is MIT. Herd copies no pod code. The importer follows the pod's documented run
format and field names (`docs/run-a-benchmark.md`, `mvp/pod/perf_grid.py`, `mvp/aeon/db.py`),
with attribution. The test fixtures under `server/bench/aeonPod/__tests__/fixtures/` are slimmed
outputs of the test run above: pod case ids, categories, scores, and perf evidence measured
against Herd's stub lane. They hold no AEON prompts, answers or checker data.
