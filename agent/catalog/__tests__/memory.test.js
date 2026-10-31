import test from "node:test";
import assert from "node:assert/strict";

import { computeMemoryBudget } from "../memory.js";

test("known-answer 1: enough free → no make-room", () => {
  const b = computeMemoryBudget(
    122880,
    70000,
    [{ name: "llm", footprintMB: 50000, running: true, needed: false }],
    40000
  );
  assert.equal(b.freeMB, 52880); // 122880 - 70000
  assert.equal(b.needMakeRoom, false);
  assert.deepEqual(b.makeRoom, []);
  assert.equal(b.servicesUsedMB, 50000);
  assert.equal(b.otherUsedMB, 20000); // 70000 - 50000
  assert.equal(b.totalMB, 122880);
  assert.equal(b.usedMB, 70000);
  assert.equal(b.services.length, 1);
  assert.equal(b.services[0].kind, "other"); // kind absent → default
  assert.ok(Number.isFinite(b.polledAt));
  assert.equal(b.nodeId, "unknown"); // default when no opts.nodeId
});

test("known-answer 2 (SPEC-ERROR FLAG): deficit → make-room plan", () => {
  // The Batch 1B task sheet listed makeRoom=[{serviceName:"tts",freesMB:5000}]
  // for these inputs. That plan CANNOT cover the deficit: freeMB=22880,
  // wantMB=40000 → deficit=17120, and stopping tts alone frees only 5000
  // (22880 + 5000 = 27880 < 40000). The task's own algorithm ("sort stoppable
  // by footprintMB desc, greedily add until deficit covered") selects "llm"
  // (50000 MB) first. Asserted against the algorithm; the spec line is
  // reported to the orchestrator as an error.
  const b = computeMemoryBudget(
    122880,
    100000,
    [
      { name: "llm", footprintMB: 50000, running: true, needed: false },
      { name: "tts", footprintMB: 5000, running: true, needed: false },
    ],
    40000
  );
  assert.equal(b.freeMB, 22880); // 122880 - 100000
  assert.equal(b.needMakeRoom, true);
  assert.deepEqual(b.makeRoom, [{ serviceName: "llm", freesMB: 50000, reason: "stoppable" }]);
});

test("make-room: small stoppable service covers a small deficit (tts case)", () => {
  // Same shape as known-answer 2, but llm is needed → only tts is stoppable,
  // and the deficit (1120) is covered by tts alone.
  const b = computeMemoryBudget(
    122880,
    100000,
    [
      { name: "llm", footprintMB: 50000, running: true, needed: true },
      { name: "tts", footprintMB: 5000, running: true, needed: false },
    ],
    24000
  );
  assert.equal(b.freeMB, 22880);
  assert.equal(b.needMakeRoom, true);
  assert.deepEqual(b.makeRoom, [{ serviceName: "tts", freesMB: 5000, reason: "stoppable" }]);
});

test("make-room: greedy multi-stop, largest first, until covered", () => {
  const b = computeMemoryBudget(
    100000,
    90000,
    [
      { name: "a", footprintMB: 3000, running: true, needed: false },
      { name: "b", footprintMB: 4000, running: true, needed: false },
      { name: "c", footprintMB: 1000, running: true, needed: false },
    ],
    20000
  );
  // freeMB=10000 → deficit=10000 → b(4000)+a(3000)+c(1000)=8000, not covered:
  // all stoppables are listed, largest first.
  assert.equal(b.needMakeRoom, true);
  assert.deepEqual(
    b.makeRoom.map((e) => e.serviceName),
    ["b", "a", "c"]
  );
  assert.deepEqual(b.makeRoom.map((e) => e.freesMB), [4000, 3000, 1000]);
});

test("boundary: freeMB == wantMB → no plan (>=, not >)", () => {
  const b = computeMemoryBudget(100, 60, [], 40);
  assert.equal(b.freeMB, 40);
  assert.equal(b.needMakeRoom, false);
  assert.deepEqual(b.makeRoom, []);
});

