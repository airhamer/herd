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

describe("activity client (issue #32)", () => {
  it("builds /api/events queries, leaving empty filters out", async () => {
    const { eventsPath, fetchEvents } = await import("./client");
    expect(eventsPath()).toBe("/api/events");
    expect(eventsPath({ limit: 8 })).toBe("/api/events?limit=8");
    expect(
      eventsPath({ limit: 100, sparkId: "rack/2", beforeId: 40, sinceId: 7, types: ["gpu.", "alert.fired"], severities: ["warn", "error"] }),
    ).toBe("/api/events?limit=100&sparkId=rack%2F2&sinceId=7&beforeId=40&type=gpu.%2Calert.fired&severity=warn%2Cerror");
    expect(eventsPath({ types: [], severities: [] })).toBe("/api/events");
    const urls = recordRequests({ events: [], oldestId: null, newestId: null, total: 0 });
    await fetchEvents({ limit: 5 });
    expect(urls).toEqual(["/api/events?limit=5"]);
  });

  it("clears everything, or only events older than a cutoff, with DELETE", async () => {
    const { clearEvents } = await import("./client");
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method });
        return { ok: true, status: 200, json: async () => ({ removed: 2 }) };
      }),
    );
    await expect(clearEvents()).resolves.toEqual({ removed: 2 });
    await clearEvents(604_800_000.7);
    expect(calls).toEqual([
      { url: "/api/events", method: "DELETE" },
      { url: "/api/events?olderThanMs=604800000", method: "DELETE" },
    ]);
  });
});
