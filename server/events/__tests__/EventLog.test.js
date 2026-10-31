// EventLog behaviour the activity feed relies on (issue #32).
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { EventLog } from "../EventLog.js";

describe("EventLog for the activity feed", () => {
  test("a quick repeat of a unit's latest event is dropped; a different one is kept", () => {
    let t = 0;
    const log = new EventLog({ now: () => t });
    assert.ok(log.record({ type: "spark.offline", sparkId: "s1", message: "a went offline" }));
    t = 1_000;
    assert.equal(log.record({ type: "spark.offline", sparkId: "s1", message: "a went offline" }), null);
    assert.ok(log.record({ type: "spark.offline", sparkId: "s2", message: "b went offline" }), "other unit");
    t = 7_000;
    assert.ok(log.record({ type: "spark.offline", sparkId: "s1", message: "a went offline" }), "after the window");
    assert.equal(log.size(), 3);
  });

  test("bounded to max, keeping the newest", () => {
    const log = new EventLog({ max: 3 });
    for (let i = 0; i < 5; i++) log.record({ type: "x", sparkId: `s${i}`, message: `m${i}` });
    assert.deepEqual(log.list().map((e) => e.message), ["m4", "m3", "m2"]);
    assert.equal(log.oldestId(), 3);
    assert.equal(log.newestId(), 5);
  });

  test("types match exactly or by trailing-dot prefix; severities filter", () => {
    const log = new EventLog();
    log.record({ type: "gpu.throttle.start", severity: "warn", message: "1", sparkId: "a" });
    log.record({ type: "gpu", severity: "info", message: "2", sparkId: "b" });
    log.record({ type: "gpuish.x", severity: "info", message: "3", sparkId: "c" });
    assert.deepEqual(log.list({ types: ["gpu."] }).map((e) => e.message), ["1"]);
    assert.deepEqual(log.list({ types: ["gpu"] }).map((e) => e.message), ["2"]);
    assert.deepEqual(log.list({ severities: ["warn"] }).map((e) => e.message), ["1"]);
    assert.equal(log.list({ types: [], severities: [] }).length, 3);
  });

  test("subscribers see every accepted event; unsubscribe stops them", () => {
    const log = new EventLog();
    const seen = [];
    const off = log.subscribe((e) => seen.push(e.id));
    log.record({ type: "x", message: "1" });
    off();
    log.record({ type: "y", message: "2" });
    assert.deepEqual(seen, [1]);
  });

  test("persists across instances, continuing ids", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eventlog-"));
    const file = path.join(dir, "events.json");
    const a = new EventLog({ file });
    a.record({ type: "x", message: "1" });
    a.record({ type: "y", message: "2" });
    a.flush();
    const b = new EventLog({ file });
    assert.equal(b.size(), 2);
    assert.equal(b.record({ type: "z", message: "3" }).id, 3);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