test("nothing stoppable → infeasible: needMakeRoom=true, makeRoom=[]", () => {
  const b = computeMemoryBudget(
    100,
    90,
    [
      { name: "llm", footprintMB: 50, running: true, needed: true }, // needed → not stoppable
      { name: "tts", footprintMB: 10, running: false, needed: false }, // stopped → not stoppable
    ],
    20
  );
  assert.equal(b.needMakeRoom, true);
  assert.deepEqual(b.makeRoom, []);
});

test("tie-break: equal footprints sorted by name (deterministic)", () => {
  const b = computeMemoryBudget(
    100,
    95,
    [
      { name: "zeta", footprintMB: 20, running: true, needed: false },
      { name: "alpha", footprintMB: 20, running: true, needed: false },
    ],
    30
  );
  assert.deepEqual(
    b.makeRoom.map((e) => e.serviceName),
    ["alpha", "zeta"]
  );
});

test("usedMB > totalMB: freeMB clamps to 0, no crash", () => {
  const b = computeMemoryBudget(
    100,
    150,
    [{ name: "x", footprintMB: 10, running: true, needed: false }],
    10
  );
  assert.equal(b.freeMB, 0);
  assert.equal(b.needMakeRoom, true);
  assert.equal(b.servicesUsedMB, 10);
  assert.equal(b.otherUsedMB, 140); // usedMB(150) - servicesUsedMB(10)
});

test("nodeId override (non-default knob)", () => {
  const b = computeMemoryBudget(100, 0, [], 10, { nodeId: "gx10-1c2c" });
  assert.equal(b.nodeId, "gx10-1c2c");
});

test("degenerate: all zeros → zeros, no plan", () => {
  const b = computeMemoryBudget(0, 0, [], 0);
  assert.equal(b.freeMB, 0);
  assert.equal(b.servicesUsedMB, 0);
  assert.equal(b.otherUsedMB, 0);
  assert.equal(b.needMakeRoom, false);
  assert.deepEqual(b.services, []);
  assert.deepEqual(b.makeRoom, []);
});

test("invalid inputs throw readable TypeErrors", () => {
  assert.throws(() => computeMemoryBudget(-1, 0, [], 0), /totalMB/);
  assert.throws(() => computeMemoryBudget(100, NaN, [], 0), /usedMB/);
  assert.throws(() => computeMemoryBudget(100, 0, [], -5), /wantMB/);
  assert.throws(() => computeMemoryBudget(100, 0, null, 0), /services must be an array/);
  assert.throws(() => computeMemoryBudget(100, 0, [{ name: "" }], 0), /services\[0\].name/);
  assert.throws(
    () => computeMemoryBudget(100, 0, [{ name: "a", footprintMB: -5 }], 0),
    /services\[0\].footprintMB/
  );
  assert.throws(() => computeMemoryBudget(100, 0, ["x"], 0), /services\[0\] must be an object/);
  // non-boolean running is tolerated, coerced to false (behavioral pin, not a throw)
  assert.doesNotThrow(() =>
    computeMemoryBudget(100, 0, [{ name: "a", footprintMB: 1, running: "yes" }], 0)
  );
  // witness: boolean coercion actually happens (red-then-green: assertion pins behavior)
  const b = computeMemoryBudget(100, 10, [{ name: "a", footprintMB: 5, running: "yes" }], 10);
  assert.equal(b.services[0].running, false);
  assert.equal(b.servicesUsedMB, 0);
});

// ─── SC3: multi-spark / TP-group calculator ───────────────────────────────

import { computeGroupMemoryBudget, BOOTSTRAP_COMPONENTS } from "../memory.js";

