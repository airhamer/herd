/**
 * lanes.test.js — tests for deriveLanes (agent/catalog/lanes.js, S3.1).
 *
 * Pure function under test: inject recipe/container/version ARRAYS, no fs,
 * no docker, no network.
 *
 * Run: node --test agent/catalog/__tests__/lanes.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";

import { deriveLanes } from "../lanes.js";

// ── Fixtures ──────────────────────────────────────────────────

const LANE_A = {
  name: "llm-a",
  kind: "llm",
  engine: "vllm",
  port: 8000,
  image: "vllm:latest",
  footprintMB: 40000,
  modelId: "model-a",
  containerName: "c-llm-a",
  lane: { pool: "gpu0", order: 0 },
};
const LANE_B = {
  name: "llm-b",
  kind: "llm",
  engine: "sglang",
  port: 8001,
  image: "sglang:latest",
  footprintMB: 50000,
  modelId: "model-b",
  containerName: "c-llm-b",
  lane: { pool: "gpu0", order: 1 },
};
const LANE_OTHER_POOL = {
  name: "llm-c",
  kind: "llm",
  engine: "vllm",
  port: 8100,
  image: "vllm:latest",
  footprintMB: 30000,
  modelId: "model-c",
  containerName: "c-llm-c",
  lane: { pool: "gpu1", order: 0 },
};
const PLAIN_LLM = {
  name: "llm-plain",
  kind: "llm",
  engine: "vllm",
  port: 8090,
  image: "vllm:latest",
  footprintMB: 1000,
  containerName: "c-plain",
};
const IMAGE_WITH_LANE = {
  name: "comfyui",
  kind: "image",
  engine: "comfyui",
  port: 8188,
  image: "comfyui:latest",
  footprintMB: 40000,
  containerName: "c-comfy",
  lane: { pool: "gpu0", order: 3 }, // misuse: validator warns, deriveLanes ignores
};

const running = (name, ports = [], image = "img:1") => ({
  name,
  image,
  status: "running",
  ports,
});
const exited = (name, ports = [], image = "img:1") => ({
  name,
  image,
  status: "exited",
  ports,
});

// ── pools + entries ────────────────────────────────────────────

test("deriveLanes: lane recipes join into pools sorted by id, lanes sorted by order", () => {
  const { pools, candidates } = deriveLanes({
    listRecipes: [LANE_B, LANE_OTHER_POOL, LANE_A, PLAIN_LLM, IMAGE_WITH_LANE],
    containers: [],
    versions: [],
  });
  assert.deepEqual(candidates, []);
  assert.deepEqual(pools.map((p) => p.id), ["gpu0", "gpu1"]); // pools sorted by id
  assert.deepEqual(pools[0].lanes.map((l) => l.recipe), ["llm-a", "llm-b"]); // order 0,1
  assert.deepEqual(pools[1].lanes.map((l) => l.recipe), ["llm-c"]);
  // Entry shape (shared/types.ts → LaneEntry).
  assert.deepEqual(pools[0].lanes[0], {
    recipe: "llm-a",
    modelId: "model-a", // recipe fallback (no live version)
    port: 8000,
    order: 0,
    running: false,
    containerName: "c-llm-a",
    state: "stopped",
  });
});

test("deriveLanes: non-llm lane and lane-less llm are excluded (ignored, not an error)", () => {
  const { pools } = deriveLanes({
    listRecipes: [IMAGE_WITH_LANE, PLAIN_LLM],
    containers: [],
    versions: [],
  });
  assert.deepEqual(pools, []);
});

test("deriveLanes: invalid lane shape on an llm recipe is excluded too", () => {
  const bad = [
    { ...LANE_A, lane: null },
    { ...LANE_B, lane: { pool: "Bad Pool", order: 0 } },
    { ...LANE_OTHER_POOL, lane: { pool: "gpu1", order: -1 } },
    { ...LANE_A, name: "llm-x", lane: { pool: "gpu1", order: 1.5 } },
  ];
  assert.deepEqual(deriveLanes({ listRecipes: bad, containers: [], versions: [] }).pools, []);
});

test("deriveLanes: running via live container by name", () => {
  const { pools } = deriveLanes({
    listRecipes: [LANE_A],
    containers: [running("c-llm-a", ["8000:8000"])],
    versions: [],
  });
  const lane = pools[0].lanes[0];
  assert.equal(lane.running, true);
  assert.equal(lane.state, "running");
});

test("deriveLanes: running via live version on the recipe port (modelId: live wins)", () => {
  const { pools } = deriveLanes({
    listRecipes: [LANE_A],
    containers: [exited("c-llm-a", ["8000:8000"])], // container down…
    versions: [{ kind: "llm", port: 8000, state: "running", modelId: "served-model" }],
    // …but the version probe says the port is up: still running.
  });
  assert.equal(pools[0].lanes[0].running, true);
  assert.equal(pools[0].lanes[0].modelId, "served-model");
  // A stopped version entry does not mark it running and keeps recipe fallback.
  const stopped = deriveLanes({
    listRecipes: [LANE_A],
    containers: [],
    versions: [{ kind: "llm", port: 8000, state: "stopped", modelId: "served-model" }],
  });
  assert.equal(stopped.pools[0].lanes[0].running, false);
  assert.equal(stopped.pools[0].lanes[0].modelId, "model-a");
});

test("deriveLanes: exited container + no version → stopped", () => {
  const { pools } = deriveLanes({
    listRecipes: [LANE_A],
    containers: [exited("c-llm-a", ["8000:8000"])],
    versions: [],
  });
  assert.equal(pools[0].lanes[0].running, false);
  assert.equal(pools[0].lanes[0].state, "stopped");
});

// ── candidates ───────────────────────────────────────────────

test("deriveLanes: lane-like names and lane-port collisions surface as candidates", () => {
  const { candidates } = deriveLanes({
    listRecipes: [LANE_A],
    containers: [
      running("c-llm-a", ["8000:8000"]), // matches LANE_A by name+port → never a candidate
      running("vllm-stray", ["9000:9000"]), // name matches the pattern
      running("sidecar", ["8000:8000"]), // port matches the lane recipe port — squatter candidate
      running("sglang_x", []), // name matches (underscore separator)
      running("redis", ["6379:6379"]), // boring → not a candidate
      exited("llama-old", []), // name matches even when stopped (advisory)
    ],
    versions: [],
  });
  assert.deepEqual(candidates.map((c) => c.containerName).sort(), [
    "llama-old",
    "sglang_x",
    "sidecar",
    "vllm-stray",
  ].sort());
  const byName = Object.fromEntries(candidates.map((c) => [c.containerName, c]));
  assert.match(byName["vllm-stray"].reason, /lane-like container name/);
  assert.match(byName["sidecar"].reason, /exposes lane-recipe port 8000/);
  assert.deepEqual(byName["sidecar"].ports, ["8000:8000"]);
  assert.equal(byName["sidecar"].image, "img:1");
});

test("deriveLanes: no lane recipes → only name-pattern candidates", () => {
  const { candidates } = deriveLanes({
    listRecipes: [PLAIN_LLM],
    containers: [running("vllm-orphan", ["7000:7000"]), running("nginx", ["80:80"])],
    versions: [],
  });
  assert.deepEqual(candidates.map((c) => c.containerName), ["vllm-orphan"]);
});

test("deriveLanes: port-squatting container (different name) is an advisory candidate, port feeds lane state", () => {
  const { candidates, pools } = deriveLanes({
    listRecipes: [LANE_A],
    containers: [running("renamed-container", ["8000:8000"])],
    versions: [],
  });
  // Not named by the recipe → candidate (advisory: someone else holds the lane port).
  assert.deepEqual(candidates, [
    {
      containerName: "renamed-container",
      image: "img:1",
      ports: ["8000:8000"],
      reason: "exposes lane-recipe port 8000",
    },
  ]);
  // And the lane port is demonstrably up → the lane's state follows it.
  assert.equal(pools[0].lanes[0].running, true);
});

// ── input shapes ────────────────────────────────────────────

test("deriveLanes: listRecipes accepts a recipes.js-style function as well as an array", () => {
  const viaFn = deriveLanes({ listRecipes: () => [LANE_A], containers: [], versions: [] });
  const viaArr = deriveLanes({ listRecipes: [LANE_A], containers: [], versions: [] });
  assert.deepEqual(viaFn, viaArr);
});

test("deriveLanes: empty/garbage inputs never throw", () => {
  assert.deepEqual(deriveLanes(), { pools: [], candidates: [] });
  assert.deepEqual(deriveLanes({}), { pools: [], candidates: [] });
  assert.deepEqual(deriveLanes({ listRecipes: "nope", containers: null, versions: 42 }), {
    pools: [],
    candidates: [],
  });
  assert.deepEqual(deriveLanes({ listRecipes: [null, 7, LANE_A], containers: [null, {}], versions: [null] }).pools.length, 1);
});
