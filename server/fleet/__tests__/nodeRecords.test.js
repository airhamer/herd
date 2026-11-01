// GRP1 (#82): GET /api/fleet/nodes carries the groups.json overlay, and
// node add / update bodies cannot write the group keys.
import { after, before, describe, test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createGroupStore } from "../groups.js";
import { GROUP_FIELDS, registerNodeListRoute, resolvedNodes, withoutGroupFields } from "../nodeRecords.js";

// Raw registry: the stale seed says 102c+25ed are tp2.
const NODES = [
  { id: "gx10-1c2c", name: "1c2c", role: "standalone", rank: null, groupId: null, headId: null, links: [] },
  { id: "gx10-102c", name: "102c", role: "head", rank: 0, groupId: "tp2", headId: null, links: [] },
  { id: "gx10-25ed", name: "25ed", role: "worker", rank: 1, groupId: "tp2", headId: "gx10-102c", links: [] },
  { id: "narthex", name: "Narthex", role: "standalone", rank: null, groupId: null, headId: null, links: [] },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-node-records-"));
const file = path.join(dir, "groups.json");
const store = createGroupStore({ path: file });
let server;
let base;

before(async () => {
  const app = express();
  registerNodeListRoute(app, { listNodes: () => NODES, groupStore: store });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const getNodes = async () => {
  const r = await fetch(`${base}/api/fleet/nodes`);
  assert.equal(r.status, 200);
  return (await r.json()).nodes;
};
const byId = (nodes) => Object.fromEntries(nodes.map((n) => [n.id, n]));

describe("GET /api/fleet/nodes (GRP1 overlay)", () => {
  test("first read seeds groups.json from the registry and returns the seeded group", async () => {
    const n = byId(await getNodes());
    assert.ok(fs.existsSync(file), "groups.json seeded");
    assert.equal(n["gx10-102c"].groupId, "tp2");
    assert.equal(n["gx10-102c"].role, "head");
    assert.equal(n["gx10-25ed"].role, "worker");
    assert.equal(n["gx10-25ed"].headId, "gx10-102c");
    assert.equal(n["gx10-1c2c"].role, "standalone");
  });

  test("after a Topology edit the records follow groups.json, not the stale registry", async () => {
    store.write({
      version: 1,
      switchPresent: false,
      groups: [{ id: "pair", name: "Pair A", members: ["gx10-1c2c", "gx10-25ed"] }],
    });
    const nodes = await getNodes();
    const n = byId(nodes);
    assert.deepEqual(nodes.map((x) => x.id), NODES.map((x) => x.id), "registry order kept");
    assert.equal(n["gx10-1c2c"].groupId, "pair");
    assert.equal(n["gx10-1c2c"].groupName, "Pair A");
    assert.equal(n["gx10-1c2c"].role, "head");
    assert.equal(n["gx10-1c2c"].rank, 0);
    assert.equal(n["gx10-25ed"].role, "worker");
    assert.equal(n["gx10-25ed"].rank, 1);
    assert.equal(n["gx10-25ed"].headId, "gx10-1c2c");
    // Raw registry still says tp2 head; the response must not.
    assert.equal(n["gx10-102c"].groupId, null);
    assert.equal(n["gx10-102c"].role, "standalone");
    assert.equal(n["gx10-102c"].rank, null);
    assert.equal(NODES[1].groupId, "tp2", "registry itself untouched");
  });

  test("a group page in progress (1 member) leaves its node standalone", async () => {
    store.write({ version: 1, switchPresent: false, groups: [{ id: "solo", name: "solo", members: ["gx10-102c"] }] });
    const n = byId(await getNodes());
    assert.equal(n["gx10-102c"].groupId, null);
    assert.equal(n["gx10-102c"].role, "standalone");
  });
});

describe("resolvedNodes / withoutGroupFields", () => {
  test("resolvedNodes matches the route output", async () => {
    assert.deepEqual(resolvedNodes(NODES, store), await getNodes());
  });

  test("withoutGroupFields drops every group key and reports which", () => {
    const { body, ignored } = withoutGroupFields({
      name: "x",
      lanIp: "1.2.3.4",
      role: "head",
      rank: 0,
      groupId: "tp2",
      headId: null,
      groupName: "tp2",
    });
    assert.deepEqual(body, { name: "x", lanIp: "1.2.3.4" });
    assert.deepEqual(ignored.sort(), [...GROUP_FIELDS].sort());
  });

  test("withoutGroupFields: no group keys → nothing ignored; null body → {}", () => {
    assert.deepEqual(withoutGroupFields({ name: "y" }), { body: { name: "y" }, ignored: [] });
    assert.deepEqual(withoutGroupFields(null), { body: {}, ignored: [] });
  });
});
