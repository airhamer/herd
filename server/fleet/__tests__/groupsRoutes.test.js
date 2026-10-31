// SC5d (#75): GET/PUT /api/fleet/groups and POST /roce-apply on a real Express app.
import { after, before, describe, test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createGroupStore } from "../groups.js";
import { registerGroupRoutes } from "../groupsRoutes.js";

const L = (from, to, fromIf, toIf) => ({ from, to, fromIf, toIf, speedMbps: 200000, transport: "roce", up: true });
const NODES = [
  { id: "gx10-1c2c", name: "1c2c", links: [L("gx10-1c2c", "gx10-102c", "p1", "p0"), L("gx10-1c2c", "gx10-25ed", "p2", "p0")] },
  { id: "gx10-102c", name: "102c", role: "head", rank: 0, groupId: "tp2", links: [L("gx10-102c", "gx10-25ed", "p1", "p1")] },
  { id: "gx10-25ed", name: "25ed", role: "worker", rank: 2, groupId: "tp2", links: [] },
  { id: "narthex", name: "Narthex", links: [] },
];
const SNAPS = { narthex: { gpu: { unifiedMemory: false } }, "gx10-25ed": { gpu: { unifiedMemory: true } } };

let server;
let base;
let changes = 0;
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "herd-groups-routes-")), "groups.json");

before(async () => {
  const app = express();
  app.use(express.json());
  registerGroupRoutes(app, {
    store: createGroupStore({ path: file }),
    listNodes: () => NODES,
    getSnapshot: (id) => SNAPS[id] ?? null,
    onChange: () => {
      changes += 1;
    },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, p, body) => {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

describe("/api/fleet/groups", () => {
  test("GET seeds tp2 from the registry and reports eligibility + the plan", async () => {
    const { status, body } = await call("GET", "/api/fleet/groups");
    assert.equal(status, 200);
    assert.deepEqual(body.groups, [{ id: "tp2", name: "tp2", members: ["gx10-102c", "gx10-25ed"] }]);
    assert.equal(body.maxGroupSize, 3);
    assert.equal(body.switchPresent, false);
    assert.equal(body.nodes.find((n) => n.nodeId === "narthex").spark, false);
    assert.equal(body.nodes.find((n) => n.nodeId === "gx10-1c2c").spark, true);
    const pair = body.plan.links.find((l) => l.groupId === "tp2");
    assert.equal(pair.action, "enable");
    assert.equal(pair.targetSpeedMbps, 200000);
    assert.equal(body.plan.links.filter((l) => l.action === "disable").length, 2);
    assert.ok(fs.existsSync(file));
  });

  test("PUT a group of three: persisted, all links at 100G", async () => {
    const { status, body } = await call("PUT", "/api/fleet/groups", {
      groups: [{ id: "tp2", name: "tp2", members: ["gx10-102c", "gx10-25ed", "gx10-1c2c"] }],
    });
    assert.equal(status, 200);
    assert.equal(changes, 1);
    assert.deepEqual(
      body.plan.links.map((l) => [l.action, l.targetSpeedMbps]),
      [["enable", 100000], ["enable", 100000], ["enable", 100000]],
    );
    assert.equal(JSON.parse(fs.readFileSync(file, "utf-8")).groups[0].members.length, 3);
  });

  test("PUT refuses a non-Spark and a 4th member with clear messages", async () => {
    const nonSpark = await call("PUT", "/api/fleet/groups", { groups: [{ id: "g", members: ["narthex"] }] });
    assert.equal(nonSpark.status, 400);
    assert.match(nonSpark.body.error, /narthex cannot join group "g": only GB10 Spark nodes/);
    const four = await call("PUT", "/api/fleet/groups", {
      groups: [{ id: "g", members: ["gx10-1c2c", "gx10-102c", "gx10-25ed", "narthex"] }],
    });
    assert.equal(four.status, 400);
    const bad = await call("PUT", "/api/fleet/groups", { nope: true });
    assert.equal(bad.status, 400);
    assert.equal(changes, 1); // nothing persisted
  });

  test("roce-apply defaults to a dry run listing the exact commands (none)", async () => {
    await call("PUT", "/api/fleet/groups", { groups: [{ id: "tp2", members: ["gx10-102c", "gx10-25ed"] }] });
    const { status, body } = await call("POST", "/api/fleet/groups/roce-apply", {});
    assert.equal(status, 200);
    assert.equal(body.dryRun, true);
    assert.equal(body.implemented, false);
    assert.deepEqual(body.commands, []);
    assert.equal(body.nodes.length, 3);
    assert.ok(body.nodes.every((n) => n.dryRun === true && n.commands.length === 0));
  });

  test("a real apply needs confirm and then answers 501 not implemented", async () => {
    const noConfirm = await call("POST", "/api/fleet/groups/roce-apply", { dryRun: false });
    assert.equal(noConfirm.status, 400);
    assert.match(noConfirm.body.error, /confirm/);
    const real = await call("POST", "/api/fleet/groups/roce-apply", { dryRun: false, confirm: true });
    assert.equal(real.status, 501);
    assert.match(real.body.error, /not implemented/);
    const badFlag = await call("POST", "/api/fleet/groups/roce-apply", { dryRun: "no" });
    assert.equal(badFlag.status, 400);
  });
});
