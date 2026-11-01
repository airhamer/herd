/**
 * stacks-catalog.js — SC2 data model: storage, external retrieval (manual
 * import), and merge for Stack definitions (shared/types.ts → Stack).
 *
 * One method, mirroring agent/catalog/recipes.js (load → validate → expose):
 *
 * - Storage: `agent/config/stacks.json` (gitignored runtime file, like
 *   recipes.json) holds `{ version, stacks: Stack[] }` (shared/types.ts →
 *   StacksFile). The committed `agent/config/stacks.example.json` mirrors the
 *   bootstrap below (operator reference; the store bootstraps in code).
 * - External retrieval (decision #1, manual): there is no auto-fetch.
 *   Definitions downloaded from github/web are handed to
 *   `StackStore.mergeExternal` (or the pure `mergeStacks`), which dedupes by
 *   stack `id` (incoming wins — extend/replace) and reports the outcome. The
 *   setup-menu merge/import/export (SC10 UI) is a thin shell over this.
 * - Dedup key: stack `id` (slug). Same id = same stack, replace in place.
 *
 * Bootstrap (decision #10, POC step 1): the initial pre-defined stacks are the
 * two Hasso-derived component definitions converted in
 * docs/COMPONENTS-DESIGN-PROPOSAL.md §4 — one stack per style:
 * - hasso-27b-stock:   qwen38-27b-stock-sglang-tp1-gx10
 * - hasso-flash-next:  qwen38-flash-next-sglang-tp1-gx10
 * `componentNames` reference Component ids (agent/catalog/components/<id>.json),
 * which are the materialized Component names (SC2↔component-format seam).
 *
 * `category` is NOT trusted from storage: stacks.json records only what the
 * user defined; categories are computed live (stacks.js calculator +
 * stack-history.js proven), so every load recomputes `category` with the
 * existing calculator instead of reading a stale value.
 */

import fs from "fs";
import path from "path";

// NOTE: agent/ runs dependency-free plain-JS ESM at runtime (no TS transpile),
// so the calculator is duplicated-by-contract here rather than imported from
// stacks.js (that file carries TS annotations and is type-reference only).

/**
 * Resource calculator (same contract as stacks.js calculateStackCategory).
 * blocked: >95% of effective usable; not_recommended: >80%; else calculated.
 * proven overrides (from stack-history, SC4).
 */
export function calculateStackCategory(components, totalMB, floorMB = 3072, currentUsedMB = 0, isProven = false) {
  if (isProven) return "proven";
  if (!components || components.length === 0) return "calculated";
  const sumFootprint = components.reduce((acc, c) => acc + (c.footprintMB || 0), 0);
  const usable = Math.max(0, totalMB - floorMB - currentUsedMB);
  const headroom = Math.max(2048, Math.floor(totalMB * 0.08));
  const effectiveUsable = Math.max(0, usable - headroom);
  const ratio = effectiveUsable > 0 ? sumFootprint / effectiveUsable : 1.0;
  if (ratio > 0.95) return "blocked";
  if (ratio > 0.80) return "not_recommended";
  return "calculated";
}

/** Runtime storage file (gitignored, like recipes.json). */
export const DEFAULT_STACKS_PATH =
  process.env.STACKS_PATH || "agent/config/stacks.json";

/** Stack category enum (mirrors shared/types.ts StackCategory). */
export const STACK_CATEGORIES = ["proven", "calculated", "not_recommended", "blocked"];

/** Schema: Stack.id — slug, same grammar as component ids / lane pools. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Validate one Stack definition (shape: shared/types.ts → Stack).
 * @returns {string[]} human-readable errors; empty when valid.
 */
export function validateStack(s) {
  const errors = [];
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    return ["stack must be an object"];
  }
  if (typeof s.id !== "string" || !ID_RE.test(s.id)) {
    errors.push(`stack.id must match ^[a-z0-9][a-z0-9-]{0,63}$ (got ${JSON.stringify(s.id)})`);
  }
  if (typeof s.name !== "string" || s.name.trim() === "") {
    errors.push("stack.name must be a non-empty string");
  }
  if (!Array.isArray(s.componentNames) || s.componentNames.length === 0) {
    errors.push("stack.componentNames must be a non-empty array");
  } else {
    s.componentNames.forEach((c, i) => {
      if (typeof c !== "string" || c.trim() === "") {
        errors.push(`stack.componentNames[${i}] must be a non-empty string`);
      }
    });
    const seen = new Set(s.componentNames);
    if (seen.size !== s.componentNames.length) {
      errors.push("stack.componentNames must not contain duplicates");
    }
  }
  if (s.notes !== undefined && typeof s.notes !== "string") {
    errors.push("stack.notes must be a string when present");
  }
  return errors;
}

