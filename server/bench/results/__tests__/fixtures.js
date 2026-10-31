/** Shared fixtures in the exact shapes the bench managers persist. */

export function decodeStream(over = {}) {
  return {
    index: 0,
    ttftContentMs: null,
    reasoningChunks: 0,
    ttftMs: 120,
    decodeTps: 50,
    decodeTokens: 399,
    completionTokens: 400,
    prefillTps: 900,
    prefillTokens: 100,
    totalMs: 8100,
    error: null,
    ...over,
  };
}

export function decodeWave(concurrency, over = {}) {
  const streams = Array.from({ length: concurrency }, (_, i) =>
    decodeStream({ index: i, ttftMs: 100 + i * 10, decodeTps: 50 - i })
  );
  const rates = streams.map((s) => s.decodeTps);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  return {
    concurrency,
    streamsOk: concurrency,
    streamsFailed: 0,
    meanDecodeTps: Math.round(mean * 100) / 100,
    medianDecodeTps: rates[Math.floor(rates.length / 2)],
    minDecodeTps: Math.min(...rates),
    maxDecodeTps: Math.max(...rates),
    meanTtftMs: 115,
    medianTtftMs: 110,
    aggregateDecodeTps: 180.5,
    meanPrefillTps: 900,
    medianPrefillTps: 900,
    aggregatePrefillTps: 3100.25,
    totalPrefillTokens: 100 * concurrency,
    totalDecodeTokens: 399 * concurrency,
    totalCompletionTokens: 400 * concurrency,
    durationMs: 8300,
    error: null,
    streams,
    model: "qwen3-30b",
    ...over,
  };
}

export function decodeJob(over = {}) {
  return {
    benchId: "bench-1",
    sparkId: "spark-a",
    status: "completed",
    startedAt: Date.UTC(2026, 9, 1, 12, 0, 0),
    completedAt: Date.UTC(2026, 9, 1, 12, 5, 0),
    config: { port: 8000, modelId: "qwen3-30b", concurrencies: [1, 4], maxTokens: 400, promptType: "structured" },
    progress: { currentConcurrency: null, completedLevels: 2, totalLevels: 2, message: "Done" },
    results: [decodeWave(1), decodeWave(4)],
    error: null,
    durationMs: 300000,
    owner: null,
    ...over,
  };
}

export function prefillJob(over = {}) {
  return {
    benchId: "pf-1",
    sparkId: "spark-a",
    status: "completed",
    startedAt: Date.UTC(2026, 9, 2, 9, 0, 0),
    completedAt: Date.UTC(2026, 9, 2, 9, 2, 0),
    config: { port: 8000, modelId: "qwen3-30b", contextSizes: [1024, 8192] },
    progress: { currentContext: null, completedLevels: 2, totalLevels: 2, message: "Done" },
    results: [
      { targetTokens: 1024, promptTokens: 1030, promptChars: 4100, prefillTps: 2500.5, ttftMs: 412, ttftContentMs: null, completionTokens: 8, durationMs: 500, model: "qwen3-30b", error: null },
      { targetTokens: 8192, promptTokens: 8200, promptChars: 33000, prefillTps: 3100, ttftMs: 2645, ttftContentMs: null, completionTokens: 8, durationMs: 2800, model: "qwen3-30b", error: null },
    ],
    error: null,
    durationMs: 120000,
    owner: null,
    ...over,
  };
}

export function showcaseRecord(over = {}) {
  return {
    sessionId: "sess-1",
    sparkId: "spark-a",
    status: "completed",
    rev: 12,
    port: 8000,
    modelId: "qwen3-30b",
    maxTokens: 512,
    temperature: 0.7,
    thinking: false,
    promptType: "mixed",
    startedAt: Date.UTC(2026, 9, 3, 10, 0, 0),
    completedAt: Date.UTC(2026, 9, 3, 10, 1, 0),
    serverGenerationTps: 140.2,
    serverGenerationTpsMax: 150,
    serverGenerationSamples: 30,
    totalTokens: 1500,
    meanDecodeTps: 46.67,
    peakStreamTps: 60,
    streamCount: 3,
    streams: [
      { streamId: "a", label: "A", prompt: "p1", status: "completed", content: "hello world", reasoning: "", contentLength: 11, reasoningLength: 0, tokenCount: 500, ttftMs: 200, decodeTps: 50, liveTokPerSec: 50, peakTokPerSec: 60, model: "qwen3-30b", error: null },
      { streamId: "b", label: "B", prompt: "p2", status: "completed", content: "x", reasoning: "think", contentLength: 1, reasoningLength: 5, tokenCount: 500, ttftMs: 250, decodeTps: 45, liveTokPerSec: 45, peakTokPerSec: 55, model: "qwen3-30b", error: null },
      { streamId: "c", label: "C", prompt: "p3", status: "completed", content: "y", reasoning: "", contentLength: 1, reasoningLength: 0, tokenCount: 500, ttftMs: 300, decodeTps: 45, liveTokPerSec: 45, peakTokPerSec: 50, model: "qwen3-30b", error: null },
    ],
    error: null,
    fromHistory: true,
    ...over,
  };
}

export function provenance(over = {}) {
  return {
    host: {
      node_id: "spark-a",
      node_name: "Spark A",
      hw_bucket: "Single DGX Spark",
      gpu: "NVIDIA GB10",
      gpu_count: 1,
      mem_class: "128GB unified",
      clock_cap_mhz: null,
      power_cap_w: 140,
    },
    lane: {
      engine: "vllm",
      engine_version: null,
      image_digest: null,
      model_id: "qwen3-30b",
      weights_hash: null,
      quant: null,
      recipe_flags: null,
      spec_decode: null,
      kv_dtype: null,
      ctx_len: 32768,
      parallel: null,
    },
    client_location: "local",
    ...over,
  };
}

/** A minimal valid reference record (as POSTed by a user). */
export function referenceRecord(over = {}) {
  return {
    id: "reference:aeon-188",
    run: {
      run_id: "aeon-188",
      started_at: "2026-09-01T00:00:00.000Z",
      suite: "herd.decode",
      suite_version: "1",
      bench: "AEON",
      bench_version: "2025.1",
      origin: "reference",
      reference_url: "https://example.org/aeon/run/188",
    },
    host: { hw_bucket: "Single DGX Spark" },
    lane: { engine: "vllm", model_id: "qwen3-30b" },
    conditions: { concurrency: 4, max_tokens: 400, temperature: 0, thinking: false, prompt_set: "decode/structured", client_location: "local" },
    metrics: [
      { metric: "agg_window_tps", value: 188.4, source: "reference", definition: "aeon.wave_peak_concurrent_window.v1" },
      { metric: "agg_sum_tps", value: 66.66, source: "reference", definition: "aeon.agg_saturated_est.v1" },
    ],
    ...over,
  };
}
