// AlertEngine (docs/specs/alerts.md §4): pending → firing → resolved, holds,
// grouping, escalation, reminders and restart. LIC1 clean-room rewrite.
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { AlertEngine, MIN_CLEAR_MS, STATE_MAX_AGE_MS } from "../engine.js";
import { RULES } from "../conditions.js";
import { makeUnit, manualClock, offlineUnit, silentLog, unitAt } from "./helpers.js";

/** An engine where only `enabledRules` (id → overrides) are switched on. */
function harness(enabledRules, { repeatIntervalMin = 0, start } = {}) {
  const rules = Object.fromEntries(RULES.map((r) => [r.id, { enabled: false }]));
  for (const [id, extra] of Object.entries(enabledRules)) rules[id] = { enabled: true, ...extra };
  const config = { repeatIntervalMin, rules, channels: [{ id: "ch", enabled: true }] };
  const groups = [];
  const saves = [];
  const now = manualClock(start);
  const engine = new AlertEngine({
    now,
    log: silentLog,
    getConfig: () => config,
    notifier: { dispatch: async (_channels, group) => void groups.push(group) },
    persistState: (state) => saves.push(state),
  });
  const run = (...units) => engine.evaluate(units);
  return { engine, config, groups, saves, now, run };
}

describe("firing", () => {
  test("pending for the rule's wait, then firing with one notification", () => {
    const h = harness({ thermal: { forSec: 120 } });
    const began = h.now();
    h.run(unitAt(86));
    assert.deepEqual(h.engine.pending().map((a) => a.key), ["spark-1:thermal"]);
    h.now.tick(119_000);
    h.run(unitAt(86));
    assert.equal(h.engine.active().length, 0);
    h.now.tick(1_000);
    h.run(unitAt(86));
    const [a] = h.engine.active();
    assert.equal(a.severity, "warning");
    assert.equal(a.label, "GPU is running hot");
    assert.equal(a.startsAt, began);
    assert.equal(h.groups.length, 1);
    h.now.tick(600_000);
    h.run(unitAt(86));
    assert.equal(h.groups.length, 1, "no repeats without reminders");
  });

  test("a condition that clears while pending is forgotten quietly", () => {
    const h = harness({ disk: { forSec: 300 } });
    const full = makeUnit({ metrics: { storage: [{ device: "/d", total: 1, percentage: 97 }] } });
    h.run(full);
    h.now.tick(100_000);
    h.run(makeUnit());
    h.now.tick(400_000);
    h.run(makeUnit());
    assert.equal(h.engine.pending().length, 0);
    assert.equal(h.groups.length, 0);
    assert.deepEqual(h.engine.recent(), []);
  });

  test("everything that fires in one pass goes out as one group", () => {
    const h = harness({ offline: { forSec: 30 }, llm: { forSec: 30 } });
    const a = offlineUnit("x", { id: "alpha", name: "alpha" });
    const b = makeUnit({ id: "beta", name: "beta", metrics: { llm: [{ available: false }] } });
    h.run(a, b);
    h.now.tick(30_000);
    h.run(a, b);
    assert.equal(h.groups.length, 1);
    assert.deepEqual(h.groups[0].firing.map((x) => x.key).sort(), ["alpha:offline", "beta:llm"]);
  });
});

