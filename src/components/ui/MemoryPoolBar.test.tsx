import { afterEach, describe, expect, it } from "vitest";
import { cleanupRenders, render } from "../../testing/render";
import { memoryPool } from "../../lib/memoryPool";
import { MemoryPoolBar } from "./MemoryPoolBar";

afterEach(cleanupRenders);

const HASSO = {
  totalMB: 124560,
  availableMB: 12040,
  cachedMB: 11264,
  swapTotalMB: 16384,
  swapFreeMB: 16384 - 8602,
  gpuMB: 101581,
  unified: true,
};

const q = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);

describe("MemoryPoolBar", () => {
  it("renders Hasso's reference panel numbers, model name, floor and swap", () => {
    const { container } = render(<MemoryPoolBar pool={memoryPool(HASSO)!} holder="flash 176B" />);
    const text = container.textContent ?? "";
    expect(text).toContain("Unified memory");
    expect(q(container, "memory-pool-used")?.textContent).toBe("109.9");
    expect(text).toContain("/ 121.6 GiB in use");
    expect(q(container, "memory-pool-available")?.textContent).toBe("11.8 GiB available");
    expect(q(container, "memory-pool-floor-text")?.textContent).toBe("8.8 above the 3 GiB floor");
    const legend = q(container, "memory-pool-legend")?.textContent ?? "";
    expect(legend).toContain("flash 176B99.2");
    expect(legend).toContain("System and apps10.7");
    expect(legend).toContain("Page cache11.0");
    expect(legend).toContain("Free0.8");
    expect(q(container, "memory-pool-swap")?.textContent).toBe("Swap in use8.4");
  });

  it("sizes segments as a share of the total and marks the floor", () => {
    const { container } = render(<MemoryPoolBar pool={memoryPool(HASSO)!} holder="m" />);
    const w = (id: string) => (q(container, id) as HTMLElement | null)?.style.width;
    expect(w("memory-pool-seg-gpu")).toBe("81.55%"); // 101581 / 124560
    expect(w("memory-pool-seg-cache")).toBe("9.04%");
    expect(w("memory-pool-floor")).toBe("2.47%"); // 3072 / 124560
  });

  it("hides swap when none is in use, and says 'under the floor' with a critical tone", () => {
    const pool = memoryPool({ totalMB: 124560, availableMB: 2048, swapTotalMB: 1024, swapFreeMB: 1024, unified: true })!;
    const { container } = render(<MemoryPoolBar pool={pool} holder="m" />);
    expect(q(container, "memory-pool-swap")).toBeNull();
    expect(q(container, "memory-pool-floor-text")?.textContent).toBe("under the 3 GiB floor");
    expect(q(container, "memory-pool-available")?.className).toContain("text-danger");
  });

  it("a non-unified host has no GPU segment and is titled Memory", () => {
    const pool = memoryPool({ ...HASSO, unified: false })!;
    const { container } = render(<MemoryPoolBar pool={pool} holder="m" />);
    expect(q(container, "memory-pool-seg-gpu")).toBeNull();
    expect(container.textContent).not.toContain("Unified memory");
    expect(container.textContent).toContain("System and apps");
  });
});
