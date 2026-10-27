import { afterEach, describe, expect, it, vi } from "vitest";
import { getGpuHistory, getUnitHistory } from "./client";

function stubFetch(payload: unknown = {}) {
  const fn = vi.fn(async (_input: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => payload }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("unit history endpoints", () => {
  it("fetches /api/sparks/:id/history with the whitelisted range, id URL-encoded", async () => {
    const fn = stubFetch({ enabled: false });
    await getUnitHistory("a b", "30d");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toBe("/api/sparks/a%20b/history?range=30d");
  });

  it("fetches /api/sparks/:id/gpu-history with an optional windowMs", async () => {
    const fn = stubFetch({ t: [], u: [], c: [], p: [], gpus: [] });
    await getGpuHistory("s1");
    expect(fn.mock.calls[0][0]).toBe("/api/sparks/s1/gpu-history");
    await getGpuHistory("s1", 48 * 3600_000);
    expect(fn.mock.calls[1][0]).toBe("/api/sparks/s1/gpu-history?windowMs=172800000");
  });
});
