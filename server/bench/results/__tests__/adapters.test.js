import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fromDecodeJob,
  fromPrefillJob,
  fromShowcaseSession,
  fromLegacyHistory,
  percentile,
  median,
  meanCi,
} from "../adapters.js";
import { validateResult } from "../schema.js";
import { getDefinition } from "../definitions.js";
import { decodeJob, decodeWave, prefillJob, showcaseRecord, provenance } from "./fixtures.js";

function assertAllValid(records) {
  for (const r of records) assert.deepEqual(validateResult(r).errors, [], r.id);
}

function assertNamedDefinitions(records) {
  for (const r of records) {
    assert.ok(r.metrics.length > 0, r.id);
    for (const m of r.metrics) {
      const def = getDefinition(m.definition);
      assert.ok(def, `${r.id}/${m.metric}: definition ${m.definition}`);
      assert.equal(def.metric, m.metric);
    }
  }
}

const byMetric = (rec, metric) => rec.metrics.find((m) => m.metric === metric);

test("stats helpers", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.deepEqual(meanCi([5]), { ci_low: null, ci_high: null });
  const ci = meanCi([10, 12, 14]);
  assert.ok(ci.ci_low < 12 && ci.ci_high > 12);
});

test("DecodeBench: one record per concurrency with full provenance", () => {
  const recs = fromDecodeJob(decodeJob(), { provenance: provenance() });
  assert.deepEqual(recs.map((r) => r.id), ["decode:bench-1:c1", "decode:bench-1:c4"]);
  assertAllValid(recs);
  assertNamedDefinitions(recs);
  const c4 = recs[1];
  assert.equal(c4.run.run_id, "decode:bench-1");
  assert.equal(c4.run.bench, "DecodeBench");
  assert.equal(c4.run.suite, "herd.decode");
  assert.equal(c4.run.started_at, "2026-10-01T12:00:00.000Z");
  assert.equal(c4.run.origin, "herd");
  assert.equal(c4.host.hw_bucket, "Single DGX Spark");
  assert.equal(c4.lane.engine, "vllm");
  assert.equal(c4.lane.model_id, "qwen3-30b");
  assert.deepEqual(
    { ...c4.conditions },
    { concurrency: 4, context_tokens: null, max_tokens: 400, temperature: 0, thinking: false, prompt_set: "decode/structured", client_location: "local" }
  );
  assert.equal(c4.settings.top_p, 1);
});

test("DecodeBench metric rows: values, n, CI, window and percentiles", () => {
  const [, c4] = fromDecodeJob(decodeJob(), { provenance: provenance() });
  // streams decode 50, 49, 48, 47; ttft 100, 110, 120, 130
  const stream = byMetric(c4, "decode_tps_stream");
  assert.equal(stream.value, 48.5);
  assert.equal(stream.n, 4);
  assert.equal(stream.source, "client");
  assert.equal(stream.tier, 4);
  assert.ok(stream.ci_low < 48.5 && stream.ci_high > 48.5);
  const win = byMetric(c4, "agg_window_tps");
  assert.equal(win.value, 180.5);
  assert.equal(win.definition, "herd.decode.agg_window.v1");
  assert.equal(win.window_s, Math.round(((399 * 4) / 180.5) * 1000) / 1000);
  assert.equal(byMetric(c4, "agg_sum_tps").value, 194);
  assert.equal(byMetric(c4, "prefill_tps").definition, "herd.decode.prefill_window.v1");
  assert.equal(byMetric(c4, "ttft_p50").value, 115);
  assert.equal(byMetric(c4, "ttft_p95").value, 130);
  assert.equal(byMetric(c4, "tpot_p95").value, Math.round((1000 / 47) * 100) / 100);
  assert.equal(byMetric(c4, "wh_per_1k_tokens"), undefined, "no power samples → no energy row");
});

test("DecodeBench: power samples give an approximate native-tier energy row", () => {
  const wave = decodeWave(1, {
    hardwareSamples: [
      { t: 0, powerDraw: 90 },
      { t: 1000, powerDraw: 110 },
    ],
  });
  const [rec] = fromDecodeJob(decodeJob({ results: [wave] }));
  const e = byMetric(rec, "wh_per_1k_tokens");
  // 100 W × 8.3 s = 0.230556 Wh over 0.4k tokens
  assert.equal(e.value, Math.round(((100 * 8300) / 3_600_000 / 0.4) * 10000) / 10000);
  assert.equal(e.source, "native");
  assert.equal(e.tier, 2);
  assert.equal(e.approximate, true);
  assert.equal(e.window_s, 8.3);
});

test("DecodeBench: a wave with no successful streams is stored as unmeasured, not 0", () => {
  const failed = decodeWave(8, { streamsOk: 0, streamsFailed: 8, meanDecodeTps: 0, aggregateDecodeTps: 0, error: "all streams failed" });
  const recs = fromDecodeJob(decodeJob({ status: "failed", results: [decodeWave(1), failed] }));
  assertAllValid(recs);
  const r8 = recs.find((r) => r.conditions.concurrency === 8);
  assert.equal(r8.run.status, "failed");
  assert.deepEqual(r8.metrics.map((m) => [m.metric, m.value, m.valid]), [["decode_tps_stream", null, false]]);
  assert.equal(r8.raw.wave.error, "all streams failed");
});

