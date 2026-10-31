/**
 * Quality bench item sets (#42).
 *
 * QA comes from qa.js. Reasoning, arithmetic chain, state tracking,
 * instruction following and long-context recall are generated here from a
 * fixed seed, so every run (and every machine) gets the same prompts. GSM8K
 * and MMLU samples are bundled MIT data (see ../data/NOTICE.md).
 *
 * Changing a generator changes the items: bump QUALITY_SUITE_VERSION when you
 * do, so old and new runs are never compared as like with like.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { QA_ITEMS } from "./qa.js";
import { QUALITY_CATEGORY_KEYS } from "../../../src/shared/qualityBench.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data/quality");

export const QUALITY_SUITE_VERSION = "1";
/** Seed for item generation and the `seed` sent with every request. */
export const QUALITY_SEED = 4242;

const ANSWER_LINE = "Think step by step if you need to, then end with a final line of the form 'Answer: <answer>'.";

/** Small, fast, deterministic PRNG (mulberry32). */
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** Integer in [lo, hi]. */
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle(arr) {
      const a2 = [...arr];
      for (let i = a2.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a2[i], a2[j]] = [a2[j], a2[i]];
      }
      return a2;
    },
  };
}

/** Per-category seed so adding a category never shifts another's items. */
function categoryRng(key) {
  let h = QUALITY_SEED;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return makeRng(h);
}

const pad = (n, w = 3) => String(n).padStart(w, "0");

/**
 * @typedef {{
 *   id: string,
 *   category: string,
 *   prompt: string,
 *   maxTokens: number,
 *   score: { kind: string, [k: string]: any },
 * }} QualityItem
 */

// ─── QA ───────────────────────────────────────────────────────────────

function qaItems() {
  return QA_ITEMS.map((it, i) => ({
    id: `qa-${pad(i + 1)}`,
    category: "qa",
    prompt: `${it.q} Reply with the answer only.`,
    maxTokens: 48,
    score: { kind: "short", answers: it.answers, cs: it.cs },
  }));
}

// ─── Reasoning ────────────────────────────────────────────────────────

