import { test } from "node:test";
import assert from "node:assert/strict";
import { llmEndpoint } from "../../collectors/LlmStreaming.js";
import { activity } from "../../events/activity.js";
import { fromFleetShowcaseSession } from "../../bench/results/adapters.js";
import { validateResult } from "../../bench/results/schema.js";
import { getDefinition } from "../../bench/results/definitions.js";
import { createResultsRecorder } from "../../bench/results/recorder.js";

test("llmEndpoint builds base and chat URLs for any (host, port)", () => {
  assert.deepEqual(llmEndpoint({ host: "10.0.0.5", port: 8000, apiKey: " " }), {
    host: "10.0.0.5",
    port: 8000,
    tls: false,
    apiKey: null,
    baseUrl: "http://10.0.0.5:8000",
    chatUrl: "http://10.0.0.5:8000/v1/chat/completions",
  });
  assert.equal(llmEndpoint({ host: "fe80::1", port: 11434 }).baseUrl, "http://[fe80::1]:11434");
  assert.equal(llmEndpoint({ host: "gw.example", port: 443, tls: true, apiKey: "k" }).baseUrl, "https://gw.example");
  assert.equal(llmEndpoint({ host: "gw.example", port: 443, tls: true, apiKey: "k" }).apiKey, "k");
  assert.throws(() => llmEndpoint({ host: "", port: 1 }), /host/);
  assert.throws(() => llmEndpoint({ host: "h", port: 0 }), /port/);
});

test("activity.fleetShowcase lifecycle events are fleet-wide", () => {
  const s = (status) => ({ sessionId: "x", status, lanes: [{ nodeName: "a", port: 1 }, { nodeName: "b", port: 2 }], error: "boom" });
  const e = activity.fleetShowcase(s("running"));
  assert.equal(e.type, "fleet.showcase.started");
  assert.equal(e.sparkId, null);
  assert.equal(e.message, "Fleet showcase started on 2 lanes");
  assert.deepEqual(e.data.lanes, ["a:1", "b:2"]);
  assert.equal(activity.fleetShowcase(s("completed")).severity, "success");
  assert.equal(activity.fleetShowcase(s("cancelled")).type, "fleet.showcase.cancelled");
  assert.match(activity.fleetShowcase(s("error")).message, /boom/);
});

const session = () => ({
  sessionId: "sid",
  status: "completed",
  startedAt: Date.parse("2026-10-31T08:00:00Z"),
  completedAt: Date.parse("2026-10-31T08:00:30Z"),
  maxTokens: 512,
  temperature: 0.7,
  thinking: false,
  promptType: "structural",
  prompts: ["a", "b"],
  lanes: [
    {
      laneId: "spark:s1:8000", kind: "spark", nodeId: "s1", nodeName: "spark-1", port: 8000, modelId: "qwen", backend: "vllm",
      via: "lan", status: "completed", clientTps: 90, serverTps: 88.5, serverSamples: 12, tokenSource: "usage", serverEngine: "vllm",
      streams: [
        { status: "completed", decodeTps: 45, ttftMs: 100, prefillTps: 900, tokenSource: "usage", promptTokenSource: "usage", content: "x".repeat(10) },
        { status: "completed", decodeTps: 47, ttftMs: 120, prefillTps: 800, tokenSource: "usage", promptTokenSource: "usage", content: "y" },
      ],
    },
    { laneId: "node:n1:1", kind: "node", nodeId: "n1", nodeName: "agent", port: 1, status: "pending", streams: [] },
  ],
});

test("fromFleetShowcaseSession: one Showcase row per run lane, provenance per lane", () => {
  const rows = fromFleetShowcaseSession(session(), {
    provenance: { lanes: { "spark:s1:8000": { host: { node_id: "s1", node_name: "Spark One", hw_bucket: "gb10x1" }, lane: { engine: "vllm", model_id: "qwen" }, client_location: "network" } } },
  });
  assert.equal(rows.length, 1, "lanes that never started are skipped");
  const r = rows[0];
  assert.deepEqual(validateResult(r).errors, []);
  assert.equal(r.id, "fleet-showcase:sid:spark:s1:8000");
  assert.equal(r.run.run_id, "fleet-showcase:sid");
  assert.equal(r.run.bench, "Showcase");
  assert.equal(r.run.suite, "herd.showcase.fleet");
  assert.equal(r.host.node_name, "Spark One");
  assert.equal(r.conditions.concurrency, 2);
  assert.equal(r.conditions.prompt_set, "showcase/structural");
  assert.equal(r.settings.source, "showcase");
  assert.equal(r.settings.via, "lan");
  const m = Object.fromEntries(r.metrics.map((x) => [x.metric, x]));
  assert.equal(m.decode_tps_stream.value, 46);
  assert.equal(m.decode_tps_stream.approximate, false);
  assert.equal(m.agg_window_tps.value, 90);
  assert.equal(m.agg_window_tps.definition, "herd.showcase.agg_window.v1", "usage-only lanes share DecodeBench's comparable");
  assert.equal(m.agg_window_tps.approximate, false);
  assert.equal(r.settings.tokens_estimated, false);
  assert.equal(m.server_generation_tps.value, 88.5);
  assert.equal(m.prefill_tps.value, 850);
  assert.equal(m.ttft_p50.value, 110);
  assert.equal(JSON.stringify(r.raw).includes("xxxxxxxxxx"), false, "stream text is not stored in bench rows");
  for (const x of r.metrics) assert.ok(getDefinition(x.definition), x.definition);
});

test("recorder writes FleetShowcase rows through the shared store", () => {
  const saved = [];
  const store = { upsertMany: (recs) => { saved.push(...recs); return { added: recs.length, updated: 0, rejected: [] }; } };
  const recorder = createResultsRecorder({ store, log: () => {} });
  recorder.noteStart("FleetShowcase", "sid", { lanes: {} });
  recorder.sinkFor("FleetShowcase")(session());
  assert.equal(saved.length, 1);
  assert.equal(saved[0].settings.source, "showcase");
});