test("DecodeBench without provenance keeps node and model, everything else null", () => {
  const [rec] = fromDecodeJob(decodeJob());
  assertAllValid([rec]);
  assert.equal(rec.host.node_id, "spark-a");
  assert.equal(rec.host.hw_bucket, null);
  assert.equal(rec.lane.engine, null);
  assert.equal(rec.lane.model_id, "qwen3-30b");
  assert.equal(rec.conditions.client_location, null);
});

test("PrefillBench: one record per context size", () => {
  const recs = fromPrefillJob(prefillJob({ results: [...prefillJob().results, { targetTokens: 65536, error: "timeout", prefillTps: 0, ttftMs: 0 }] }), { provenance: provenance() });
  assert.deepEqual(recs.map((r) => r.id), ["prefill:pf-1:t1024", "prefill:pf-1:t8192", "prefill:pf-1:t65536"]);
  assertAllValid(recs);
  assertNamedDefinitions(recs);
  assert.equal(recs[0].conditions.context_tokens, 1024);
  assert.equal(recs[0].conditions.concurrency, 1);
  assert.equal(byMetric(recs[0], "prefill_tps").value, 2500.5);
  assert.equal(byMetric(recs[0], "prefill_tps").definition, "herd.prefill.single_request.v1");
  assert.equal(byMetric(recs[0], "ttft_p50").value, 412);
  assert.equal(recs[0].settings.prompt_tokens, 1030);
  assert.deepEqual(recs[2].metrics.map((m) => [m.metric, m.value, m.valid]), [["prefill_tps", null, false]]);
});

test("Showcase: one record, estimated per-stream definition, engine counter tier, no stream text kept", () => {
  const [rec] = fromShowcaseSession(showcaseRecord(), { provenance: provenance() });
  assertAllValid([rec]);
  assertNamedDefinitions([rec]);
  assert.equal(rec.id, "showcase:sess-1");
  assert.equal(rec.conditions.concurrency, 3);
  assert.equal(rec.conditions.temperature, 0.7);
  const d = byMetric(rec, "decode_tps_stream");
  assert.equal(d.definition, "herd.showcase.stream_mean_estimated.v1");
  assert.equal(d.value, 46.67);
  assert.equal(d.approximate, true);
  const g = byMetric(rec, "server_generation_tps");
  assert.equal(g.source, "counter");
  assert.equal(g.tier, 1);
  assert.equal(g.n, 30);
  assert.equal(byMetric(rec, "ttft_p50").value, 250);
  for (const s of rec.raw.streams) {
    assert.equal("content" in s, false);
    assert.equal("reasoning" in s, false);
  }
  assert.equal(rec.raw.streams[1].reasoningLength, 5);
});

test("legacy history import is lossless: every wave/point/session and every number survives", () => {
  const decodeHistory = {
    "spark-a": [decodeJob(), decodeJob({ benchId: "bench-0", results: [decodeWave(2)] })],
    "spark-b": [decodeJob({ benchId: "bench-b", sparkId: "spark-b" })],
  };
  const recs = fromLegacyHistory("DecodeBench", decodeHistory, "bench-history.json");
  assertAllValid(recs);
  assertNamedDefinitions(recs);
  let waves = 0;
  for (const [sparkId, jobs] of Object.entries(decodeHistory)) {
    for (const job of jobs) {
      for (const wave of job.results) {
        waves++;
        const rec = recs.find((r) => r.id === `decode:${job.benchId}:c${wave.concurrency}`);
        assert.ok(rec, `${job.benchId} c${wave.concurrency}`);
        assert.deepEqual(rec.raw.wave, wave, "wave kept verbatim");
        const { results: _drop, ...jobRest } = job;
        assert.deepEqual(rec.raw.job, jobRest, "job fields kept verbatim");
        assert.deepEqual(rec.run.imported_from, { file: "bench-history.json", key: sparkId });
        assert.equal(rec.host.node_id, sparkId);
        assert.equal(byMetric(rec, "decode_tps_stream").value, wave.meanDecodeTps);
        assert.equal(byMetric(rec, "agg_window_tps").value, wave.aggregateDecodeTps);
      }
    }
  }
  assert.equal(recs.length, waves);

  const prefill = fromLegacyHistory("PrefillBench", { "spark-a": [prefillJob()] }, "prefill-bench-history.json");
  assertAllValid(prefill);
  assert.equal(prefill.length, 2);
  prefillJob().results.forEach((point, i) => {
    assert.deepEqual(prefill[i].raw.point, point);
    assert.equal(byMetric(prefill[i], "prefill_tps").value, point.prefillTps);
  });

  const show = fromLegacyHistory("Showcase", { "spark-a": [showcaseRecord(), showcaseRecord({ sessionId: "sess-2" })] }, "showcase-history.json");
  assertAllValid(show);
  assert.deepEqual(show.map((r) => r.id), ["showcase:sess-1", "showcase:sess-2"]);
  const orig = showcaseRecord();
  for (const k of ["serverGenerationTps", "serverGenerationTpsMax", "totalTokens", "meanDecodeTps", "peakStreamTps", "streamCount"]) {
    assert.equal(show[0].raw[k], orig[k], k);
  }
});

test("legacy entries without sparkId take it from the history key; junk is ignored", () => {
  const job = decodeJob();
  delete job.sparkId;
  const recs = fromLegacyHistory("DecodeBench", { "spark-z": [job, null, { nope: 1 }], bad: "x" }, "bench-history.json");
  assert.equal(recs.length, 2);
  assert.equal(recs[0].host.node_id, "spark-z");
  assert.deepEqual(fromLegacyHistory("DecodeBench", null, "f"), []);
  assert.deepEqual(fromLegacyHistory("DecodeBench", [], "f"), []);
});
