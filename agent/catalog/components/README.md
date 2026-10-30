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
