import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fromAeonPodRun, slimPodRun, BOARD_STATUSES } from "../importer.js";
import { validateResult } from "../../results/schema.js";
import { provenance } from "../../results/__tests__/fixtures.js";

// Real pod runs (AEON Bench Pod 20e87a0, --target against Herd's demo lane),
// slimmed with slimPodRun. The demo lane answers filler, so text scores are 0.
const load = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const lane = (over = {}) => provenance({ lane: { ...provenance().lane, model_id: "Qwen3-30B-A3B-FP8", ...over } });

function assertValid(records) {
  for (const r of records) {
    const v = validateResult(r);
    assert.ok(v.ok, `${r.id}: ${v.errors.join("; ")}`);
  }
}

test("perf run → aeon-perf-v1 cells matching Herd's AEON ladder", () => {
  const out = fromAeonPodRun(load("perf-v1-run.json"), { provenance: lane() });
  assertValid(out.records);
  assert.equal(out.bench, "AEONPodPerf");
  assert.equal(out.records.length, 12);
  assert.deepEqual(out.skipped, []);
  const c4 = out.records.find((r) => r.id === "aeon-pod:85994d5f23:perf.direct.overall.c4");
  assert.equal(c4.run.origin, "aeon-pod");
  assert.equal(c4.run.suite, "aeon-perf-v1");
  assert.equal(c4.run.suite_version, "1");
  assert.equal(c4.conditions.concurrency, 4);
  assert.equal(c4.conditions.max_tokens, 256);
  assert.equal(c4.conditions.prompt_set, "aeon-perf-v1/overall");
  assert.equal(c4.host.node_id, "spark-a");
  const agg = c4.metrics.find((m) => m.metric === "agg_window_tps");
  assert.equal(agg.definition, "aeon.wave_peak_concurrent_window.v1");
  assert.equal(agg.value, 855.84);
  // The pod's local mirror stamps perf runs "attested"; Herd keeps that as a claim only.
  assert.equal(c4.settings.aeon_pod.pod_trust_tier, "attested");
  assert.equal(c4.settings.aeon_pod.board_status, "not_submitted");
});

test("text suite → per-category + overall accuracy with case vectors", () => {
  const out = fromAeonPodRun(load("suite-v4-run.json"), { provenance: lane(), clientLocation: "network" });
  assertValid(out.records);
  assert.equal(out.bench, "AEONPodSuite");
  assert.deepEqual(
    out.records.map((r) => r.id.split(":").pop()),
    ["coding", "instruction", "math", "prose", "reasoning", "overall"]
  );
  const overall = out.records.at(-1);
  assert.equal(overall.run.suite, "aeon-suite-v4");
  assert.equal(overall.run.suite_version, "7cfb2aea7c9b7f74");
  assert.equal(overall.quality.items.length, 174);
  assert.equal(overall.metrics[0].definition, "aeon.suite_case_mean_score.v1");
  assert.equal(overall.metrics[0].value, 0);
  assert.equal(overall.metrics[0].n, 174);
  assert.equal(overall.conditions.max_tokens, 512);
  assert.equal(overall.conditions.concurrency, 8);
  assert.equal(overall.conditions.client_location, "network");
  assert.equal(overall.settings.aeon_pod.pod_trust_tier, "self_reported");
  assert.equal(out.records.find((r) => r.id.endsWith(":coding")).quality.items.length, 36);
});

test("partial credit, unscored cases and the pass threshold", () => {
  const run = {
    id: "abc123",
    model: "m",
    suite_id: "aeon-suite-v4",
    suite_hash: "h1",
    status: "succeeded",
    params_json: "{}",
    results: [
      { case_id: "a.1", category: "Math", score: 1 },
      { case_id: "a.2", category: "Math", score: 0.5 },
      { case_id: "a.3", category: "Math", score: 0.25 },
      { case_id: "a.4", category: "Math", status: "needs_frontier_judge", score: null },
    ],
  };
  const out = fromAeonPodRun(run, { provenance: lane({ model_id: "m" }) });
  assertValid(out.records);
  const math = out.records[0];
  assert.equal(math.metrics[0].value, 58.33);
  assert.equal(math.metrics[0].n, 3);
  assert.deepEqual(math.quality.items.map((x) => x.pass), [true, true, false, null]);
  assert.deepEqual(math.settings.unscored_by_status, { needs_frontier_judge: 1 });
});

