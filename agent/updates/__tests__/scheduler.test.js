/**
 * agent/updates/scheduler.test.js — unit tests for the DGX schedule layer.
 * Zero deps: node:test + a fake dgx + injected clock. No timers wait in real
 * time (fireSchedule is invoked directly; armed timers are .unref'd).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseCron, nextCronFire, createUpdateScheduler } from "../scheduler.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-sched-"));
}

function fakeDgx(overrides = {}) {
  return {
    probes: 0,
    triggers: 0,
    snapshot: { dgxConfigured: true, otaAvailable: null, packages: [], firmware: [] },
    async probe(force) {
      this.probes++;
      return this.snapshot;
    },
    async triggerNow() {
      this.triggers++;
      if (overrides.throwOnTrigger) {
        throw Object.assign(new Error("trigger boom"), { httpStatus: 502 });
      }
      return { ok: true };
    },
    ...overrides,
  };
}

// ── cron parsing ───────────────────────────────────────────────────────────

test("parseCron: rejects wrong field counts and garbage", () => {
  assert.equal(parseCron("0 3 * *"), null);
  assert.equal(parseCron("bogus"), null);
  assert.equal(parseCron("60 * * * *"), null);
  assert.equal(parseCron("* * * * 7"), null);
  assert.ok(parseCron("0 3 * * 0"));
});

test("nextCronFire: weekly Sunday 03:00", () => {
  const parsed = parseCron("0 3 * * 0");
  // Friday 2026-10-09 12:00 EDT → Sunday 2026-10-11 03:00 EDT
  const from = new Date("2026-10-09T12:00:00-04:00").getTime();
  const next = new Date(nextCronFire(parsed, from));
  assert.equal(next.toISOString(), new Date("2026-10-11T03:00:00-04:00").toISOString());
});

test("nextCronFire: step + range (*/15 9-17 * * 1-5)", () => {
  const parsed = parseCron("*/15 9-17 * * 1-5");
  const from = new Date("2026-10-09T12:14:00-04:00").getTime(); // Friday
  const next = new Date(nextCronFire(parsed, from));
  assert.equal(next.getHours(), 12);
  assert.equal(next.getMinutes(), 15);
});

test("nextCronFire: daily 02:30 rolls to tomorrow past the hour", () => {
  const parsed = parseCron("30 2 * * *");
  const from = new Date("2026-10-09T02:30:00-04:00").getTime();
  const next = new Date(nextCronFire(parsed, from));
  assert.equal(next.getDate(), 10);
  assert.equal(next.getHours(), 2);
  assert.equal(next.getMinutes(), 30);
});

// ── schedule-update validation & one-pending rule ─────────────────────────

test("schedule-update: at + future ok; past rejected; invalid cron rejected", async () => {
  const dir = tmpDir();
  const sched = createUpdateScheduler({ dgx: fakeDgx(), configDir: dir, now: () => 1_000_000 });
  const r = await sched.scheduleUpdate({ kind: "at", at: 2_000_000 });
  assert.equal(r.schedule.kind, "at");
  assert.equal(r.schedule.nextFire, 2_000_000);
  assert.equal(r.schedule.status, "pending");
  await assert.rejects(() => sched.scheduleUpdate({ kind: "at", at: 900_000 }), /past/);
  await assert.rejects(() => sched.scheduleUpdate({ kind: "cron", cron: "nope" }), /cron/);
  await assert.rejects(() => sched.scheduleUpdate({ kind: "someday" }), /kind/);
});

test("schedule-update: second pending → 409; replace:true swaps", async () => {
  const dir = tmpDir();
  const sched = createUpdateScheduler({ dgx: fakeDgx(), configDir: dir, now: () => 1_000_000 });
  const a = await sched.scheduleUpdate({ kind: "at", at: 2_000_000 });
  await assert.rejects(
    () => sched.scheduleUpdate({ kind: "at", at: 3_000_000 }),
    (err) => err.httpStatus === 409
  );
  const b = await sched.scheduleUpdate({ kind: "at", at: 3_000_000, replace: true });
  assert.notEqual(b.schedule.id, a.schedule.id);
  const list = sched.listSchedules();
  assert.equal(list.length, 1); // replaced one is cancelled + filtered
});

test("schedules persist across scheduler restart", async () => {
  const dir = tmpDir();
  const dgx = fakeDgx();
  const s1 = createUpdateScheduler({ dgx, configDir: dir, now: () => 1_000_000 });
  const r = await s1.scheduleUpdate({ kind: "at", at: 9_000_000 });
  const s2 = createUpdateScheduler({ dgx, configDir: dir, now: () => 2_000_000 });
  s2.start(); // re-arm from disk
  assert.equal(s2.listSchedules().length, 1);
  assert.equal(s2.listSchedules()[0].id, r.schedule.id);
});

// ── fire semantics ─────────────────────────────────────────────────────────

test("fire-schedule one-shot: fires exactly once; double-nudge is a no-op", async () => {
  const dir = tmpDir();
  const dgx = fakeDgx({
    snapshot: { dgxConfigured: true, otaAvailable: { version: "7.6.0" }, packages: [], firmware: [] },
  });
  let clock = 1_000_000;
  const sched = createUpdateScheduler({ dgx, configDir: dir, now: () => clock });
  const { schedule } = await sched.scheduleUpdate({ kind: "at", at: clock + 1 });
  clock += 1;
  const r1 = await sched.fireSchedule(schedule.id);
  assert.equal(r1.ok, true);
  assert.equal(dgx.triggers, 1);
  const r2 = await sched.fireSchedule(schedule.id);
  assert.equal(r2.alreadyFired, true);
  assert.equal(dgx.triggers, 1);
});

