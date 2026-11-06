import test from "node:test";
import assert from "node:assert/strict";
import { bindRelayCapture, listInstancesForBind } from "../recordingBind.js";

function inst(over = {}) {
  return {
    nodeId: "n1",
    componentId: over.componentId || "comp-a",
    variantId: over.variantId || "stock",
    variantGeneration: over.variantGeneration ?? 1,
    recording: over.recording || { content: "prompts+responses", observer: "relay" },
    ports: over.ports || { engine: 8080, guard: null },
    servedModelName: over.servedModelName || "qwen-stock",
  };
}

test("bind matches the request upstream port, not the latest instance key", () => {
  const instances = [
    inst({ componentId: "comp-a", ports: { engine: 8080 }, variantId: "stock" }),
    inst({ componentId: "comp-b", ports: { engine: 8090 }, variantId: "flash", recording: { content: "metadata", observer: "relay" } }),
  ];
  const a = bindRelayCapture({ listenPort: 18080, upstreamPort: 8080, path: "/v1/chat/completions" }, instances);
  assert.equal(a.ok, true);
  assert.equal(a.componentId, "comp-a");
  assert.equal(a.variantId, "stock");
  assert.equal(a.policy.content, "prompts+responses");
  const b = bindRelayCapture({ listenPort: 18090, upstreamPort: 8090 }, instances);
  assert.equal(b.componentId, "comp-b");
  assert.equal(b.policy.content, "metadata");
});

test("unbound or multi-instance same port fail closed", () => {
  const none = bindRelayCapture({ upstreamPort: 8080 }, [inst({ ports: { engine: 8090 } })]);
  assert.equal(none.ok, false);
  assert.equal(none.code, "unbound");
  const amb = bindRelayCapture({ upstreamPort: 8080 }, [
    inst({ componentId: "comp-a", ports: { engine: 8080 } }),
    inst({ componentId: "comp-b", ports: { engine: 8080 }, servedModelName: "other" }),
  ]);
  assert.equal(amb.ok, false);
  assert.equal(amb.code, "ambiguous");
});

test("start-of-request snapshot is not changed by a later variant swap", () => {
  const rows = [inst({ variantId: "stock", variantGeneration: 3 })];
  const bound = bindRelayCapture({ upstreamPort: 8080 }, rows);
  rows[0].variantId = "uncensored";
  rows[0].variantGeneration = 4;
  assert.equal(bound.variantId, "stock");
  assert.equal(bound.variantGeneration, 3);
});

test("listInstancesForBind reads ports from the catalog when the instance omits them", () => {
  const store = { instances: { "n1/comp-a": { variantId: "stock", recording: { content: "off" } } } };
  const listed = listInstancesForBind(store, [{ id: "comp-a", runtimeProfile: { ports: { engine: 8080 } } }]);
  assert.equal(listed[0].ports.engine, 8080);
  assert.equal(listed[0].recording.content, "off");
});
