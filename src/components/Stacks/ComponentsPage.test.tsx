import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, flush, render } from "../../testing/render";
import { ComponentsPage } from "./ComponentsPage";
import { FILTERS_STORAGE_KEY } from "./stackFilters";
import { comp, fakeFetch, fstack } from "./testKit";

const q = (c: HTMLElement, sel: string) => c.querySelector(sel) as HTMLElement | null;
const qt = (c: HTMLElement, id: string) => q(c, `[data-testid="${id}"]`);

function pick(c: HTMLElement, label: string, value: string) {
  const sel = Array.from(c.querySelectorAll("label")).find((l) => l.textContent?.startsWith(label))!.querySelector("select")!;
  act(() => {
    sel.value = value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function routes(extra: Record<string, unknown> = {}) {
  return fakeFetch({
    "/api/components": {
      components: [comp("a"), comp("b", { engine: "vllm", recipeSource: "aeon", purpose: "chat" }), comp("fat")],
      warnings: [],
    },
    "/api/fleet/nodes": { nodes: [{ id: "n1", name: "one" }] },
    "/api/stacks": {
      stacks: [
        fstack("s-ok"),
        fstack("s-tight", { componentNames: ["b"], category: "not_recommended", facets: { tp: 1, sources: ["aeon"], engines: ["vllm"], purposes: ["chat"] } }),
        fstack("s-big", { componentNames: ["fat"], category: "blocked", categoryReason: "does not fit: needs 120.0 GiB per spark, 100.0 GiB usable on one" }),
      ],
      facets: { tp: [1], sources: ["hasso", "mia-ai-lab", "aeon", "custom", "unknown"], engines: ["sglang", "vllm"], purposes: ["chat", "code"] },
      errors: [],
    },
    ...extra,
  });
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanupRenders();
  vi.unstubAllGlobals();
});

describe("ComponentsPage (SC5a filters + stack cards)", () => {
  it("renders stack cards with category badges and hides blocked ones by default", async () => {
    vi.stubGlobal("fetch", routes().fn);
    const { container } = render(<ComponentsPage />);
    await flush();
    await flush();
    expect(qt(container, "stack-card-s-ok")!.textContent).toContain("Calculated");
    expect(qt(container, "stack-card-s-tight")!.textContent).toContain("Not recommended");
    expect(qt(container, "stack-card-s-big")).toBeNull();
    expect(container.textContent).toContain("1 blocked hidden");
    expect(container.textContent).toContain("Components (2)");

    act(() => {
      (Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.includes("show blocked"))!
        .querySelector("input") as HTMLInputElement).click();
    });
    const big = qt(container, "stack-card-s-big")!;
    expect(big.textContent).toContain("Blocked");
    expect(big.textContent).toContain("does not fit: needs 120.0 GiB");
    expect(container.textContent).toContain("Components (3)");
    expect(container.textContent).toContain("Blocked: does not fit");
  });

  it("filters by engine and persists the filter in localStorage", async () => {
    vi.stubGlobal("fetch", routes().fn);
    const { container } = render(<ComponentsPage />);
    await flush();
    await flush();
    pick(container, "engine", "vllm");
    expect(qt(container, "stack-card-s-ok")).toBeNull();
    expect(qt(container, "stack-card-s-tight")).not.toBeNull();
    expect(container.textContent).toContain("Components (1)");
    expect(JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY)!).engine).toBe("vllm");

    cleanupRenders();
    const again = render(<ComponentsPage />);
    await flush();
    await flush();
    expect(again.container.textContent).toContain("Components (1)");
  });

  it("clicking a stack card filters the components to its members", async () => {
    vi.stubGlobal("fetch", routes().fn);
    const { container } = render(<ComponentsPage />);
    await flush();
    await flush();
    act(() => (q(qt(container, "stack-card-s-tight")!, "button") as HTMLButtonElement).click());
    expect(container.textContent).toContain("Components (1)");
    expect(container.textContent).toContain("Comp b");
  });

  it("saves a new stack through POST /api/stacks", async () => {
    const posted: unknown[] = [];
    const f = routes({
      "POST /api/stacks": (init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body)));
        return { stack: { id: "mine", name: "Mine", componentNames: ["a"], category: "calculated" } };
      },
    });
    vi.stubGlobal("fetch", f.fn);
    const { container } = render(<ComponentsPage />);
    await flush();
    await flush();
    act(() => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "New stack")!.click());
    const builder = qt(container, "stack-builder")!;
    const name = builder.querySelector("input[aria-label='Stack name']") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Mine");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => (builder.querySelector("input[type='checkbox']") as HTMLInputElement).click());
    await act(async () => {
      Array.from(builder.querySelectorAll("button")).find((b) => b.textContent === "Save stack")!.click();
    });
    await flush();
    expect(posted).toEqual([{ name: "Mine", componentNames: ["a"] }]);
    expect(qt(container, "stack-builder")).toBeNull();
  });

  it("an older server without categories still renders", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch({
        "/api/components": { components: [comp("a")], warnings: [] },
        "/api/fleet/nodes": { nodes: [] },
      }).fn
    );
    const { container } = render(<ComponentsPage />);
    await flush();
    await flush();
    expect(container.textContent).toContain("No stacks match the filters.");
    expect(container.textContent).toContain("Components (1)");
  });
});


