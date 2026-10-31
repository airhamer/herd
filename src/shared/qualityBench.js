/**
 * Quality bench (#42): category catalog and run options, shared by the Node
 * runner and the React dialog.
 */

/**
 * Categories in run order. `optIn` categories are off by default. The six
 * default categories make 755 requests.
 */
export const QUALITY_CATEGORIES = Object.freeze([
  { key: "qa", label: "QA", count: 150, optIn: false, source: "herd" },
  { key: "reasoning", label: "Reasoning", count: 40, optIn: false, source: "herd" },
  { key: "arithmetic", label: "Arithmetic chain", count: 40, optIn: false, source: "herd" },
  { key: "state", label: "State tracking", count: 40, optIn: false, source: "herd" },
  { key: "gsm8k", label: "GSM8K", count: 200, optIn: false, source: "GSM8K (MIT)" },
  { key: "mmlu", label: "MMLU", count: 285, optIn: false, source: "MMLU (MIT)" },
  { key: "instruction", label: "Instruction following", count: 40, optIn: true, source: "herd" },
  { key: "longctx", label: "Long-context recall", count: 20, optIn: true, source: "herd" },
]);

export const QUALITY_CATEGORY_KEYS = Object.freeze(QUALITY_CATEGORIES.map((c) => c.key));

export const QUALITY_DEFAULT_CATEGORIES = Object.freeze(
  QUALITY_CATEGORIES.filter((c) => !c.optIn).map((c) => c.key)
);

/** Client concurrency choices. 1 is the most reproducible (no batching effects). */
export const QUALITY_CONCURRENCY_OPTIONS = Object.freeze([1, 2, 4, 8]);
export const QUALITY_DEFAULT_CONCURRENCY = 4;

/** McNemar exact p at or above this is "within noise". */
export const QUALITY_NOISE_P = 0.05;

/** Runs listed per node (upstream keeps 30; Herd keeps every run in the results store). */
export const QUALITY_HISTORY_LIMIT = 30;

/**
 * Keep known keys in catalog order, drop duplicates and unknowns.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeQualityCategories(raw) {
  if (!Array.isArray(raw)) return [];
  const want = new Set(raw.map((v) => String(v)));
  return QUALITY_CATEGORY_KEYS.filter((k) => want.has(k));
}

/** @param {string[]} keys */
export function qualityRequestCount(keys) {
  return QUALITY_CATEGORIES.filter((c) => keys.includes(c.key)).reduce((a, c) => a + c.count, 0);
}

/** @param {string} key */
export function qualityCategoryLabel(key) {
  return QUALITY_CATEGORIES.find((c) => c.key === key)?.label ?? key;
}
