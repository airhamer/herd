/**
 * library.test.js — SC6 library collector (agent/collectors/library.js):
 * pin claims from the validated recipe store, engine-image pinning by
 * digest, HF-cache checkpoint scan with pinned/unpinned/stray/missing
 * verdicts, fail-soft raw sources (docker/du/readdir → null + reported
 * error, never a fabricated value), and the telemetry seam (opts.recipes
 * passthrough, fail-soft recipe load note).
 *
 * Pure verdicts (checkpointPinStatus / engineImagePinned / buildPinsIndex)
 * are known-answer tested; the collect runs against an injected exec and
 * real temp dirs in os.tmpdir (like stacks-catalog.test.js).
 *
 * Run: node --test agent/collectors/__tests__/library.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  normalizeDigest,
  hex40Or64,
  extractPins,
  buildPinsIndex,
  checkpointPinStatus,
  engineImagePinned,
  isEngineImage,
  defaultModelRoots,
  collectLibrary,
} from "../library.js";

const D = (c) => c.repeat(64).slice(0, 64); // exactly 64 chars
const C = (c) => c.repeat(40); // 40-hex filler

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "herd-library-test-"));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Build an HF-cache model dir: models--org--name/{refs,snapshots}. */
function hfModel(root, dirName, { refs = {}, snapshots = [] }) {
  const full = path.join(root, dirName);
  const refsDir = path.join(full, "refs");
  const snapsDir = path.join(full, "snapshots");
  fs.mkdirSync(refsDir, { recursive: true });
  fs.mkdirSync(snapsDir, { recursive: true });
  for (const [name, rev] of Object.entries(refs)) {
    fs.writeFileSync(path.join(refsDir, name), String(rev) + String.fromCharCode(10));
  }
  for (const snap of snapshots) {
    fs.mkdirSync(path.join(snapsDir, String(snap)), { recursive: true });
  }
  return full;
}

// ── pure verdicts (known-answer) ──────────────────────────────

test("normalizeDigest: sha256-prefixed and bare-hex forms, rejects junk", () => {
  assert.equal(normalizeDigest("sha256:" + D("a")), "sha256:" + D("a"));
  assert.equal(normalizeDigest(D("ab")), "sha256:" + D("ab"));
  assert.equal(normalizeDigest("sha256:" + D("AB")), "sha256:" + D("ab")); // case-folded
  assert.equal(normalizeDigest("  " + D("f") + " "), "sha256:" + D("f"));
  assert.equal(normalizeDigest(""), null);
  assert.equal(normalizeDigest(null), null);
  assert.equal(normalizeDigest("sha256:" + D("a").slice(0, 63)), null);
  assert.equal(normalizeDigest("sha512:" + D("a")), null);
  assert.equal(normalizeDigest("deadbeef"), null);
});

test("extractPins: image + model claims, malformed claims dropped", () => {
  const ok = extractPins({
    name: "llm-a",
    image: "lmsysorg/sglang",
    imageDigest: "sha256:" + D("a"),
    modelPath: "RadixArk/Qwen3.8-27B-NVFP4",
    modelRevision: C("b"),
  });
  assert.deepEqual(ok.image, { digest: "sha256:" + D("a") });
  assert.deepEqual(ok.model, { model: "RadixArk/Qwen3.8-27B-NVFP4", revision: C("b") });

  assert.deepEqual(extractPins({ name: "x", imageDigest: "not-a-digest" }), { image: null, model: null });
  assert.deepEqual(extractPins({ name: "x", modelPath: "a/b", modelRevision: "short" }), { image: null, model: null });
  assert.deepEqual(extractPins({ name: "x", modelPath: "", modelRevision: C("c") }), { image: null, model: null });
  // non-hex filler ("z" repeated) is not a git sha — dropped, never guessed
  assert.deepEqual(extractPins({ name: "x", modelPath: "a/b", modelRevision: C("z") }), { image: null, model: null });
  assert.deepEqual(extractPins(null), { image: null, model: null });
  assert.deepEqual(extractPins("nope"), { image: null, model: null });
});

