/**
 * stacks-catalog.test.js — tests for the SC2 stack data model
 * (agent/catalog/stacks-catalog.js): validation, merge/dedup, bootstrap.
 *
 * Pure functions (validateStack / validateStacksFile / mergeStacks /
 * bootstrapStacks) take arrays, touch no fs. StackStore is exercised against
 * a temp file in os.tmpdir (cleaned up in the same test).
 *
 * Run: node --test agent/catalog/__tests__/stacks-catalog.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  validateStack,
  validateStacksFile,
  mergeStacks,
  bootstrapStacks,
  createStackStore,
} from "../stacks-catalog.js";

// ── fixtures ────────────────────────────────────────────────

const S1 = { id: "alpha", name: "Alpha", componentNames: ["comp-a"], category: "calculated" };
const S1R = { id: "alpha", name: "Alpha v2", componentNames: ["comp-a", "comp-b"], category: "calculated" };
const S2 = { id: "beta", name: "Beta", componentNames: ["comp-c"], category: "calculated" };

// ── validateStack ───────────────────────────────────────────

test("validateStack: accepts a minimal valid stack and one with notes", () => {
  assert.deepEqual(validateStack(S1), []);
  assert.deepEqual(validateStack({ ...S2, notes: "hi" }), []);
});

test("validateStack: rejects bad id, empty name, empty/dup/non-string components", () => {
  assert.ok(validateStack({ ...S1, id: "Alpha" }).length === 1); // uppercase
  assert.ok(validateStack({ ...S1, id: "-x" }).length === 1); // leading dash
  assert.ok(validateStack({ ...S1, name: "  " }).length === 1);
  assert.ok(validateStack({ ...S1, componentNames: [] }).length === 1);
  assert.ok(validateStack({ ...S1, componentNames: ["a", "a"] }).length === 1);
  assert.ok(validateStack({ ...S1, componentNames: [7] }).length === 1);
  assert.ok(validateStack(null).length === 1);
  assert.ok(validateStack([]).length === 1);
});

test("validateStacksFile: version must be 1, stacks must be array, ids unique", () => {
  assert.deepEqual(validateStacksFile({ version: 1, stacks: [S1, S2] }), []);
  assert.ok(validateStacksFile({ version: 2, stacks: [] })[0].includes("version"));
  assert.ok(validateStacksFile({ version: 1, stacks: "nope" })[0].includes("array"));
  const dup = validateStacksFile({ version: 1, stacks: [S1, S1R] });
  assert.ok(dup.some((e) => e.includes('duplicate id "alpha"')));
});

// ── mergeStacks (external retrieval, dedup, extend/replace) ─

test("mergeStacks: adds new ids, replaces same id in place (incoming wins)", () => {
  const r = mergeStacks([S1, S2], [S1R]);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.replaced, ["alpha"]);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.stacks.map((s) => s.name), ["Alpha v2", "Beta"]);
  assert.equal(r.stacks[0], S1R);
});

test("mergeStacks: appends unseen ids after existing order", () => {
  const r = mergeStacks([S1], [S2, { id: "gamma", name: "G", componentNames: ["x"] }]);
  assert.deepEqual(r.stacks.map((s) => s.id), ["alpha", "beta", "gamma"]);
  
  assert.deepEqual(r.added, ["beta", "gamma"]);
});

test("mergeStacks: invalid incoming entries are skipped, never merged", () => {
  const r = mergeStacks([S1], [{ id: "BAD" }, null, S2]);
  assert.deepEqual(r.skipped, ["BAD", "<invalid>"]);
  assert.deepEqual(r.stacks.map((s) => s.id), ["alpha", "beta"]);
});

test("mergeStacks: garbage existing/incoming never throws", () => {
  assert.deepEqual(mergeStacks(undefined, undefined).stacks, []);
  assert.deepEqual(mergeStacks("nope", 7).stacks, []);
});

// ── bootstrapStacks (POC step 1: the two Hasso recipes) ────

test("bootstrapStacks: the two Hasso-derived stacks, valid, unique ids", () => {
  const bs = bootstrapStacks();
  assert.equal(bs.length, 2);
  assert.deepEqual(validateStacksFile({ version: 1, stacks: bs }), []);
  assert.deepEqual(bs.map((s) => s.id), ["hasso-27b-stock", "hasso-flash-next"]);
  assert.deepEqual(bs[0].componentNames, ["qwen38-27b-stock-sglang-tp1-gx10"]);
  assert.deepEqual(bs[1].componentNames, ["qwen38-flash-next-sglang-tp1-gx10"]);
});

// ── StackStore (storage: agent/config/stacks.json) ─────────

test("StackStore: missing file bootstraps and persists; reload round-trips", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stacks-test-"));
  const file = path.join(dir, "stacks.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = createStackStore(file).load();
  assert.deepEqual(store.stacks.map((s) => s.id), ["hasso-27b-stock", "hasso-flash-next"]);
  assert.ok(fs.existsSync(file));

  const again = createStackStore(file).load();
  assert.deepEqual(again.stacks.map((s) => s.id), ["hasso-27b-stock", "hasso-flash-next"]);
  assert.deepEqual(again.errors, []);
});

test("StackStore: mergeExternal dedupes by id and persists", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stacks-test-"));
  const file = path.join(dir, "stacks.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = createStackStore(file).load();
  const report = store.mergeExternal({
    version: 1,
    stacks: [{ id: "hasso-27b-stock", name: "Custom 27B", componentNames: ["my-component"] }, { id: "custom", name: "Custom", componentNames: ["c"] }],
  });
  assert.deepEqual(report.replaced, ["hasso-27b-stock"]);
  
  assert.deepEqual(report.added, ["custom"]);
  assert.equal(store.get("hasso-27b-stock").name, "Custom 27B");

  const reloaded = createStackStore(file).load();
  assert.deepEqual(reloaded.stacks.map((s) => s.id), ["hasso-27b-stock", "hasso-flash-next", "custom"]);
});

test("StackStore: corrupt file degrades to empty with a reported error, no write", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stacks-test-"));
  const file = path.join(dir, "stacks.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(file, "{not json");

  const store = createStackStore(file).load();
  assert.equal(store.stacks.length, 0);
  assert.ok(store.errors.some((e) => e.includes("unreadable")));
});

test("StackStore: bad entries dropped fail-soft, good entries kept", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stacks-test-"));
  const file = path.join(dir, "stacks.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, stacks: [S1, { id: "BAD ID" }, S2] })
  );

  const store = createStackStore(file).load();
  assert.deepEqual(store.stacks.map((s) => s.id), ["alpha", "beta"]);
  assert.ok(store.errors.some((e) => e.includes("dropped")));
});

test("StackStore: stored category is a hint; load recomputes it from footprints", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stacks-test-"));
  const file = path.join(dir, "stacks.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (category) =>
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        stacks: [{ id: "big", name: "Big", componentNames: ["a", "b"], category }],
      })
    );

  // 128 GB box, two ~50 GB components: sum 102400 over effective usable
  // (131072 - 3072 - 10485 = 117515) → 0.871 → not_recommended, whatever was stored.
  write("calculated");
  const tight = createStackStore(file, {
    totalMB: 131072,
    footprintsMB: { a: 51200, b: 51200 },
  }).load();
  assert.equal(tight.get("big").category, "not_recommended");

  // A stored "blocked" hint is likewise replaced by the live math.
  write("blocked");
  const ok = createStackStore(file, {
    totalMB: 131072,
    footprintsMB: { a: 4096, b: 4096 },
  }).load();
  assert.equal(ok.get("big").category, "calculated");

  // Proven is the history override (SC4), not a definition: it survives
  // recomputation against the same tight footprints.
  write("proven");
  const proven = createStackStore(file, {
    totalMB: 131072,
    footprintsMB: { a: 51200, b: 51200 },
  }).load();
  assert.equal(proven.get("big").category, "proven");
});
