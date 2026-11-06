import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { planGroupRecipe } from "../groupRecipe.js";
import { buildRecipePlan } from "../recipePlan.js";
import { normalizeComponent } from "../runtimeProfile.js";

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "../../agent/catalog/components");

function load(id) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
}

test("GLM and DeepSeek definitions normalize without embedding secrets", () => {
  for (const id of ["glm53-flash-tensorfold-tp2-gx10", "deepseek-v4-flash-vllm-tp2-gx10"]) {
    const raw = load(id);
    const n = normalizeComponent(raw);
    assert.equal(n.ok, true, n.issues && n.issues.join("; "));
    assert.equal(n.component.runtimeProfile.topology.tp, 2);
  }
  const glm = normalizeComponent(load("glm53-flash-tensorfold-tp2-gx10")).component;
  assert.equal(glm.runtimeProfile.adapters[0].support, "unverified");
  const ds = load("deepseek-v4-flash-vllm-tp2-gx10");
  assert.equal(ds.source.license, "MIT");
  assert.match(ds.variants.find((v) => v.id === "abliterated").notes, /gated/);
});

test("tp=2 group plan: two members, worker then head, no hardware mutation", () => {
  const raw = load("deepseek-v4-flash-vllm-tp2-gx10");
  const ok = planGroupRecipe(raw, {
    action: "install",
    group: { id: "tp2", members: ["gx10-102c", "gx10-25ed"], headId: "gx10-102c" },
    network: {
      config: {
        WORKER_HOST: "10.0.0.2",
        MASTER_ADDR: "10.0.0.1",
        NCCL_IB_HCA: "rocep1s0f1",
        NCCL_SOCKET_IFNAME: "enp1s0f1np1",
      },
    },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.plan.order.map((s) => s.role), ["worker", "head"]);
  assert.equal(ok.plan.order[0].nodeId, "gx10-25ed");
  assert.equal(ok.plan.recordingIdentity, "tp2");

  const stop = planGroupRecipe(raw, {
    action: "stop",
    group: { id: "tp2", members: ["gx10-102c", "gx10-25ed"], headId: "gx10-102c" },
    network: { config: { WORKER_HOST: "10.0.0.2", MASTER_ADDR: "10.0.0.1", NCCL_IB_HCA: "x", NCCL_SOCKET_IFNAME: "y" } },
  });
  assert.deepEqual(stop.plan.order.map((s) => s.role), ["head", "worker"]);
});

test("incompatible membership or missing/mutating interconnect is an error", () => {
  const raw = load("deepseek-v4-flash-vllm-tp2-gx10");
  const one = planGroupRecipe(raw, { group: { members: ["only-one"] } });
  assert.equal(one.ok, false);
  assert.equal(one.code, "incompatible-topology");

  const missing = planGroupRecipe(raw, {
    group: { members: ["a", "b"], headId: "a" },
    network: { config: { WORKER_HOST: "10.0.0.2" } },
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /NCCL_IB_HCA/);

  const mutate = planGroupRecipe(raw, {
    group: { members: ["a", "b"], headId: "a" },
    network: {
      wouldChangeHardware: true,
      config: { WORKER_HOST: "x", MASTER_ADDR: "y", NCCL_IB_HCA: "z", NCCL_SOCKET_IFNAME: "w" },
    },
  });
  assert.equal(mutate.ok, false);
  assert.equal(mutate.code, "network-mutation-forbidden");
});

test("GLM preview injects DRY_RUN=1; confirm execution does not", () => {
  const raw = load("glm53-flash-tensorfold-tp2-gx10");
  const preview = buildRecipePlan(raw, "install");
  assert.equal(preview.ok, true);
  assert.equal(preview.plan.steps[0].env.DRY_RUN, "1");
  const run = buildRecipePlan(raw, "install", { execute: true });
  assert.equal(run.plan.steps[0].env.DRY_RUN, undefined);
  assert.deepEqual(run.plan.steps[0].argv, ["./start.sh"]);
});
