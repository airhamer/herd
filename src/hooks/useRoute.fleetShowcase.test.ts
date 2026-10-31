import { describe, expect, it } from "vitest";
import { parseFleetPath, parsePath } from "./useRoute";

describe("fleet showcase route (SHOW1, #39)", () => {
  it("parses /fleet/showcase as its own full-screen mode", () => {
    expect(parsePath("/fleet/showcase")).toEqual({ mode: "fleet-showcase", showcaseSparkId: null });
    expect(parsePath("/fleet/showcase/")).toEqual({ mode: "fleet-showcase", showcaseSparkId: null });
    expect(parsePath("/showcase/abc")).toEqual({ mode: "showcase", showcaseSparkId: "abc" });
    expect(parsePath("/fleet")).toEqual({ mode: "app", showcaseSparkId: null });
  });
  it("is not a dashboard fleet view", () => {
    expect(parseFleetPath("/fleet/showcase")).toBeNull();
  });
});
