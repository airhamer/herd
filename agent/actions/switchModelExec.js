/**
 * Execute the reviewed Hasso `./switch-model.sh <target>` with spawn (no shell).
 */
import { spawn } from "node:child_process";
import { validateSwitchArgv } from "../../shared/switchLifecycle.js";

/**
 * @param {string[]} argv
 * @param {{cwd?: string, execFile?: Function, timeoutMs?: number, env?: NodeJS.ProcessEnv}} [opts]
 */
export function runSwitchModel(argv, opts = {}) {
  const checked = validateSwitchArgv(argv);
  if (!checked.ok) return Promise.resolve({ ok: false, error: checked.error, argv });
  if (!opts.cwd || typeof opts.cwd !== "string") {
    return Promise.resolve({
      ok: false,
      error: "switch working directory is not configured (set ALZEO_DIR to the pinned alzeo checkout)",
      argv: checked.argv,
    });
  }
  const execFile = opts.execFile;
  if (typeof execFile === "function") {
    return Promise.resolve(execFile(checked.argv, { cwd: opts.cwd })).then((r) => ({
      ok: r?.ok !== false && r?.status !== "failure" && (r?.statusCode ?? 0) === 0,
      statusCode: r?.statusCode ?? (r?.ok === false ? 1 : 0),
      stdout: r?.stdout ?? "",
      stderr: r?.stderr ?? "",
      argv: checked.argv,
      error: r?.error,
      hardwareRolledBack: false,
    }));
  }
  return spawnSwitch(checked.argv, opts);
}

function spawnSwitch(argv, opts) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 20 * 60 * 1000;
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      shell: false,
      env: opts.env || process.env,
    });
    let stdout = "";
    let stderr = "";
    const cap = 64 * 1024;
    child.stdout?.on("data", (d) => {
      if (stdout.length < cap) stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < cap) stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        error: String(err.message || err),
        stdout,
        stderr,
        argv,
        hardwareRolledBack: false,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        statusCode: code,
        stdout,
        stderr,
        argv,
        error: code === 0 ? null : `switch-model.sh exited ${code}`,
        hardwareRolledBack: false,
      });
    });
  });
}
