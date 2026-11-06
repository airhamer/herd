import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatchComponentAction } from "../componentDispatch.js";

const SECRET = "test-secret";

function stockDef() {
  return {
    id: "qwen38-27b-stock-sglang-tp1-gx10",
    name: "Qwen3.8-27B",
    tp: 1,
    machineClass: "dgx-spark-gb10-128g",
    engine: "sglang",
    ports: { engine: 8080, placeholder: true },
    runtimeAliases: { serviceNames: ["qwen38-sglang"] },
    model: { servedModelName: "qwen3.8-27b", aliases: ["stock"] },
    memory_estimate_mb: { perSpark: 102400, basis: "measured" },
    flags: { context_length: 1010000 },
    variants: [
      { id: "stock", label: "stock", model: { servedModelName: "qwen3.8-27b" } },
      { id: "uncensored", label: "uncensored", model: { servedModelName: "qwen3.8-27b", aliases: ["uncensored"] } },
    ],
  };
}

function writeCatalog(def) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-cat-"));
  fs.writeFileSync(path.join(dir, `${def.id}.json`), JSON.stringify(def));
  return dir;
}

test("swap-variant dry-run then confirm persists and keeps recording", async () => {
  const catalogDir = writeCatalog(stockDef());
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-cfg-"));
  const base = {
    version: 2,
    actionId: "a1",
    componentId: "qwen38-27b-stock-sglang-tp1-gx10",
    type: "swap-variant",
    nodeId: "n1",
    groupRef: null,
    exclusiveWith: null,
    confirmationToken: null,
    dryRun: true,
    recipeName: null,
    timeoutMs: null,
    variantId: "uncensored",
  };
  const preview = await dispatchComponentAction(base, { catalogDir, configDir, confirmSecret: SECRET });
  assert.equal(preview.ok, true);
  assert.equal(preview.plan.confirm, "required");
  assert.equal(preview.plan.recording.content, "metadata");
  assert.ok(preview.plan.confirmationToken);

  const applied = await dispatchComponentAction(
    { ...base, actionId: "a2", dryRun: false, confirmationToken: preview.plan.confirmationToken },
    { catalogDir, configDir, confirmSecret: SECRET }
  );
  assert.equal(applied.ok, true);
  assert.equal(applied.state.variantId, "uncensored");
  assert.equal(applied.state.recording.content, "metadata");
  assert.match(applied.message, /unchanged/);

  const store = JSON.parse(fs.readFileSync(path.join(configDir, "component-instances.json"), "utf8"));
  assert.equal(store.instances["n1/qwen38-27b-stock-sglang-tp1-gx10"].variantId, "uncensored");
});

test("incompatible variant is blocked without writing instance state", async () => {
  const def = stockDef();
  def.variants.push({ id: "x", requires: { engine: "vllm" }, model: { servedModelName: "x" } });
  const catalogDir = writeCatalog(def);
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-cfg-"));
  const res = await dispatchComponentAction(
    {
      version: 2,
      actionId: "a",
      componentId: def.id,
      type: "swap-variant",
      nodeId: "n1",
      groupRef: null,
      exclusiveWith: null,
      confirmationToken: null,
      dryRun: true,
      recipeName: null,
      timeoutMs: null,
      variantId: "x",
    },
    { catalogDir, configDir, confirmSecret: SECRET }
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /engine/);
  assert.equal(fs.existsSync(path.join(configDir, "component-instances.json")), false);
});

test("start dry-run requires confirm; execute without token fails; execute with token calls dispatchAction", async () => {
  const catalogDir = writeCatalog(stockDef());
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-cfg-"));
  const req = {
    version: 2,
    actionId: "s1",
    componentId: stockDef().id,
    type: "start",
    nodeId: "n1",
    groupRef: null,
    exclusiveWith: null,
    confirmationToken: null,
    dryRun: true,
    recipeName: null,
    timeoutMs: null,
  };
  const preview = await dispatchComponentAction(req, { catalogDir, configDir, confirmSecret: SECRET });
  assert.equal(preview.ok, true);
  assert.ok(preview.plan.confirmationToken.includes("."));

  const denied = await dispatchComponentAction(
    { ...req, dryRun: false, confirmationToken: null },
    { catalogDir, configDir, confirmSecret: SECRET, dispatchAction: async () => ({ ok: true, status: "success" }) }
  );
  assert.equal(denied.ok, false);
  assert.match(denied.error, /confirmation/);

  let seen = null;
  const run = await dispatchComponentAction(
    { ...req, dryRun: false, confirmationToken: preview.plan.confirmationToken },
    {
      catalogDir,
      configDir,
      confirmSecret: SECRET,
      dispatchAction: async (v1) => {
        seen = v1;
        return { ok: true, status: "success", message: "started" };
      },
    }
  );
  assert.equal(run.ok, true);
  assert.equal(seen.serviceName, "qwen38-sglang");
  assert.equal(seen.type, "start");
});