/**
 * Validate a whole stacks file: `{ version: 1, stacks: Stack[] }`.
 * @returns {string[]} errors; empty when valid.
 */
export function validateStacksFile(data) {
  const errors = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return ["stacks file must be an object"];
  }
  if (data.version !== 1) {
    errors.push(`stacks file version must be 1 (got ${JSON.stringify(data.version)})`);
  }
  if (!Array.isArray(data.stacks)) {
    errors.push("stacks file stacks must be an array");
    return errors;
  }
  const ids = new Set();
  data.stacks.forEach((s, i) => {
    for (const e of validateStack(s)) errors.push(`stacks[${i}]: ${e}`);
    if (s && typeof s.id === "string" && ID_RE.test(s.id)) {
      if (ids.has(s.id)) errors.push(`stacks[${i}]: duplicate id "${s.id}"`);
      ids.add(s.id);
    }
  });
  return errors;
}

/**
 * Merge two stack lists, deduping by id; `incoming` wins (extend/replace).
 * Order: existing order preserved (replaced in place), new ids appended.
 *
 * @param {Array} existing
 * @param {Array} incoming
 * @returns {{ stacks: Array[], added: string[], replaced: string[], skipped: string[] }}
 *          `skipped` = incoming stacks that failed validation (fail-soft:
 *          one bad external definition never blocks the merge).
 */
export function mergeStacks(existing, incoming) {
  const out = (Array.isArray(existing) ? existing : []).filter(
    (s) => s && typeof s.id === "string" && ID_RE.test(s.id)
  );
  const byId = new Map(out.map((s) => [s.id, s]));
  const added = [];
  const replaced = [];
  const skipped = [];

  for (const s of Array.isArray(incoming) ? incoming : []) {
    const errs = validateStack(s);
    if (errs.length) {
      skipped.push(s && typeof s.id === "string" ? s.id : "<invalid>");
      continue;
    }
    if (byId.has(s.id)) {
      const idx = out.findIndex((e) => e.id === s.id);
      out[idx] = s;
      byId.set(s.id, s);
      replaced.push(s.id);
    } else {
      out.push(s);
      byId.set(s.id, s);
      added.push(s.id);
    }
  }
  return { stacks: out, added, replaced, skipped };
}

/**
 * The SC2 bootstrap: pre-defined stacks from the design decisions
 * (IMPLEMENTATION_PLAN.md decision #10, POC step 1) — the two Hasso recipes
 * pulled into our format (COMPONENTS-DESIGN-PROPOSAL.md §4), one stack each.
 * Pure data; category is recomputed at load, so these carry "calculated".
 */
export function bootstrapStacks() {
  return [
    {
      id: "hasso-27b-stock",
      name: "Hasso 27B stock (SGLang, native window)",
      componentNames: ["qwen38-27b-stock-sglang-tp1-gx10"],
      category: "calculated",
      notes:
        "Bootstrap pre-defined stack (POC step 1). Sourced from hasso5703/dgx-spark-qwen38 builtin `stock`; see agent/catalog/components/qwen38-27b-stock-sglang-tp1-gx10.json for pins and provenance.",
    },
    {
      id: "hasso-flash-next",
      name: "Hasso Flash-Next (SGLang, file-backed PLE)",
      componentNames: ["qwen38-flash-next-sglang-tp1-gx10"],
      category: "calculated",
      notes:
        "Bootstrap pre-defined stack (POC step 1). Sourced from hasso5703/dgx-spark-qwen38 builtin `flash` (concurrency tier); single-spark GB10 only — see the component definition for the PLE mechanism and provenance.",
    },
  ];
}

/**
 * File-backed stack store. Load → validate (fail-soft: bad entries are
 * reported and dropped, the good ones load) → recompute category live.
 * save() writes `{ version: 1, stacks }` atomically-enough (single write).
 */
export class StackStore {
  /**
   * @param {string} stacksPath runtime file
   * @param {{ totalMB?: number, floorMB?: number, currentUsedMB?: number,
   *          footprintsMB?: Record<string, number> }} calc
   *        resource-calc inputs for the live category (stacks.js calculator);
   *        footprintsMB maps component name → footprint MB (from recipes).
   *        Without totalMB the stored category is kept (unit-testable seam).
   */
  constructor(stacksPath = DEFAULT_STACKS_PATH, calc = {}) {
    this.stacksPath = stacksPath;
    this.calc = calc;
    this.stacks = [];
    this.errors = [];
    this.writable = true;
  }

