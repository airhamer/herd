import { describe, expect, it } from "vitest";
import { fleetViewToPath, parseFleetPath } from "./useRoute";

describe("activity route (issue #32)", () => {
  it("round-trips /activity", () => {
    expect(parseFleetPath("/activity")).toEqual({ page: "activity" });
    expect(fleetViewToPath({ page: "activity" })).toBe("/activity");
    expect(parseFleetPath("/activity/extra")).toBeNull();
  });
});
