import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeComponent,
  swapVariant,
  resolveRecordingPolicy,
  canRecordContent,
  discoverCapabilities,
  unknownIsNotZero,
  nextCounterSegments,
  findEmbeddedSecret,
  variantCompatibility,
} from "../runtimeProfile.js";

const stock = {
  id: "qwen38-27b-stock-sglang-tp1-gx10",
  name: "Qwen3.8-27B",
  tp: 1,
  machineClass: "dgx-spark-gb10-128g",
  engine: "sglang",
  ports: { engine: 8080, placeholder: true },
  model: {
    repo: "RadixArk/Qwen3.8-27B-NVFP4",
    revision: "52d1adc5f38aa5ebf099c29ed7025ba34cfbb854",
    servedModelName: "qwen3.8-27b",
    aliases: ["stock"],
  },
  memory_estimate_mb: { perSpark: 102400, basis: "measured" },
  flags: { context_length: 1010000 },
  variants: [
    {
      id: "stock",
      label: "stock",
      role: "standard",
      switchTarget: "stock",
      model: {
        repo: "RadixArk/Qwen3.8-27B-NVFP4",
        revision: "52d1adc5f38aa5ebf099c29ed7025ba34cfbb854",
        servedModelName: "qwen3.8-27b",
        aliases: ["stock"],
      },
    },
    {
      id: "uncensored",
      label: "uncensored",
      role: "uncensored",
      switchTarget: "uncensored",
      model: {
        repo: "edp1096/Huihui-RadixArk-Qwen3.8-27B-abliterated-NVFP4",
        revision: "21565d389fe573a32c1c425e0c7ade204ddb2263",
        servedModelName: "qwen3.8-27b",
        aliases: ["uncensored"],
      },
    },
    {
      id: "needs-vllm",
      label: "incompatible",
      requires: { engine: "vllm" },
      model: { servedModelName: "other" },
    },
  ],
};

test("normalize synthesizes a profile from existing catalog JSON (backward compatible)", () => {
  const { ok, component } = normalizeComponent(stock);
  assert.equal(ok, true);
  assert.equal(component.runtimeProfile.engine, "sglang");
  assert.equal(component.runtimeProfile.ports.engine, 8080);
  assert.equal(component.runtimeProfile.ports.guard, 8081);
  assert.equal(component.runtimeProfile.recording.content, "metadata");
  assert.equal(component.variants.length, 3);
  assert.equal(component.activeVariantId, "stock");
});

test("compatible stock→uncensored swap preserves profile, routes, recording, and segments history", () => {
  const { component } = normalizeComponent(stock);
  const rec = { content: "metadata", retentionHours: 24 };
  const first = swapVariant(component, "uncensored", {
    variantId: "stock",
    recording: rec,
    segments: [{ variantId: "stock", startedAt: 1, endedAt: null, open: true, baseline: "inherit" }],
  });
  assert.equal(first.ok, true);
  assert.equal(first.result.profileUnchanged, true);
  assert.deepEqual(first.result.runtimeProfile, component.runtimeProfile);
  assert.equal(first.result.variantId, "uncensored");
  assert.equal(first.result.previousVariantId, "stock");
  assert.equal(first.result.recording.content, "metadata");
  assert.equal(first.result.recording.retentionHours, 24);
  const closed = first.result.segments.find((s) => s.variantId === "stock");
  const opened = first.result.segments.find((s) => s.variantId === "uncensored" && s.open);
  assert.equal(closed.open, false);
  assert.ok(closed.endedAt);
  assert.ok(opened);
  assert.equal(opened.baseline, "inherit");
});

test("incompatible engine/protocol/topology/port is an explicit error, not a rewrite", () => {
  const { component } = normalizeComponent(stock);
  const bad = swapVariant(component, "needs-vllm");
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "incompatible-engine");
  assert.match(bad.error, /migrate/);
  const portBad = variantCompatibility(component.runtimeProfile, {
    requires: { ports: { engine: 30000 } },
  });
  assert.equal(portBad.ok, false);
  assert.equal(portBad.code, "incompatible-ports");
});

test("recording: metadata default; stricter-wins; content needs an observer", () => {
  const a = resolveRecordingPolicy([{ content: "prompts+responses", retentionHours: 48, maxBytes: 1000 }]);
  assert.equal(a.content, "metadata"); // no observer → cannot record payloads
  assert.match(a.blockedReason, /observer/);
  assert.equal(canRecordContent(a), false);

  const b = resolveRecordingPolicy([
    { content: "prompts+responses", observer: "litellm", retentionHours: 48, maxBytes: 10000 },
    { content: "metadata", retentionHours: 12, maxBytes: 1000 },
  ]);
  assert.equal(b.content, "metadata");
  assert.equal(b.retentionHours, 12);
  assert.equal(b.maxBytes, 1000);

  const c = resolveRecordingPolicy([
    { content: "prompts", observer: "relay", retentionHours: 24 },
    { content: "off" },
  ]);
  assert.equal(c.content, "off");
});

test("capability discovery: unknown/unavailable is not numeric zero", () => {
  const declared = [{ id: "sglang", support: "verified", capabilities: ["metrics"] }];
  const unknown = discoverCapabilities(declared, {});
  assert.equal(unknown[0].status, "unknown");
  assert.equal(unknownIsNotZero(unknown[0].value), null);

  const down = discoverCapabilities(declared, { sglang: { reachable: false, provenance: "probe", observedAt: 1 } });
  assert.equal(down[0].status, "unreachable");
  assert.equal(unknownIsNotZero(down[0].value), null);

  const up = discoverCapabilities(declared, {
    sglang: { reachable: true, supported: true, metrics: 12, provenance: "engine-prom", observedAt: 2 },
  });
  assert.equal(up[0].status, "supported+enabled");
  assert.equal(unknownIsNotZero(up[0].value), 12);
});

test("counter segments do not wipe prior variant history", () => {
  const segs = nextCounterSegments(
    [{ variantId: "stock", startedAt: 10, endedAt: null, open: true }],
    { previousVariantId: "stock", nextVariantId: "uncensored", at: 20 }
  );
  assert.equal(segs[0].variantId, "stock");
  assert.equal(segs[0].open, false);
  assert.equal(segs[0].endedAt, 20);
  assert.equal(segs[1].variantId, "uncensored");
  assert.equal(segs[1].open, true);
});

test("embedded raw secrets are rejected; env/file refs are allowed", () => {
  assert.ok(findEmbeddedSecret({ apiKey: "sk-live-not-a-ref" }));
  assert.equal(findEmbeddedSecret({ apiKeyRef: "env:GUARD_PROXY_KEY" }), null);
  const bad = normalizeComponent({ ...stock, runtimeProfile: { credentialRefs: ["env:OK"], apiKey: "hunter2" } });
  assert.equal(bad.ok, false);
});