describe("resolving", () => {
  test("short recoveries never resolve; a full wait of clear does, dated when it cleared", () => {
    const h = harness({ offline: { forSec: 90 } });
    h.run(offlineUnit());
    h.now.tick(90_000);
    h.run(offlineUnit());
    for (let i = 0; i < 4; i++) {
      h.now.tick(45_000);
      h.run(makeUnit());
      h.now.tick(45_000);
      h.run(offlineUnit());
    }
    assert.equal(h.groups.length, 1);
    h.now.tick(1_000);
    h.run(makeUnit());
    const clearedAt = h.now();
    h.now.tick(89_000);
    h.run(makeUnit());
    assert.equal(h.engine.active().length, 1);
    h.now.tick(1_000);
    h.run(makeUnit());
    assert.equal(h.engine.active().length, 0);
    const last = h.groups.at(-1);
    assert.equal(last.resolved[0].endsAt, clearedAt);
    assert.deepEqual(h.engine.recent().map((e) => e.status), ["resolved", "firing"]);
  });

  test("a zero wait still needs MIN_CLEAR_MS clear", () => {
    const h = harness({ xid: { forSec: 0 } });
    const bad = makeUnit({ health: [{ id: "xid", severity: "critical", title: "NVIDIA Xid error", detail: "d", hint: "" }] });
    h.run(bad);
    assert.equal(h.groups.length, 1);
    h.now.tick(1_000);
    h.run(makeUnit());
    h.now.tick(MIN_CLEAR_MS - 1);
    h.run(makeUnit());
    assert.equal(h.groups.length, 1);
    h.now.tick(1);
    h.run(makeUnit());
    assert.equal(h.groups.length, 2);
    assert.equal(h.groups[1].resolved[0].ruleId, "xid");
  });

  test("going offline holds the unit's other alerts", () => {
    const h = harness({ thermal: { forSec: 0 }, offline: { forSec: 0 } });
    h.run(unitAt(95));
    for (let i = 0; i < 3; i++) {
      h.now.tick(240_000);
      h.run(unitAt(95, { online: false, offlineReason: "timeout" }));
    }
    assert.deepEqual(h.engine.active().map((a) => a.ruleId).sort(), ["offline", "thermal"]);
    assert.equal(h.groups.some((g) => g.resolved.length > 0), false);
  });

  test("switching a rule off or removing a unit ends its alerts with a reason", () => {
    const h = harness({ thermal: { forSec: 0 }, offline: { forSec: 0 } });
    const other = offlineUnit("x", { id: "other", name: "other" });
    h.run(unitAt(95), other);
    h.config.rules.thermal = { enabled: false };
    h.now.tick(5_000);
    h.run(unitAt(95), other);
    assert.deepEqual(h.engine.active().map((a) => a.key), ["other:offline"]);
    assert.match(h.groups.at(-1).resolved[0].summary, /rule turned off/);
    h.now.tick(5_000);
    h.run(unitAt(95));
    assert.deepEqual(h.engine.active(), []);
    assert.match(h.groups.at(-1).resolved[0].summary, /unit removed/);
  });
});

describe("severity", () => {
  test("escalation must hold for the wait and notifies once; stepping down is silent", () => {
    const h = harness({ thermal: { forSec: 40 } });
    h.run(unitAt(86));
    h.now.tick(40_000);
    h.run(unitAt(86));
    assert.equal(h.groups[0].firing[0].severity, "warning");
    h.now.tick(1_000);
    h.run(unitAt(95));
    h.now.tick(20_000);
    h.run(unitAt(95));
    assert.equal(h.groups.length, 1);
    h.now.tick(20_000);
    h.run(unitAt(95));
    assert.equal(h.groups.length, 2);
    assert.equal(h.groups[1].firing[0].severity, "critical");
    h.now.tick(50_000);
    h.run(unitAt(86));
    h.now.tick(50_000);
    h.run(unitAt(86));
    assert.equal(h.groups.length, 2);
    const [a] = h.engine.active();
    assert.deepEqual([a.severity, a.peakSeverity], ["warning", "critical"]);
  });
});

describe("reminders", () => {
  test("repeat at the interval and say they are reminders", () => {
    const h = harness({ offline: { forSec: 0 } }, { repeatIntervalMin: 30 });
    h.run(offlineUnit());
    h.now.tick(29 * 60_000);
    h.run(offlineUnit());
    assert.equal(h.groups.length, 1);
    h.now.tick(60_000);
    h.run(offlineUnit());
    assert.equal(h.groups.length, 2);
    assert.equal(h.groups[1].reminder, true);
    assert.equal(h.groups[1].firing.length, 1);
  });
});

describe("restart", () => {
  test("a recent saved firing set is adopted without notifying again", () => {
    const before = harness({ thermal: { forSec: 0 } });
    before.run(unitAt(95));
    const saved = before.saves.at(-1);
    assert.equal(saved.firing.length, 1);

    const after = harness({ thermal: { forSec: 0 } }, { start: before.now() + 30_000 });
    assert.equal(after.engine.restore(saved), 1);
    after.run(unitAt(95));
    assert.equal(after.groups.length, 0);
    assert.equal(after.engine.active()[0].startsAt, before.now());
  });

  test("an old or future-dated save is ignored", () => {
    const before = harness({ thermal: { forSec: 0 } });
    before.run(unitAt(95));
    const saved = before.saves.at(-1);
    const late = harness({}, { start: saved.savedAt + STATE_MAX_AGE_MS + 1 });
    assert.equal(late.engine.restore(saved), 0);
    const early = harness({}, { start: saved.savedAt - 1 });
    assert.equal(early.engine.restore(saved), 0);
    assert.equal(early.engine.restore(null), 0);
  });

  test("reset forgets live alerts but keeps history", () => {
    const h = harness({ offline: { forSec: 0 } });
    h.run(offlineUnit());
    h.engine.reset();
    assert.deepEqual(h.engine.active(), []);
    assert.equal(h.engine.recent().length, 1);
  });
});

test("names and summaries are capped", () => {
  const h = harness({ offline: { forSec: 0 } });
  h.run(offlineUnit("q".repeat(400), { name: "w".repeat(400) }));
  const [a] = h.engine.active();
  assert.ok([...a.unitName].length <= 60);
  assert.ok([...a.summary].length <= 120);
});