test("agentic run → one record per harness; unsupported rows are skipped", () => {
  const agentic = fromAeonPodRun(
    {
      id: "ag1",
      model: "m",
      suite_id: "aeon-agentic-v2.5",
      suite_hash: "h2",
      harness: "OpenCode",
      status: "succeeded",
      results: [
        { case_id: "t1", category: "Agentic", score: 1 },
        { case_id: "t2", category: "Agentic", score: 0 },
      ],
    },
    { provenance: lane({ model_id: "m" }) }
  );
  assertValid(agentic.records);
  assert.deepEqual(agentic.records.map((r) => r.id), ["aeon-pod:ag1:agentic.opencode"]);
  assert.equal(agentic.records[0].metrics[0].definition, "aeon.agentic_task_mean_score.v1");
  assert.equal(agentic.records[0].metrics[0].value, 50);

  const perf = load("perf-v1-run.json");
  perf.results.push({ case_id: "perf.sustained.tps_at_high_kv", category: "Performance", evidence: {} });
  const out = fromAeonPodRun(perf, { provenance: lane() });
  assert.equal(out.records.length, 12);
  assert.equal(out.skipped[0].case_id, "perf.sustained.tps_at_high_kv");
});

test("board status, model mismatch and bad input", () => {
  const run = load("perf-v1-run.json");
  assert.deepEqual(BOARD_STATUSES, ["not_submitted", "self_reported", "attested"]);
  assert.throws(() => fromAeonPodRun(run, { boardStatus: "attested" }), /needs board_url/);
  assert.throws(() => fromAeonPodRun(run, { boardStatus: "self_reported", boardUrl: "http://x" }), /https/);
  assert.throws(() => fromAeonPodRun(run, { boardStatus: "verified" }), /board_status/);
  const att = fromAeonPodRun(run, { provenance: lane(), boardStatus: "attested", boardUrl: "https://aeon-bench.com/run/x" });
  assert.equal(att.records[0].run.reference_url, "https://aeon-bench.com/run/x");
  assert.equal(att.records[0].settings.aeon_pod.board_status, "attested");

  const other = fromAeonPodRun(run, { provenance: lane({ model_id: "Llama-3.3-70B" }) });
  assert.match(other.warnings[0], /lane now serves Llama-3.3-70B/);
  assert.equal(other.records[0].lane.model_id, "Qwen3-30B-A3B-FP8");
  assert.equal(other.records[0].lane.ctx_len, null);

  const prefixed = fromAeonPodRun(run, { provenance: lane({ model_id: "Qwen/qwen3-30b-a3b-fp8" }) });
  assert.deepEqual(prefixed.warnings, []);
  assert.equal(prefixed.records[0].lane.model_id, "Qwen/qwen3-30b-a3b-fp8");

  const anon = fromAeonPodRun(run, { podUrl: "http://pod:8091/" });
  assert.match(anon.warnings[0], /no Herd node/);
  assert.equal(anon.records[0].run.reference_url, "http://pod:8091/api/runs/85994d5f23");
  assertValid(anon.records);

  assert.throws(() => fromAeonPodRun(null), /pod run object/);
  assert.throws(() => fromAeonPodRun({ id: "x", results: [], suite_id: "aeon-vision-v1" }), /not imported/);
  assert.throws(() => fromAeonPodRun({ id: "../x", results: [] }), /run.id/);
  assert.throws(() => fromAeonPodRun({ id: "x", suite_id: "aeon-perf-v1", results: [] }), /no importable/);
});

test("slimPodRun drops outputs and text evidence, keeps perf evidence", () => {
  const slim = slimPodRun({
    id: "r",
    suite_id: "aeon-suite-v4",
    secret_extra: 1,
    results: [
      { case_id: "v4.math.1", category: "Math", score: 1, raw_output: "x".repeat(1000), evidence: { checkers: [] } },
      { case_id: "perf.direct.math.c1", category: "Performance", evidence: { n: 1 } },
    ],
  });
  assert.equal("secret_extra" in slim, false);
  assert.deepEqual(slim.results[0], { case_id: "v4.math.1", category: "Math", tier: null, status: null, score: 1 });
  assert.deepEqual(slim.results[1].evidence, { n: 1 });
});
