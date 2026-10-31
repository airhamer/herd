import { afterEach, describe, expect, it, vi } from "vitest";
import { compareBenchResults, getBenchResult, listBenchReferences, listBenchResults, nearestBenchReferences } from "./client";

function stubFetch(payload: unknown = {}) {
  const fn = vi.fn(async (_input: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => payload }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bench results client", () => {
  it("lists without a query string when no filter is given", async () => {
    const fn = stubFetch({ schema_version: 1, read_only: false, total: 0, results: [] });
    const out = await listBenchResults();
    expect(fn.mock.calls[0][0]).toBe("/api/bench-results");
    expect(out.total).toBe(0);
  });

  it("maps filters to query params and drops empty ones", async () => {
    const fn = stubFetch({ schema_version: 1, read_only: false, total: 0, results: [] });
    await listBenchResults({ node_id: "s1", metric: "agg_window_tps", concurrency: 8, model_id: undefined, engine: "" });
    expect(fn.mock.calls[0][0]).toBe("/api/bench-results?node_id=s1&metric=agg_window_tps&concurrency=8");
  });

  it("encodes result ids (they contain colons)", async () => {
    const fn = stubFetch({});
    await getBenchResult("decode:abc:c8");
    expect(fn.mock.calls[0][0]).toBe("/api/bench-results/decode%3Aabc%3Ac8");
  });

  it("compares two results by id", async () => {
    const fn = stubFetch({ comparable: false, reasons: ["hw_bucket differs"], rows: [], refused: [] });
    const out = await compareBenchResults("a:1", "b:2");
    expect(fn.mock.calls[0][0]).toBe("/api/bench-results/compare?baseline=a%3A1&candidate=b%3A2");
    expect(out.comparable).toBe(false);
    expect(out.reasons).toEqual(["hw_bucket differs"]);
  });

  it("reads the reference registry and a result's nearest references", async () => {
    const fn = stubFetch({ loaded: true, total: 0, results: [], entries: [], not_seeded: [] });
    await listBenchReferences();
    expect(fn.mock.calls[0][0]).toBe("/api/bench-results/references");
    await nearestBenchReferences("decode:abc:c8", 2);
    expect(fn.mock.calls[1][0]).toBe("/api/bench-results/decode%3Aabc%3Ac8/references?limit=2");
    await nearestBenchReferences("decode:abc:c8");
    expect(fn.mock.calls[2][0]).toBe("/api/bench-results/decode%3Aabc%3Ac8/references");
  });
});
