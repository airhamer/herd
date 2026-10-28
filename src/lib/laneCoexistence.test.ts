import { describe, expect, it } from "vitest";
import { computeLaneBudgets } from "./laneCoexistence";
import type { BudgetLane, BudgetLanes } from "./laneCoexistence";

const lane = (over: Partial<BudgetLane> & { recipe: string }): BudgetLane => ({
  modelId: "m",
  port: 8080,
  order: 0,
  running: false,
  containerName: null,
  state: "stopped",
  footprintMB: 1000,
  ...over,
});

const view = (...pools: [string, BudgetLane[]][]): BudgetLanes => ({
  pools: pools.map(([id, lanes]) => ({ id, lanes })),
});

const TOTAL = 128_000;

describe("computeLaneBudgets", () => {
  it("is not-present when lanes are null or undefined", () => {
    expect(computeLaneBudgets(null, TOTAL)).toEqual({ available: false, pools: [] });
    expect(computeLaneBudgets(undefined, TOTAL)).toEqual({ available: false, pools: [] });
  });

  it("is not-present when the pool total is unknown (null / <=0 / non-finite)", () => {
    const lanes = view(["gpu0", [lane({ recipe: "a", running: true, state: "running" })]]);
    expect(computeLaneBudgets(lanes, null)).toEqual({ available: false, pools: [] });
    expect(computeLaneBudgets(lanes, 0)).toEqual({ available: false, pools: [] });
    expect(computeLaneBudgets(lanes, -1)).toEqual({ available: false, pools: [] });
    expect(computeLaneBudgets(lanes, Number.NaN)).toEqual({ available: false, pools: [] });
  });

  it("is available with no pools when the lane view is empty", () => {
    expect(computeLaneBudgets({ pools: [] }, TOTAL)).toEqual({ available: true, pools: [] });
  });

  it("sums running footprints and reports headroom", () => {
    const lanes = view([
      "gpu0",
      [
        lane({ recipe: "a", running: true, state: "running", footprintMB: 40_000 }),
        lane({ recipe: "b", running: true, state: "running", footprintMB: 30_000, order: 1 }),
        lane({ recipe: "c", footprintMB: 20_000, order: 2 }),
      ],
    ]);
    const out = computeLaneBudgets(lanes, TOTAL);
    expect(out.available).toBe(true);
    const p = out.pools[0];
    expect(p).toMatchObject({
      id: "gpu0",
      totalMB: 128_000,
      runningMB: 70_000,
      runningCount: 2,
      headroomMB: 58_000,
      overCommitted: false,
    });
    expect(p.unknownFootprint).toBeUndefined();
    expect(p.lanes.map((l) => l.recipe)).toEqual(["a", "b", "c"]); // input order kept
    // running lanes carry no fitsWhenStopped verdict; stopped lanes do.
    expect(p.lanes[0].fitsWhenStopped).toBeUndefined();
    expect(p.lanes[2]).toEqual({
      recipe: "c",
      modelId: "m",
      state: "stopped",
      footprintMB: 20_000,
      order: 2,
      fitsWhenStopped: true,
    });
  });

  it("flags a pool over-committed with negative headroom", () => {
    const lanes = view([
      "gpu0",
      [
        lane({ recipe: "a", running: true, state: "running", footprintMB: 90_000 }),
        lane({ recipe: "b", running: true, state: "running", footprintMB: 60_000, order: 1 }),
      ],
    ]);
    const p = computeLaneBudgets(lanes, TOTAL).pools[0];
    expect(p.runningMB).toBe(150_000);
    expect(p.headroomMB).toBe(-22_000);
    expect(p.overCommitted).toBe(true);
  });

  it("decides fitsWhenStopped against exact headroom (fits at equality)", () => {
    const lanes = view([
      "gpu0",
      [
        lane({ recipe: "big", running: true, state: "running", footprintMB: 100_000 }),
        lane({ recipe: "exact", footprintMB: 28_000, order: 1 }),
        lane({ recipe: "over", footprintMB: 28_001, order: 2 }),
      ],
    ]);
    const p = computeLaneBudgets(lanes, TOTAL).pools[0];
    expect(p.lanes[1].fitsWhenStopped).toBe(true); // 28_000 <= 28_000
    expect(p.lanes[2].fitsWhenStopped).toBe(false); // 28_001 > 28_000
  });

  it("counts unknown (nullish / non-finite) footprints as 0 and flags the pool", () => {
    const lanes = view([
      "gpu0",
      [
        lane({ recipe: "known", running: true, state: "running", footprintMB: 50_000 }),
        lane({ recipe: "missing", footprintMB: undefined }),
        lane({ recipe: "nullish", footprintMB: null, order: 1 }),
        lane({ recipe: "nan", footprintMB: Number.NaN, order: 2 }),
      ],
    ]);
    const p = computeLaneBudgets(lanes, TOTAL).pools[0];
    expect(p.unknownFootprint).toBe(true);
    expect(p.runningMB).toBe(50_000); // unknown contributes 0
    expect(p.lanes[1].footprintMB).toBe(0);
    // unknown (0 MB) stopped lanes trivially fit — the flag warns the UI.
    expect(p.lanes[1].fitsWhenStopped).toBe(true);
    expect(p.lanes[2].fitsWhenStopped).toBe(true);
    // known pools in the same call are unaffected by the flag.
    const mixed = computeLaneBudgets(
      view(["gpu0", [lane({ recipe: "x", footprintMB: null })]], ["gpu1", [lane({ recipe: "y" })]]),
      TOTAL,
    );
    expect(mixed.pools[0].unknownFootprint).toBe(true);
    expect(mixed.pools[1].unknownFootprint).toBeUndefined();
  });

  it("computes multi-pool budgets independently", () => {
    const lanes = view(
      ["gpu0", [lane({ recipe: "a", running: true, state: "running", footprintMB: 120_000 })]],
      ["gpu1", [lane({ recipe: "b", footprintMB: 10_000 })]],
    );
    const out = computeLaneBudgets(lanes, TOTAL);
    expect(out.pools.map((p) => p.id)).toEqual(["gpu0", "gpu1"]);
    expect(out.pools[0]).toMatchObject({ runningMB: 120_000, headroomMB: 8_000, overCommitted: false });
    expect(out.pools[1]).toMatchObject({ runningMB: 0, runningCount: 0, headroomMB: 128_000 });
    expect(out.pools[1].lanes[0].fitsWhenStopped).toBe(true);
  });

  it("falls back to the state string when the running boolean is absent", () => {
    const bare = {
      pools: [
        {
          id: "gpu0",
          lanes: [
            { recipe: "served", modelId: null, port: null, order: 0, state: "running", containerName: null, footprintMB: 4000 },
            { recipe: "idle", modelId: null, port: null, order: 1, state: "stopped", containerName: null, footprintMB: 5000 },
          ],
        },
      ],
    };
    // The seam always carries `running`; this tests the defensive fallback,
    // so the shape is deliberately off-type (input validation, not the seam).
    const p = computeLaneBudgets(bare as unknown as BudgetLanes, TOTAL).pools[0];
    expect(p.runningCount).toBe(1);
    expect(p.runningMB).toBe(4000);
    expect(p.lanes[1].fitsWhenStopped).toBe(true);
  });
});
