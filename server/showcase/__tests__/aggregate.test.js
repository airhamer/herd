import { test } from "node:test";
import assert from "node:assert/strict";
import { AggregatePeak, aggregateView, concurrentWindow, sampleDue, PEAK_MIN_WINDOW_MS } from "../aggregate.js";

const ok = (tFirst, tLast, tokens, extra = {}) => ({ tFirst, tLast, tokens, status: "completed", ...extra });

test("overlapping streams: Σ decode tokens over the shared window, not a sum of rates", () => {
  // Three streams fully overlapping over 2 s, 201 tokens each → 200 decode tokens each.
  const agg = concurrentWindow([ok(1000, 3000, 201), ok(1000, 3000, 201), ok(1000, 3000, 201)]);
  assert.equal(agg.tps, 300);
  assert.equal(agg.decodeTokens, 600);
  assert.equal(agg.totalTokens, 603);
  assert.equal(agg.windowMs, 2000);
  assert.equal(agg.streams, 3);
  assert.equal(agg.estimated, false);
  // Partially overlapping: window spans min first → max last.
  const part = concurrentWindow([ok(0, 2000, 101), ok(1000, 3000, 101)]);
  assert.equal(part.windowMs, 3000);
  assert.equal(part.tps, 66.67);
});

test("staggered streams: gaps between streams stay in the window", () => {
  // Back-to-back streams each at 100 tok/s alone; the wave aggregate is still 100, not 200.
  const back = concurrentWindow([ok(0, 1000, 101), ok(1000, 2000, 101)]);
  assert.equal(back.tps, 100);
  // A late straggler with an idle gap lowers the aggregate (idle time counts).
  const gap = concurrentWindow([ok(0, 1000, 101), ok(3000, 4000, 101)]);
  assert.equal(gap.windowMs, 4000);
  assert.equal(gap.tps, 50);
  // Order of input does not matter.
  assert.deepEqual(concurrentWindow([ok(3000, 4000, 101), ok(0, 1000, 101)]), gap);
});

test("only streams that produced tokens and did not fail count", () => {
  const agg = concurrentWindow([
    ok(0, 1000, 101),
    { tFirst: 0, tLast: 5000, tokens: 500, status: "error" },
    { tFirst: 0, tLast: 5000, tokens: 500, status: "cancelled" },
    { tFirst: null, tLast: null, tokens: 0, status: "pending" },
    { tFirst: 0, tLast: null, tokens: 3, status: "streaming" },
    ok(0, 1000, 0),
  ]);
  assert.equal(agg.streams, 1);
  assert.equal(agg.tps, 100);
  const empty = concurrentWindow([]);
  assert.equal(empty.tps, null);
  assert.equal(empty.tFirst, null);
  assert.equal(concurrentWindow([ok(5, 5, 1)]).tps, null, "a zero-length window has no rate");
  // Live streams count (with their t_last so far).
  assert.equal(concurrentWindow([{ tFirst: 0, tLast: 500, tokens: 51, status: "streaming" }]).tps, 100);
});

test("estimated: any counted stream with character-estimated tokens flags the aggregate", () => {
  assert.equal(concurrentWindow([ok(0, 1000, 11), ok(0, 1000, 11, { estimated: true })]).estimated, true);
  assert.equal(concurrentWindow([ok(0, 1000, 11), { ...ok(0, 1000, 11, { estimated: true }), status: "error" }]).estimated, false);
});

test("peak: samples need a minimum window; the final value always counts", () => {
  const p = new AggregatePeak();
  assert.equal(p.observe({ tps: 900, windowMs: PEAK_MIN_WINDOW_MS - 1 }), null, "short windows are noise");
  assert.equal(p.observe({ tps: 120, windowMs: 1500 }), 120);
  assert.equal(p.observe({ tps: 150, windowMs: 2000 }), 150);
  assert.equal(p.observe({ tps: 140, windowMs: 2500 }), 150);
  assert.equal(p.observe({ tps: null, windowMs: 3000 }), 150);
  assert.equal(p.final({ tps: 130, windowMs: 3000 }), 150, "peak ≥ final");
  const short = new AggregatePeak();
  assert.equal(short.final({ tps: 80, windowMs: 200 }), 80, "short waves still get a peak");
  const viewPeak = new AggregatePeak();
  viewPeak.final({ tps: 120, windowMs: 1000 });
  assert.deepEqual(aggregateView(concurrentWindow([ok(0, 1000, 101)]), viewPeak), {
    tps: 100, peakTps: 120, peakEstimated: false, estimated: false, decodeTokens: 100, windowMs: 1000, streams: 1,
  });
  assert.equal(aggregateView(concurrentWindow([]), null).peakTps, null);
});

test("peak taken from live character-estimated counts is flagged even if the final counts are exact", () => {
  const p = new AggregatePeak();
  p.observe({ tps: 200, windowMs: 1500, estimated: true }); // live sample
  p.final({ tps: 180, windowMs: 3000, estimated: false }); // usage arrived
  assert.equal(p.peak, 200);
  assert.equal(p.estimated, true);
  assert.equal(aggregateView(concurrentWindow([ok(0, 3000, 541)]), p).peakEstimated, true);
  const q = new AggregatePeak();
  q.observe({ tps: 150, windowMs: 1500, estimated: true });
  q.final({ tps: 180, windowMs: 3000, estimated: false });
  assert.equal(q.estimated, false, "an exact final above every live sample is the peak");
});

test("sampleDue throttles per holder", () => {
  const h = {};
  assert.equal(sampleDue(h, 0, 100), true);
  assert.equal(sampleDue(h, 50, 100), false);
  assert.equal(sampleDue(h, 100, 100), true);
});
