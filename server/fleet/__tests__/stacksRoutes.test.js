// SC5a (#72): /api/stacks routes on a real Express app with a temp stacks file.
import { after, before, describe, test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createDashboardStackStore, registerStackRoutes, slugId } from "../stacksRoutes.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-stacks-routes-"));
const file = path.join(dir, "stacks.json");
const NODES = [{ id: "n1", name: "one" }];
const COMPONENTS = [
  { id: "qwen38-27b-stock-sglang-tp1-gx10", tp: 1, machineClass: "dgx-spark-gb10-128g", engine: "sglang", purpose: "code", recipeSource: "hasso", memoryPerSparkMB: 102400, nodes: [] },
  { id: "qwen38-flash-next-sglang-tp1-gx10", tp: 1, machineClass: "dgx-spark-gb10-128g", engine: "sglang", purpose: "code", recipeSource: "hasso", memoryPerSparkMB: 40960, nodes: [] },
];
let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  registerStackRoutes(app, {
    store: createDashboardStackStore(file),
    listNodes: () => NODES,
    getSnapshot: () => ({ gpu: { unifiedMemory: true }, mem: { totalMB: 131072, usedMB: 8192 } }),
    loadComponents: () => COMPONENTS.map((c) => ({ ...c })),
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

describe("/api/stacks", () => {
  test("first run seeds config/stacks.json with the bootstrap stacks", async () => {
    const r = await call("GET", "/api/stacks");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.stacks.map((s) => s.id), ["hasso-27b-stock", "hasso-flash-next"]);
    assert.ok(fs.existsSync(file));
    // 100 GiB on a 128 GiB spark with 8 GiB used is over 80% of usable.
    assert.equal(r.body.stacks[0].category, "not_recommended");
    assert.equal(r.body.stacks[1].category, "calculated");
    assert.ok(r.body.facets.sources.includes("mia-ai-lab"));
    assert.ok(r.body.facets.purposes.includes("tts"));
    assert.deepEqual(r.body.facets.tp, [1]);
  });

  test("POST saves a user stack with a slugged id, then it is listed and exported", async () => {
    const r = await call("POST", "/api/stacks", { name: "My Flash Pair", componentNames: ["qwen38-flash-next-sglang-tp1-gx10"] });
    assert.equal(r.status, 201);
    assert.equal(r.body.stack.id, "my-flash-pair");
    const list = await call("GET", "/api/stacks");
    assert.ok(list.body.stacks.some((s) => s.id === "my-flash-pair"));
    const exp = await call("GET", "/api/stacks/export");
    assert.equal(exp.body.version, 1);
    assert.ok(exp.body.stacks.some((s) => s.id === "my-flash-pair"));
    assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).stacks.some((s) => s.id === "my-flash-pair"));
  });

  test("POST rejects an invalid stack", async () => {
    const r = await call("POST", "/api/stacks", { name: "", componentNames: [] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /componentNames/);
  });

  test("import merges an external file and reports it", async () => {
    const r = await call("POST", "/api/stacks/import", {
      version: 1,
      stacks: [{ id: "ext-one", name: "Ext", componentNames: ["x"], category: "calculated" }, { id: "BAD" }],
    });
    assert.deepEqual(r.body, { added: ["ext-one"], replaced: [], skipped: ["BAD"] });
    const list = await call("GET", "/api/stacks");
    const ext = list.body.stacks.find((s) => s.id === "ext-one");
    assert.equal(ext.category, "blocked");
  });

  test("slugId", () => {
    assert.equal(slugId("  Hello, World! "), "hello-world");
  });
});

describe("POST /api/stacks/:id/preview", () => {
  test("returns a read-only preview for the node's target", async () => {
    const before = fs.readFileSync(file, "utf8");
    const r = await call("POST", "/api/stacks/hasso-flash-next/preview?node=n1");
    assert.equal(r.status, 200);
    assert.equal(r.body.preview.stackId, "hasso-flash-next");
    assert.deepEqual(r.body.preview.startupSequence.flat().map((s) => s.componentId), ["qwen38-flash-next-sglang-tp1-gx10"]);
    assert.equal(r.body.preview.startupSequence[0][0].eta.source, "estimate");
    assert.deepEqual(r.body.live, []);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });

  test("404 for an unknown stack or a node outside every target", async () => {
    assert.equal((await call("POST", "/api/stacks/nope/preview")).status, 404);
    assert.equal((await call("POST", "/api/stacks/hasso-flash-next/preview?node=zz")).status, 404);
  });

  test("GET /api/component-actions/live", async () => {
    const r = await call("GET", "/api/component-actions/live");
    assert.deepEqual(r.body, { running: [] });
  });
});
