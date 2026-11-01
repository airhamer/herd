import { describe, expect, it } from "vitest";
import { fleetViewToPath, parseFleetPath } from "./useRoute";

describe("SC5c: /node/:id/traffic", () => {
  it("round-trips", () => {
    expect(parseFleetPath("/node/gx10-1c2c/traffic")).toEqual({ page: "node-traffic", nodeId: "gx10-1c2c" });
    expect(fleetViewToPath({ page: "node-traffic", nodeId: "a b" })).toBe("/node/a%20b/traffic");
    expect(parseFleetPath(fleetViewToPath({ page: "node-traffic", nodeId: "a b" }))).toEqual({ page: "node-traffic", nodeId: "a b" });
  });
  it("leaves the other node sub-pages alone", () => {
    expect(parseFleetPath("/node/x/requests")).toEqual({ page: "node-requests", nodeId: "x" });
    expect(parseFleetPath("/node/x")).toEqual({ page: "node", nodeId: "x" });
    expect(parseFleetPath("/node/x/trafficz")).toBeNull();
  });
});