test("SC3 group known-answer: TP2 totals, per-spark breakdown, tight spark", () => {
  // totalEstimateMB path: 192000 / 2 = 96000 per spark.
  const plan = computeGroupMemoryBudget(
    { groupId: "tp2-aeon", tp: 2, totalEstimateMB: 192000, basis: "estimated" },
    [
      { nodeId: "102c", totalMB: 122880, usedMB: 20000 },
      { nodeId: "25ed", totalMB: 122880, usedMB: 30000 },
    ]
  );
  assert.equal(plan.perSparkMB, 96000);
  assert.equal(plan.groupTotalMB, 192000);
  assert.equal(plan.groupTotalMemMB, 245760);
  assert.equal(plan.groupUsedMemMB, 50000);
  assert.equal(plan.groupFreeMemMB, 195760);
  assert.equal(plan.tp, 2);
  assert.deepEqual(plan.sparkIds, ["102c", "25ed"]);
  assert.equal(plan.fits, false); // 25ed is 3120 short; 102c fits
  assert.equal(plan.estimated, true);
  assert.equal(plan.sparks.length, 2);
  assert.equal(plan.sparks[0].head, true); // first spark is head by default
  assert.equal(plan.sparks[0].plannedMB, 96000);
  assert.equal(plan.sparks[0].projectedFreeMB, 6880);
  assert.equal(plan.sparks[0].feasible, true);
  // 25ed: free 92880 < 96000 shard, nothing stoppable → infeasible, -3120.
  assert.equal(plan.sparks[1].freeMB, 92880);
  assert.equal(plan.sparks[1].feasible, false);
  assert.equal(plan.sparks[1].projectedFreeMB, -3120);
  assert.deepEqual(plan.sparks[0].makeRoom, []);
});

test("SC3 group: one spark needs make-room, other does not", () => {
  const plan = computeGroupMemoryBudget(
    { tp: 2, perSparkMB: 90000 },
    [
      { nodeId: "a", totalMB: 122880, usedMB: 10000, services: [] },
      {
        nodeId: "b",
        totalMB: 122880,
        usedMB: 90000,
        services: [
          { name: "image", kind: "image", footprintMB: 40000, running: true, needed: false },
        ],
      },
    ]
  );
  // a: free 112880 >= 90000 → no plan. b: free 32880, deficit 57120 → stops
  // image (40000); 32880 + 40000 = 72880 < 90000 → infeasible, group fits=false.
  assert.deepEqual(plan.sparks[0].makeRoom, []);
  assert.equal(plan.sparks[0].feasible, true);
  assert.deepEqual(plan.sparks[1].makeRoom, [
    { serviceName: "image", freesMB: 40000, reason: "stoppable" },
  ]);
  assert.equal(plan.sparks[1].feasible, false);
  assert.equal(plan.sparks[1].projectedFreeMB, 32880 + 40000 - 90000); // -17120
  assert.equal(plan.fits, false);
});

test("SC3 group: make-room covers the shard on every spark → fits", () => {
  const plan = computeGroupMemoryBudget(
    { groupId: "g", tp: 2, perSparkMB: 50000 },
    [
      {
        nodeId: "a",
        totalMB: 122880,
        usedMB: 100000,
        services: [
          { name: "comfy", kind: "image", footprintMB: 40000, running: true, needed: false },
        ],
      },
      { nodeId: "b", totalMB: 122880, usedMB: 60000 },
    ]
  );
  assert.equal(plan.sparks[0].makeRoom.length, 1); // frees 40000, covers 47120 deficit? 22880+40000>=50000
  assert.equal(plan.sparks[0].feasible, true);
  assert.equal(plan.sparks[1].makeRoom.length, 0);
  assert.equal(plan.fits, true);
  assert.equal(plan.groupId, "g");
  assert.equal(plan.estimated, false); // basis absent → not an estimate
  assert.equal(plan.groupFloorMB, 0); // default: no floor policy
});

