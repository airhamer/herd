/**
 * updates/cronMirror.js — idempotent host-crontab mirror for DGX-update
 * schedules (docs/SPEC-UPDATES.md §5.2 "long-horizon / durability option").
 *
 * One marker-commented crontab LINE per schedule:
 *
 *   0 3 * * 0 curl -s -m 10 -X POST http://127.0.0.1:30091/actions -H 'Content-Type: application/json' -d '{"type":"fire-schedule","scheduleId":"<id>"}' # sparkdash:<id>
 *
 * The in-process scheduler table remains the source of truth; fire-schedule is
 * idempotent, so a timer+cron double-fire is harmless. The entry's only jobs
 * are visibility in `crontab -l` and surviving a full agent reinstall.
 *
 * Doctrine: crontab is used via child_process ONLY when the binary exists;
 * otherwise install/remove return {installed:false, reason:'crontab-unavailable'}
 * (or {removed:false, ...}). Nothing ever throws — the agent commonly runs in
 * a container without crontab, which is normal degradation, not an error.
 *
 * Zero dependencies.
 */
import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";

/** Local agent API the mirror entry posts a fire-schedule action to. */
export const AGENT_ACTIONS_URL = "http://127.0.0.1:30091/actions";

/** Marker comment identifying a sparkDash-managed line (spec §5.2). */
export const markerFor = (id) => `# sparkdash:${id}`;

/**
 * The crontab line for one schedule. `expr` is the schedule's own cron
 * expression (kind "cron") or the minute/hour/dom/month derived from its
 * epoch time (kind "at") — never a bare "* * * * *", which would fire the
 * one-shot before its time.
 * @param {string} id schedule id
 * @param {string} expr 5-field cron expression
 */
export function mirrorLine(id, expr) {
  const body = JSON.stringify({ type: "fire-schedule", scheduleId: id });
  // body contains only double quotes; wrapping in single quotes is shell-safe.
  return (
    `${expr} curl -s -m 10 -X POST ${AGENT_ACTIONS_URL} ` +
    `-H 'Content-Type: application/json' -d '${body}' ` +
    `> /dev/null 2>&1 ${markerFor(id)}`
  );
}

/**
 * @typedef {{err?: {code?: string|number|null}|null, stdout?: string, stderr?: string}} RunResult
 */

function defaultExecFile(file, args) {
  return new Promise((resolve) => {
    try {
      nodeExecFile(file, args, { timeout: 5000 }, (err, stdout, stderr) =>
        resolve({ err: err || null, stdout: String(stdout || ""), stderr: String(stderr || "") })
      );
    } catch (err) {
      resolve({ err });
    }
  });
}

function defaultSpawnWrite(text) {
  return new Promise((resolve) => {
    let child;
    try {
      child = nodeSpawn("crontab", ["-"], { timeout: 5000 });
    } catch (err) {
      resolve({ err });
      return;
    }
    let spawnErr = null;
    child.on("error", (err) => {
      spawnErr = err; // ENOENT when the binary is missing
    });
    child.on("close", (code) => resolve({ err: spawnErr || (code === 0 ? null : { code }) }));
    child.stdin.write(text);
    child.stdin.end();
  });
}

/** Read the current crontab. unavailable=true only when the binary is missing. */
async function readCrontab(execFile) {
  const r = await execFile("crontab", ["-l"]);
  if (r.err && r.err.code === "ENOENT") {
    return { unavailable: true, text: "" };
  }
  if (r.err && r.err.code !== 1) {
    // exit 1 = "no crontab for user" on some platforms → empty, not a failure
    return { unavailable: false, text: "", failed: true, reason: `crontab-list-failed` };
  }
  return { unavailable: false, text: String(r.stdout || "") };
}

/**
 * Install (or replace) the marker line for one schedule.
 * @param {{id: string, expr: string}} schedule
 * @param {{execFile?: Function, spawnWrite?: (text: string) => Promise<object>}} [opts] test seams
 * @returns {Promise<{installed: boolean, reason?: string}>} never throws
 */
export async function installMirror(schedule, opts = {}) {
  const id = schedule && typeof schedule.id === "string" ? schedule.id : "";
  const expr = schedule && typeof schedule.expr === "string" ? schedule.expr.trim() : "";
  if (!id || !expr) return { installed: false, reason: "invalid-arguments" };
  const execFile = typeof opts.execFile === "function" ? opts.execFile : defaultExecFile;
  const spawnWrite =
    typeof opts.spawnWrite === "function" ? opts.spawnWrite : defaultSpawnWrite;
  try {
    const cur = await readCrontab(execFile);
    if (cur.unavailable) return { installed: false, reason: "crontab-unavailable" };
    if (cur.failed) return { installed: false, reason: cur.reason };
    const lines = cur.text
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.includes(markerFor(id)));
    lines.push(mirrorLine(id, expr));
    const w = await spawnWrite(lines.join("\n") + "\n");
    if (w && w.err) {
      return w.err.code === "ENOENT"
        ? { installed: false, reason: "crontab-unavailable" }
        : { installed: false, reason: "crontab-write-failed" };
    }
    return { installed: true };
  } catch (err) {
    return { installed: false, reason: String(err?.message || err) };
  }
}

/**
 * Remove the marker line for one schedule. Removing a line that was never
 * installed succeeds (idempotent).
 * @param {{id: string}} schedule
 * @param {{execFile?: Function, spawnWrite?: (text: string) => Promise<object>}} [opts] test seams
 * @returns {Promise<{removed: boolean, reason?: string}>} never throws
 */
export async function removeMirror(schedule, opts = {}) {
  const id = schedule && typeof schedule.id === "string" ? schedule.id : "";
  if (!id) return { removed: false, reason: "invalid-arguments" };
  const execFile = typeof opts.execFile === "function" ? opts.execFile : defaultExecFile;
  const spawnWrite =
    typeof opts.spawnWrite === "function" ? opts.spawnWrite : defaultSpawnWrite;
  try {
    const cur = await readCrontab(execFile);
    if (cur.unavailable) return { removed: false, reason: "crontab-unavailable" };
    if (cur.failed) return { removed: false, reason: cur.reason };
    const lines = cur.text
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.includes(markerFor(id)));
    if (lines.length === 0) return { removed: true };
    const w = await spawnWrite(lines.join("\n") + "\n");
    if (w && w.err) {
      return w.err.code === "ENOENT"
        ? { removed: false, reason: "crontab-unavailable" }
        : { removed: false, reason: "crontab-write-failed" };
    }
    return { removed: true };
  } catch (err) {
    return { removed: false, reason: String(err?.message || err) };
  }
}
