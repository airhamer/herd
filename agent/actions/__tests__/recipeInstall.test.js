import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatchComponentAction } from "../componentDispatch.js";
import { loadDefinitions } from "../../catalog/definitions.js";

const SECRET = "test-secret";
const CATALOG = path.join(path.dirname(new URL(import.meta.url).pathname), "../../catalog/components");

test("catalog stock and flash JSON normalize and declare alzeo lifecycle", () => {
  const { definitions, warnings } = loadDefinitions(CATALOG);
  assert.equal(warnings.length, 0, warnings.join("; "));
  const stock = definitions.find((d) => d.id.includes("27b-stock"));
  const flash = definitions.find((d) => d.id.includes("flash-next"));
  assert.ok(stock && flash);
  assert.equal(stock.runtimeProfile.ports.engine, 8080);
  assert.equal(stock.runtimeProfile.ports.guard, 8081);
  assert.ok(stock.variants.some((v) => v.id === "uncensored"));
  assert.equal(stock.raw.lifecycle.install.env.MODEL_CHOICE, "stock");
  assert.equal(flash.raw.lifecycle.loadingDeadlineMs, 900000);
  assert.equal(stock.raw.source.origin, "hasso5703/alzeo");
});

test("install preview/confirm/execute gating with mocked exec", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-cfg-"));
  const req = {
    version: 2,
    actionId: "i1",
    componentId: "qwen38-27b-stock-sglang-tp1-gx10",
    type: "install",
    nodeId: "n1",
    groupRef: null,
    exclusiveWith: null,
    confirmationToken: null,
    dryRun: true,
    recipeName: null,
    timeoutMs: null,
  };
  const preview = await dispatchComponentAction(req, { catalogDir: CATALOG, configDir, confirmSecret: SECRET });
  assert.equal(preview.ok, true);
  const installStep = preview.plan.recipe.steps.find((s) => Array.isArray(s.argv) && s.argv[0] === "./install.sh");
  assert.equal(installStep.argv[1], "--plan");
  assert.ok(preview.plan.willDo.includes("checkout"));
  assert.equal(preview.plan.confirm, "required");

  const denied = await dispatchComponentAction(
    { ...req, dryRun: false, confirmationToken: null },
    { catalogDir: CATALOG, configDir, confirmSecret: SECRET, exec: async () => ({ ok: true }) }
  );
  assert.equal(denied.ok, false);

  const calls = [];
  const run = await dispatchComponentAction(
    { ...req, dryRun: false, confirmationToken: preview.plan.confirmationToken },
    {
      catalogDir: CATALOG,
      configDir,
      confirmSecret: SECRET,
      home: "/home/u",
      pathExists: () => false,
      execHost: async () => ({ ok: true }),
      execGit: async (argv) => {
        if (argv.includes("rev-parse") && argv.at(-1) === "HEAD") {
          return { ok: true, stdout: "01902c67709c4164c30ccf036422bfed6f172158\n" };
        }
        return { ok: true, stdout: "" };
      },
      exec: async (file, args, opts) => {
        calls.push({ file, args, opts });
        return { ok: true, stdout: "ok" };
      },
    }
  );
  assert.equal(run.ok, true);
  assert.equal(run.canaryState, "installed");
  const installCall = calls.find((c) => c.file === "./install.sh");
  assert.ok(installCall);
  assert.deepEqual(installCall.args, ["--no-start"]);
  assert.equal(run.state.recording.content, "metadata");
});

test("occupied exclusive peer plans a coordinated stop instead of blocking", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-cfg-"));
  const res = await dispatchComponentAction(
    {
      version: 2,
      actionId: "i2",
      componentId: "qwen38-27b-stock-sglang-tp1-gx10",
      type: "install",
      nodeId: "n1",
      groupRef: null,
      exclusiveWith: null,
      confirmationToken: null,
      dryRun: true,
      recipeName: null,
      timeoutMs: null,
    },
    {
      catalogDir: CATALOG,
      configDir,
      confirmSecret: SECRET,
      portOccupier: { 8080: "qwen38-flash-next-sglang-tp1-gx10" },
    }
  );
  assert.equal(res.ok, true);
  assert.ok(res.plan.willDo.includes("stop-peer") || res.plan.displaces === "qwen38-flash-next-sglang-tp1-gx10");
});