test("hex40Or64: 40/64 hex accepted, everything else rejected", () => {
  assert.equal(hex40Or64(C("a")), true);
  assert.equal(hex40Or64("a".repeat(40).toUpperCase()), true); // case-folded
  assert.equal(hex40Or64(D("f")), true);
  assert.equal(hex40Or64(" " + C("0") + " "), true); // trimmed
  assert.equal(hex40Or64(C("z")), false); // z is not hex
  assert.equal(hex40Or64("a".repeat(41)), false); // wrong length
  assert.equal(hex40Or64(""), false);
  assert.equal(hex40Or64(null), false);
});

test("buildPinsIndex: accumulates recipes per digest/model+rev", () => {
  const idx = buildPinsIndex([
    { name: "a", image: "img", imageDigest: "sha256:" + D("a") },
    { name: "b", image: "img", imageDigest: D("a") }, // bare hex, same digest
    { name: "c", modelPath: "Org/M", modelRevision: C("b") },
    { name: "d", modelPath: "Org/M", modelRevision: C("b").toUpperCase() },
    { name: "e" }, // no claims
    null,
    "junk",
  ]);
  assert.deepEqual(idx.byDigest.get("sha256:" + D("a")), ["a", "b"]);
  assert.deepEqual(idx.byModel.get("Org/M").get(C("b")), ["c", "d"]);
  assert.deepEqual(buildPinsIndex(undefined).byDigest.size, 0);
  assert.deepEqual(buildPinsIndex("not-an-array").byModel.size, 0);
});

test("checkpointPinStatus: pinned / stray / unpinned (negative case proves rejects)", () => {
  const claims = [{ revision: C("a") }];
  assert.equal(checkpointPinStatus(C("a"), claims), "pinned");
  assert.equal(checkpointPinStatus(C("a").toUpperCase(), claims), "pinned"); // case-folded
  assert.equal(checkpointPinStatus(C("b"), claims), "stray"); // drift next to the pin
  assert.equal(checkpointPinStatus(C("b"), []), "unpinned"); // ungoverned ≠ drift
  assert.equal(checkpointPinStatus(C("b"), null), "unpinned");
});

test("engineImagePinned: digest match across prefixed/bare forms", () => {
  assert.equal(engineImagePinned("sha256:" + D("a"), [D("a")]), true);
  assert.equal(engineImagePinned(D("a"), ["sha256:" + D("a")]), true);
  assert.equal(engineImagePinned("sha256:" + D("b"), ["sha256:" + D("a")]), false);
  assert.equal(engineImagePinned(null, ["sha256:" + D("a")]), false);
  assert.equal(engineImagePinned("sha256:" + D("a"), []), false);
});

test("isEngineImage: engine substrings, negative on unrelated", () => {
  assert.equal(isEngineImage("lmsysorg/sglang"), true);
  assert.equal(isEngineImage("ghcr.io/aeon-7/aeon-vllm-ultimate"), true);
  assert.equal(isEngineImage("postgres:16"), false);
});

test("defaultModelRoots: env override first, deduped", () => {
  const roots = defaultModelRoots({ HERD_MODEL_ROOTS: "/srv/models", HF_HOME: "/hf" });
  assert.equal(roots[0], "/srv/models");
  assert.ok(roots.includes(path.join("/hf", "hub")));
  assert.ok(roots.includes("/host/root/.cache/huggingface/hub"));
  assert.ok(roots.includes("/host/models"));
});

// ── collectLibrary ─────────────────────────────────────────────

test("collectLibrary: docker rows parsed; pin claims match by digest (moved tag stays pinned)", async () => {
  const root = tmpRoot();
  try {
    const recipes = [
      { name: "llm-a", kind: "llm", engine: "sglang", port: 8080, image: "lmsysorg/sglang", footprintMB: 1, imageDigest: "sha256:" + D("a") },
    ];
    const exec = async (cmd) => {
      if (cmd.startsWith("docker images")) {
        return [
          "lmsysorg/sglang v0.5.22 sha256:" + D("a") + " 21.4GB abc123def456",
          "postgres 16 <none> 612MB ee9876543210",
        ].join("\n");
      }
      throw new Error("unexpected: " + cmd);
    };
    const rep = await collectLibrary({ exec, recipes, env: { HERD_MODEL_ROOTS: root } });
    assert.equal(rep.version, 1);
    assert.equal(rep.engineImages.length, 2);
    const sg = rep.engineImages.find((i) => i.reference === "lmsysorg/sglang");
    assert.equal(sg.pinned, true);
    assert.deepEqual(sg.pinnedBy, ["llm-a"]);
    assert.equal(sg.inferenceEngine, true);
    const pg = rep.engineImages.find((i) => i.reference === "postgres");
    assert.equal(pg.inferenceEngine, false);
    assert.equal(pg.pinned, false);
    // image pin claim resolved present
    const imgPin = rep.pins.find((p) => p.kind === "image");
    assert.deepEqual(imgPin, { kind: "image", recipe: "llm-a", ref: "sha256:" + D("a"), present: true, status: "pinned" });
    assert.deepEqual(rep.errors, []);
  } finally {
    cleanup(root);
  }
});

