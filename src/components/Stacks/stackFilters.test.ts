import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS,
  FILTERS_STORAGE_KEY,
  componentBlockedReason,
  filterComponents,
  filterStacks,
  loadFilters,
  saveFilters,
} from "./stackFilters";
import { comp, fstack } from "./testKit";

const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe("stackFilters (SC5a)", () => {
  it("persists and restores filters; bad storage falls back to defaults", () => {
    const st = memStore();
    saveFilters({ ...DEFAULT_FILTERS, engine: "vllm", showBlocked: true }, st);
    expect(JSON.parse(st.m.get(FILTERS_STORAGE_KEY)!)).toMatchObject({ engine: "vllm", showBlocked: true });
    expect(loadFilters(st)).toEqual({ ...DEFAULT_FILTERS, engine: "vllm", showBlocked: true });
    st.m.set(FILTERS_STORAGE_KEY, "{nope");
    expect(loadFilters(st)).toEqual(DEFAULT_FILTERS);
    expect(loadFilters(null)).toEqual(DEFAULT_FILTERS);
  });

  it("hides blocked stacks unless show blocked is on", () => {
    const stacks = [fstack("ok"), fstack("bad", { category: "blocked" })];
    expect(filterStacks(stacks, DEFAULT_FILTERS).map((s) => s.id)).toEqual(["ok"]);
    expect(filterStacks(stacks, { ...DEFAULT_FILTERS, showBlocked: true }).map((s) => s.id)).toEqual(["ok", "bad"]);
  });

  it("filters stacks by tp, source, engine and purpose facets", () => {
    const stacks = [
      fstack("a"),
      fstack("b", { tp: 2, facets: { tp: 2, sources: ["aeon"], engines: ["vllm"], purposes: ["chat"] } }),
    ];
    expect(filterStacks(stacks, { ...DEFAULT_FILTERS, tp: "2" }).map((s) => s.id)).toEqual(["b"]);
    expect(filterStacks(stacks, { ...DEFAULT_FILTERS, source: "aeon" }).map((s) => s.id)).toEqual(["b"]);
    expect(filterStacks(stacks, { ...DEFAULT_FILTERS, engine: "sglang" }).map((s) => s.id)).toEqual(["a"]);
    expect(filterStacks(stacks, { ...DEFAULT_FILTERS, purpose: "chat" }).map((s) => s.id)).toEqual(["b"]);
  });

  it("filters components by facet and by the selected stack; missing values are 'unknown'", () => {
    const comps = [comp("a"), comp("b", { engine: null, recipeSource: undefined }), comp("c", { purpose: "chat" })];
    const stacks = [fstack("s", { componentNames: ["a", "c"] })];
    expect(filterComponents(comps, stacks, { ...DEFAULT_FILTERS, stack: "s" }).map((c) => c.id)).toEqual(["a", "c"]);
    expect(filterComponents(comps, stacks, { ...DEFAULT_FILTERS, engine: "unknown" }).map((c) => c.id)).toEqual(["b"]);
    expect(filterComponents(comps, stacks, { ...DEFAULT_FILTERS, source: "unknown" }).map((c) => c.id)).toEqual(["b"]);
    expect(filterComponents(comps, stacks, { ...DEFAULT_FILTERS, purpose: "chat" }).map((c) => c.id)).toEqual(["c"]);
  });

  it("a single-spark fleet hides tp>1 components and members of only-blocked stacks", () => {
    const comps = [comp("a"), comp("big", { tp: 2 }), comp("fat")];
    const stacks = [fstack("s1"), fstack("s2", { componentNames: ["fat"], category: "blocked", categoryReason: "does not fit" })];
    expect(componentBlockedReason(comps[1], stacks)).toMatch(/no 2-machine group/);
    expect(componentBlockedReason(comps[2], stacks)).toBe("does not fit");
    expect(filterComponents(comps, stacks, DEFAULT_FILTERS).map((c) => c.id)).toEqual(["a"]);
    expect(filterComponents(comps, stacks, { ...DEFAULT_FILTERS, showBlocked: true })).toHaveLength(3);
  });
});
