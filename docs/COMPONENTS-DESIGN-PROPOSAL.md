# Components Design Proposal — component definition catalog (SC2/SC10 POC, batch 5)

**Date:** 2026-10-30 · **Status:** POC (owner-approved 2026-10-30) · **Issue:** airhamer/herd#5

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
