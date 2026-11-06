import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dispatchGroupComponentAction } from "../groupRecipeActions.js";
import { planGroupFanout } from "../../../shared/groupRecipe.js";

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "../../../agent/catalog/components");
const glm = JSON.parse(fs.readFileSync(path.join(dir, "glm53-flash-tensorfold-tp2-gx10.json"), "utf8"));
const ds = JSON.parse(fs.readFileSync(path.join(dir, "deepseek-v4-flash-vllm-tp2-gx10.json"), "utf8"));

const group = { id: "tp2", members: ["head-node", "worker-node"], headId: "head-node" };
const nodes = [
  { id: "head-node", lanIp: "10.0.0.1", agentPort: 30091 },
  { id: "worker-node", lanIp: "10.0.0.2", agentPort: 30091 },
];

test("fanout names worker then head with pinned entrypoints and required env", () => {
  const plan = planGroupFanout(ds, {
    action: "install",
    group,
    network: { config: { WORKER_HOST: "10.0.0.2", MASTER_ADDR: "10.0.0.1", MASTER_PORT: "29500", NCCL_IB_HCA: "roce0", NCCL_SOCKET_IFNAME: "eth0" } },
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.plan.members.map((m) => m.role), ["worker", "head"]);
  assert.equal(plan.plan.members[0].argv, null);
  assert.equal(plan.plan.members[0].runsInstaller, false);
  assert.ok(plan.plan.members[1].argv.includes("./start-deepseek-v4-flash-dspark.sh"));
  assert.equal(plan.plan.members[0].env.ROLE, "worker");
  assert.ok(plan.plan.paths.dataPlane.some((p) => p.name === "WORKER_HOST"));
  assert.equal(plan.plan.paths.dataPlane.find((p) => p.name === "MASTER_ADDR").provided, true);
});

test("all-or-nothing preflight fails closed if either agent is down", async () => {
  const out = await dispatchGroupComponentAction({
    definition: glm,
    group,
    network: { config: { WORKER: "10.0.0.2" } },
    request: { type: "install", dryRun: true, componentId: glm.id },
    listNodes: nodes,
    probeHealth: async (rec) => ({ ok: rec.id !== "worker-node", error: "down" }),
    proxy: async () => ({ status: 200, body: { ok: true } }),
  });
  assert.equal(out.status, 409);
  assert.match(out.body.error, /preflight/);
});

test("execute proxies stop-old then worker then head and records argv", async () => {
  const calls = [];
  const out = await dispatchGroupComponentAction({
    definition: glm,
    group,
    network: { config: { WORKER: "10.0.0.2" } },
    request: { type: "install", dryRun: false, componentId: glm.id, confirmationToken: "t" },
    listNodes: nodes,
    probeHealth: async () => ({ ok: true }),
    proxy: async (rec, req) => {
      calls.push({ nodeId: rec.id, type: req.type, role: req.role });
      return { status: 200, body: { ok: true, message: `${req.role} ${req.type}` } };
    },
  });
  assert.equal(out.status, 200);
  assert.equal(out.body.mocksOnly, true);
  const types = calls.map((c) => `${c.role}:${c.type}`);
  assert.deepEqual(types, ["head:stop", "worker:install", "head:install"]);
});

test("member failure does not claim hardware rollback", async () => {
  const out = await dispatchGroupComponentAction({
    definition: glm,
    group,
    network: { config: { WORKER: "10.0.0.2" } },
    request: { type: "install", dryRun: false, componentId: glm.id },
    listNodes: nodes,
    probeHealth: async () => ({ ok: true }),
    proxy: async (rec, req) => {
      if (req.type === "install" && req.role === "head") {
        return { status: 502, body: { ok: false, error: "start.sh failed" } };
      }
      return { status: 200, body: { ok: true } };
    },
  });
  assert.equal(out.body.ok, false);
  assert.equal(out.body.hardwareRolledBack, false);
});

test("missing data-plane config blocks before any stop or mutation", async () => {
  const calls = [];
  const out = await dispatchGroupComponentAction({
    definition: ds,
    group,
    network: { config: {} },
    request: { type: "install", dryRun: false, componentId: ds.id, confirmationToken: "t" },
    listNodes: nodes,
    probeHealth: async () => ({ ok: true }),
    proxy: async (rec, req) => {
      calls.push({ nodeId: rec.id, type: req.type, role: req.role });
      return { status: 200, body: { ok: true } };
    },
  });
  assert.ok(out.status >= 400);
  assert.match(out.body.error, /WORKER_HOST|interconnect|missing/i);
  assert.equal(calls.length, 0);
});

test("inventory LAN alone does not satisfy DeepSeek data-plane env", async () => {
  const calls = [];
  const out = await dispatchGroupComponentAction({
    definition: ds,
    group,
    network: { config: {} },
    request: { type: "install", dryRun: false, componentId: ds.id },
    listNodes: nodes,
    probeHealth: async () => ({ ok: true }),
    proxy: async (rec, req) => {
      calls.push({ nodeId: rec.id, type: req.type });
      return { status: 200, body: { ok: true } };
    },
  });
  assert.ok(out.status >= 400);
  assert.equal(calls.length, 0);
});
