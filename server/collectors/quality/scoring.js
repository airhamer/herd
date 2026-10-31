/**
 * Quality bench scoring (#42). Pure functions: reply text in, pass/fail out.
 *
 * Most prompts ask for a final line "Answer: <answer>". Scoring reads that
 * line (the last one if there are several). With no such line it reads the
 * last non-empty line, so a terse reply ("Paris") still scores.
 */

/** Drop reasoning blocks. An unclosed <think> means the reply never left reasoning. */
export function stripThinking(text) {
  let t = String(text ?? "");
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const open = t.search(/<think>/i);
  if (open >= 0) t = t.slice(0, open);
  // A template that drops the opening tag still leaves "...</think>answer".
  const close = t.lastIndexOf("</think>");
  if (close >= 0) t = t.slice(close + "</think>".length);
  return t.trim();
}

/** The text the reply commits to as its answer. */
export function finalAnswerSegment(text) {
  let t = stripThinking(text);
  t = t.replace(/\\boxed\{([^{}]*)\}/g, "$1").replace(/\*\*|__|`/g, "");
  const re = /\banswer\s*(?:is)?\s*[:：]/gi;
  let last = -1;
  let m;
  while ((m = re.exec(t)) !== null) last = m.index + m[0].length;
  const lines = (last >= 0 ? t.slice(last) : t).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  return last >= 0 ? lines[0] : lines[lines.length - 1];
}

/** Lower-case, strip accents, digits-group commas removed, non-alphanumerics → single spaces. */
export function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Whole-word phrase match on normalised text. */
export function containsPhrase(text, phrase) {
  const p = normalizeText(phrase);
  if (!p) return false;
  return ` ${normalizeText(text)} `.includes(` ${p} `);
}

/** Numbers in a string ("1,440", "$18.50", "-3"). */
export function extractNumbers(s) {
  const out = [];
  const re = /-?\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(String(s ?? ""))) !== null) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Short answer: any accepted answer appears as whole words in the answer segment. */
export function scoreShort(answers, text, caseSensitive = false) {
  const seg = finalAnswerSegment(text);
  if (!seg) return false;
  if (caseSensitive) {
    const tokens = new Set(seg.match(/[A-Za-z0-9]+/g) || []);
    return answers.some((a) => tokens.has(a));
  }
  return answers.some((a) => containsPhrase(seg, a));
}

/** Numeric answer: the last number in the answer segment equals `expected`. */
export function scoreNumber(expected, text) {
  const nums = extractNumbers(finalAnswerSegment(text));
  if (nums.length === 0) return false;
  return Math.abs(nums[nums.length - 1] - Number(expected)) < 1e-6;
}

/** Multiple choice: the first standalone choice letter in the answer segment. */
export function scoreChoice(expected, text, letters = "ABCD") {
  const seg = finalAnswerSegment(text);
  const m = seg.match(new RegExp(`(?:^|[^A-Za-z])([${letters}])(?![A-Za-z])`));
  return Boolean(m && m[1] === expected);
}

/** Exactly one of `options` named in the answer segment, and it is `expected`. */
export function scoreOneOf(expected, options, text) {
  const seg = finalAnswerSegment(text);
  const named = options.filter((o) => containsPhrase(seg, o));
  return named.length === 1 && named[0] === expected;
}

// ─── instruction following ────────────────────────────────────────────

function words(text) {
  return String(text).trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

/**
 * Check one verifiable instruction against the whole (reasoning-stripped) reply.
 * @param {{ type: string, [k: string]: any }} spec
 * @param {string} reply
 */
export function checkInstruction(spec, reply) {
  const t = stripThinking(reply);
  if (!t) return false;
  switch (spec.type) {
    case "upper":
      return /\p{L}/u.test(t) && !/\p{Ll}/u.test(t);
    case "lower":
      return /\p{L}/u.test(t) && !/\p{Lu}/u.test(t);
    case "word_count":
      return words(t).length === spec.n;
    case "no_commas":
      return !/[,，]/.test(t) && (t.match(/[.!?](?:\s|$)/g) || []).length >= 2;
    case "keyword_count": {
      const re = new RegExp(`\\b${spec.word}\\b`, "gi");
      return (t.match(re) || []).length === spec.n;
    }
    case "json_keys": {
      let obj;
      try {
        obj = JSON.parse(t);
      } catch {
        return false;
      }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
      const keys = Object.keys(obj).sort();
      const want = Object.keys(spec.keys).sort();
      if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) return false;
      return want.every((k) => typeof obj[k] === spec.keys[k]);
    }
    case "bullets": {
      const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return lines.length === spec.n && lines.every((l) => l.startsWith("- ") && l.length > 2);
    }
    case "ends_with": {
      const w = words(t);
      const last = w.length ? w[w.length - 1].replace(/[^\p{L}\p{N}]/gu, "").toLowerCase() : "";
      return last === spec.word;
    }
    case "starts_with":
      return t.startsWith(spec.word) && !/[\p{L}]/u.test(t.charAt(spec.word.length));
    case "quoted":
      return t.length > 2 && /^["“]/.test(t) && /["”]$/.test(t);
    default:
      return false;
  }
}

/**
 * Score one item's reply.
 * @param {{ score: { kind: string, [k: string]: any } }} item
 * @param {string} reply
 * @returns {boolean}
 */
export function scoreItem(item, reply) {
  const s = item.score;
  switch (s.kind) {
    case "short":
      return scoreShort(s.answers, reply, Boolean(s.cs));
    case "number":
      return scoreNumber(s.expected, reply);
    case "choice":
      return scoreChoice(s.expected, reply, s.letters || "ABCD");
    case "one_of":
      return scoreOneOf(s.expected, s.options, reply);
    case "instruction":
      return checkInstruction(s.spec, reply);
    default:
      return false;
  }
}

/** Expected answer as display text (for item detail rows). */
export function expectedText(item) {
  const s = item.score;
  switch (s.kind) {
    case "short":
      return s.answers[0];
    case "number":
      return String(s.expected);
    case "choice":
    case "one_of":
      return s.expected;
    case "instruction":
      return s.spec.type;
    default:
      return "";
  }
}
