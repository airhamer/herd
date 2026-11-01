/**
 * SC5a (#72) Components-tab filters: tp, recipe source, inference engine,
 * LLM purpose and pre-defined stack, plus the "show blocked" toggle.
 * Pure functions, so the page and the tests share one definition.
 * The filter state persists in localStorage (decision #6).
 */
import type { CatalogComponent, FleetStack } from "../../api/client";

export interface StackFilters {
  tp: string;
  source: string;
  engine: string;
  purpose: string;
  stack: string;
  /** Decision #4: blocked stacks and components are hidden by default. */
  showBlocked: boolean;
}

export const DEFAULT_FILTERS: StackFilters = {
  tp: "all",
  source: "all",
  engine: "all",
  purpose: "all",
  stack: "all",
  showBlocked: false,
};

export const FILTERS_STORAGE_KEY = "herd.components.filters.v1";

/** Read the saved filters. Bad or missing storage falls back to the defaults. */
export function loadFilters(storage: Pick<Storage, "getItem"> | null = safeStorage()): StackFilters {
  try {
    const raw = storage?.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_FILTERS };
    const v = JSON.parse(raw) as Partial<StackFilters>;
    const str = (x: unknown, d: string) => (typeof x === "string" && x !== "" ? x : d);
    return {
      tp: str(v.tp, "all"),
      source: str(v.source, "all"),
      engine: str(v.engine, "all"),
      purpose: str(v.purpose, "all"),
      stack: str(v.stack, "all"),
      showBlocked: v.showBlocked === true,
    };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

export function saveFilters(f: StackFilters, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(FILTERS_STORAGE_KEY, JSON.stringify(f));
  } catch {
    // A full or blocked storage only costs persistence.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** A missing facet value reads "unknown" (decision #3). */
export function facetOf(c: CatalogComponent, key: "recipeSource" | "engine" | "purpose"): string {
  const v = c[key];
  return typeof v === "string" && v.trim() !== "" ? v : "unknown";
}

const matches = (want: string, have: string[]) => want === "all" || have.includes(want);

/** Stack cards that pass the filters. The stack filter highlights a card; it does not hide the others. */
export function filterStacks(stacks: FleetStack[], f: StackFilters): FleetStack[] {
  return stacks.filter(
    (s) =>
      (f.showBlocked || s.category !== "blocked") &&
      (f.tp === "all" || String(s.tp) === f.tp) &&
      matches(f.source, s.facets?.sources ?? []) &&
      matches(f.engine, s.facets?.engines ?? []) &&
      matches(f.purpose, s.facets?.purposes ?? [])
  );
}

/**
 * Why a component counts as blocked on this fleet, or null when it does not.
 * - Its tp has no landing scope here; a single Spark or a non-Spark host
 *   only takes tp1 components.
 * - Every stack it belongs to is blocked on every target.
 */
export function componentBlockedReason(c: CatalogComponent, stacks: FleetStack[]): string | null {
  if (stacks.length > 0) {
    const scopeTps = new Set(stacks.map((s) => s.tp));
    if (!scopeTps.has(c.tp)) return `tp${c.tp}: no ${c.tp}-machine group in this fleet`;
  }
  const holding = stacks.filter((s) => s.componentNames.includes(c.id));
  if (holding.length > 0 && holding.every((s) => s.category === "blocked")) return holding[0].categoryReason;
  return null;
}

/** Components that pass the filters. */
export function filterComponents(components: CatalogComponent[], stacks: FleetStack[], f: StackFilters): CatalogComponent[] {
  const stack = f.stack === "all" ? null : stacks.find((s) => s.id === f.stack) ?? null;
  return components.filter(
    (c) =>
      (!stack || stack.componentNames.includes(c.id)) &&
      (f.tp === "all" || String(c.tp) === f.tp) &&
      (f.source === "all" || facetOf(c, "recipeSource") === f.source) &&
      (f.engine === "all" || facetOf(c, "engine") === f.engine) &&
      (f.purpose === "all" || facetOf(c, "purpose") === f.purpose) &&
      (f.showBlocked || componentBlockedReason(c, stacks) === null)
  );
}