  /** Load the file; bootstrap (and persist) when absent. Returns this. */
  load() {
    this.errors = [];
    let data = null;
    let absent = false;
    try {
      if (fs.existsSync(this.stacksPath)) {
        data = JSON.parse(fs.readFileSync(this.stacksPath, "utf8"));
      } else {
        absent = true;
      }
    } catch (e) {
      // Corrupt runtime data degrades to empty with a reported error — do NOT
      // re-bootstrap (that would overwrite the operator's file with defaults).
      this.errors.push(`stacks file unreadable: ${e.message}`);
      this.stacks = [];
      return this;
    }
    if (!data && absent) {
      this.stacks = bootstrapStacks();
      this.stacks.forEach((s) => this.recalculate(s));
      this.save(); // first-run persistence of the bootstrap (skipped when read-only)
      return this;
    }
    const fileErrs = validateStacksFile(data);
    if (fileErrs.length && !Array.isArray(data?.stacks)) {
      this.errors.push(...fileErrs);
      this.stacks = [];
      return this;
    }
    this.errors.push(...fileErrs.filter((e) => !e.startsWith("stacks[")));
    const good = [];
    for (const s of data.stacks) {
      const errs = validateStack(s);
      if (errs.length) {
        this.errors.push(`dropped "${s?.id ?? "<invalid>"}": ${errs.join("; ")}`);
        continue;
      }
      if (good.some((g) => g.id === s.id)) {
        this.errors.push(`dropped duplicate id "${s.id}"`);
        continue;
      }
      this.recalculate(s);
      good.push(s);
    }
    this.stacks = good;
    return this;
  }

  /** Recompute the live category (never trust the stored one). */
  recalculate(s) {
    if (!isFiniteNumber(this.calc.totalMB)) return;
    const names = [...new Set(s.componentNames)];
    const footprints = this.calc.footprintsMB || {};
    s.category = calculateStackCategory(
      names.map((n) => ({ name: n, footprintMB: footprints[n] ?? 0 })),
      this.calc.totalMB,
      this.calc.floorMB ?? 3072,
      this.calc.currentUsedMB ?? 0,
      s.category === "proven" // proven override comes from stack-history (SC4)
    );
  }

  /** All stacks (shallow copies). */
  list() {
    return this.stacks.map((s) => ({ ...s }));
  }

  /** One stack by id, or null. */
  get(id) {
    const s = this.stacks.find((x) => x.id === id);
    return s ? { ...s } : null;
  }

  /**
   * Setup-menu merge of an external stacks file / array (manual retrieval:
   * the operator hands us the downloaded JSON). Dedupes by id, incoming wins.
   * Provenance: a replaced stack keeps its proven verdict (proven is history,
   * not definition — an external extend must not silently demote it).
   * Persists on success. Returns the merge report.
   */
  mergeExternal(incoming) {
    const list = Array.isArray(incoming)
      ? incoming
      : Array.isArray(incoming?.stacks)
        ? incoming.stacks
        : [];
    const wasProven = new Set(this.stacks.filter((s) => s.category === "proven").map((s) => s.id));
    const report = mergeStacks(this.stacks, list);
    if (wasProven.size) {
      for (const id of report.replaced) {
        const s = report.stacks.find((x) => x.id === id);
        if (s) s.category = "proven";
      }
    }
    this.stacks = report.stacks;
    this.stacks.forEach((s) => this.recalculate(s));
    this.save();
    return report;
  }

  /** Add/update a user-authored stack (custom definitions, decision #1). */
  upsert(stack) {
    const report = mergeStacks(this.stacks, [stack]);
    if (report.skipped.length) {
      throw new Error(validateStack(stack).join("; "));
    }
    this.stacks = report.stacks;
    this.stacks.forEach((s) => this.recalculate(s));
    this.save();
    return this.get(stack.id);
  }

  /** Export the current definitions as a stacks file (setup-menu export). */
  export() {
    return { version: 1, stacks: this.list() };
  }

  save() {
    if (!this.writable) return;
    const dir = path.dirname(this.stacksPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.stacksPath, JSON.stringify(this.export(), null, 2) + "\n");
  }
}

export function createStackStore(stacksPath, calc) {
  return new StackStore(stacksPath, calc);
}

export default {
  DEFAULT_STACKS_PATH,
  calculateStackCategory,
  STACK_CATEGORIES,
  validateStack,
  validateStacksFile,
  mergeStacks,
  bootstrapStacks,
  StackStore,
  createStackStore,
};
