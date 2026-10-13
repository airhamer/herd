import { describe, expect, it } from "vitest";
import {
  formatGrace,
  graceLabel,
  statusLabel,
  statusTone,
  WAVE_LOCK_NOTICE,
} from "./format";
import { updatesView } from "./testKit";

describe("formatGrace — m:ss, minutes keep climbing", () => {
  it("known answers", () => {
    expect(formatGrace(60_000)).toBe("1:00");
    expect(formatGrace(252_000)).toBe("4:12");
    expect(formatGrace(1_361_000)).toBe("22:41");
    expect(formatGrace(3_720_000)).toBe("62:00");
    expect(formatGrace(0)).toBe("0:00");
    expect(formatGrace(-5)).toBe("0:00");
    expect(formatGrace(Number.NaN)).toBe("0:00");
  });
});

describe("graceLabel — §6.2/§6.3 grace copy", () => {
  it("inside the grace window → REBOOTING", () => {
    expect(graceLabel("rebooting", 60_000)).toBe("REBOOTING 1:00");
    expect(graceLabel("rebooting", 252_000)).toBe("REBOOTING 4:12");
  });

  it("at/past 6 min → SLOW copy", () => {
    expect(graceLabel("rebooting", 360_000)).toBe("SLOW 6:00 — firmware may run long");
    expect(graceLabel("rebooting", 1_361_000)).toBe("SLOW 22:41 — firmware may run long");
    expect(graceLabel("slow", 1_361_000)).toBe("SLOW 22:41 — firmware may run long");
  });

  it("server-derived display slow flips it even below the window", () => {
    expect(graceLabel("slow", 60_000)).toBe("SLOW 1:00 — firmware may run long");
  });

  it("null graceElapsedMs renders an ellipsis time, never a fake number", () => {
    expect(graceLabel("rebooting", null)).toBe("REBOOTING …");
    expect(graceLabel("slow", null)).toBe("SLOW … — firmware may run long");
  });
});

describe("statusLabel — server display passthrough (never re-derived)", () => {
  it("stage is passed through for updating", () => {
    const v = updatesView("n1", {
      display: "updating",
      state: {
        ...updatesView("n1").state,
        inProgress: true,
        stage: "upgrade_packages",
      },
    });
    expect(statusLabel(v)).toBe("updating: upgrade_packages");
    expect(statusLabel(updatesView("n1", { display: "updating" }))).toBe("updating: …");
  });

  it("fixed labels per display", () => {
    expect(statusLabel(updatesView("n1", { display: "current" }))).toBe("current");
    expect(statusLabel(updatesView("n1", { display: "available" }))).toBe("update available");
    expect(statusLabel(updatesView("n1", { display: "stale" }))).toBe("probe stale");
    expect(statusLabel(updatesView("n1", { display: "failed" }))).toBe("failed");
    expect(statusLabel(updatesView("n1", { display: "rebooting", graceElapsedMs: 252_000 }))).toBe(
      "REBOOTING 4:12"
    );
  });

  it("negative: a current view never renders grace copy", () => {
    const text = statusLabel(updatesView("n1", { display: "current", graceElapsedMs: 1_361_000 }));
    expect(text).toBe("current");
    expect(text).not.toContain("SLOW");
    expect(text).not.toContain("REBOOTING");
  });
});

describe("WAVE_LOCK_NOTICE — exact §6.3 inline notice", () => {
  it("matches the spec string verbatim", () => {
    expect(WAVE_LOCK_NOTICE).toBe(
      "a wave is open; single-node updates are locked until it completes"
    );
  });
});

describe("statusTone", () => {
  it("maps display to tone classes", () => {
    expect(statusTone(updatesView("n1", { display: "failed" }))).toBe("text-danger");
    expect(statusTone(updatesView("n1", { display: "available" }))).toBe("text-warning");
    expect(statusTone(updatesView("n1", { display: "rebooting" }))).toBe("text-accent");
    expect(statusTone(updatesView("n1", { display: "current" }))).toBe("text-muted");
  });
});