const PEOPLE = ["Alice", "Bruno", "Chen", "Dara", "Elif", "Farid", "Greta", "Hugo", "Ines", "Jonas", "Kofi", "Lena"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ATTRS = [
  { more: "taller than", top: "the tallest", bottom: "the shortest", second: "the second tallest" },
  { more: "older than", top: "the oldest", bottom: "the youngest", second: "the second oldest" },
  { more: "faster than", top: "the fastest", bottom: "the slowest", second: "the second fastest" },
];
const NONSENSE = ["blicks", "dorps", "florbs", "glims", "snarks", "wugs", "zorbs", "quibs", "tovs", "mimsies"];
const SYLLOGISMS = [
  { text: (a, b, c) => `All ${a} are ${b}. All ${b} are ${c}. Must every one of the ${a} be one of the ${c}?`, answer: "yes" },
  { text: (a, b, c) => `All ${a} are ${b}. Some ${b} are ${c}. Must at least one of the ${a} be one of the ${c}?`, answer: "no" },
  { text: (a, b, c) => `No ${a} are ${b}. All ${c} are ${b}. Can any of the ${c} be one of the ${a}?`, answer: "no" },
  { text: (a, b, c) => `All ${a} are ${b}. All ${c} are ${b}. Must every one of the ${a} be one of the ${c}?`, answer: "no" },
  { text: (a, b, c) => `All ${a} are ${b}. Some ${c} are ${a}. Must at least one of the ${c} be one of the ${b}?`, answer: "yes" },
];

function reasoningItems() {
  const rng = categoryRng("reasoning");
  const out = [];
  const push = (prompt, score) =>
    out.push({ id: `reasoning-${pad(out.length + 1)}`, category: "reasoning", prompt: `${prompt}\n\n${ANSWER_LINE}`, maxTokens: 384, score });

  for (let i = 0; i < 10; i++) {
    const n = 4 + (i % 2);
    const order = rng.shuffle(PEOPLE).slice(0, n);
    const attr = ATTRS[i % 3];
    const facts = rng.shuffle(order.slice(0, -1).map((p, k) => `${p} is ${attr.more} ${order[k + 1]}.`));
    const ask = i % 3;
    const [q, expected] =
      ask === 0 ? [attr.top, order[0]] : ask === 1 ? [attr.bottom, order[n - 1]] : [attr.second, order[1]];
    push(`${facts.join(" ")} Who is ${q}?`, { kind: "one_of", expected, options: order });
  }
  for (let i = 0; i < 10; i++) {
    const d0 = rng.int(0, 6);
    const n = rng.int(10, 100);
    push(`Today is ${DAYS[d0]}. What day of the week will it be ${n} days from today?`, {
      kind: "one_of",
      expected: DAYS[(d0 + n) % 7],
      options: DAYS,
    });
  }
  for (let i = 0; i < 10; i++) {
    const [p1, p2, p3] = rng.shuffle(PEOPLE).slice(0, 3);
    const z = rng.int(30, 60);
    const y = rng.int(2, 15);
    const x = rng.int(1, 12);
    push(`${p1} is ${x} years older than ${p2}. ${p2} is ${y} years younger than ${p3}. ${p3} is ${z} years old. How old is ${p1}?`, {
      kind: "number",
      expected: z - y + x,
    });
  }
  for (let i = 0; i < 10; i++) {
    const [a, b, c] = rng.shuffle(NONSENSE).slice(0, 3);
    const form = SYLLOGISMS[i % SYLLOGISMS.length];
    push(`${form.text(a, b, c)} Answer yes or no.`, { kind: "one_of", expected: form.answer, options: ["yes", "no"] });
  }
  return out;
}

// ─── Arithmetic chain ─────────────────────────────────────────────────

function arithmeticItems() {
  const rng = categoryRng("arithmetic");
  const out = [];
  for (let i = 0; i < 40; i++) {
    let v = rng.int(2, 50);
    const steps = [`Start with ${v}.`];
    const nSteps = 5 + (i % 4);
    while (steps.length <= nSteps) {
      const op = rng.int(0, 3);
      if (op === 0) {
        const k = rng.int(1, 30);
        v += k;
        steps.push(`Add ${k}.`);
      } else if (op === 1) {
        const k = rng.int(1, 30);
        v -= k;
        steps.push(`Subtract ${k}.`);
      } else if (op === 2) {
        const k = rng.int(2, 5);
        if (Math.abs(v * k) > 5000) continue;
        v *= k;
        steps.push(`Multiply by ${k}.`);
      } else {
        const k = rng.int(2, 5);
        if (v === 0 || v % k !== 0) continue;
        v /= k;
        steps.push(`Divide by ${k}.`);
      }
    }
    out.push({
      id: `arithmetic-${pad(i + 1)}`,
      category: "arithmetic",
      prompt: `${steps.join(" ")} What is the final number?\n\n${ANSWER_LINE}`,
      maxTokens: 384,
      score: { kind: "number", expected: v },
    });
  }
  return out;
}

// ─── State tracking ───────────────────────────────────────────────────

const OBJECTS = ["key", "coin", "ring", "marble", "stamp", "button", "shell", "feather", "pebble", "ticket"];

function stateItems() {
  const rng = categoryRng("state");
  const out = [];
  for (let i = 0; i < 40; i++) {
    const boxes = "ABCDE".slice(0, 3 + (i % 3)).split("");
    const objs = rng.shuffle(OBJECTS).slice(0, boxes.length);
    /** @type {Record<string, string>} object → box */
    const where = Object.fromEntries(objs.map((o, k) => [o, boxes[k]]));
    const lines = [`There are ${boxes.length} boxes labelled ${boxes.join(", ")}.`];
    lines.push(objs.map((o) => `Box ${where[o]} contains the ${o}.`).join(" "));
    const nOps = 4 + (i % 5);
    for (let k = 0; k < nOps; k++) {
      if (rng.next() < 0.6) {
        const o = rng.pick(objs);
        const src = where[o];
        const dst = rng.pick(boxes.filter((b) => b !== src));
        where[o] = dst;
        lines.push(`Move the ${o} from box ${src} to box ${dst}.`);
      } else {
        const [b1, b2] = rng.shuffle(boxes).slice(0, 2);
        for (const o of objs) {
          if (where[o] === b1) where[o] = b2;
          else if (where[o] === b2) where[o] = b1;
        }
        lines.push(`Swap the entire contents of box ${b1} and box ${b2}.`);
      }
    }
    const target = rng.pick(objs);
    out.push({
      id: `state-${pad(i + 1)}`,
      category: "state",
      prompt: `${lines.join("\n")}\nWhich box contains the ${target} now? Answer with the box letter.\n\n${ANSWER_LINE}`,
      maxTokens: 384,
      score: { kind: "choice", expected: where[target], letters: boxes.join("") },
    });
  }
  return out;
}

// ─── GSM8K / MMLU (bundled MIT samples) ───────────────────────────────

let gsmCache = null;
let mmluCache = null;

function readData(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8")).items;
}

function gsm8kItems() {
  gsmCache ??= readData("gsm8k-test-200.json").map((r) => ({
    id: `gsm8k-${pad(r.i, 4)}`,
    category: "gsm8k",
    prompt: `${r.q}\n\nSolve the problem step by step, then end with a final line of the form 'Answer: <number>'.`,
    maxTokens: 768,
    score: { kind: "number", expected: Number(r.a) },
  }));
  return gsmCache;
}

function mmluItems() {
  mmluCache ??= readData("mmlu-dev-285.json").map((r) => ({
    id: `mmlu-${r.s}-${r.k + 1}`,
    category: "mmlu",
    prompt:
      `The following is a multiple choice question about ${r.s.replace(/_/g, " ")}.\n\n${r.q}\n` +
      r.c.map((c, k) => `${"ABCD"[k]}. ${c}`).join("\n") +
      "\n\nEnd your reply with a final line of the form 'Answer: <letter>'.",
    maxTokens: 512,
    score: { kind: "choice", expected: r.a, letters: "ABCD" },
  }));
  return mmluCache;
}

// ─── Instruction following (opt-in) ───────────────────────────────────

const IF_TEMPLATES = [
  (k) => {
    const t = ["the ocean", "a forest", "a city at night", "a thunderstorm"][k];
    return [`Write one sentence about ${t}. Use only capital letters.`, { type: "upper" }];
  },
  (k) => {
    const t = ["breakfast", "a train journey", "the moon", "a garden"][k];
    return [`Write one sentence about ${t} using only lowercase letters.`, { type: "lower" }];
  },
  (k) => {
    const n = [3, 5, 7, 9][k];
    return [`Describe a cat in exactly ${n} words. Reply with those words only.`, { type: "word_count", n }];
  },
  (k) => {
    const t = ["autumn", "the sea", "a library", "winter"][k];
    return [`Write two sentences about ${t} without using any commas.`, { type: "no_commas" }];
  },
  (k) => {
    const w = ["river", "light", "stone", "bread"][k];
    return [`Write one sentence that uses the word "${w}" exactly twice.`, { type: "keyword_count", word: w, n: 2 }];
  },
  (k) => {
    const [what, keys] = [
      ["a fictional person", { name: "string", age: "number" }],
      ["a fictional city", { city: "string", population: "number" }],
      ["a fictional book", { title: "string", year: "number" }],
      ["a colour", { color: "string", hex: "string" }],
    ][k];
    const desc = Object.entries(keys).map(([key, type]) => `"${key}" (a ${type})`).join(" and ");
    return [
      `Reply with only a JSON object describing ${what}, with exactly the keys ${desc}. No code fences and no other text.`,
      { type: "json_keys", keys },
    ];
  },
  (k) => {
    const n = [3, 4, 5, 6][k];
    return [`List exactly ${n} fruits as a bulleted list. Start every line with "- " and write nothing else.`, { type: "bullets", n }];
  },
  (k) => {
    const w = ["today", "forever", "again", "home"][k];
    return [`Write one sentence about mountains that ends with the word "${w}".`, { type: "ends_with", word: w }];
  },
  (k) => {
    const w = ["Certainly", "Indeed", "Absolutely", "Naturally"][k];
    return [`Begin your reply with the word "${w}", then name one colour.`, { type: "starts_with", word: w }];
  },
  (k) => {
    const who = ["a friend", "a teacher", "a neighbour", "a colleague"][k];
    return [`Reply with a short greeting for ${who}, wrapped in double quotation marks, and nothing else.`, { type: "quoted" }];
  },
];

function instructionItems() {
  const out = [];
  for (let k = 0; k < 4; k++) {
    for (const tpl of IF_TEMPLATES) {
      const [prompt, spec] = tpl(k);
      out.push({
        id: `instruction-${pad(out.length + 1)}`,
        category: "instruction",
        prompt,
        maxTokens: 256,
        score: { kind: "instruction", spec },
      });
    }
  }
  return out;
}

// ─── Long-context recall (opt-in) ─────────────────────────────────────

export const LONGCTX_SIZES = [2048, 4096, 8192, 16384];
export const LONGCTX_DEPTHS = [0.1, 0.3, 0.5, 0.7, 0.9];
const HAY_SUBJECTS = ["The committee", "A traveller", "The old library", "Every gardener", "The river ferry", "A quiet engineer", "The morning market", "The harbour clock"];
const HAY_VERBS = ["noted", "recorded", "remembered", "described", "counted", "reported"];
const HAY_OBJECTS = ["the colour of the autumn leaves", "seventeen barrels of apples", "a change in the evening weather", "the price of copper wire", "the path along the northern wall", "an unusual number of swallows"];
const HAY_TAILS = ["before noon.", "during the festival.", "without comment.", "in a worn notebook.", "near the bridge.", "after the rain."];
const COLORS = ["amber", "cobalt", "crimson", "emerald", "ivory", "indigo", "scarlet", "silver", "violet", "ochre"];
const ANIMALS = ["falcon", "otter", "badger", "heron", "lynx", "marten", "osprey", "stoat", "wren", "bison"];

function longctxItems() {
  const rng = categoryRng("longctx");
  const out = [];
  for (const size of LONGCTX_SIZES) {
    for (const depth of LONGCTX_DEPTHS) {
      const sentences = [];
      let chars = 0;
      const budget = size * 4; // ~4 chars per token
      while (chars < budget) {
        const s = `${rng.pick(HAY_SUBJECTS)} ${rng.pick(HAY_VERBS)} ${rng.pick(HAY_OBJECTS)} ${rng.pick(HAY_TAILS)}`;
        sentences.push(s);
        chars += s.length + 1;
      }
      const color = rng.pick(COLORS);
      const animal = rng.pick(ANIMALS);
      const code = rng.int(100000, 999999);
      sentences.splice(Math.round(sentences.length * depth), 0, `The access code for the ${color} ${animal} vault is ${code}.`);
      out.push({
        id: `longctx-${size / 1024}k-d${Math.round(depth * 100)}`,
        category: "longctx",
        prompt: `${sentences.join(" ")}\n\nWhat is the access code for the ${color} ${animal} vault? Reply with the number only.`,
        maxTokens: 24,
        score: { kind: "number", expected: code },
      });
    }
  }
  return out;
}

const BUILDERS = {
  qa: qaItems,
  reasoning: reasoningItems,
  arithmetic: arithmeticItems,
  state: stateItems,
  gsm8k: gsm8kItems,
  mmlu: mmluItems,
  instruction: instructionItems,
  longctx: longctxItems,
};

/**
 * Items for the selected categories, in catalog order.
 * @param {string[]} categories
 * @returns {QualityItem[]}
 */
export function buildQualityItems(categories) {
  const out = [];
  for (const key of QUALITY_CATEGORY_KEYS) {
    if (categories.includes(key)) out.push(...BUILDERS[key]());
  }
  return out;
}