test("SC3 group: floorMB raises the want and the group floor", () => {
  const plan = computeGroupMemoryBudget(
    { tp: 1, perSparkMB: 100000 },
    [{ nodeId: "solo", totalMB: 122880, usedMB: 10000 }],
    { floorMB: 3072 }
  );
  assert.equal(plan.groupFloorMB, 3072);
  // free 112880 < 100000 + 3072 = 103072? No: 112880 >= 103072 → fits, floor shows in projection.
  assert.equal(plan.fits, true);
  assert.equal(plan.sparks[0].projectedFreeMB, 112880 - 100000 - 3072); // 9808
});

test("SC3 group: tp/spark-count mismatch and bad service throw", () => {
  assert.throws(
    () => computeGroupMemoryBudget({ tp: 2, perSparkMB: 10 }, [{ nodeId: "a", totalMB: 1, usedMB: 0 }]),
    TypeError
  );
  assert.throws(() => computeGroupMemoryBudget({ tp: 0, perSparkMB: 10 }, []), TypeError);
  assert.throws(() => computeGroupMemoryBudget({ tp: 1 }, [{ nodeId: "a", totalMB: 1, usedMB: 0 }]), TypeError);
  assert.throws(() => computeGroupMemoryBudget(null, []), TypeError);
});

test("SC3 single-node budget with group context: group need drives make-room", () => {
  // wantMB 0 alone would never plan; the TP shard need does.
  const b = computeMemoryBudget(
    122880,
    100000,
    [{ name: "comfy", kind: "image", footprintMB: 40000, running: true, needed: false }],
    0,
    { nodeId: "n", group: { sparkIds: ["n", "peer"], perSparkMB: 60000 } }
  );
  assert.equal(b.groupAvailableMB, 22880);
  assert.equal(b.needMakeRoom, true); // 22880 < 60000 shard need
  assert.deepEqual(b.makeRoom, [{ serviceName: "comfy", freesMB: 40000, reason: "stoppable" }]);
});

test("SC3 single-node budget: group context with enough free → OK, still reports availability", () => {
  const b = computeMemoryBudget(122880, 20000, [], 0, { group: { perSparkMB: 50000 } });
  assert.equal(b.groupAvailableMB, 102880);
  assert.equal(b.needMakeRoom, false);
  assert.deepEqual(b.makeRoom, []);
});

test("SC3 budget without group context is unchanged (no groupAvailableMB)", () => {
  const b = computeMemoryBudget(122880, 70000, [], 0);
  assert.equal("groupAvailableMB" in b, false);
});

test("SC3 group context validates its inputs", () => {
  assert.throws(
    () => computeMemoryBudget(1, 0, [], 0, { group: { perSparkMB: -5 } }),
    TypeError
  );
  assert.throws(
    () => computeMemoryBudget(1, 0, [], 0, { group: { sparkIds: ["ok", ""] } }),
    TypeError
  );
  // Empty sparkIds is legal: membership not yet assembled (node-side enrich).
  const b = computeMemoryBudget(122880, 20000, [], 0, { group: { sparkIds: [], perSparkMB: 1000 } });
  assert.equal(b.groupAvailableMB, 102880);
});

test("SC3 bootstrap hardcodes are present and well-formed", () => {
  assert.ok(Array.isArray(BOOTSTRAP_COMPONENTS));
  assert.ok(BOOTSTRAP_COMPONENTS.length >= 2);
  const tp2 = BOOTSTRAP_COMPONENTS.find((c) => c.tp === 2);
  assert.ok(tp2, "a TP=2 bootstrap seed exists (aeon7 pair)");
  assert.equal(tp2.basis, "estimated");
  assert.ok(Number.isFinite(tp2.perSparkMB) && tp2.perSparkMB > 0);
  for (const c of BOOTSTRAP_COMPONENTS) {
    assert.equal(typeof c.id, "string");
    assert.ok(c.id.length > 0);
    assert.ok(["measured", "estimated"].includes(c.basis));
    assert.ok(Number.isInteger(c.tp) && c.tp >= 1);
  }
});
