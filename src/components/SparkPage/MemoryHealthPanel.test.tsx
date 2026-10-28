import { describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import type { MemoryServiceResult } from "../../api/types";
import {
  MEMORY_HEALTH_POLL_MS,
  MemoryHealthPanel,
  memoryHealthSummary,
} from "./MemoryHealthPanel";

/** A present, ok memory service; callers override only what a test is about. */
const service = (over: Partial<MemoryServiceResult> = {}): MemoryServiceResult => ({
  id: "qdrant-main",
  label: "Qdrant Main",
  kind: "qdrant",
  present: true,
  status: "ok",
  version: null,
  modelCount: null,
  checkedAt: "2026-10-28T14:00:00.000Z",
  reason: null,
  ...over,
});

const fetcherOf = (...services: MemoryServiceResult[]) =>
  vi.fn(async () => ({ services }));

describe("MemoryHealthPanel", () => {
  it("shows the loading note until the first answer lands", () => {
    const never = () => new Promise<{ services: MemoryServiceResult[] }>(() => {});
    const { container } = render(<MemoryHealthPanel fetcher={never} />);
    expect(container.textContent ?? "").toContain("Checking memory services…");
  });

  it("renders the empty service list calmly, not as an error", async () => {
    const { container } = render(<MemoryHealthPanel fetcher={fetcherOf()} />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Memory Health");
    expect(text).toContain("No memory services configured");
    expect(container.querySelector(".text-danger")).toBeNull();
  });

  it("shows a danger fetch line (without throwing) when the fetch rejects", async () => {
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    const { container } = render(<MemoryHealthPanel fetcher={failing} />);
    await flush();
    const line = container.querySelector(".text-danger");
    expect(line).not.toBeNull();
    expect(line?.textContent ?? "").toContain("boom");
    expect(container.textContent ?? "").not.toContain("Checking memory services…");
  });

  it("badges an ok service with the success style", async () => {
    const { container } = render(<MemoryHealthPanel fetcher={fetcherOf(service())} />);
    await flush();
    const badge = container.querySelector("span.text-success");
    expect(badge?.textContent).toBe("ok");
  });

  it("badges a degraded service with the warning style", async () => {
    const { container } = render(
      <MemoryHealthPanel fetcher={fetcherOf(service({ status: "degraded" }))} />,
    );
    await flush();
    const badge = container.querySelector("span.text-warning");
    expect(badge?.textContent).toBe("degraded");
  });

  it("badges an unknown status with the muted style", async () => {
    const { container } = render(
      <MemoryHealthPanel fetcher={fetcherOf(service({ status: "unknown" }))} />,
    );
    await flush();
    const badge = container.querySelector("span.bg-border");
    expect(badge?.textContent).toBe("unknown");
  });

  it("falls back label → id → \"?\"", async () => {
    const byId = render(
      <MemoryHealthPanel fetcher={fetcherOf(service({ label: null, id: "m9" }))} />,
    );
    await flush();
    expect(byId.container.textContent ?? "").toContain("m9");

    const unnamed = render(
      <MemoryHealthPanel fetcher={fetcherOf(service({ label: null, id: null }))} />,
    );
    await flush();
    expect(unnamed.container.querySelector("span[title]")?.textContent).toBe("?");
  });

  it("renders the kind tag, and an em-dash when kind is null", async () => {
    const { container } = render(
      <MemoryHealthPanel
        fetcher={fetcherOf(service({ kind: "embedder" }), service({ id: "s2", kind: null }))}
      />,
    );
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("embedder");
    expect(text).toContain("—");
  });

  it("shows version and modelCount when set", async () => {
    const { container } = render(
      <MemoryHealthPanel
        fetcher={fetcherOf(service({ version: "1.11.0", modelCount: 3 }))}
      />,
    );
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("1.11.0");
    expect(text).toContain("3 models");
  });

  it("hides version and modelCount when null", async () => {
    const { container } = render(
      <MemoryHealthPanel fetcher={fetcherOf(service({ version: null, modelCount: null }))} />,
    );
    await flush();
    const text = container.textContent ?? "";
    expect(text).not.toContain("models");
    expect(text).not.toContain("vnull");
  });

  it("shows the probe reason on a not-present service", async () => {
    const { container } = render(
      <MemoryHealthPanel
        fetcher={fetcherOf(
          service({ present: false, status: "unknown", version: null, reason: "unreachable" }),
        )}
      />,
    );
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("unreachable");
  });

  it("shows checkedAt as a compact locale time", async () => {
    const { container } = render(<MemoryHealthPanel fetcher={fetcherOf(service())} />);
    await flush();
    const expected = new Date("2026-10-28T14:00:00.000Z").toLocaleTimeString();
    expect(container.textContent ?? "").toContain(expected);
  });

  it("counts total, ok, degraded, and unknown in memoryHealthSummary", () => {
    expect(memoryHealthSummary([])).toEqual({ total: 0, ok: 0, degraded: 0, unknown: 0 });
    expect(
      memoryHealthSummary([
        service(),
        service({ id: "s2", status: "degraded" }),
        service({ id: "s3", status: "unknown" }),
        service({ id: "s4" }),
      ]),
    ).toEqual({ total: 4, ok: 2, degraded: 1, unknown: 1 });
  });

  it("renders the header count badge from the live data", async () => {
    const { container } = render(
      <MemoryHealthPanel
        fetcher={fetcherOf(
          service(),
          service({ id: "s2", status: "degraded" }),
          service({ id: "s3", status: "unknown" }),
        )}
      />,
    );
    await flush();
    expect(container.textContent ?? "").toContain("1/3 ok · 1 degraded · 1 unknown");
  });

  it("polls on a 30 s cadence", () => {
    expect(MEMORY_HEALTH_POLL_MS).toBe(30_000);
  });
});
