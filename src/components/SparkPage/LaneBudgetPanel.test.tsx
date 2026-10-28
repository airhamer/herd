import { render } from "../../testing/render";
import { describe, expect, it } from "vitest";
import type { LaneEntry, NodeLanes } from "../../../shared/types";
import { LaneBudgetPanel } from "./LaneBudgetPanel";

const lane = (over: Partial<LaneEntry> & { recipe: string }): LaneEntry => ({
  modelId: "m",
  port: 8080,
  order: 0,
  running: false,
  containerName: null,
  state: "stopped",
  ...over,
});

const lanes = (...pools: [string, LaneEntry[]][]): NodeLanes => ({
  pools: pools.map(([id, l]) => ({ id, lanes: l })),
  candidates: [],
});

const TOTAL = 128_000;

describe("LaneBudgetPanel", () => {
  it("renders a not-present state when lanes is null, without hiding the panel", () => {
    const { container } = render(<LaneBudgetPanel lanes={null} poolTotalMB={TOTAL} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Lanes");
    expect(text).toContain("No lane data");
  });

  it("renders a not-present state when the pool total is unknown", () => {
    const l = lanes(["gpu0", [lane({ recipe: "a", running: true, state: "running" })]]);
    const { container } = render(<LaneBudgetPanel lanes={l} poolTotalMB={null} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Lanes");
    expect(text).toContain("No lane data");
    expect(text).not.toContain("gpu0");
  });

  it("renders one pool with running totals and headroom", () => {
    const l = lanes([
      "gpu0",
      [lane({ recipe: "a", running: true, state: "running" }), lane({ recipe: "b", order: 1 })],
    ]);
    const { container } = render(
      <LaneBudgetPanel lanes={l} poolTotalMB={TOTAL} recipeFootprints={{ a: 40_000, b: 20_000 }} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Pool gpu0 · 1 running");
    expect(text).toContain("39.1 GB / 125.0 GB"); // 40_000 / 128_000
    expect(text).toContain("85.9 GB"); // headroom 88_000
    expect(text).toContain("fits if stopped"); // b: 20_000 <= 88_000
  });

  it("shows a danger badge in the header when a pool is over-committed", () => {
    const l = lanes([
      "gpu0",
      [
        lane({ recipe: "a", running: true, state: "running" }),
        lane({ recipe: "b", running: true, state: "running", order: 1 }),
      ],
    ]);
    const { container } = render(
      <LaneBudgetPanel lanes={l} poolTotalMB={1000} recipeFootprints={{ a: 900, b: 600 }} />,
    );
    const badge = [...container.querySelectorAll("span.text-danger")].find((s) =>
      (s.textContent ?? "").includes("Over committed"),
    );
    expect(badge).toBeDefined();
    expect(badge!.className).toContain("border-danger/40");
  });

  it("marks stopped lanes as fits / won't fit against the headroom", () => {
    const l = lanes([
      "gpu0",
      [
        lane({ recipe: "big", running: true, state: "running" }),
        lane({ recipe: "exact", order: 1 }),
        lane({ recipe: "over", order: 2 }),
      ],
    ]);
    const { container } = render(
      <LaneBudgetPanel lanes={l} poolTotalMB={1000} recipeFootprints={{ big: 800, exact: 200, over: 201 }} />,
    );
    expect(container.textContent ?? "").toContain("fits if stopped");
    expect(container.textContent ?? "").toContain("won't fit");
  });

  it("renders multiple pools independently", () => {
    const l = lanes(
      ["gpu0", [lane({ recipe: "a", running: true, state: "running" })]],
      ["gpu1", [lane({ recipe: "b" })]],
    );
    const { container } = render(
      <LaneBudgetPanel lanes={l} poolTotalMB={TOTAL} recipeFootprints={{ a: 120_000, b: 10_000 }} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Pool gpu0 · 1 running");
    expect(text).toContain("Pool gpu1 · 0 running");
    expect(text).toContain("fits if stopped"); // gpu1 headroom = 128_000 (pools independent)
  });

  it("shows an estimate-only hint and a dash footprint for unknown recipes", () => {
    const l = lanes(["gpu0", [lane({ recipe: "known", modelId: "known", running: true, state: "running" }), lane({ recipe: "ghost", modelId: "ghost", order: 1 })]]);
    const { container } = render(
      <LaneBudgetPanel lanes={l} poolTotalMB={TOTAL} recipeFootprints={{ known: 50_000, ghost: null }} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Unknown footprints");
    expect(text).toContain("estimates only");
    // The ghost lane's row shows "—" instead of a footprint.
    const rows = [...container.querySelectorAll(".bg-surface-elevated")];
    const ghostRow = rows.find((r) => (r.textContent ?? "").includes("ghost"));
    expect(ghostRow?.textContent ?? "").toContain("—");
    const knownRow = rows.find((r) => (r.textContent ?? "").includes("known"));
    expect(knownRow?.textContent ?? "").toContain("48.8 GB"); // 50_000 MB
  });

  it("keeps a present-but-empty lane view visible with an empty note", () => {
    const { container } = render(<LaneBudgetPanel lanes={lanes()} poolTotalMB={TOTAL} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Lanes");
    expect(text).toContain("No lane data");
  });
});
