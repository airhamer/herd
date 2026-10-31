/**
 * Per-Spark Showcase (ShowcaseManager) concurrent-window aggregate and the
 * estimated-token flag (SHOW2, #40), against the fake SSE server.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ShowcaseManager } from "../../collectors/ShowcaseManager.js";
import { closeLlmStreamAgent } from "../../collectors/LlmStreaming.js";
import { fromShowcaseSession } from "../../bench/results/adapters.js";
import { validateResult } from "../../bench/results/schema.js";
import { getDefinition } from "../../bench/results/definitions.js";
import { startFakeLlm } from "./fakeLlm.js";

after(() => closeLlmStreamAgent());

async function runOnce(t, llmOpts, sparkId) {
  const llm = await startFakeLlm(llmOpts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showcase-agg-"));
  t.after(async () => {
    await llm.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const m = new ShowcaseManager(path.join(dir, "showcase-history.json"));
  t.after(() => m._heartbeatTimer && clearInterval(m._heartbeatTimer));
  const records = [];
  m.resultSink = (r) => records.push(r);
  const { sessionId } = m.start({ sparkId, lanIp: "127.0.0.1", port: llm.port, prompts: ["Write a table", "Write a poem", "Write a list"], maxTokens: 128 });
  let sawLive = false;
  for (let i = 0; i < 400 && m.getActive(sparkId); i += 1) {
    const live = m.getSession(sparkId, sessionId);
    if (live && !live.fromHistory && live.streams.some((s) => s.status === "streaming" && s.tokenCount > 0)) {
      // Live counts are character estimates until usage arrives.
      assert.ok(live.streams.filter((s) => s.status === "streaming" && s.tokenCount > 0).every((s) => s.estimated === true));
      assert.ok("aggregate" in live);
      sawLive = true;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(m.getActive(sparkId), null);
  assert.ok(sawLive, "polled while streaming");
  return { m, sessionId, records, rec: m.getSession(sparkId, sessionId) };
}

test("ShowcaseManager: usage-counted run gets an exact concurrent-window aggregate and peak", async (t) => {
  const { m, rec, records } = await runOnce(t, { chunks: 40, delayMs: 5, usage: true, metrics: false }, "agg-usage");
  assert.equal(rec.status, "completed");
  assert.ok(rec.streams.every((s) => s.tokenCount === 40 && s.tokenSource === "usage" && s.estimated === false));
  const agg = rec.aggregate;
  assert.equal(agg.estimated, false);
  assert.equal(agg.streams, 3);
  assert.equal(agg.decodeTokens, 3 * 39);
  assert.ok(agg.tps > 0 && agg.windowMs > 0);
  assert.ok(Math.abs(agg.tps - (agg.decodeTokens / agg.windowMs) * 1000) < 0.05, "Σ decode tokens / window");
  assert.ok(agg.peakTps >= agg.tps, "peak ≥ final");
  const [row] = m.getHistory("agg-usage");
  assert.equal(row.aggregateTps, agg.tps);
  assert.equal(row.aggregatePeakTps, agg.peakTps);
  assert.equal(row.aggregateEstimated, false);

  const [result] = fromShowcaseSession(records.at(-1));
  assert.deepEqual(validateResult(result).errors, []);
  const metric = result.metrics.find((x) => x.metric === "agg_window_tps");
  assert.equal(metric.definition, "herd.showcase.agg_window.v1");
  assert.equal(getDefinition(metric.definition).comparable, "agg_concurrent_window", "same comparable as DecodeBench");
  assert.equal(metric.approximate, false);
  assert.equal(result.settings.agg_peak_tps, agg.peakTps);
});

test("ShowcaseManager: no usage → tokens estimated from characters and flagged in data and bench rows", async (t) => {
  const { m, rec, records } = await runOnce(t, { chunks: 40, delayMs: 5, usage: false, metrics: false }, "agg-est");
  assert.equal(rec.status, "completed");
  assert.ok(rec.streams.every((s) => s.tokenSource === "estimate" && s.estimated === true));
  assert.equal(rec.aggregate.estimated, true);
  assert.ok(rec.aggregate.tps > 0);
  assert.equal(m.getHistory("agg-est")[0].aggregateEstimated, true);
  const [result] = fromShowcaseSession(records.at(-1));
  const metric = result.metrics.find((x) => x.metric === "agg_window_tps");
  assert.equal(metric.definition, "herd.showcase.agg_window_estimated.v1");
  assert.equal(metric.approximate, true);
  assert.equal(result.settings.tokens_estimated, true);
});

test("ShowcaseManager: records archived before SHOW2 have no aggregate", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showcase-agg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "h.json");
  const old = { sessionId: "old", sparkId: "s", status: "completed", port: 8000, streams: [{ streamId: "0", status: "completed", tokenCount: 10, decodeTps: 5 }] };
  fs.writeFileSync(file, JSON.stringify({ s: [old] }));
  const m = new ShowcaseManager(file);
  const [row] = m.getHistory("s");
  assert.equal(row.aggregateTps, null);
  assert.equal(row.aggregateEstimated, false);
  const [result] = fromShowcaseSession(old);
  assert.equal(result.metrics.find((x) => x.metric === "agg_window_tps"), undefined);
});
