import { describe, expect, it } from "vitest";
import { fleetViewToPath, parseFleetPath } from "./useRoute";

describe("SC5c: /node/:id/traffic", () => {
  it("round-trips", () => {
    expect(parseFleetPath("/node/gx10-1c2c/traffic")).toEqual({ page: "node-traffic", nodeId: "gx10-1c2c" });
    expect(fleetViewToPath({ page: "node-traffic", nodeId: "a b" })).toBe("/node/a%20b/traffic");
    expect(parseFleetPath(fleetViewToPath({ page: "node-traffic", nodeId: "a b" }))).toEqual({ page: "node-traffic", nodeId: "a b" });
    expect(parseFleetPath("/node/gx10-1c2c/components")).toEqual({ page: "node-components", nodeId: "gx10-1c2c" });
    expect(fleetViewToPath({ page: "node-components", nodeId: "gx10-1c2c" })).toBe("/node/gx10-1c2c/components");
    expect(parseFleetPath("/group/tp2/components")).toEqual({ page: "group-components", groupId: "tp2" });
    expect(parseFleetPath("/components")).toEqual({ page: "components" });
  });
  it("leaves the other node sub-pages alone", () => {
    expect(parseFleetPath("/node/x/requests")).toEqual({ page: "node-requests", nodeId: "x" });
    expect(parseFleetPath("/node/x")).toEqual({ page: "node", nodeId: "x" });
    expect(parseFleetPath("/node/x/trafficz")).toBeNull();
  });
});