test("collectLibrary: unmet image pin → finding in pins AND errors", async () => {
  const root = tmpRoot();
  try {
    const exec = async () => ""; // no images at all
    const rep = await collectLibrary({
      exec,
      recipes: [{ name: "llm-a", image: "img", imageDigest: "sha256:" + D("a") }],
      env: { HERD_MODEL_ROOTS: root },
    });
    const imgPin = rep.pins.find((p) => p.kind === "image");
    assert.equal(imgPin.present, false);
    assert.equal(imgPin.status, "missing");
    assert.ok(rep.errors.some((e) => e.includes(D("a").slice(0, 12)) && e.includes("llm-a")));
  } finally {
    cleanup(root);
  }
});

test("collectLibrary: HF scan — pinned / stray / unpinned / missing, refs fold + drift surfaced", async () => {
  const root = tmpRoot();
  try {
    hfModel(root, "models--RadixArk--Qwen3.8-27B-NVFP4", {
      refs: { main: C("a"), other: C("c"), pinnedRef: C("e") }, // main→pinned snapshot; other is ungoverned noise; pinnedRef names the absent pin
      snapshots: [C("a"), C("b")],
    });
    hfModel(root, "models--Some--Ungoverned", { refs: {}, snapshots: [C("d")] });
    fs.mkdirSync(path.join(root, "plain-model"), { recursive: true });

    const recipes = [
      { name: "llm-a", image: "img", modelPath: "RadixArk/Qwen3.8-27B-NVFP4", modelRevision: C("a") },
      { name: "llm-b", image: "img", modelPath: "RadixArk/Qwen3.8-27B-NVFP4", modelRevision: C("e") }, // absent → missing
    ];
    const exec = async (cmd) => {
      if (cmd.startsWith("docker images")) return "";
      if (cmd.startsWith("du -sb")) return "12345678";
      throw new Error("unexpected: " + cmd);
    };
    const rep = await collectLibrary({ exec, recipes, env: { HERD_MODEL_ROOTS: root } });

    const byRev = (rev) => rep.checkpoints.filter((c) => c.revision === rev);
    // pinned snapshot
    const pinned = byRev(C("a")).find((c) => c.refName === null);
    assert.equal(pinned.status, "pinned");
    assert.deepEqual(pinned.pinnedBy, ["llm-a"]);
    assert.equal(pinned.sizeBytes, 12345678);
    // stray snapshot (model has pins, this matches none)
    assert.equal(byRev(C("b"))[0].status, "stray");
    // named ref drift whose target is NOT a materialized snapshot surfaces
    // with its own verdict: pinned when it names the pin (pinnedRef → C(e)).
    const refPin = byRev(C("e")).find((c) => c.refName === "pinnedRef");
    assert.equal(refPin.status, "pinned");
    assert.deepEqual(refPin.pinnedBy, ["llm-b"]);
    // the same absent revision ALSO yields a missing entry — a pin claim not
    // materialized on disk is a pull finding even when a ref names it.
    const missingEntries = byRev(C("e")).filter((c) => c.status === "missing");
    assert.equal(missingEntries.length, 1);
    // an ungoverned named ref pointing at an absent snapshot ("other") is
    // noise and stays dropped (negative case — proves the drop rejects it).
    assert.equal(byRev(C("c")).length, 0);
    // main ref folds into the pinned snapshot (no duplicate entry)
    assert.equal(byRev(C("a")).filter((c) => c.refName === "main").length, 0);
    // ungoverned model: unpinned, never missing/stray
    assert.equal(byRev(C("d"))[0].status, "unpinned");
    assert.deepEqual(byRev(C("d"))[0].pinnedBy, []);
    // missing pin finding (by status — the ref entry shares this revision)
    const missing = missingEntries[0];
    assert.equal(missing.status, "missing");
    assert.deepEqual(missing.pinnedBy, ["llm-b"]);
    assert.equal(missing.sizeBytes, null);
    // ungoverned model never produces a missing entry
    assert.equal(rep.checkpoints.filter((c) => c.model === "Some/Ungoverned" && c.status === "missing").length, 0);
    // plain model dir fallback
    const plain = rep.checkpoints.find((c) => c.model === "plain-model");
    assert.equal(plain.revision, "<dir>");
    assert.equal(plain.status, "unpinned");
    // model pin claims resolved
    const modelPins = rep.pins.filter((p) => p.kind === "model");
    assert.equal(modelPins.find((p) => p.ref === `RadixArk/Qwen3.8-27B-NVFP4@${C("a")}`).status, "pinned");
    // disk truth: a ref naming an absent revision does NOT make it present
    assert.equal(modelPins.find((p) => p.ref === `RadixArk/Qwen3.8-27B-NVFP4@${C("e")}`).status, "missing");
  } finally {
    cleanup(root);
  }
});

