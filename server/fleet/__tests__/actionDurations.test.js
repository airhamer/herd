// SC5b (#73): component action durations and the ETA source switch at 5 runs.
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BOOTSTRAP_ETA_MS, createDurationStore, etaFrom, median } from "../actionDurations.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "herd-durations-")), "d.json");
const run = (ms, success = true, type = "start") => ({ componentId: "c", nodeId: "n", type, ms, success });

describe("ETA", () => {
  test("bootstrap estimate below 5 successful runs, median of the last 5 from then on", () => {
    const entries = [];
    for (const ms of [60_000, 70_000, 80_000, 90_000]) entries.push(run(ms));
    assert.deepEqual(etaFrom(entries, "c", "start"), { ms: 120_000, source: "estimate", runs: 4 });
    entries.push(run(100_000));
    assert.deepEqual(etaFrom(entries, "c", "start"), { ms: 80_000, source: "history", runs: 5 });
    entries.push(run(10_000));
    // last five: 70 80 90 100 10 → median 80
    assert.equal(etaFrom(entries, "c", "start").ms, 80_000);
  });

  test("failed runs are excluded from the ETA", () => {
    const entries = [run(1, false), run(1, false), run(1, false), run(1, false), run(50_000), run(50_000)];
    assert.equal(etaFrom(entries, "c", "start").source, "estimate");
    assert.equal(etaFrom(entries, "c", "start").runs, 2);
  });

  test("bootstrap values per verb", () => {
    assert.equal(etaFrom([], "c", "stop").ms, BOOTSTRAP_ETA_MS.stop);
    assert.equal(BOOTSTRAP_ETA_MS.start, 120_000);
    assert.equal(BOOTSTRAP_ETA_MS.stop, 20_000);
  });

  test("median", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 3);
  });
});

describe("createDurationStore", () => {
  test("begin/end records the elapsed time, logs failures, and persists", () => {
    let t = 1_000;
    const file = tmp();
    const store = createDurationStore({ path: file, now: () => t });
    const k = store.begin({ componentId: "c", nodeId: "n", type: "start" });
    t += 5_000;
    assert.deepEqual(store.live().map((r) => [r.componentId, r.elapsedMs, r.etaMs]), [["c", 5_000, 120_000]]);
    store.end(k, true);
    const k2 = store.begin({ componentId: "c", nodeId: "n", type: "stop" });
    t += 1_000;
    store.end(k2, false);
    assert.deepEqual(store.live(), []);
    assert.deepEqual(store.list().map((e) => [e.type, e.ms, e.success]), [["start", 5_000, true], ["stop", 1_000, false]]);
    const again = createDurationStore({ path: file });
    assert.equal(again.list().length, 2);
  });

  test("an unreadable file degrades to empty with an error", () => {
    const file = tmp();
    fs.writeFileSync(file, "{nope");
    const store = createDurationStore({ path: file });
    assert.equal(store.list().length, 0);
    assert.match(store.errors[0], /unreadable/);
  });

  test("invalid entries are rejected", () => {
    const store = createDurationStore({ path: tmp() });
    assert.equal(store.record({ componentId: "", nodeId: "n", type: "start", ms: 1, success: true }), null);
    assert.equal(store.record({ componentId: "c", nodeId: "n", type: "nap", ms: 1, success: true }), null);
  });
});