test("fire-schedule: nothing-new probe → skipped-current, no trigger", async () => {
  const dir = tmpDir();
  const dgx = fakeDgx(); // snapshot: no ota, no packages, no firmware
  let clock = 5_000_000;
  const sched = createUpdateScheduler({ dgx, configDir: dir, now: () => clock });
  const { schedule } = await sched.scheduleUpdate({ kind: "at", at: clock });
  const r = await sched.fireSchedule(schedule.id);
  assert.equal(dgx.triggers, 0);
  assert.equal(dgx.probes >= 1, true);
  assert.equal(r.result, "skipped-current");
});

test("fire-schedule: update available → triggered", async () => {
  const dir = tmpDir();
  const dgx = fakeDgx({
    snapshot: { dgxConfigured: true, otaAvailable: { version: "7.6.0" }, packages: [], firmware: [] },
  });
  let clock = 5_000_000;
  const sched = createUpdateScheduler({ dgx, configDir: dir, now: () => clock });
  const { schedule } = await sched.scheduleUpdate({ kind: "at", at: clock });
  const r = await sched.fireSchedule(schedule.id);
  assert.equal(dgx.triggers, 1);
  assert.equal(r.result, "triggered");
});

test("fire-schedule: already-updating (409 from trigger) counts as skipped", async () => {
  const dir = tmpDir();
  const dgx = fakeDgx({
    snapshot: { dgxConfigured: true, otaAvailable: { version: "7.6.0" }, packages: [], firmware: [] },
    async triggerNow() {
      throw Object.assign(new Error("already in progress"), { httpStatus: 409 });
    },
  });
  let clock = 5_000_000;
  const sched = createUpdateScheduler({ dgx, configDir: dir, now: () => clock });
  const { schedule } = await sched.scheduleUpdate({ kind: "at", at: clock });
  const r = await sched.fireSchedule(schedule.id);
  assert.equal(r.result, "skipped-current");
});

test("cron schedule: after fire stays pending with recomputed nextFire", async () => {
  const dir = tmpDir();
  const dgx = fakeDgx({
    snapshot: { dgxConfigured: true, otaAvailable: { version: "7.6.0" }, packages: [], firmware: [] },
  });
  let clock = new Date("2026-10-09T12:00:00-04:00").getTime();
  const sched = createUpdateScheduler({ dgx, configDir: dir, now: () => clock });
  const { schedule } = await sched.scheduleUpdate({ kind: "cron", cron: "30 2 * * *" });
  const first = schedule.nextFire;
  // production fires the schedule at nextFire; advance the clock there first
  // so recomputation can land on the NEXT day.
  clock = first + 60_000;
  await sched.fireSchedule(schedule.id);
  const after = sched.listSchedules().find((s) => s.id === schedule.id);
  assert.equal(after.status, "pending");
  assert.ok(after.nextFire > first);
  assert.equal(dgx.triggers, 1);
});

test("mirrorCron: crontab unavailable → recorded, never throws", async () => {
  const dir = tmpDir();
  const sched = createUpdateScheduler({
    dgx: fakeDgx(),
    configDir: dir,
    now: () => 1_000_000,
    crontabList: async () => {
      throw new Error("crontab: not found");
    },
  });
  const { schedule } = await sched.scheduleUpdate({ kind: "at", at: 2_000_000, mirrorCron: true });
  assert.equal(schedule.mirrorStatus, "unavailable");
});

test("mirrorCron: installs marker line; cancel removes it", async () => {
  const dir = tmpDir();
  let tab = "# base entry\n";
  const sched = createUpdateScheduler({
    dgx: fakeDgx(),
    configDir: dir,
    now: () => 1_000_000,
    crontabList: async () => tab,
    crontabWrite: async (text) => {
      tab = text;
    },
  });
  const { schedule } = await sched.scheduleUpdate({ kind: "at", at: 2_000_000, mirrorCron: true });
  assert.equal(schedule.mirrorStatus, "installed");
  assert.ok(tab.includes(`# sparkdash:${schedule.id}`));
  assert.ok(tab.includes("# base entry")); // existing entries preserved
  await sched.cancelSchedule(schedule.id);
  assert.ok(!tab.includes(schedule.id)); // marker + line removed
  assert.ok(tab.includes("# base entry"));
});

test("cancel-schedule: unknown id → 404; cancels pending", async () => {
  const dir = tmpDir();
  const sched = createUpdateScheduler({ dgx: fakeDgx(), configDir: dir, now: () => 1_000_000 });
  await assert.rejects(() => sched.cancelSchedule("nope"), (e) => e.httpStatus === 404);
  const { schedule } = await sched.scheduleUpdate({ kind: "at", at: 2_000_000 });
  const r = await sched.cancelSchedule(schedule.id);
  assert.equal(r.ok, true);
  // free again: a fresh schedule must be accepted without replace
  const r2 = await sched.scheduleUpdate({ kind: "at", at: 4_000_000 });
  assert.equal(r2.schedule.status, "pending");
});

test("fullView merges dgx state + schedules", async () => {
  const dir = tmpDir();
  const dgx = fakeDgx({
    async fullView() {
      return { snapshot: { probedAt: 5, dgxConfigured: false }, state: { inProgress: false, events: [] } };
    },
  });
  const sched = createUpdateScheduler({ dgx, configDir: dir, now: () => 1_000_000 });
  await sched.scheduleUpdate({ kind: "at", at: 2_000_000 });
  const view = await sched.fullView();
  assert.equal(view.snapshot.dgxConfigured, false);
  assert.equal(view.schedules.length, 1);
});
