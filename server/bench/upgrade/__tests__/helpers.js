/** Fixtures for the upgrade compare tests: decode runs and quality runs in store shape. */

import { fromDecodeJob } from "../../results/adapters.js";
import { makeResult } from "../../results/schema.js";
import { decodeJob, decodeWave, provenance } from "../../results/__tests__/fixtures.js";

const MIN = 60_000;

/**
 * One DecodeBench run (c1 + c4) on spark-a.
 * @param {string} benchId
 * @param {{ c1?: number, c4?: number, model?: string, engineVersion?: string|null, day?: number, maxTokens?: number, hw?: string }} [o]
 */
export function decodeRun(benchId, o = {}) {
  const start = Date.UTC(2026, 9, o.day ?? 1, 12, 0, 0);
  const model = o.model ?? "qwen3-30b";
  const job = decodeJob({
    benchId,
    startedAt: start,
    completedAt: start + 5 * MIN,
    config: { port: 8000, modelId: model, concurrencies: [1, 4], maxTokens: o.maxTokens ?? 400, promptType: "structured" },
    results: [
      decodeWave(1, { aggregateDecodeTps: o.c1 ?? 50, model }),
      decodeWave(4, { aggregateDecodeTps: o.c4 ?? 180, model }),
    ],
  });
  const prov = provenance();
  return fromDecodeJob(job, {
    provenance: {
      ...prov,
      host: { ...prov.host, hw_bucket: o.hw ?? prov.host.hw_bucket },
      lane: { ...prov.lane, model_id: model, engine_version: o.engineVersion ?? null },
    },
  });
}

/**
 * One QualityBench run with a category record per entry of `cats`:
 * `{ key: passes[] }` (true/false per item, same item ids on every run).
 */
export function qualityRun(runKey, cats, o = {}) {
  const runId = `quality:${runKey}`;
  return Object.entries(cats).map(([cat, passes]) => {
    const passed = passes.filter(Boolean).length;
    return makeResult({
      id: `${runId}:${cat}`,
      run: {
        run_id: runId,
        started_at: new Date(Date.UTC(2026, 9, o.day ?? 1, 13, 0, 0)).toISOString(),
        completed_at: new Date(Date.UTC(2026, 9, o.day ?? 1, 13, 30, 0)).toISOString(),
        status: "completed",
        suite: "herd.quality",
        suite_version: o.suiteVersion ?? "1",
        bench: "QualityBench",
        bench_version: "1",
        origin: "herd",
      },
      host: { node_id: "spark-a", hw_bucket: "Single DGX Spark" },
      lane: { model_id: o.model ?? "qwen3-30b", engine: "vllm" },
      conditions: {
        concurrency: 4,
        context_tokens: null,
        max_tokens: 512,
        temperature: 0,
        thinking: false,
        prompt_set: `quality/${cat}`,
        client_location: "local",
      },
      settings: { category: cat },
      metrics: [
        {
          metric: "accuracy_pct",
          definition: "herd.quality.item_pass_rate.v1",
          source: "client",
          value: Math.round((10000 * passed) / passes.length) / 100,
          n: passes.length,
        },
      ],
      quality: { items: passes.map((pass, i) => ({ id: `${cat}-${i}`, pass })) },
    });
  });
}

/** `n` items, the first `k` passing. */
export function passes(n, k) {
  return Array.from({ length: n }, (_, i) => i < k);
}
