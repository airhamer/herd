import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildComponentAction, proxyComponentAction } from "../componentActions.js";
import { dispatchComponentAction } from "../../../agent/actions/componentDispatch.js";

test("server → agent → argv → status roundtrip for a confirmed switch", async () => {
  const catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-rt-cat-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-rt-cfg-"));
  const def = {
    id: "qwen38-27b-stock-sglang-tp1-gx10",
    name: "Qwen",
    engine: "sglang",
    ports: { engine: 8080 },
    runtimeAliases: { serviceNames: ["qwen38-sglang"] },
    model: { servedModelName: "qwen3.8-27b" },
    variants: [
      { id: "stock", switchTarget: "stock", model: { servedModelName: "qwen3.8-27b" } },
      { id: "uncensored", switchTarget: "uncensored", model: { servedModelName: "qwen3.8-27b" } },
    ],
  };
  fs.writeFileSync(path.join(catalogDir, `${def.id}.json`), JSON.stringify(def));

  const previewBuilt = buildComponentAction(
    { type: "swap-variant", componentId: def.id, dryRun: true, variantId: "uncensored", exclusiveWith: null, confirmationToken: null, groupRef: null, recipeName: null, timeoutMs: null },
    { nodeId: "spark-1", actor: "tester" }
  );
  assert.equal(previewBuilt.ok, true);

  let seenArgv = null;
  const fetchImpl = async (url, init) => {
    assert.match(String(url), /\/actions$/);
    const request = JSON.parse(init.body);
    const body = await dispatchComponentAction(request, {
      catalogDir,
      configDir,
      confirmSecret: "s",
      execSwitch: async ({ argv }) => {
        seenArgv = argv;
        return { ok: true, statusCode: 0, stdout: "ok" };
      },
      probeReady: async () => ({ ready: true, loading: false }),
    });
    return { ok: true, status: 200, json: async () => body };
  };

  const preview = await proxyComponentAction({ lanIp: "127.0.0.1", agentPort: 9 }, previewBuilt.request, { fetchImpl });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.plan.argv, ["./switch-model.sh", "uncensored"]);

  const confirmBuilt = buildComponentAction(
    {
      type: "swap-variant",
      componentId: def.id,
      dryRun: false,
      variantId: "uncensored",
      exclusiveWith: null,
      confirmationToken: preview.body.plan.confirmationToken,
      groupRef: null,
      recipeName: null,
      timeoutMs: null,
    },
    { nodeId: "spark-1", actor: "tester" }
  );
  const applied = await proxyComponentAction({ lanIp: "127.0.0.1", agentPort: 9 }, confirmBuilt.request, { fetchImpl });
  assert.deepEqual(seenArgv, ["./switch-model.sh", "uncensored"]);
  assert.equal(applied.body.ok, true);
  assert.equal(applied.body.state.variantId, "uncensored");
  assert.equal(applied.body.canaryState, "ready");
});
