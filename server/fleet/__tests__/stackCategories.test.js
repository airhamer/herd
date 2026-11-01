// SC5a (#72): live stack categories per landing target.
import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { categorizeStack, categorizeStacks, nodeMemory, provenOn, stackFacets } from "../stackCategories.js";
import { loadComponentCatalog, recipeSourceOf } from "../componentCatalog.js";

const comp = (id, over = {}) => ({
  id,
  name: id,
  purpose: "code",
  kind: "llm",
  tp: 1,
  machineClass: "dgx-spark-gb10-128g",
  engine: "sglang",
  memoryPerSparkMB: 40 * 1024,
  recipeSource: "hasso",
  nodes: [],
  ...over,
});
const SPARK = (usedGiB, extra = {}) => ({ gpu: { unifiedMemory: true }, mem: { totalMB: 128 * 1024, usedMB: usedGiB * 1024 }, ...extra });
const stack = (over = {}) => ({ id: "s1", name: "S1", componentNames: ["a"], category: "calculated", tp: 1, target: { groupId: null, nodeIds: ["n1"] }, ...over });

function ctx(components, snaps, nodes = [{ id: "n1", name: "one" }, { id: "n2", name: "two" }]) {
  return {
    componentsById: new Map(components.map((c) => [c.id, c])),
    nodesById: new Map(nodes.map((n) => [n.id, n])),
    getSnapshot: (id) => snaps[id] ?? null,
  };
}

describe("categorizeStack", () => {
  test("fits comfortably → calculated with a fit reason", () => {
    const r = categorizeStack(stack(), ctx([comp("a")], { n1: SPARK(10) }));
    assert.equal(r.category, "calculated");
    assert.match(r.categoryReason, /^fits: needs 40\.0 GiB per spark/);
    assert.equal(r.perNode.length, 1);
  });

  test("tight fit → not_recommended, overfull → blocked with the reason", () => {
    assert.equal(categorizeStack(stack(), ctx([comp("a", { memoryPerSparkMB: 90 * 1024 })], { n1: SPARK(10) })).category, "not_recommended");
    const r = categorizeStack(stack(), ctx([comp("a", { memoryPerSparkMB: 110 * 1024 })], { n1: SPARK(10) }));
    assert.equal(r.category, "blocked");
    assert.match(r.categoryReason, /^does not fit: needs 110\.0 GiB per spark/);
  });

  test("a running member's own memory is credited back", () => {
    const a = comp("a", { memoryPerSparkMB: 100 * 1024, nodes: [{ nodeId: "n1", state: "running" }] });
    // 105 GiB used, 100 of it is the stack itself → it still fits itself.
    assert.notEqual(categorizeStack(stack(), ctx([a], { n1: SPARK(105) })).category, "blocked");
  });

  test("the worst node decides on a group target", () => {
    const s = stack({ tp: 2, target: { groupId: "g", nodeIds: ["n1", "n2"] } });
    const r = categorizeStack(s, ctx([comp("a", { tp: 2 })], { n1: SPARK(10), n2: SPARK(100) }));
    assert.equal(r.category, "blocked");
    assert.match(r.categoryReason, /two/);
  });

  test("a tp1 member on a tp2 target is blocked (copy-on-tp)", () => {
    const s = stack({ tp: 2, target: { groupId: "g", nodeIds: ["n1", "n2"] } });
    const r = categorizeStack(s, ctx([comp("a")], { n1: SPARK(0), n2: SPARK(0) }));
    assert.equal(r.category, "blocked");
    assert.match(r.categoryReason, /tp1 definition and this target needs tp2/);
  });

  test("a Spark-only member on a non-Spark host is blocked", () => {
    const r = categorizeStack(stack(), ctx([comp("a")], { n1: { gpu: { unifiedMemory: false }, mem: { totalMB: 65536, usedMB: 0 } } }));
    assert.equal(r.category, "blocked");
    assert.match(r.categoryReason, /needs a DGX Spark/);
  });

  test("unknown component → blocked", () => {
    const r = categorizeStack(stack({ componentNames: ["nope"] }), ctx([], {}));
    assert.equal(r.category, "blocked");
    assert.match(r.categoryReason, /not in the component catalog: nope/);
  });

  test("proven history at the same tp wins over the memory verdict, not over hard blocks", () => {
    const hist = { stackHistory: { s1: { stackId: "s1", entries: [{ success: true, tpSize: 1 }] } } };
    const big = comp("a", { memoryPerSparkMB: 120 * 1024 });
    assert.equal(categorizeStack(stack(), ctx([big], { n1: SPARK(10, hist) })).category, "proven");
    const wrongTp = { stackHistory: { s1: { entries: [{ success: true, tpSize: 2 }] } } };
    assert.equal(categorizeStack(stack(), ctx([big], { n1: SPARK(10, wrongTp) })).category, "blocked");
  });

  test("no telemetry / no nodes → calculated, fit not checked", () => {
    assert.match(categorizeStack(stack(), ctx([comp("a")], {})).categoryReason, /no memory telemetry/);
    const r = categorizeStack(stack({ target: { groupId: null, nodeIds: [] } }), ctx([comp("a")], {}));
    assert.equal(r.category, "calculated");
    assert.match(r.categoryReason, /no fleet nodes/);
  });
});

describe("facets and helpers", () => {
  test("stackFacets unions member values, missing → unknown", () => {
    const f = stackFacets(stack({ componentNames: ["a", "b"] }), new Map([["a", comp("a")], ["b", comp("b", { engine: null, purpose: "chat", recipeSource: "aeon" })]]));
    assert.deepEqual(f, { tp: 1, sources: ["aeon", "hasso"], engines: ["sglang", "unknown"], purposes: ["chat", "code"] });
  });

  test("categorizeStacks collects facet options", () => {
    const { facets } = categorizeStacks([stack(), stack({ id: "s2", tp: 2, componentNames: ["b"] })], ctx([comp("a"), comp("b", { tp: 2, engine: "vllm" })], {}));
    assert.deepEqual(facets.tp, [1, 2]);
    assert.deepEqual(facets.engines, ["sglang", "vllm"]);
  });

  test("nodeMemory prefers the SC3 budget over raw mem", () => {
    assert.deepEqual(nodeMemory({ memory: { totalMB: 2, usedMB: 1 }, mem: { totalMB: 9, usedMB: 9 } }), { totalMB: 2, usedMB: 1 });
    assert.equal(nodeMemory({}), null);
  });

  test("provenOn ignores failed runs", () => {
    assert.equal(provenOn({ stackHistory: { s: { entries: [{ success: false, tpSize: 1 }] } } }, "s", 1), false);
  });

  test("recipeSourceOf maps origins, explicit wins, missing → unknown", () => {
    assert.equal(recipeSourceOf({ source: { origin: "hasso5703/dgx-spark-qwen38" } }), "hasso");
    assert.equal(recipeSourceOf({ source: { origin: "MiaAI-Lab/x" } }), "mia-ai-lab");
    assert.equal(recipeSourceOf({ source: "aeon-7/recipes" }), "aeon");
    assert.equal(recipeSourceOf({ source: { origin: "me/my-stack" } }), "custom");
    assert.equal(recipeSourceOf({ recipeSource: "Community" }), "community");
    assert.equal(recipeSourceOf({}), "unknown");
  });

  test("the shipped catalog projects recipeSource", () => {
    const { components } = loadComponentCatalog();
    assert.ok(components.length >= 2);
    for (const c of components) assert.equal(c.recipeSource, "hasso");
  });
});
