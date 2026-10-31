import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetAlertStrip, deriveAlerts, stripAlerts } from "./FleetAlertStrip";
import type { AlertInstance, SparkSnapshot } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { render } from "../../testing/render";

const T0 = 1_800_000_000_000;
const MIN = 60_000;

/** A unit whose GPU reports throttling for the given cause. */
function withThrottle(id: string, cause: "thermal" | "power"): SparkSnapshot {
  const spark = makeSpark(id);
  const gpu = spark.metrics.gpu!;
  spark.metrics.gpu = {
    ...gpu,
    temperature: 88,
    throttle: {
      active: true,
      reason: cause,
      thermal: cause === "thermal",
      powerCap: cause === "power",
      hwSlowdown: false,
      detail: cause === "thermal" ? "HW thermal slowdown" : "SW power cap",
      smClockMHz: 1200,
      smClockPct: 40,
    },
  } as typeof gpu;
  return spark;
}

function firing(fields: Partial<AlertInstance> & Pick<AlertInstance, "unitId" | "ruleId">): AlertInstance {
  const { unitId, ruleId } = fields;
  return {
    key: `${unitId}:${ruleId}`,
    ruleName: ruleId,
    unitName: `Unit ${unitId}`,
    severity: "warning",
    state: "firing",
    label: `${ruleId} label`,
    summary: `${ruleId} summary`,
    startsAt: T0,
    firingAt: T0,
    ...fields,
  };
}

const memoryAlert = () =>
  firing({ unitId: "spark-1", ruleId: "memory", unitName: "Spark spark-1", label: "Unified memory is running low", summary: "2.8 GB available of 122 GB.", startsAt: T0 - 125 * MIN });

const shownText = () => Array.from(document.querySelectorAll(".ov-alert .ov-alert__text"), (el) => el.textContent);

describe("deriveAlerts", () => {
  it("applies the strip rules: offline and thermal throttle count, a power cap does not", () => {
    const rows = deriveAlerts([makeSpark("a", false), withThrottle("b", "thermal"), withThrottle("c", "power")]);
    expect(rows.map((r) => [r.key, r.severity, r.throttle ?? false])).toEqual([
      ["a:offline", "critical", false],
      ["b:throttle", "critical", true],
    ]);
  });

  it("formats temperatures in the requested unit", () => {
    expect(deriveAlerts([withThrottle("b", "thermal")], "fahrenheit")[0].detail).toBe("HW thermal slowdown · GPU at 190°F · SM clock 1.2 GHz (40% of max)");
  });
});

describe("stripAlerts", () => {
  it("uses the browser's own rows while notifications are off, ignoring server alerts", () => {
    const rows = stripAlerts({ sparks: [makeSpark("a", false)], serverAlerts: [memoryAlert()] });
    expect(rows.map((r) => r.key)).toEqual(["a:offline"]);
    expect(rows[0].startsAt).toBeNull();
  });

  it("falls back to its own rows until the server's set arrives", () => {
    expect(stripAlerts({ sparks: [makeSpark("a", false)], alertsEnabled: true, serverAlerts: null }).map((r) => r.key)).toEqual(["a:offline"]);
  });

  it("with notifications on, a strip rule the browser can see takes the live wording", () => {
    const [row] = stripAlerts({
      sparks: [withThrottle("b", "thermal")],
      alertsEnabled: true,
      temperatureUnit: "fahrenheit",
      serverAlerts: [firing({ unitId: "b", ruleId: "throttle", severity: "critical", label: "is thermal throttling", summary: "GPU at 88°C", startsAt: T0 - 7 * MIN })],
    });
    expect(row.detail).toContain("GPU at 190°F");
    expect(row.startsAt).toBe(T0 - 7 * MIN);
    expect(row.throttle).toBe(true);
  });

  it("a server alert unknown to the browser keeps the server's text; an identical summary is not repeated", () => {
    const rows = stripAlerts({
      sparks: [],
      alertsEnabled: true,
      serverAlerts: [memoryAlert(), firing({ unitId: "z", ruleId: "disk", label: "Disk full", summary: "Disk full" })],
    });
    expect(rows[0]).toMatchObject({ label: "Unified memory is running low", detail: "2.8 GB available of 122 GB." });
    expect(rows[1].detail).toBeUndefined();
  });

  it("with the full list hidden only throttle rows remain, from either source", () => {
    const sparks = [makeSpark("a", false), withThrottle("b", "thermal")];
    expect(stripAlerts({ sparks, showExceptions: false }).map((r) => r.key)).toEqual(["b:throttle"]);
    const server = [memoryAlert(), firing({ unitId: "b", ruleId: "throttle", severity: "critical" })];
    expect(stripAlerts({ sparks, alertsEnabled: true, serverAlerts: server, showExceptions: false }).map((r) => r.key)).toEqual(["b:throttle"]);
  });
});

describe("FleetAlertStrip", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it("renders derived rows timed from first sight", () => {
    render(<FleetAlertStrip sparks={[makeSpark("a", false), makeSpark("b")]} />);
    expect(shownText()).toEqual(["Spark a Host unreachable.0m active"]);
  });

  it("renders server alerts with their real age, marks critical rows and opens the unit on click", () => {
    const select = vi.fn();
    const offline = firing({ unitId: "x", ruleId: "offline", unitName: "X", label: "Host unreachable", summary: "Unreachable: timeout", severity: "critical", startsAt: T0 - 61_000 });
    render(<FleetAlertStrip sparks={[makeSpark("spark-1")]} alertsEnabled serverAlerts={[memoryAlert(), offline]} onSelect={select} />);

    expect(shownText()).toEqual(["Spark spark-1 Unified memory is running low.2.8 GB available of 122 GB. · 125m active", "X Host unreachable.Unreachable: timeout · 1m active"]);
    const rows = document.querySelectorAll<HTMLElement>(".ov-alert");
    expect(rows[0].classList.contains("ov-alert--bad")).toBe(false);
    expect(rows[1].classList.contains("ov-alert--bad")).toBe(true);
    rows[1].querySelector("button")!.click();
    expect(select).toHaveBeenCalledWith("x");
  });

  it("renders nothing when the server reports nothing firing, whatever the browser sees", () => {
    const { container } = render(<FleetAlertStrip sparks={[makeSpark("a", false)]} alertsEnabled serverAlerts={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
