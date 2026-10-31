import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  makeResult,
  makeMetricRow,
  validateResult,
  compareResults,
  incomparabilityReasons,
  comparabilityKey,
  RUN_FIELDS,
  HOST_FIELDS,
  LANE_FIELDS,
  CONDITION_FIELDS,
  METRIC_ROW_FIELDS,
} from "../schema.js";
import { fromDecodeJob } from "../adapters.js";
import { decodeJob, provenance, referenceRecord } from "./fixtures.js";

const herd = () => fromDecodeJob(decodeJob(), { provenance: provenance() })[1]; // c=4
const ref = () => makeResult(referenceRecord());

function errorsOf(rec) {
  return validateResult(rec).errors.join("\n");
}

test("makeResult fills every schema field, unknowns as null", () => {
  const r = makeResult({});
  assert.equal(r.schema_version, SCHEMA_VERSION);
  for (const [section, fields] of [["run", RUN_FIELDS], ["host", HOST_FIELDS], ["lane", LANE_FIELDS], ["conditions", CONDITION_FIELDS]]) {
    assert.deepEqual(Object.keys(r[section]).sort(), [...fields].sort());
    for (const f of fields) assert.equal(r[section][f], null, `${section}.${f}`);
  }
});

test("makeMetricRow derives unit, tier and validity", () => {
  const row = makeMetricRow({ metric: "ttft_p50", value: 120, source: "client", definition: "herd.ttft.client_first_token.v1" });
  assert.deepEqual(Object.keys(row).sort(), [...METRIC_ROW_FIELDS].sort());
  assert.equal(row.unit, "ms");
  assert.equal(row.tier, 4);
  assert.equal(row.valid, true);
  assert.equal(row.approximate, false);
  const missing = makeMetricRow({ metric: "ttft_p50", value: null, source: "client", definition: "herd.ttft.client_first_token.v1" });
  assert.equal(missing.valid, false);
});

test("herd and reference fixtures validate", () => {
  assert.deepEqual(validateResult(herd()).errors, []);
  assert.deepEqual(validateResult(ref()).errors, []);
});

test("missing and extra fields are rejected", () => {
  const r = herd();
  delete r.lane.quant;
  r.host.colour = "green";
  const e = errorsOf(r);
  assert.match(e, /lane\.quant is missing/);
  assert.match(e, /host\.colour is not a schema field/);
});

test("every metric row must carry a registered definition for its own metric", () => {
  const r = herd();
  r.metrics[0].definition = null;
  assert.match(errorsOf(r), /must name a registered definition/);
  const r2 = herd();
  r2.metrics[0].definition = "herd.decode.agg_window.v1"; // row 0 is decode_tps_stream
  assert.match(errorsOf(r2), /defines agg_window_tps, not decode_tps_stream/);
});

test("unit and tier must match the metric and source", () => {
  const r = herd();
  r.metrics[0].unit = "tokens/s";
  r.metrics[0].tier = 1;
  const e = errorsOf(r);
  assert.match(e, /unit must be "tok\/s"/);
  assert.match(e, /tier must be 4 for source client/);
});

test("origins: references need a URL and reference sources; herd needs node_id and no reference rows", () => {
  const r = ref();
  r.run.reference_url = null;
  r.metrics[0].source = "client";
  r.metrics[0].tier = 4;
  const e = errorsOf(r);
  assert.match(e, /reference_url is required/);
  assert.match(e, /source must be "reference"/);

  const h = herd();
  h.host.node_id = null;
  h.metrics[0].source = "reference";
  h.metrics[0].tier = null;
  const e2 = errorsOf(h);
  assert.match(e2, /node_id is required/);
  assert.match(e2, /not allowed on herd results/);
});

test("unmeasured is null and invalid, never a valid null; CI must bracket the value", () => {
  const r = herd();
  r.metrics[0].value = null;
  r.metrics[0].valid = true;
  assert.match(errorsOf(r), /valid must be false when value is null/);
  const r2 = herd();
  r2.metrics[0].ci_low = r2.metrics[0].value + 1;
  assert.match(errorsOf(r2), /ci_low exceeds value/);
  const r3 = herd();
  r3.metrics = [];
  assert.match(errorsOf(r3), /non-empty array/);
});