describe("ComponentsPage runtime profile (COMP2)", () => {
  it("shows metadata recording default and previews a variant swap", async () => {
    const profiled = comp("a", {
      recording: { content: "metadata" },
      runtimeProfile: {
        engine: "sglang",
        protocol: "sglang-http",
        ports: { engine: 8080, guard: 8081 },
        adapters: [{ id: "sglang", support: "verified", capabilities: ["metrics"] }],
        recording: { content: "metadata", retentionHours: null, maxBytes: null, observer: null },
      },
      variants: [
        { id: "stock", label: "stock", role: "standard", model: { servedModelName: "qwen3.8-27b", aliases: [] } },
        { id: "uncensored", label: "uncensored", role: "uncensored", model: { servedModelName: "qwen3.8-27b", aliases: ["uncensored"] } },
      ],
      activeVariantId: "stock",
    });
    const fx = fakeFetch({
      "/api/components": { components: [profiled], warnings: [] },
      "/api/fleet/nodes": { nodes: [{ id: "n1", name: "one" }] },
      "/api/fleet/nodes/n1/recording-status": { recording: false, available: false, content: "metadata", ui: "not recording / unavailable", reason: "observer-unavailable" },
      "/api/stacks": { stacks: [fstack("s-ok")], facets: { tp: [1], sources: ["hasso"], engines: ["sglang"], purposes: ["code"] }, errors: [] },
      "POST /api/fleet/nodes/n1/component-actions": (init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || "{}"));
        return {
          ok: true,
          version: 2,
          actionId: "x",
          componentId: "a",
          nodeId: "n1",
          type: body.type,
          status: "success",
          message: "preview",
          error: null,
          plan: body.dryRun
            ? {
                willDo: ["swap-variant"],
                displaces: null,
                confirm: "required",
                confirmationToken: "1.tok",
                estDowntimeMs: 0,
                memoryDeltaMB: 0,
                inflightRequests: null,
                scopeBlocked: null,
              }
            : null,
          canaryState: null,
          steps: [],
          state: null,
          traffic: null,
          logs: null,
          durationMs: 1,
          at: 1,
        };
      },
    });
    vi.stubGlobal("fetch", fx.fn);
    const { container } = render(<ComponentsPage />);
    await flush();
    await flush();
    expect(qt(container, "recording-a")!.textContent).toContain("not recording / unavailable");
    const swap = qt(container, "variant-swap-a")!;
    await act(async () => {
      swap.click();
    });
    await flush();
    const posted = fx.calls.find((c) => String(c.url).includes("component-actions"));
    expect(posted).toBeTruthy();
    const body = JSON.parse(String(posted!.init?.body || "{}"));
    expect(body.type).toBe("swap-variant");
    expect(body.dryRun).toBe(true);
    expect(body.variantId).toBe("stock");
  });
});
