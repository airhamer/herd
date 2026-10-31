import { describe, expect, it } from "vitest";
import { fleetViewToPath, parseFleetPath } from "./useRoute";

describe("group route (SC5d, #75)", () => {
  it("round-trips /group/:id", () => {
    expect(parseFleetPath("/group/tp2")).toEqual({ page: "group", groupId: "tp2" });
    expect(fleetViewToPath({ page: "group", groupId: "group 1" })).toBe("/group/group%201");
    expect(parseFleetPath("/group/group%201")).toEqual({ page: "group", groupId: "group 1" });
    expect(parseFleetPath("/group")).toBeNull();
    expect(parseFleetPath("/group/a/b")).toBeNull();
  });
});