test("quality vectors need unique ids and boolean/null pass", () => {
  const r = herd();
  r.quality = { items: [{ id: "q1", pass: true }, { id: "q1", pass: false }, { id: "q3", pass: "yes" }] };
  const e = errorsOf(r);
  assert.match(e, /"q1" is duplicated/);
  assert.match(e, /quality\.items\[2\]/);
  r.quality = { items: [{ id: "q1", pass: true }, { id: "q2", pass: null }] };
  assert.deepEqual(validateResult(r).errors, []);
});

test("type checks on conditions and dates", () => {
  const r = herd();
  r.conditions.client_location = "moon";
  r.conditions.concurrency = 0;
  r.run.started_at = "yesterday";
  const e = errorsOf(r);
  assert.match(e, /client_location/);
  assert.match(e, /concurrency must be a positive integer/);
  assert.match(e, /started_at must be an ISO date/);
});

test("compare: like-with-like across origins, deltas follow the metric's direction", () => {
  const out = compareResults(ref(), herd());
  assert.equal(out.comparable, true);
  const win = out.rows.find((r) => r.metric === "agg_window_tps");
  assert.equal(win.baseline, 188.4);
  assert.equal(win.candidate, 180.5);
  assert.equal(win.improved, false);
  assert.equal(win.baseline_definition, "aeon.wave_peak_concurrent_window.v1");
  assert.equal(win.candidate_definition, "herd.decode.agg_window.v1");
  const sum = out.rows.find((r) => r.metric === "agg_sum_tps");
  assert.equal(sum.baseline, 66.66);
  assert.deepEqual(out.refused, []);
});

test("compare refuses mismatched definitions per metric", () => {
  // Published single-stream greedy median vs DecodeBench's per-stream mean.
  const baseline = ref();
  baseline.metrics = [
    makeMetricRow({ metric: "decode_tps_stream", value: 30, source: "reference", definition: "hasso.single_stream_greedy_median.v1" }),
    makeMetricRow({ metric: "agg_window_tps", value: 188.4, source: "reference", definition: "aeon.wave_peak_concurrent_window.v1" }),
  ];
  const out = compareResults(baseline, herd());
  assert.equal(out.comparable, true);
  assert.deepEqual(out.rows.map((r) => r.metric), ["agg_window_tps"]);
  assert.equal(out.refused.length, 1);
  assert.equal(out.refused[0].metric, "decode_tps_stream");
  assert.equal(out.refused[0].baseline_definition, "hasso.single_stream_greedy_median.v1");
  assert.deepEqual(out.refused[0].candidate_definitions, ["herd.decode.stream_mean.v1"]);
});

test("compare refuses different hardware buckets, suites and conditions with reasons", () => {
  const a = herd();
  const b = herd();
  b.host.hw_bucket = "2× DGX Spark";
  b.run.suite_version = "2";
  b.conditions.concurrency = 8;
  b.conditions.client_location = "network";
  const out = compareResults(a, b);
  assert.equal(out.comparable, false);
  assert.deepEqual(out.rows, []);
  const text = out.reasons.join("\n");
  assert.match(text, /hw_bucket differs/);
  assert.match(text, /suite_version differs/);
  assert.match(text, /conditions\.concurrency differs \(4 vs 8\)/);
  assert.match(text, /conditions\.client_location differs/);
  assert.notEqual(comparabilityKey(a), comparabilityKey(b));
});

test("unknown hardware is never assumed equal", () => {
  const a = herd();
  const b = herd();
  a.host.hw_bucket = null;
  b.host.hw_bucket = null;
  assert.match(incomparabilityReasons(a, b).join(), /hw_bucket unknown/);
});

test("lower-is-better metrics report improvement on decrease", () => {
  const a = herd();
  const b = herd();
  const t = b.metrics.find((m) => m.metric === "ttft_p50");
  t.value = 50;
  const row = compareResults(a, b).rows.find((r) => r.metric === "ttft_p50");
  assert.equal(row.improved, true);
  assert.ok(row.delta < 0);
});

test("compare adds exact McNemar only when both sides carry item vectors", () => {
  assert.equal(compareResults(herd(), herd()).quality, null);
  const a = herd();
  const b = herd();
  a.quality = { items: Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, pass: i < 2 })) };
  b.quality = { items: Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, pass: true })) };
  const out = compareResults(a, b);
  assert.equal(out.quality.paired, 12);
  assert.equal(out.quality.candidate_only, 10);
  assert.equal(out.quality.within_noise, false);
  b.run.suite_version = "9";
  assert.equal(compareResults(a, b).quality, null);
});
