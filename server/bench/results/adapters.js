/**
 * Turn Herd bench output (DecodeBench jobs, PrefillBench jobs, Showcase
 * sessions — live or from their legacy history files) into bench result
 * records.
 *
 * Every record keeps the source object it was derived from under `raw`, so
 * an import loses no numbers even where the schema has no column for one.
 */

import { makeResult } from "./schema.js";

/** Protocol versions of the Herd benches as they stand in this commit. */
export const BENCH_VERSIONS = Object.freeze({
  DecodeBench: "1",
  PrefillBench: "1",
  Showcase: "1",
  QualityBench: "1",
});

export const SUITES = Object.freeze({
  DecodeBench: { suite: "herd.decode", suite_version: "1" },
  PrefillBench: { suite: "herd.prefill", suite_version: "1" },
  Showcase: { suite: "herd.showcase", suite_version: "1" },
  // suite_version follows QUALITY_SUITE_VERSION (server/collectors/quality/items.js).
  QualityBench: { suite: "herd.quality", suite_version: "1" },
});

const STATUS_MAP = {
  completed: "completed",
  failed: "failed",
  error: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
};

// ─── small stats helpers ──────────────────────────────────────────────

/** Two-sided 95% Student t critical values, df 1..30. */
const T95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
  2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

export function round2(v) {
  return Math.round(v * 100) / 100;
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Nearest-rank percentile (p in 0..100) of a non-empty array. */
export function percentile(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[rank - 1];
}

/** Median (average of middle pair for even n). */
export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 95% CI of the mean (Student t); null for n < 2. */
export function meanCi(xs) {
  if (xs.length < 2) return { ci_low: null, ci_high: null };
  const m = mean(xs);
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  const df = xs.length - 1;
  const t = df <= 30 ? T95[df - 1] : 1.96;
  const half = (t * sd) / Math.sqrt(xs.length);
  return { ci_low: round2(m - half), ci_high: round2(m + half) };
}

const pos = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

function iso(ms) {
  if (ms === null || ms === undefined) return null;
  const d = typeof ms === "number" ? new Date(ms) : new Date(String(ms));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A metric row for a value that was not measured (null, never 0). */
function unmeasured(metric, definition, source = "client") {
  return { metric, definition, source, value: null, valid: false };
}

/**
 * Provenance known to the server when a bench starts (host + lane), see
 * server/bench/results/provenance.js. Imports from legacy history have no
 * provenance beyond the node id and model, so the rest stays null.
 * @typedef {{ host?: object, lane?: object, client_location?: "local"|"network"|null }} Provenance
 */

function baseRecord({ bench, runId, startedAt, completedAt, status, nodeId, modelId, provenance, importedFrom }) {
  const prov = provenance || {};
  return {
    run: {
      run_id: runId,
      started_at: iso(startedAt) ?? iso(completedAt) ?? new Date(0).toISOString(),
      completed_at: iso(completedAt),
      status: STATUS_MAP[status] ?? null,
      ...SUITES[bench],
      bench,
      bench_version: BENCH_VERSIONS[bench],
      origin: "herd",
      reference_url: null,
      imported_from: importedFrom ?? null,
    },
    host: { ...(prov.host || {}), node_id: nodeId ?? prov.host?.node_id ?? null },
    lane: { ...(prov.lane || {}), model_id: modelId ?? prov.lane?.model_id ?? null },
    clientLocation: prov.client_location ?? null,
  };
}

// ─── DecodeBench ──────────────────────────────────────────────────────

/**
 * One record per concurrency wave of a DecodeBench job.
 * @param {any} job  public job (live or from bench-history.json)
 * @param {{ provenance?: Provenance, importedFrom?: object, recordedAt?: string }} [opts]
 */
export function fromDecodeJob(job, opts = {}) {
  if (!job || !job.benchId || !Array.isArray(job.results)) return [];
  if (job.config?.protocol === AEON_SUITE.suite && job.aeon && Array.isArray(job.aeon.levels)) {
    return fromAeonDecodeJob(job, opts);
  }
  if (job.config?.protocol === HASSO_SUITE.suite && job.hasso) {
    return fromHassoDecodeJob(job, opts);
  }
  const cfg = job.config || {};
  const base = baseRecord({
    bench: "DecodeBench",
    runId: `decode:${job.benchId}`,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    status: job.status,
    nodeId: job.nodeId || job.sparkId,
    modelId: cfg.modelId ?? null,
    provenance: opts.provenance,
    importedFrom: opts.importedFrom,
  });
  const jobRaw = { ...job };
  delete jobRaw.results;

  return job.results
    .filter((w) => w && Number.isInteger(w.concurrency))
    .map((wave) => {
      const okStreams = Array.isArray(wave.streams) ? wave.streams.filter((s) => s && !s.error) : [];
      const n = wave.streamsOk > 0 ? wave.streamsOk : null;
      const metrics = decodeMetrics(wave, okStreams, n);
      return makeResult({
        id: `${base.run.run_id}:c${wave.concurrency}`,
        recorded_at: opts.recordedAt,
        run: base.run,
        host: base.host,
        lane: { ...base.lane, model_id: wave.model || base.lane.model_id },
        conditions: {
          concurrency: wave.concurrency,
          context_tokens: null,
          max_tokens: Number.isInteger(cfg.maxTokens) ? cfg.maxTokens : null,
          temperature: 0,
          thinking: false,
          prompt_set: `decode/${cfg.promptType || "default"}`,
          client_location: base.clientLocation,
        },
        settings: {
          top_p: 1,
          warmup_max_tokens: 32,
          port: cfg.port ?? null,
          concurrencies: cfg.concurrencies ?? null,
          streams_ok: wave.streamsOk ?? null,
          streams_failed: wave.streamsFailed ?? null,
        },
        metrics,
        raw: { job: jobRaw, wave },
      });
    });
}

function decodeMetrics(wave, okStreams, n) {
  const rows = [];
  if (!n) return [unmeasured("decode_tps_stream", "herd.decode.stream_mean.v1")];

  const rates = okStreams.map((s) => s.decodeTps).filter(pos);
  if (pos(wave.meanDecodeTps)) {
    rows.push({
      metric: "decode_tps_stream",
      definition: "herd.decode.stream_mean.v1",
      source: "client",
      value: round2(wave.meanDecodeTps),
      n,
      ...(rates.length === n ? meanCi(rates) : {}),
    });
    rows.push({
      metric: "agg_sum_tps",
      definition: "herd.decode.agg_sum.v1",
      source: "client",
      value: round2(rates.length === n ? rates.reduce((a, b) => a + b, 0) : wave.meanDecodeTps * n),
      n,
    });
  } else {
    rows.push(unmeasured("decode_tps_stream", "herd.decode.stream_mean.v1"));
  }

  if (pos(wave.aggregateDecodeTps)) {
    rows.push({
      metric: "agg_window_tps",
      definition: "herd.decode.agg_window.v1",
      source: "client",
      value: round2(wave.aggregateDecodeTps),
      n,
      window_s: pos(wave.totalDecodeTokens)
        ? Math.round((wave.totalDecodeTokens / wave.aggregateDecodeTps) * 1000) / 1000
        : null,
    });
  }

  if (pos(wave.aggregatePrefillTps)) {
    rows.push({
      metric: "prefill_tps",
      definition: "herd.decode.prefill_window.v1",
      source: "client",
      value: round2(wave.aggregatePrefillTps),
      n,
    });
  }

  const ttfts = okStreams.map((s) => s.ttftMs).filter(pos);
  if (ttfts.length) {
    rows.push({ metric: "ttft_p50", definition: "herd.ttft.client_first_token.v1", source: "client", value: round2(median(ttfts)), n: ttfts.length });
    rows.push({ metric: "ttft_p95", definition: "herd.ttft.client_first_token_p95.v1", source: "client", value: round2(percentile(ttfts, 95)), n: ttfts.length });
  } else if (pos(wave.medianTtftMs)) {
    rows.push({ metric: "ttft_p50", definition: "herd.ttft.client_first_token.v1", source: "client", value: round2(wave.medianTtftMs), n });
  }

  if (rates.length) {
    const tpot = rates.map((r) => 1000 / r);
    rows.push({ metric: "tpot_p95", definition: "herd.tpot.client_stream.v1", source: "client", value: round2(percentile(tpot, 95)), n: rates.length });
  }

  const energy = waveEnergy(wave);
  if (energy) rows.push(energy);
  return rows;
}

/** Wh per 1k completion tokens from the wave's ~1 Hz GPU power samples. */
function waveEnergy(wave) {
  const samples = Array.isArray(wave.hardwareSamples) ? wave.hardwareSamples : [];
  const watts = samples.map((s) => s?.powerDraw).filter(pos);
  if (watts.length < 2 || !pos(wave.durationMs) || !pos(wave.totalCompletionTokens)) return null;
  const wh = (mean(watts) * wave.durationMs) / 3_600_000;
  return {
    metric: "wh_per_1k_tokens",
    definition: "herd.energy.gpu_power_wave.v1",
    source: "native",
    value: Math.round((wh / (wave.totalCompletionTokens / 1000)) * 10000) / 10000,
    n: watts.length,
    window_s: Math.round(wave.durationMs) / 1000,
    approximate: true,
  };
}

// ─── DecodeBench, AEON aeon-perf-v1 ladder ──────────────────────────────

/** Suite of DecodeBench runs that used AEON's ladder (DecodeBench `protocol`). */
export const AEON_SUITE = Object.freeze({ suite: "aeon-perf-v1", suite_version: "1" });

/**
 * One record per AEON cell: `perf.direct.<category>.c<n>` for each category
 * and `perf.direct.overall.c<n>` for the level, the row names AEON's
 * to_results() uses. Both aggregates are stored: the peak wave window under
 * `agg_window_tps` (aeon.wave_peak_concurrent_window.v1) and decode × conc
 * under `agg_sum_tps` (aeon.agg_saturated_est.v1).
 *
 * @param {any} job
 * @param {{ provenance?: Provenance, importedFrom?: object, recordedAt?: string }} [opts]
 */
export function fromAeonDecodeJob(job, opts = {}) {
  const cfg = job.config || {};
  const base = baseRecord({
    bench: "DecodeBench",
    runId: `decode:${job.benchId}`,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    status: job.status,
    nodeId: job.nodeId || job.sparkId,
    modelId: cfg.modelId ?? null,
    provenance: opts.provenance,
    importedFrom: opts.importedFrom,
  });
  const anyErrors = job.aeon.levels.some((lv) => (lv?.overall?.n_errors || 0) > 0);
  const run = {
    ...base.run,
    ...AEON_SUITE,
    status: base.run.status === "completed" && anyErrors ? "partial" : base.run.status,
    reference_url: null,
  };
  const jobRaw = { ...job };
  delete jobRaw.results;
  delete jobRaw.aeon;

  const out = [];
  for (const level of job.aeon.levels) {
    if (!level || !Number.isInteger(level.conc)) continue;
    const cells = [
      ...Object.entries(level.categories || {}).map(([cat, cell]) => ({ scope: cat, cell })),
      { scope: "overall", cell: level.overall },
    ];
    for (const { scope, cell } of cells) {
      if (!cell) continue;
      const caseId = `perf.direct.${scope.toLowerCase()}.c${level.conc}`;
      const cellRaw = { ...cell };
      out.push(
        makeResult({
          id: `${run.run_id}:${caseId}`,
          recorded_at: opts.recordedAt,
          run,
          host: base.host,
          lane: base.lane,
          conditions: {
            concurrency: level.conc,
            context_tokens: null,
            max_tokens: Number.isInteger(cfg.maxTokens) ? cfg.maxTokens : 256,
            temperature: 0,
            // AEON sends no thinking flags: the engine default applies.
            thinking: null,
            prompt_set: `${AEON_SUITE.suite}/${scope.toLowerCase()}`,
            client_location: base.clientLocation,
          },
          settings: {
            case_id: caseId,
            scope,
            port: cfg.port ?? null,
            ladder: cfg.concurrencies ?? null,
            isolation: "per_category",
            agg_source: cell.agg_source ?? null,
            tokens_source: cell.tokens_source ?? "client",
            wave_count: cell.wave_count ?? null,
            n_errors: cell.n_errors ?? 0,
            cell_wall_s: scope === "overall" ? level.wallClockS ?? null : cell.cell_wall_s ?? null,
            tokens_per_wall_s: cell.tokens_per_wall_s ?? null,
            nonce: job.aeon.nonce ?? null,
          },
          metrics: aeonMetrics(cell),
          raw: { job: jobRaw, level_conc: level.conc, cell: cellRaw },
        })
      );
    }
  }
  return out;
}

export function aeonMetrics(cell) {
  const n = Number.isInteger(cell.n) && cell.n > 0 ? cell.n : null;
  const val = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const row = (metric, definition, value, extra = {}) => ({
    metric,
    definition,
    source: "client",
    value: val(value),
    n: val(value) === null ? null : n,
    ...(val(value) === null ? { valid: false } : {}),
    ...extra,
  });
  return [
    row("agg_window_tps", "aeon.wave_peak_concurrent_window.v1", cell.agg_decode_tps, {
      window_s: val(cell.concurrent_window_s),
    }),
    row("agg_sum_tps", "aeon.agg_saturated_est.v1", cell.agg_saturated_est),
    row("decode_tps_stream", "aeon.decode_tps_mean.v1", cell.decode_tps_mean),
    row("prefill_tps", "aeon.prefill_tps_mean.v1", cell.prefill_tps_mean),
    row("ttft_p50", "herd.ttft.client_first_token.v1", cell.ttft_ms_p50),
    row("ttft_p95", "aeon.ttft_p95_linear.v1", cell.ttft_ms_p95),
    row("tpot_p95", "aeon.tpot_p95_linear.v1", cell.tpot_ms_p95),
  ];
}

// ─── DecodeBench, Hasso battery v1 ─────────────────────────────────────

/** Suite of DecodeBench runs that used Hasso's battery (DecodeBench `protocol`). */
export const HASSO_SUITE = Object.freeze({ suite: "hasso-battery-v1", suite_version: "1" });

/**
 * Records of a Hasso battery run, all single-stream:
 *   hasso.bench.greedy_median   bench.sh headline (hasso.single_stream_greedy_median.v1)
 *   hasso.bench.<probe>         each bench.sh probe (hasso.bench_probe_median.v1)
 *   hasso.matrix.<workload>     each battery v1 workload (hasso.matrix_two_call_delta.v1);
 *                               a refused sample is stored with value null, valid false.
 *
 * @param {any} job
 * @param {{ provenance?: Provenance, importedFrom?: object, recordedAt?: string }} [opts]
 */
export function fromHassoDecodeJob(job, opts = {}) {
  const cfg = job.config || {};
  const h = job.hasso || {};
  const base = baseRecord({
    bench: "DecodeBench",
    runId: `decode:${job.benchId}`,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    status: job.status,
    nodeId: job.nodeId || job.sparkId,
    modelId: cfg.modelId ?? h.model ?? null,
    provenance: opts.provenance,
    importedFrom: opts.importedFrom,
  });
  const run = { ...base.run, ...HASSO_SUITE };
  const jobRaw = { ...job };
  delete jobRaw.results;
  delete jobRaw.hasso;
  const val = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const metric = (definition, value, n) => {
    const v = val(value);
    return {
      metric: "decode_tps_stream",
      definition,
      source: "client",
      value: v,
      n: v === null || !(Number.isInteger(n) && n > 0) ? null : n,
      ...(v === null ? { valid: false } : {}),
    };
  };
  const record = (caseId, conditions, settings, metrics, raw) =>
    makeResult({
      id: `${run.run_id}:${caseId}`,
      recorded_at: opts.recordedAt,
      run,
      host: base.host,
      lane: base.lane,
      conditions: {
        concurrency: 1,
        context_tokens: null,
        // Hasso sends no thinking flags: the engine default applies.
        thinking: null,
        client_location: base.clientLocation,
        ...conditions,
      },
      settings: {
        case_id: caseId,
        port: cfg.port ?? null,
        battery_version: h.batteryVersion ?? 1,
        parts: cfg.parts ?? h.parts ?? null,
        tokens_source: "client",
        ...settings,
      },
      metrics,
      raw: { job: jobRaw, ...raw },
    });

  const out = [];
  const bench = h.bench;
  if (bench && Array.isArray(bench.probes)) {
    const greedyProbes = bench.probes.filter((p) => p.inMedian);
    if (greedyProbes.length && greedyProbes.every((p) => Array.isArray(p.runs) && p.runs.length > 0)) {
      out.push(
        record(
          "hasso.bench.greedy_median",
          { max_tokens: greedyProbes[0].maxTokens ?? 1200, temperature: 0, prompt_set: `${HASSO_SUITE.suite}/bench/greedy` },
          {
            method: "streamed, (out − 1) / (t_last − t_first)",
            probes: greedyProbes.map((p) => p.key),
            runs_per_probe: 2,
            untimed_runs: bench.untimed ?? 0,
          },
          [metric("hasso.single_stream_greedy_median.v1", bench.greedyMedian, bench.greedyRuns)],
          { bench: { greedyMedian: bench.greedyMedian, greedyRuns: bench.greedyRuns, untimed: bench.untimed } }
        )
      );
    }
    for (const p of bench.probes) {
      if (!Array.isArray(p.runs) || !p.runs.length) continue;
      const timed = p.runs.filter((r) => val(r.tps) !== null).length;
      out.push(
        record(
          `hasso.bench.${p.key}`,
          {
            max_tokens: p.maxTokens ?? null,
            temperature: typeof p.temperature === "number" ? p.temperature : null,
            prompt_set: `${HASSO_SUITE.suite}/bench/${p.key}`,
          },
          {
            probe: p.name ?? p.key,
            in_greedy_median: Boolean(p.inMedian),
            run_tps: p.runs.map((r) => val(r.tps)),
            untimed_runs: p.runs.length - timed,
          },
          [metric("hasso.bench_probe_median.v1", p.median, timed)],
          { probe: p }
        )
      );
    }
  }
  const matrix = h.matrix;
  if (matrix && Array.isArray(matrix.probes)) {
    for (const p of matrix.probes) {
      out.push(
        record(
          `hasso.matrix.${p.key}`,
          { max_tokens: 680, temperature: 0, prompt_set: `${HASSO_SUITE.suite}/matrix/${p.key}` },
          {
            probe: p.name ?? p.key,
            lang: p.lang ?? null,
            method: "two-call delta, temperature 0, max_tokens 80/680",
            short_max_tokens: 80,
            short_tokens: p.short?.tokens ?? null,
            short_wall_s: p.short?.wallS ?? null,
            long_tokens: p.long?.tokens ?? null,
            long_wall_s: p.long?.wallS ?? null,
            delta_tokens: p.deltaTokens ?? null,
            delta_s: p.deltaS ?? null,
            reliable: Boolean(p.reliable),
            refused_reason: p.reliable ? null : p.reason ?? null,
            warmup_discarded: Boolean(matrix.warmup),
          },
          [metric("hasso.matrix_two_call_delta.v1", p.reliable ? p.tps : null, null)],
          { probe: p }
        )
      );
    }
  }
  return out;
}

// ─── PrefillBench ─────────────────────────────────────────────────────

/**
 * One record per context size of a PrefillBench job.
 * @param {any} job
 * @param {{ provenance?: Provenance, importedFrom?: object, recordedAt?: string }} [opts]
 */
export function fromPrefillJob(job, opts = {}) {
  if (!job || !job.benchId || !Array.isArray(job.results)) return [];
  const cfg = job.config || {};
  const base = baseRecord({
    bench: "PrefillBench",
    runId: `prefill:${job.benchId}`,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    status: job.status,
    nodeId: job.sparkId,
    modelId: cfg.modelId ?? null,
    provenance: opts.provenance,
    importedFrom: opts.importedFrom,
  });
  const jobRaw = { ...job };
  delete jobRaw.results;

  return job.results
    .filter((r) => r && Number.isInteger(r.targetTokens))
    .map((point) => {
      const ok = !point.error;
      const metrics = [];
      if (ok && pos(point.prefillTps)) {
        metrics.push({ metric: "prefill_tps", definition: "herd.prefill.single_request.v1", source: "client", value: round2(point.prefillTps), n: 1 });
      } else {
        metrics.push(unmeasured("prefill_tps", "herd.prefill.single_request.v1"));
      }
      if (ok && pos(point.ttftMs)) {
        metrics.push({ metric: "ttft_p50", definition: "herd.ttft.client_first_token.v1", source: "client", value: round2(point.ttftMs), n: 1 });
      }
      return makeResult({
        id: `${base.run.run_id}:t${point.targetTokens}`,
        recorded_at: opts.recordedAt,
        run: base.run,
        host: base.host,
        lane: { ...base.lane, model_id: point.model || base.lane.model_id },
        conditions: {
          concurrency: 1,
          context_tokens: point.targetTokens,
          max_tokens: 8,
          temperature: 0,
          thinking: false,
          prompt_set: "prefill/salted-filler",
          client_location: base.clientLocation,
        },
        settings: {
          top_p: 1,
          port: cfg.port ?? null,
          context_sizes: cfg.contextSizes ?? null,
          prompt_tokens: point.promptTokens ?? null,
        },
        metrics,
        raw: { job: jobRaw, point },
      });
    });
}

// ─── Showcase ─────────────────────────────────────────────────────────

/**
 * One record per finished Showcase session. Stream text is dropped from
 * `raw` (lengths are kept); it is output, not a measurement.
 * @param {any} session  publicSessionRecord(...) shape
 * @param {{ provenance?: Provenance, importedFrom?: object, recordedAt?: string }} [opts]
 */
export function fromShowcaseSession(session, opts = {}) {
  if (!session || !session.sessionId) return [];
  const streams = Array.isArray(session.streams) ? session.streams : [];
  const base = baseRecord({
    bench: "Showcase",
    runId: `showcase:${session.sessionId}`,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    status: session.status,
    nodeId: session.sparkId,
    modelId: session.modelId ?? null,
    provenance: opts.provenance,
    importedFrom: opts.importedFrom,
  });

  const ok = streams.filter((s) => s && !s.error && s.status !== "error" && s.status !== "cancelled");
  const rates = ok.map((s) => s.decodeTps).filter(pos);
  const metrics = [];
  if (pos(session.meanDecodeTps) || rates.length) {
    metrics.push({
      metric: "decode_tps_stream",
      definition: "herd.showcase.stream_mean_estimated.v1",
      source: "client",
      value: round2(rates.length ? mean(rates) : session.meanDecodeTps),
      n: rates.length || null,
      ...meanCi(rates),
      approximate: true,
    });
  } else {
    metrics.push(unmeasured("decode_tps_stream", "herd.showcase.stream_mean_estimated.v1"));
  }
  if (pos(session.serverGenerationTps)) {
    metrics.push({
      metric: "server_generation_tps",
      definition: "herd.engine.generation_tps_counter.v1",
      source: "counter",
      value: round2(session.serverGenerationTps),
      n: pos(session.serverGenerationSamples) ? session.serverGenerationSamples : null,
    });
  }
  const ttfts = ok.map((s) => s.ttftMs).filter(pos);
  if (ttfts.length) {
    metrics.push({ metric: "ttft_p50", definition: "herd.ttft.client_first_token.v1", source: "client", value: round2(median(ttfts)), n: ttfts.length });
    metrics.push({ metric: "ttft_p95", definition: "herd.ttft.client_first_token_p95.v1", source: "client", value: round2(percentile(ttfts, 95)), n: ttfts.length });
  }

  const raw = {
    ...session,
    streams: streams.map((s) => {
      const copy = { ...s };
      delete copy.content;
      delete copy.reasoning;
      return copy;
    }),
  };

  return [
    makeResult({
      id: base.run.run_id,
      recorded_at: opts.recordedAt,
      run: base.run,
      host: base.host,
      lane: base.lane,
      conditions: {
        concurrency: streams.length > 0 ? streams.length : null,
        context_tokens: null,
        max_tokens: Number.isInteger(session.maxTokens) ? session.maxTokens : null,
        temperature: typeof session.temperature === "number" ? session.temperature : null,
        thinking: typeof session.thinking === "boolean" ? session.thinking : null,
        prompt_set: `showcase/${session.promptType || "custom"}`,
        client_location: base.clientLocation,
      },
      settings: { port: session.port ?? null, peak_stream_tps: session.peakStreamTps ?? null },
      metrics,
      raw,
    }),
  ];
}

// ─── QualityBench ─────────────────────────────────────────────────────

/** Wilson 95% interval for a pass rate, in percent. */
export function wilsonCi(passed, n) {
  if (!(n > 0)) return { ci_low: null, ci_high: null };
  const z = 1.96;
  const p = passed / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return {
    ci_low: round2(Math.max(0, centre - half) * 100),
    ci_high: round2(Math.min(1, centre + half) * 100),
  };
}

/**
 * One record per category plus one overall record for a Quality bench run.
 * Every record carries its per-item pass/fail vector in `quality.items`
 * (errored items as pass: null); the overall record keeps the per-item
 * detail (expected, extracted answer, latency) in `raw.items`.
 * @param {any} job  full job (QualityBenchManager.fullJob)
 * @param {{ provenance?: Provenance, importedFrom?: object, recordedAt?: string }} [opts]
 */
export function fromQualityJob(job, opts = {}) {
  if (!job || !job.benchId || !Array.isArray(job.items) || !job.summary) return [];
  const cfg = job.config || {};
  const base = baseRecord({
    bench: "QualityBench",
    runId: `quality:${job.benchId}`,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    status: job.status,
    nodeId: job.sparkId,
    modelId: cfg.modelId ?? null,
    provenance: opts.provenance,
    importedFrom: opts.importedFrom,
  });
  const summary = job.summary;
  const run =
    base.run.status === "completed" && summary.itemsErrored > 0 ? { ...base.run, status: "partial" } : base.run;
  const jobRaw = { ...job };
  delete jobRaw.items;
  const conditions = (promptSet, maxTokens) => ({
    concurrency: Number.isInteger(cfg.concurrency) && cfg.concurrency > 0 ? cfg.concurrency : null,
    context_tokens: null,
    max_tokens: Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : null,
    temperature: 0,
    thinking: false,
    prompt_set: promptSet,
    client_location: base.clientLocation,
  });
  const settings = {
    top_p: 1,
    seed: cfg.seed ?? null,
    port: cfg.port ?? null,
    categories: cfg.categories ?? null,
  };
  const vector = (items) => ({ items: items.map((it) => ({ id: it.id, pass: typeof it.pass === "boolean" ? it.pass : null })) });
  const attempted = job.items.filter((it) => it && it.attempted !== false);

  const records = [];
  for (const cat of summary.categories) {
    const items = attempted.filter((it) => it.category === cat.key);
    if (items.length === 0) continue;
    const metric =
      cat.scored > 0
        ? {
            metric: "accuracy_pct",
            definition: "herd.quality.item_pass_rate.v1",
            source: "client",
            value: round2((100 * cat.passed) / cat.scored),
            n: cat.scored,
            ...wilsonCi(cat.passed, cat.scored),
          }
        : unmeasured("accuracy_pct", "herd.quality.item_pass_rate.v1");
    records.push(
      makeResult({
        id: `${base.run.run_id}:${cat.key}`,
        recorded_at: opts.recordedAt,
        run,
        host: base.host,
        lane: base.lane,
        conditions: conditions(`quality/${cat.key}`, cat.maxTokens),
        settings: { ...settings, category: cat.key, items_total: cat.total, items_scored: cat.scored, items_errored: cat.errored, passed: cat.passed },
        metrics: [metric],
        quality: vector(items),
        raw: { job: jobRaw, category: cat.key },
      })
    );
  }
  if (records.length === 0) return [];

  const metrics = [];
  if (typeof summary.overall === "number") {
    metrics.push({
      metric: "accuracy_pct",
      definition: "herd.quality.category_mean.v1",
      source: "client",
      value: round2(summary.overall),
      n: summary.categories.filter((c) => c.scored > 0).length,
    });
  } else {
    metrics.push(unmeasured("accuracy_pct", "herd.quality.category_mean.v1"));
  }
  if (summary.itemsScored > 0) {
    metrics.push({
      metric: "accuracy_pct",
      definition: "herd.quality.item_pass_rate.v1",
      source: "client",
      value: round2((100 * summary.passed) / summary.itemsScored),
      n: summary.itemsScored,
      ...wilsonCi(summary.passed, summary.itemsScored),
    });
  }
  records.push(
    makeResult({
      id: base.run.run_id,
      recorded_at: opts.recordedAt,
      run,
      host: base.host,
      lane: base.lane,
      conditions: conditions(`quality/overall:${(cfg.categories || []).join("+")}`, null),
      settings: {
        ...settings,
        items_total: summary.itemsTotal ?? null,
        items_scored: summary.itemsScored,
        items_errored: summary.itemsErrored,
        passed: summary.passed,
        category_summary: summary.categories,
      },
      metrics,
      quality: vector(attempted),
      raw: { job: jobRaw, items: attempted },
    })
  );
  return records;
}

// ─── Legacy history import ────────────────────────────────────────────

/**
 * Convert one legacy history file's parsed JSON ({ sparkId: entry[] })
 * into records.
 * @param {"DecodeBench"|"PrefillBench"|"Showcase"} bench
 * @param {unknown} data
 * @param {string} file  path/name recorded in run.imported_from
 */
export function fromLegacyHistory(bench, data, file) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const convert =
    bench === "DecodeBench" ? fromDecodeJob : bench === "PrefillBench" ? fromPrefillJob : fromShowcaseSession;
  const out = [];
  for (const [sparkId, entries] of Object.entries(data)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const withSpark = entry && !entry.sparkId ? { ...entry, sparkId } : entry;
      out.push(...convert(withSpark, { importedFrom: { file, key: sparkId } }));
    }
  }
  return out;
}