test("collectLibrary: du failure → null size + error, never 0", async () => {
  const root = tmpRoot();
  try {
    hfModel(root, "models--Org--M", { snapshots: [C("a")] });
    const exec = async (cmd) => {
      if (cmd.startsWith("docker images")) return "";
      throw new Error("du: not found");
    };
    const rep = await collectLibrary({ exec, recipes: [], env: { HERD_MODEL_ROOTS: root } });
    assert.equal(rep.checkpoints[0].sizeBytes, null);
    assert.ok(rep.errors.some((e) => e.startsWith("du ")));
  } finally {
    cleanup(root);
  }
});

test("collectLibrary: docker failure → empty engineImages + error; absent roots silent, unreadable root reported", async () => {
  const exec = async () => {
    throw new Error("docker: command not found");
  };
  const rep = await collectLibrary({ exec, recipes: [], env: { HERD_MODEL_ROOTS: "/definitely/not/here" } });
  assert.deepEqual(rep.engineImages, []);
  assert.ok(rep.errors.some((e) => e.startsWith("docker images:")));
  assert.ok(!rep.errors.some((e) => e.includes("definitely/not/here"))); // ENOENT is absence, not a failure
});

test("collectLibrary: no recipes given → fail-soft load (missing file reported), disk truth still collected", async () => {
  const root = tmpRoot();
  try {
    hfModel(root, "models--Org--M", { snapshots: [C("a")] });
    const exec = async (cmd) => {
      if (cmd.startsWith("docker images")) return "";
      if (cmd.startsWith("du -sb")) return "42";
      throw new Error("unexpected: " + cmd);
    };
    const rep = await collectLibrary({
      exec,
      recipePath: path.join(root, "missing-recipes.json"),
      env: { HERD_MODEL_ROOTS: root },
    });
    assert.ok(rep.errors.some((e) => e.includes("recipes unavailable")));
    assert.equal(rep.checkpoints[0].status, "unpinned"); // disk truth without pins
    assert.deepEqual(rep.pins, []);
  } finally {
    cleanup(root);
  }
});

test("collectLibrary: pinsNote from the caller's fail-soft load is reported", async () => {
  const root = tmpRoot();
  try {
    const rep = await collectLibrary({
      exec: async () => "",
      recipes: [],
      pinsNote: "recipes unavailable: ENOENT — library reports disk truth with no pins",
      env: { HERD_MODEL_ROOTS: root },
    });
    assert.ok(rep.errors.some((e) => e.includes("recipes unavailable")));
  } finally {
    cleanup(root);
  }
});

test("collectLibrary: never throws on junk inputs", async () => {
  const rep = await collectLibrary({ recipes: "not-an-array", env: null, exec: undefined });
  assert.equal(typeof rep, "object");
  assert.equal(rep.version, 1);
  assert.ok(Array.isArray(rep.errors));
});
