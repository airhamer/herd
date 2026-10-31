# Reference registry: data provenance

`registry.json` lists published benchmark figures. Herd did not measure
them. For each figure it records the number, its unit and definition, the
setup facts it was measured under, and the URL it was read from (2026-10-31).
Herd wrote all the descriptive text in the file. No prose, tables, code or
other expression is copied from the sources, and the figures are attributed
to their authors below.

| Entry | Source | Licence of the source repository |
|---|---|---|
| `mia-glm-5.3-flash-exl3-2x-spark` | MiaAI-Lab, [GLM-5.3-Flash-EXL3-2x-DGX-Sparks-TensorFold](https://github.com/MiaAI-Lab/GLM-5.3-Flash-EXL3-2x-DGX-Sparks-TensorFold), README "Performance" | Apache-2.0 |
| `mia-qwen3.8-flash-next-fp4-1x-spark` | MiaAI-Lab, [Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark-TensorFold), README "Performance" | MIT, © 2026 MiaAI-Lab |
| `hasso-qwen3.8-27b-nvfp4-dflash2-gx10`, `hasso-kolibri-1-fp8-vllm-gx10`, `hasso-ornith-1.5-122b-nvfp4-vllm-gx10` | Hasso, [dgx-spark-qwen38](https://github.com/hasso5703/dgx-spark-qwen38): `BENCHMARKS.md`, `docs/kolibri-lane.md`, `docs/ornith-lane.md` | MIT |
| `aeon-peak16-c8-definition-gap` | AEON-7, [Aeon-Bench-Pod](https://github.com/AEON-7/Aeon-Bench-Pod), `docs/spark-perf-180-vs-74.md` | MIT, © 2026 AEON-7 |

No sparkDash code or text was used. Its README was read only to check what
"aggregate" means, and it did not settle the question.

Herd itself stays under MIT. Before you add a figure, check the source's
licence. Record the figure as a fact with its URL; never paste the source's
wording.
