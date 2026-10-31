/**
 * Quality bench item sets and scoring (#42).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildQualityItems, makeRng, QUALITY_SUITE_VERSION } from "../quality/items.js";
import { QA_ITEMS } from "../quality/qa.js";
import {
  checkInstruction,
  expectedText,
  finalAnswerSegment,
  scoreChoice,
  scoreItem,
  scoreNumber,
  scoreOneOf,
  scoreShort,
  stripThinking,
} from "../quality/scoring.js";
import {
  QUALITY_CATEGORIES,
  QUALITY_CATEGORY_KEYS,
  QUALITY_DEFAULT_CATEGORIES,
  normalizeQualityCategories,
  qualityRequestCount,
} from "../../../src/shared/qualityBench.js";
import { SUITES } from "../../bench/results/adapters.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("catalog: six default categories, 755 requests; two opt-in", () => {
  assert.deepEqual(QUALITY_DEFAULT_CATEGORIES, ["qa", "reasoning", "arithmetic", "state", "gsm8k", "mmlu"]);
  assert.equal(qualityRequestCount(QUALITY_DEFAULT_CATEGORIES), 755);
  assert.deepEqual(
    QUALITY_CATEGORIES.filter((c) => c.optIn).map((c) => c.key),
    ["instruction", "longctx"]
  );
  assert.deepEqual(normalizeQualityCategories(["mmlu", "qa", "nope", "qa"]), ["qa", "mmlu"]);
  assert.deepEqual(normalizeQualityCategories("qa"), []);
});

test("builders produce the catalog counts with unique ids", () => {
  const items = buildQualityItems(QUALITY_CATEGORY_KEYS);
  for (const c of QUALITY_CATEGORIES) {
    assert.equal(items.filter((it) => it.category === c.key).length, c.count, c.key);
  }
  assert.equal(new Set(items.map((it) => it.id)).size, items.length);
  for (const it of items) {
    assert.ok(it.id.startsWith(`${it.category}-`), it.id);
    assert.ok(it.prompt.length > 0 && it.maxTokens > 0, it.id);
  }
  assert.equal(QA_ITEMS.length, 150);
});

test("item sets are pinned: changing them needs a suite version bump", () => {
  const items = buildQualityItems(QUALITY_CATEGORY_KEYS);
  const fp = crypto
    .createHash("sha256")
    .update(JSON.stringify(items.map((i) => [i.id, i.prompt, i.score, i.maxTokens])))
    .digest("hex");
  assert.equal(QUALITY_SUITE_VERSION, "1");
  assert.equal(SUITES.QualityBench.suite_version, QUALITY_SUITE_VERSION);
  assert.equal(fp, "9e08289352413803879ced0120118084494c5d87c41fe86b25da0303281860ad");
});

test("selection keeps catalog order and the same items", () => {
  const all = buildQualityItems(QUALITY_CATEGORY_KEYS);
  const some = buildQualityItems(["mmlu", "qa"]);
  assert.equal(some.length, 435);
  assert.equal(some[0].id, "qa-001");
  assert.deepEqual(some.at(-1), all.filter((i) => i.category === "mmlu").at(-1));
});

test("generated items are self-consistent", () => {
  const items = buildQualityItems(["arithmetic", "state", "reasoning", "longctx"]);
  for (const it of items) {
    if (it.category === "longctx") {
      // The needle's code is in the prompt and is the expected answer.
      assert.ok(it.prompt.includes(String(it.score.expected)), it.id);
    }
    assert.notEqual(expectedText(it), "", it.id);
    // The expected answer, on an answer line, scores as a pass.
    assert.equal(scoreItem(it, `Answer: ${expectedText(it)}`), true, it.id);
  }
});

test("bundled data files are MIT with attribution", () => {
  const dir = path.resolve(__dirname, "../data/quality");
  for (const f of ["gsm8k-test-200.json", "mmlu-dev-285.json"]) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.equal(doc.license, "MIT", f);
    assert.ok(doc.source, f);
  }
  const notice = fs.readFileSync(path.resolve(__dirname, "../data/NOTICE.md"), "utf8");
  assert.match(notice, /Copyright \(c\) 2021 OpenAI/);
  assert.match(notice, /Dan Hendrycks/);
});

test("mulberry32 is stable and seed-sensitive", () => {
  const seq = (seed) => {
    const r = makeRng(seed);
    return Array.from({ length: 8 }, () => r.int(0, 999));
  };
  assert.deepEqual(seq(4242), seq(4242));
  assert.notDeepEqual(seq(4242), seq(4243));
  assert.ok(seq(1).every((n) => n >= 0 && n <= 999));
});

test("answer extraction: last Answer line, think blocks, markup", () => {
  assert.equal(stripThinking("<think>Answer: 3</think>Answer: 4").trim(), "Answer: 4");
  assert.equal(finalAnswerSegment("2+2\nAnswer: **4**"), "4");
  assert.equal(finalAnswerSegment("answer is: \\boxed{12}"), "12");
  assert.equal(finalAnswerSegment("first\n\nParis\n"), "Paris");
  assert.equal(finalAnswerSegment("Answer: 3\nwait\nAnswer: 5"), "5");
});

test("scorers", () => {
  assert.equal(scoreShort(["Paris"], "The capital is Paris."), true);
  assert.equal(scoreShort(["Paris"], "Lyon"), false);
  assert.equal(scoreShort(["Fe"], "fe", true), false);
  assert.equal(scoreShort(["Fe"], "Fe", true), true);
  assert.equal(scoreNumber(1234, "so 1,000 + 234\nAnswer: 1,234"), true);
  assert.equal(scoreNumber(18, "Answer: 18 dollars"), true);
  assert.equal(scoreNumber(18, "Answer: 17"), false);
  assert.equal(scoreChoice("B", "Answer: B) because"), true);
  assert.equal(scoreChoice("B", "Answer: A"), false);
  assert.equal(scoreOneOf("Alice", ["Alice", "Bob"], "Answer: Alice"), true);
  assert.equal(scoreOneOf("Alice", ["Alice", "Bob"], "Answer: Alice or Bob"), false);
});

test("instruction checks", () => {
  assert.equal(checkInstruction({ type: "upper" }, "THE OCEAN IS WIDE."), true);
  assert.equal(checkInstruction({ type: "upper" }, "The ocean."), false);
  assert.equal(checkInstruction({ type: "json_keys", keys: { name: "string", age: "number" } }, '{"name":"a","age":3}'), true);
  assert.equal(checkInstruction({ type: "json_keys", keys: { name: "string", age: "number" } }, '{"name":"a"}'), false);
});
