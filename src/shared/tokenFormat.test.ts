import { describe, expect, it } from "vitest";
import { formatShare, formatTokens } from "./tokenFormat";

describe("formatTokens", () => {
  it("keeps three significant digits per unit", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1_000)).toBe("1.00K");
    expect(formatTokens(12_345)).toBe("12.3K");
    expect(formatTokens(845_000)).toBe("845K");
    expect(formatTokens(2_210_000)).toBe("2.21M");
    expect(formatTokens(3.4e9)).toBe("3.40B");
    expect(formatTokens(-1500)).toBe("-1.50K");
  });
  it("promotes values that round up to 1000 of a unit", () => {
    expect(formatTokens(999_600)).toBe("1.00M");
  });
  it("shows a dash for missing values", () => {
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(undefined)).toBe("—");
    expect(formatTokens(Number.NaN)).toBe("—");
  });
  it("formats shares", () => {
    expect(formatShare(41, 100)).toBe("41%");
    expect(formatShare(1, 1000)).toBe("<1%");
    expect(formatShare(0, 0)).toBe("—");
  });
});
