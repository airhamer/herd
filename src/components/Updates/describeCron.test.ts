import { describe, expect, it } from "vitest";
import { describeCron } from "./describeCron";

// Known-answer tests (BATCH6 binding rule: e.g. `0 3 * * 0` → "weekly Sun 03:00").
// Ground truth was worked by hand from the §6.3 field classes, NOT by running
// describeCron — every expected string here was written before importing it.

describe("describeCron — every-field class, known answers", () => {
  it("single time weekly by dow number", () => {
    expect(describeCron("0 3 * * 0")).toBe("weekly Sun 03:00");
    expect(describeCron("30 4 * * 5")).toBe("weekly Fri 04:30");
  });

  it("7 is the Sunday alias", () => {
    expect(describeCron("0 3 * * 7")).toBe("weekly Sun 03:00");
  });

  it("step minute every-N", () => {
    expect(describeCron("*/15 * * * *")).toBe("every 15 minutes");
    expect(describeCron("*/5 * * * *")).toBe("every 5 minutes");
  });

  it("all stars", () => {
    expect(describeCron("* * * * *")).toBe("every minute");
  });

  it("hour step + hour star at fixed minute", () => {
    expect(describeCron("0 */2 * * *")).toBe("every 2 hours at :00");
    expect(describeCron("0 * * * *")).toBe("every hour at :00");
  });

  it("daily at fixed time", () => {
    expect(describeCron("15 2 * * *")).toBe("daily 02:15");
  });

  it("dow ranges and comma lists (numeric)", () => {
    expect(describeCron("0 3 * * 1-5")).toBe("weekly Mon-Fri 03:00");
    expect(describeCron("0 3 * * 1,3,5")).toBe("weekly Mon,Wed,Fri 03:00");
  });

  it("dow names and name ranges", () => {
    expect(describeCron("0 3 * * SUN")).toBe("weekly Sun 03:00");
    expect(describeCron("0 3 * * SUN-SAT")).toBe("weekly Sun-Sat 03:00");
    expect(describeCron("0 3 * * MON,WED")).toBe("weekly Mon,Wed 03:00");
  });

  it("day-of-month ranges and lists", () => {
    expect(describeCron("30 4 1-7 * *")).toBe("monthly on day 1-7 04:30");
    expect(describeCron("0 12 15 * *")).toBe("monthly on day 15 12:00");
    expect(describeCron("0 8 1,15 * *")).toBe("monthly on day 1,15 08:00");
  });

  it("month names and month/day combos", () => {
    expect(describeCron("0 0 * FEB *")).toBe("yearly in Feb 00:00");
    expect(describeCron("0 0 4 JUL *")).toBe("yearly Jul 4 00:00");
    expect(describeCron("0 0 15 FEB-MAR *")).toBe("yearly Feb-Mar 15 00:00");
    expect(describeCron("0 12 1 1 *")).toBe("yearly Jan 1 12:00");
  });

  it("valid-but-unpreviewed shapes fall back to `cron: <expr>`", () => {
    expect(describeCron("0,30 3 * * *")).toBe("cron: 0,30 3 * * *");
  });

  it("surrounding whitespace is tolerated", () => {
    expect(describeCron("  0 3 * * 0  ")).toBe("weekly Sun 03:00");
  });
});

describe("describeCron — invalid input → null", () => {
  it("wrong field counts", () => {
    expect(describeCron("0 3 * *")).toBeNull(); // 4 fields
    expect(describeCron("* * * * * *")).toBeNull(); // 6 fields
    expect(describeCron("")).toBeNull();
  });

  it("out-of-range values", () => {
    expect(describeCron("60 * * * *")).toBeNull(); // minute > 59
    expect(describeCron("* 24 * * *")).toBeNull(); // hour > 23
    expect(describeCron("0 0 0 * *")).toBeNull(); // dom < 1
    expect(describeCron("0 0 * 13 *")).toBeNull(); // month > 12
    expect(describeCron("0 0 * * 8")).toBeNull(); // dow > 7
    expect(describeCron("* * * * SUN-SUN-XYZ")).toBeNull();
  });

  it("non-numeric, non-name tokens", () => {
    expect(describeCron("a * * * *")).toBeNull();
    expect(describeCron("*/x * * * *")).toBeNull();
    expect(describeCron("* * * * FOO")).toBeNull();
  });
});
