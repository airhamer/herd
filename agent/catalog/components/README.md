# Component definition catalog

One JSON file per **Component** (UI term; internally still a lane/recipe). A
component file is a *host-independent definition* — what to serve, pinned to the
commit — not a node config. The bootstrap/stack machinery (SC10/SC5) reads these
files; the per-node `agent/config/recipes.json` stays the single-node instance
file validated against `shared/recipe.schema.json`.

Definitions here are **derived from external sources**. Each file carries a
`source` block: upstream repo, pinned upstream commit, files read, and the
license the material arrived under.

## The copy-on-TP-or-inference-machine-change rule

A component definition is scoped to **(tp, inference-machine-class)**:

- The pinned flags, memory estimates, context modes, and boot estimates are
  measurements of one tensor-parallel size on one machine class. A GB10
  (DGX Spark) recipe's `mem_fraction` is a measured cell of the GB10 cookbook;
  the same model on TP2 across two Sparks (the fleet's `tp2_pair`) has its own
  measured values, which nobody may assume.
- Therefore: when a component needs to run at a different `tp` or on a
  different machine class, **copy the file and re-pin/re-estimate the copy**
  (new `id` suffixed `-tp2`, `-gx10`, …). Never edit one file to serve two
  shapes, and never let the loader silently reinterpret a definition at a
  different TP/machine — the numbers in it are measurements, not parameters.
- File name = component `id`.

## Schema

See `docs/COMPONENTS-DESIGN-PROPOSAL.md` (repo docs) for the full schema and
the conversion rules used for the Hasso-derived examples.

Optional `runtimeProfile` and `variants[]` fields (#118) separate the reusable
serving/monitoring profile (endpoints, adapters, credential *references*,
recording policy) from weight variants such as stock vs uncensored. Existing
files without those fields still load: the profile is synthesized from
`engine`, `ports`, and `model`. A compatible variant swap keeps the parent
profile; an incompatible engine/protocol/topology/port change is an error.
Recording defaults to metadata; content recording is an explicit opt-in that
requires a request-level observer. Instance state (active variant, recording,
counter segments) is stored in `agent/config/component-instances.json`, not
by rewriting the catalog file.

## Aliases and placeholder ports

A definition may list `model.aliases` (served model ids the live engine might
report, such as `flash-nvda` for Flash-Next) and `runtimeAliases` (systemd
unit / container names). `ports.placeholder` (default true for Hasso recipes)
means `ports.engine` is a host hint, not a pin — two exclusive lanes that
share 8080/8081 must not both match that placeholder port.

See `docs/components-1c2c.md` for the two single-Spark Qwen3.8 lanes.

## Lifecycle (install / switch)

Optional `lifecycle` describes dashboard-driven install and unit rewrite using
**pinned upstream entry points** (allowlisted `./install.sh`, `./prepare-lane.sh`,
`./switch-model.sh`, …). Preview shows exact argv, disk, sudo, and boot
deadlines. Confirm is required. The agent executes argv arrays (no shell), and
only after a matching confirmation token. Missing checkouts are blockers — the
dashboard will not `curl | sh`.
