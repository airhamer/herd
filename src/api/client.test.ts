// URL shapes of the history endpoints (docs/specs/unit-history.md §9).
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGpuHistory, getUnitHistory } from "./client";

function recordRequests(body: unknown) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => body };
    }),
  );
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

describe("history client", () => {
  it("asks for one range of a unit, escaping the id", async () => {
    const urls = recordRequests({ enabled: false });
    await expect(getUnitHistory("rack/2 node", "24h")).resolves.toEqual({ enabled: false });
    expect(urls).toEqual(["/api/sparks/rack%2F2%20node/history?range=24h"]);
  });

  it("adds windowMs to the GPU history request only when given", async () => {
    const urls = recordRequests({ t: [], u: [], c: [], p: [], gpus: [] });
    await getGpuHistory("n1");
    await getGpuHistory("n1", 0);
    await getGpuHistory("n1", 3_600_000);
    expect(urls).toEqual([
      "/api/sparks/n1/gpu-history",
      "/api/sparks/n1/gpu-history?windowMs=0",
      "/api/sparks/n1/gpu-history?windowMs=3600000",
    ]);
  });
});
