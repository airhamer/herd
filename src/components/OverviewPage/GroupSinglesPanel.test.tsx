import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { CatalogComponent } from "../../api/client";
import { cleanupRenders, flush, render } from "../../testing/render";
import { GroupSinglesPanel } from "./GroupSinglesPanel";

const GiB = 1024;
const comp = (id: string, tp: number, memGiB: number, nodes: CatalogComponent["nodes"] = []): CatalogComponent => ({
  id, name: `${id} name`, purpose: "chat", kind: "llm", tp, machineClass: null, engine: "vllm", image: null, servedModelName: id,
  memoryPerSparkMB: memGiB * GiB, description: "", nodes,
});
const member = (nodeId: string, availGiB: number) => ({
  nodeId, nodeName: nodeId,
  mem: { usedMB: (120 - availGiB) * GiB, totalMB: 120 * GiB, availableMB: availGiB * GiB, percentage: 0 },
  gpu: null,
});

afterEach(() => cleanupRenders());

function setSelect(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("GroupSinglesPanel (SC5e)", () => {
  it("running TP component: per-member singles, non-fitting hidden then flagged", async () => {
    const cat = [comp("glm", 2, 90, [{ nodeId: "a", nodeName: "a", state: "running" }]), comp("small", 1, 8), comp("embed", 1, 18), comp("big", 1, 100)];
    const { container } = render(<GroupSinglesPanel members={[member("a", 40), member("b", 15)]} loadComponents={async () => ({ components: cat })} />);
    await flush();
    expect(container.querySelector('[data-testid="tp-placement"]')!.textContent).toContain("glm name is running");
    expect(container.querySelector('[data-testid="tp-select"]')).toBeNull();
    const a = container.querySelector('[data-testid="member-singles-a"]')!;
    const b = container.querySelector('[data-testid="member-singles-b"]')!;
    expect(a.querySelector('[data-testid="remaining"]')!.textContent).toBe("37.0 GiB left above floor");
    expect(Array.from(a.querySelectorAll('[data-testid="single-row"]')).map((r) => r.getAttribute("data-fit"))).toEqual(["fits", "fits"]);
    expect(a.querySelector('[data-testid="hidden-count"]')!.textContent).toContain("1 hidden");
    expect(Array.from(b.querySelectorAll('[data-testid="single-row"]')).map((r) => r.getAttribute("data-fit"))).toEqual(["tight"]);
    act(() => (container.querySelector('[data-testid="show-nofit"]') as HTMLInputElement).click());
    const bRows = Array.from(b.querySelectorAll('[data-testid="single-row"]'));
    expect(bRows.map((r) => r.getAttribute("data-fit"))).toEqual(["tight", "no_fit", "no_fit"]);
    expect(bRows[1].textContent).toContain("doesn't fit");
    expect(bRows[1].textContent).toContain("short 6.0");
  });

  it("no TP component yet: selector plans with one and the remaining memory drops", async () => {
    const cat = [comp("glm", 2, 90), comp("small", 1, 8)];
    const { container } = render(<GroupSinglesPanel members={[member("a", 110), member("b", 110)]} loadComponents={async () => ({ components: cat })} />);
    await flush();
    expect(container.querySelector('[data-testid="tp-placement"]')!.textContent).toContain("No TP component placed yet");
    const rem = () => container.querySelector('[data-testid="member-singles-a"] [data-testid="remaining"]')!.textContent;
    expect(rem()).toBe("107.0 GiB left above floor");
    setSelect(container.querySelector('[data-testid="tp-select"]') as HTMLSelectElement, "glm");
    expect(rem()).toBe("17.0 GiB left above floor");
    expect(container.querySelector('[data-testid="tp-placement"]')!.textContent).toContain("Planning with");
  });

  it("catalog error is shown", async () => {
    const { container } = render(<GroupSinglesPanel members={[member("a", 1)]} loadComponents={async () => Promise.reject(new Error("HTTP 500"))} />);
    await flush();
    expect(container.textContent).toContain("Components unavailable: HTTP 500");
  });
});
