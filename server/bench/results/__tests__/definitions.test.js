import { test } from "node:test";
import assert from "node:assert/strict";
import {
  METRICS,
  SOURCES,
  DEFINITIONS,
  getDefinition,
  listDefinitions,
  definitionsComparable,
} from "../definitions.js";

test("every definition names a known metric, has a versioned name and a formula", () => {
  for (const d of listDefinitions()) {
    assert.ok(METRICS[d.metric], `${d.name}: unknown metric ${d.metric}`);
    assert.match(d.name, /^[a-z0-9_-]+(\.[a-z0-9_-]+)+\.v\d+$/, d.name);
    assert.ok(d.formula.length > 20, `${d.name}: formula too short`);
    assert.ok(d.comparable, `${d.name}: no comparable group`);
    assert.equal(d.unit, METRICS[d.metric].unit);
  }
  assert.equal(listDefinitions().length, Object.keys(DEFINITIONS).length, "names are unique");
});

test("the four published 'aggregate tok/s' definitions are registered by name", () => {
  for (const name of [
    "sparkdash.agg_window.v1",
    "aeon.wave_peak_concurrent_window.v1",
    "aeon.agg_saturated_est.v1",
    "mia.agg_sum_per_request.v1",
    "hasso.single_stream_greedy_median.v1",
  ]) {
    assert.ok(getDefinition(name), name);
  }
});

test("window and sum-of-streams aggregates never compare", () => {
  assert.equal(definitionsComparable("herd.decode.agg_window.v1", "sparkdash.agg_window.v1"), true);
  assert.equal(definitionsComparable("herd.decode.agg_window.v1", "aeon.wave_peak_concurrent_window.v1"), true);
  assert.equal(definitionsComparable("mia.agg_sum_per_request.v1", "aeon.agg_saturated_est.v1"), true);
  assert.equal(definitionsComparable("herd.decode.agg_sum.v1", "mia.agg_sum_per_request.v1"), true);
  assert.equal(definitionsComparable("herd.decode.agg_window.v1", "mia.agg_sum_per_request.v1"), false);
  assert.equal(definitionsComparable("aeon.wave_peak_concurrent_window.v1", "aeon.agg_saturated_est.v1"), false);
});

test("single-stream greedy median and Showcase estimates do not compare with DecodeBench means", () => {
  assert.equal(definitionsComparable("herd.decode.stream_mean.v1", "hasso.single_stream_greedy_median.v1"), false);
  assert.equal(definitionsComparable("herd.decode.stream_mean.v1", "herd.showcase.stream_mean_estimated.v1"), false);
  assert.equal(definitionsComparable("herd.prefill.single_request.v1", "herd.decode.prefill_window.v1"), false);
});

test("unknown names are never comparable and lookups do not reach the prototype", () => {
  assert.equal(definitionsComparable("nope.v1", "nope.v1"), false);
  assert.equal(getDefinition("toString"), null);
  assert.equal(getDefinition("__proto__"), null);
});

test("source tiers follow Page §3", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, v.tier])),
    { counter: 1, native: 2, proxy: 3, client: 4, reference: null }
  );
});
