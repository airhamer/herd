// What alerts watch (docs/specs/alerts.md §2–3): Health findings exactly as
// HealthEvaluator raises them plus the Overview strip's exceptions.
// LIC1 clean-room rewrite.
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { RULES, collectConditions, effectiveRuleConfig, ruleById } from "../conditions.js";
import { fleetExceptions } from "../../../src/shared/fleetExceptions.js";
import { MAX_SUMMARY_CHARS, capText } from "../text.js";
import { healthFor, makeUnit, offlineUnit, unitAt } from "./helpers.js";

const pairs = (u) => collectConditions(u).conditions.map((c) => [c.ruleId, c.severity]);

describe("rule catalogue", () => {
  test("every rule has an id, a name, a source and defaults", () => {
    for (const rule of RULES) {
      assert.equal(typeof rule.name, "string");
      assert.ok(rule.source === "strip" || rule.source === "health", rule.id);
      assert.equal(typeof rule.defaults.enabled, "boolean");
      assert.ok(rule.defaults.forSec >= 0);
      assert.equal(ruleById(rule.id), rule);
    }
    assert.equal(ruleById("concurrency").defaults.enabled, false, "opt-in rule");
  });

  test("overrides apply per field; an unknown id is on with no wait", () => {
    assert.deepEqual(effectiveRuleConfig("disk", { disk: { forSec: 10 } }), { enabled: true, forSec: 10 });
    assert.deepEqual(effectiveRuleConfig("disk", { disk: { enabled: false } }).enabled, false);
    assert.deepEqual(effectiveRuleConfig("made-up"), { enabled: true, forSec: 0 });
  });
});

describe("Health findings", () => {
  test("GPU temperature thresholds are HealthEvaluator's", () => {
    assert.deepEqual(pairs(unitAt(80)), []);
    assert.deepEqual(pairs(unitAt(86)), [["thermal", "warning"]]);
    assert.deepEqual(pairs(unitAt(95)), [["thermal", "critical"]]);
    const [condition] = collectConditions(unitAt(95)).conditions;
    const [finding] = healthFor({ gpu: { temperature: 95 } });
    assert.equal(condition.label, finding.title);
    assert.equal(condition.summary, finding.detail);
  });

  test("unified memory: plenty is quiet, little warns, almost none is critical", () => {
    const withAvail = (mb) => makeUnit({ health: healthFor({ unifiedMemory: { total: 124_610, available: mb } }) });
    assert.deepEqual(pairs(withAvail(9_000)), []);
    assert.deepEqual(pairs(withAvail(2_500)), [["memory", "warning"]]);
    assert.deepEqual(pairs(withAvail(1_000)), [["memory", "critical"]]);
  });

  test("a finding id outside the catalogue is still reported under its own name", () => {
    const u = makeUnit({ health: [{ id: "future-check", severity: "critical", title: "Future check", detail: "x", hint: "" }] });
    const [c] = collectConditions(u).conditions;
    assert.deepEqual([c.ruleId, c.ruleName, c.severity], ["future-check", "Future check", "critical"]);
  });
});

describe("strip exceptions", () => {
  const cases = {
    offline: offlineUnit("ssh: no route to host"),
    throttle: makeUnit({
      metrics: {
        gpu: {
          temperature: 83,
          throttle: { active: true, reason: "hw", thermal: false, hwSlowdown: true, powerCap: false, detail: "HW slowdown", smClockMHz: 900, smClockPct: 35 },
        },
      },
    }),
    disk: makeUnit({ metrics: { storage: [{ device: "/dev/y", label: "/data", total: 10, used: 9.5, percentage: 95 }] } }),
    llm: makeUnit({ metrics: { llm: [{ available: false, error: "refused" }] } }),
    tailnet: makeUnit({ tailscaleMonitoring: true, metrics: { tailscale: { available: false } } }),
  };

  test("each kind maps to its rule, in the strip's order and severity", () => {
    assert.deepEqual(pairs(cases.offline), [["offline", "critical"]]);
    assert.deepEqual(pairs(cases.throttle), [["throttle", "critical"]]);
    assert.deepEqual(pairs(cases.disk), [["disk", "warning"]]);
    assert.deepEqual(pairs(cases.llm), [["llm", "warning"]]);
    assert.deepEqual(pairs(cases.tailnet), [["tailnet", "warning"]]);
    for (const u of Object.values(cases)) {
      assert.deepEqual(pairs(u), fleetExceptions(u).map((e) => [e.id, e.severity]));
    }
  });

  test("summaries carry the strip's detail", () => {
    assert.equal(collectConditions(cases.offline).conditions[0].summary, "Unreachable: ssh: no route to host");
    assert.equal(collectConditions(cases.throttle).conditions[0].summary, "HW slowdown · GPU at 83°C · SM clock 0.9 GHz (35% of max)");
  });

  test("LLM monitoring off means no LLM condition", () => {
    assert.deepEqual(pairs({ ...cases.llm, llmMonitoring: false }), []);
  });

  test("a software power cap alone is not an exception", () => {
    const capped = makeUnit({
      metrics: { gpu: { throttle: { active: true, reason: "power", thermal: false, hwSlowdown: false, powerCap: true, detail: "SW power cap", smClockPct: 60 } } },
    });
    assert.deepEqual(pairs(capped), []);
  });
});

describe("what gets judged", () => {
  test("online: every rule is judged", () => {
    const r = collectConditions(makeUnit());
    assert.deepEqual(r.conditions, []);
    for (const rule of RULES) assert.equal(r.judged(rule.id), true, rule.id);
  });

  test("offline with a reason: only `offline`, stale findings are left alone", () => {
    const r = collectConditions(unitAt(95, { online: false, offlineReason: "timeout" }));
    assert.deepEqual(r.conditions.map((c) => c.ruleId), ["offline"]);
    assert.equal(r.judged("offline"), true);
    assert.equal(r.judged("thermal"), false);
  });

  test("offline before the first check (no reason): nothing", () => {
    const r = collectConditions(offlineUnit(null));
    assert.deepEqual(r.conditions, []);
    assert.equal(r.judged("offline"), false);
  });
});

describe("text from remote hosts", () => {
  test("long reasons and finding text are capped and flattened", () => {
    const huge = "z".repeat(1000);
    const [down] = collectConditions(offlineUnit(huge)).conditions;
    assert.equal([...down.summary].length, MAX_SUMMARY_CHARS);
    assert.equal(down.summary.at(-1), "…");
    const finding = { id: "oom", severity: "warn", title: `OOM ${huge}`, detail: `first\nsecond ${huge}`, hint: "" };
    const [c] = collectConditions(makeUnit({ health: [finding] })).conditions;
    assert.ok([...c.label].length <= MAX_SUMMARY_CHARS);
    assert.ok([...c.summary].length <= MAX_SUMMARY_CHARS);
    assert.equal(c.summary.includes("\n"), false);
  });

  test("capText", () => {
    assert.equal(capText("one\ttwo\r\nthree"), "one two three");
    assert.equal(capText(undefined), "");
    assert.equal(capText("kept"), "kept");
    assert.equal(capText("123456789", 5), "1234…");
    assert.equal([...capText("😀".repeat(10), 4)].length, 4, "counts code points");
  });
});
