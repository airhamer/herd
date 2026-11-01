// Shared fixtures for the Components-tab tests (SC5a / SC5b).
import type { CatalogComponent, FleetStack } from "../../api/client";

export function comp(id: string, over: Partial<CatalogComponent> = {}): CatalogComponent {
  return {
    id,
    name: `Comp ${id}`,
    purpose: "code",
    kind: "llm",
    tp: 1,
    machineClass: "dgx-spark-gb10-128g",
    engine: "sglang",
    image: null,
    servedModelName: id,
    memoryPerSparkMB: 40960,
    description: "",
    recipeSource: "hasso",
    nodes: [],
    ...over,
  };
}

export function fstack(id: string, over: Partial<FleetStack> = {}): FleetStack {
  return {
    id,
    name: `Stack ${id}`,
    componentNames: ["a"],
    category: "calculated",
    categoryReason: "fits: needs 40.0 GiB per spark, 100.0 GiB usable on one",
    tp: 1,
    target: { groupId: null, nodeIds: ["n1"] },
    perNode: [],
    facets: { tp: 1, sources: ["hasso"], engines: ["sglang"], purposes: ["code"] },
    ...over,
  };
}

/** A fetch fake: route → JSON body (a function gets the request init). */
export function fakeFetch(routes: Record<string, unknown | ((init?: RequestInit) => unknown)>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.includes(" ") ? k.split(" ") : ["GET", k];
      return (init?.method ?? "GET") === m && path.split("?")[0] === p;
    });
    if (!key) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const r = routes[key];
    const body = typeof r === "function" ? (r as (i?: RequestInit) => unknown)(init) : r;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { fn, calls };
}
