// SC5b (#73): read-only downtime preview for switching a target to a stack.
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { buildStackPreview } from "../stackPreview.js";

const GiB = 1024;
const comp = (id, over = {}) => ({ id, kind: "llm", tp: 1, memoryPerSparkMB: 40 * GiB, nodes: [], ...over });
const on = (nodeId) => [{ nodeId, state: "running" }];
const snap = (usedGiB) => ({ mem: { totalMB: 128 * GiB, usedMB: usedGiB * GiB } });
const stack = (over = {}) => ({ id: "s", name: "S", componentNames: ["new"], category: "calculated", categoryReason: "", tp: 1, target: { groupId: null, nodeIds: ["n1"] }, ...over });
const est = (componentId, type) => ({ ms: type === "stop" ? 20_000 : 120_000, source: "estimate", runs: 0 });

function preview(s, components, snaps, eta = est) {
  return buildStackPreview(s, { components, getSnapshot: (id) => snaps[id] ?? null, eta });
}

describe("buildStackPreview", () => {
  test("enough free memory: start only, no shutdowns", () => {
    const p = preview(stack(), [comp("new")], { n1: snap(10) });
    assert.equal(p.shutdownSequence.length, 0);
    assert.deepEqual(p.startupSequence.map((w) => w.map((s) => `${s.type} ${s.componentId}@${s.nodeId}`)), [["start new@n1"]]);
    assert.equal(p.feasible, true);
    assert.equal(p.totalEtaMs, 120_000);
    assert.equal(p.totalSource, "estimate");
  });

  test("make-room: stops the biggest running non-member first, shutdowns before startups", () => {
    const comps = [comp("new", { memoryPerSparkMB: 80 * GiB }), comp("big", { memoryPerSparkMB: 60 * GiB, nodes: on("n1") }), comp("small", { memoryPerSparkMB: 10 * GiB, nodes: on("n1") })];
    const p = preview(stack(), comps, { n1: snap(75) });
    assert.deepEqual(p.shutdownSequence.map((w) => w.map((s) => s.componentId)), [["big"]]);
    assert.equal(p.startupSequence.flat()[0].componentId, "new");
    assert.equal(p.feasible, true);
    assert.equal(p.totalEtaMs, 140_000);
  });

  test("sequential by default: two starts are two waves", () => {
    const p = preview(stack({ componentNames: ["a", "b"] }), [comp("a", { memoryPerSparkMB: 10 }), comp("b", { memoryPerSparkMB: 10 })], { n1: snap(0) });
    assert.deepEqual(p.startupSequence.map((w) => w.map((s) => s.componentId)), [["a"], ["b"]]);
    assert.equal(p.totalEtaMs, 240_000);
    assert.equal(p.parallel, false);
  });

  test("a parallel stack groups its starts into one wave; the wave takes its slowest step", () => {
    const eta = (id) => ({ ms: id === "a" ? 30_000 : 90_000, source: id === "a" ? "history" : "estimate", runs: id === "a" ? 5 : 0 });
    const p = preview(stack({ componentNames: ["a", "b"], parallel: true }), [comp("a", { memoryPerSparkMB: 10 }), comp("b", { memoryPerSparkMB: 10 })], { n1: snap(0) }, eta);
    assert.deepEqual(p.startupSequence.map((w) => w.map((s) => s.componentId)), [["a", "b"]]);
    assert.equal(p.totalEtaMs, 90_000);
    assert.equal(p.totalSource, "mixed");
    assert.deepEqual(p.startupSequence[0].map((s) => s.eta.source), ["history", "estimate"]);
  });

  test("members already running are skipped", () => {
    const p = preview(stack({ componentNames: ["a", "b"] }), [comp("a", { nodes: on("n1") }), comp("b")], { n1: snap(50) });
    assert.deepEqual(p.alreadyRunning, [{ componentId: "a", nodeId: "n1" }]);
    assert.deepEqual(p.startupSequence.flat().map((s) => s.componentId), ["b"]);
  });

  test("not enough stoppable memory → infeasible with a note", () => {
    const p = preview(stack(), [comp("new", { memoryPerSparkMB: 100 * GiB })], { n1: snap(60) });
    assert.equal(p.feasible, false);
    assert.match(p.notes.join(" "), /memory held outside the catalog/);
  });

  test("tp2 group: make-room on every member, start on the head", () => {
    const s = stack({ tp: 2, target: { groupId: "g", nodeIds: ["h", "w"] } });
    const comps = [comp("new", { tp: 2, memoryPerSparkMB: 80 * GiB }), comp("old", { tp: 2, memoryPerSparkMB: 70 * GiB, nodes: [...on("h"), ...on("w")] })];
    const p = preview(s, comps, { h: snap(80), w: snap(80) });
    assert.deepEqual(p.shutdownSequence.flat().map((x) => `${x.componentId}@${x.nodeId}`).sort(), ["old@h", "old@w"]);
    assert.deepEqual(p.startupSequence.flat().map((x) => x.nodeId), ["h"]);
    assert.match(p.notes.join(" "), /tp2: each start runs on h across h \+ w/);
  });

  test("no nodes → infeasible, nothing planned", () => {
    const p = preview(stack({ target: { groupId: null, nodeIds: [] } }), [comp("new")], {});
    assert.equal(p.feasible, false);
    assert.equal(p.startupSequence.length, 0);
  });
});
