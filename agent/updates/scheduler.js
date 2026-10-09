/**
 * updates/scheduler.js — DGX-update schedules on the node agent.
 *
 * Contract (docs/SPEC-UPDATES.md §5.1/§5.2):
 *  - One pending dgx-update per agent; second schedule → 409 unless replace.
 *  - kind "at": in-process armed timer; persisted; re-armed on start; a
 *    past-due one-shot fires exactly once immediately after start.
 *  - kind "cron": 5-field cron evaluated in-process; after each fire,
 *    nextFire recomputed; schedule stays pending.
 *  - fire-schedule is IDEMPOTENT: a one-shot fires at most once no matter how
 *    many substrates (timer, host-cron mirror, dashboard) nudge it.
 *  - A cron fire probes first: nothing newer → logged no-op
 *    (lastFireResult "skipped-current"), no trigger, no reboot.
 *  - mirrorCron: best-effort host crontab entry (marker-commented); the agent
 *    runs in a container where crontab is usually unavailable — failure to
 *    mirror is recorded on the schedule, never fatal.
 *
 * Zero dependencies. Timers fire; between fires nothing polls.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CONFIG_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "config");

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

// ── 5-field cron ──────────────────────────────────────────────────────────
// minute hour day-of-month month day-of-week (0-6, Sunday=0). Supports
// "*", lists "a,b", ranges "a-b", steps "*\/n" and "a-b/n".

function parseField(spec, min, max) {
  const out = new Set();
  for (const part of String(spec).split(",")) {
    let m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    let lo, hi;
    if (m[1] === "*") {
      lo = min; hi = max;
    } else if (m[1].includes("-")) {
      const [a, b] = m[1].split("-").map(Number);
      lo = a; hi = b;
    } else {
      lo = hi = Number(m[1]);
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < min || hi > max || hi < lo || step < 1) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

/** Parse a 5-field cron expression → field sets, or null when invalid. */
export function parseCron(expr) {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12);
  const dow = parseField(parts[4], 0, 6);
  if (!minute || !hour || !dom || !month || !dow) return null;
  return { minute, hour, dom, month, dow };
}

/**
 * Next fire time (epoch ms, strictly after `fromMs`) for a parsed cron.
 * Minute-step scan bounded to ~366 days; computed only at schedule and
 * fire time — never in a polling loop.
 * @param {ReturnType<typeof parseCron>} parsed
 */
export function nextCronFire(parsed, fromMs) {
  if (!parsed) return null;
  let t = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const limit = fromMs + 367 * 24 * 60 * 60_000;
  while (t < limit) {
    const d = new Date(t);
    if (
      parsed.minute.has(d.getMinutes()) &&
      parsed.hour.has(d.getHours()) &&
      parsed.month.has(d.getMonth() + 1) &&
      (parsed.dow.has(d.getDay()) || parsed.dow.size === 7) &&
      (parsed.dom.has(d.getDate()) || parsed.dom.size === 31)
    ) {
      return t;
    }
    t += 60_000;
  }
  return null;
}

// ── Scheduler ─────────────────────────────────────────────────────────────

/**
 * @param {{
 *   dgx: import("./dgx.js") returns,
 *   configDir?: string,
 *   now?: () => number,
 * }} opts
 */
