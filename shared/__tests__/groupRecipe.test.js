import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { planGroupRecipe, planGroupFanout, classifyNetworkPreview, memberRolePlan } from "../groupRecipe.js";
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
        MASTER_PORT: "29500",
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
    network: { config: { WORKER_HOST: "10.0.0.2", MASTER_ADDR: "10.0.0.1", MASTER_PORT: "29500", NCCL_IB_HCA: "x", NCCL_SOCKET_IFNAME: "y" } },
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
      config: { WORKER_HOST: "x", MASTER_ADDR: "y", MASTER_PORT: "29500", NCCL_IB_HCA: "z", NCCL_SOCKET_IFNAME: "w" },
    },
  });
  assert.equal(mutate.ok, false);
  assert.equal(mutate.code, "network-mutation-forbidden");
});

test("GLM preview injects DRY_RUN=1; confirm execution does not", () => {
  const raw = load("glm53-flash-tensorfold-tp2-gx10");
  const group = { id: "g", members: ["h", "w"], headId: "h" };
  const network = { config: { WORKER: "10.0.0.2" } };
  const preview = planGroupFanout(raw, { action: "install", dryRun: true, group, network });
  assert.equal(preview.ok, true);
  const headPrev = preview.plan.members.find((m) => m.role === "head");
  assert.equal(headPrev.env.DRY_RUN, "1");
  assert.deepEqual(headPrev.argv, ["./start.sh"]);
  const run = planGroupFanout(raw, { action: "install", dryRun: false, group, network });
  const headRun = run.plan.members.find((m) => m.role === "head");
  assert.equal(headRun.env.DRY_RUN, undefined);
  assert.deepEqual(headRun.argv, ["./start.sh"]);
  assert.equal(run.plan.members.find((m) => m.role === "worker").runsInstaller, false);
});

test("preview separates inventory management from named control/data paths", () => {
  const raw = load("deepseek-v4-flash-vllm-tp2-gx10");
  const paths = classifyNetworkPreview(raw, {
    network: { config: { WORKER_HOST: "10.0.0.2", MASTER_ADDR: "10.0.0.1", MASTER_PORT: "29500", NCCL_IB_HCA: "rocep1s0f1", NCCL_SOCKET_IFNAME: "enp1s0f1np1" } },
    listNodes: [
      { id: "h", lanIp: "192.168.1.10", agentPort: 30091 },
      { id: "w", lanIp: "192.168.1.11", agentPort: 30091 },
    ],
  });
  assert.equal(paths.management[0].plane, "management");
  assert.equal(paths.management[0].address, "192.168.1.10:30091");
  assert.ok(paths.dataPlane.some((x) => x.name === "WORKER_HOST" && x.provided));
  assert.ok(paths.dataPlane.every((x) => x.plane === "data"));
});

test("inventory host is not copied into WORKER when the overlay omitted it", () => {
  const raw = load("glm53-flash-tensorfold-tp2-gx10");
  const planned = memberRolePlan(raw, "head", { action: "install", workerHost: "192.168.1.11", env: {} });
  assert.equal(planned.env.WORKER, undefined);
});