export function createUpdateScheduler(opts) {
  const configDir = opts.configDir || CONFIG_DIR;
  const now = opts.now || Date.now;
  const dgx = opts.dgx;
  const storePath = path.join(configDir, "schedules.json");
  // Test seam: inject fake crontab IO so unit tests never touch a real
  // crontab. Production (undefined) uses the crontab binary when present.
  const crontabList = typeof opts.crontabList === "function" ? opts.crontabList : null;
  const crontabWrite = typeof opts.crontabWrite === "function" ? opts.crontabWrite : null;
  const timers = new Map();

  /** @type {Array<import("../../shared/types.ts").NodeUpdateSchedule>} */
  let schedules = readJsonSafe(storePath) || [];
  if (!Array.isArray(schedules)) schedules = [];

  function save() {
    writeJsonAtomic(storePath, schedules);
  }

  function pending() {
    return schedules.find((s) => s.status === "pending");
  }

  function armOne(s) {
    disarmOne(s.id);
    const due = s.nextFire - now();
    const t = setTimeout(() => void fireSchedule(s.id), Math.max(due, 0));
    t.unref?.();
    timers.set(s.id, t);
  }

  function disarmOne(id) {
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
  }

  /** Re-arm every pending schedule on agent start (past-due fires once). */
  function start() {
    for (const s of schedules) {
      if (s.status !== "pending") continue;
      if (s.kind === "cron") {
        const parsed = parseCron(s.cron);
        s.nextFire = nextCronFire(parsed, now()) ?? s.nextFire;
      }
      armOne(s);
    }
  }

  /**
   * POST /actions {action:"schedule-update"}
   * @returns {Promise<{schedule:object}>} — throws {httpStatus} on 409/400.
   */
  async function scheduleUpdate(req) {
    const kind = req.kind;
    if (kind !== "at" && kind !== "cron") {
      throw Object.assign(new Error('kind must be "at" or "cron"'), { httpStatus: 400 });
    }
    let at = null;
    let cron = null;
    let nextFire;
    if (kind === "at") {
      at = Number(req.at);
      if (!Number.isFinite(at) || at <= 0) {
        throw Object.assign(new Error("at must be a positive epoch-ms number"), { httpStatus: 400 });
      }
      if (at < now() - 60_000) {
        throw Object.assign(new Error("at is more than a minute in the past"), { httpStatus: 400 });
      }
      nextFire = at;
    } else {
      cron = typeof req.cron === "string" ? req.cron.trim() : "";
      const parsed = parseCron(cron);
      if (!parsed) {
        throw Object.assign(new Error(`invalid 5-field cron expression: ${JSON.stringify(req.cron)}`), { httpStatus: 400 });
      }
      nextFire = nextCronFire(parsed, now());
      if (nextFire == null) {
        throw Object.assign(new Error("cron expression never fires within a year"), { httpStatus: 400 });
      }
    }
    const existing = pending();
    if (existing && req.replace !== true) {
      throw Object.assign(
        new Error(`a schedule is already pending (${existing.id}); use replace:true to replace it`),
        { httpStatus: 409 }
      );
    }
    if (existing && req.replace === true) {
      existing.status = "cancelled";
      disarmOne(existing.id);
      void removeMirror(existing);
    }
    const schedule = {
      id: crypto.randomUUID(),
      action: "dgx-update",
      kind,
      at,
      cron,
      nextFire,
      status: "pending",
      mirrorCron: req.mirrorCron === true,
      mirrorStatus: null,
      createdAt: now(),
      firedAt: null,
      lastFireResult: null,
    };
    schedules.push(schedule);
    save();
    if (schedule.mirrorCron) await installMirror(schedule);
    armOne(schedule);
    return { schedule };
  }

  async function cancelSchedule(scheduleId) {
    const s = schedules.find((x) => x.id === scheduleId);
    if (!s) throw Object.assign(new Error("no such schedule"), { httpStatus: 404 });
    s.status = "cancelled";
    disarmOne(s.id);
    await removeMirror(s);
    save();
    return { ok: true };
  }

  /** Idempotent fire. Double-nudges (timer + host cron) are safe. */
  async function fireSchedule(scheduleId) {
    const s = schedules.find((x) => x.id === scheduleId);
    if (!s) throw Object.assign(new Error("no such schedule"), { httpStatus: 404 });
    if (s.status === "cancelled") return { ok: true, skipped: "cancelled" };
    if (s.kind === "at" && s.status !== "pending") {
      return { ok: true, alreadyFired: true };
    }
    if (s.kind === "cron" && s.firedAt && now() - s.firedAt < 60_000) {
      return { ok: true, alreadyFired: true }; // double-nudge guard
    }
    s.firedAt = now();
    if (s.kind === "at") s.status = "fired";
    save();
    try {
      const snap = await dgx.probe(true);
      const nothingNew =
        snap &&
        snap.dgxConfigured !== false &&
        !snap.otaAvailable &&
        (!snap.packages || snap.packages.length === 0) &&
        (!snap.firmware || snap.firmware.length === 0);
      if (nothingNew) {
        s.lastFireResult = "skipped-current";
      } else {
        await dgx.triggerNow();
        s.lastFireResult = "triggered";
      }
    } catch (err) {
      if (err?.httpStatus === 409) {
        s.lastFireResult = "skipped-current"; // already updating
      } else {
        s.lastFireResult = "error";
        s.lastFireDetail = String(err?.message || err);
        save();
        if (s.kind === "cron") {
          s.nextFire = nextCronFire(parseCron(s.cron), now());
          armOne(s);
        }
        throw err;
      }
    }
    if (s.kind === "cron") {
      s.status = "pending";
      s.nextFire = nextCronFire(parseCron(s.cron), now());
      armOne(s);
    } else {
      disarmOne(s.id);
    }
    save();
    return { ok: true, result: s.lastFireResult };
  }

  // ── host crontab mirror (best-effort; container may have no crontab) ──
  const MARK = (id) => `# sparkdash:${id}`;
  const CRON_LINE = (id) =>
    `curl -sf -m5 -X POST http://127.0.0.1:30091/actions -H 'Content-Type: application/json' -d '{"type":"fire-schedule","scheduleId":"${id}"}' >/dev/null`;

  async function crontab(list) {
    if (crontabList) {
      try {
        return await crontabList();
      } catch {
        return null;
      }
    }
    const { execFile } = await import("node:child_process");
    return new Promise((resolve) => {
      execFile("crontab", list ? ["-l"] : [], { timeout: 5000 }, (err, stdout) =>
        resolve(err ? null : String(stdout))
      );
    });
  }

  async function installMirror(s) {
    try {
      const cur = await crontab(true);
      if (cur == null) {
        s.mirrorStatus = "unavailable";
      } else {
        const lines = cur.split("\n").filter((l) => !l.includes(MARK(s.id)));
        lines.push(MARK(s.id), `* * * * * ${CRON_LINE(s.id)}`);
        await writeCrontab(lines.join("\n") + "\n");
        s.mirrorStatus = "installed";
      }
    } catch {
      s.mirrorStatus = "unavailable";
    }
    save();
  }

  async function removeMirror(s) {
    if (!s.mirrorCron || s.mirrorStatus !== "installed") return;
    try {
      const cur = await crontab(true);
      if (cur != null) {
        const lines = cur.split("\n").filter((l) => !l.includes(MARK(s.id)) && !l.includes(s.id));
        await writeCrontab(lines.join("\n") + (lines.length ? "\n" : ""));
        s.mirrorStatus = "removed";
      }
    } catch {}
    save();
  }

  async function writeCrontab(text) {
    if (crontabWrite) return crontabWrite(text);
    const { spawn } = await import("node:child_process");
    await new Promise((resolve, reject) => {
      const p = spawn("crontab", ["-"], { timeout: 5000 });
      p.on("error", reject);
      p.stdin.write(text);
      p.stdin.end();
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`crontab exit ${code}`))));
    });
  }

  function listSchedules() {
    return schedules.filter((s) => s.status !== "cancelled");
  }

  /** GET /updates body. */
  async function fullView() {
    const view = await dgx.fullView();
    return { ...view, schedules: listSchedules() };
  }

  return { start, scheduleUpdate, cancelSchedule, fireSchedule, listSchedules, fullView };
}
