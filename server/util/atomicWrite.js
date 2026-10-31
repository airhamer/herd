// Crash-safe file replacement for herd's JSON state files.
// LIC2 clean-room rewrite from docs/specs/unit-history.md §8 (the sync form
// descends from the MIT base; the async form and fallbacks were rewritten).
import fs from "fs";
import path from "path";

const ownershipHint = (target) => `If this is a root-owned file: sudo chown $(id -u):$(id -g) ${target}`;

function failure(target, err, withHint = false) {
  const reason = err?.message ?? String(err);
  return new Error(`Failed to write ${target}: ${reason}${withHint ? `. ${ownershipHint(target)}` : ""}`);
}

function ignore() {}

/**
 * Replace `filePath` with `contents` without ever leaving a half-written
 * target: the data goes to `<file>.<pid>.tmp` first (one name per target and
 * process, so a leftover from a crash is simply reused), then is renamed into
 * place. A target we may not rename over (root-owned, 0400…) is unlinked and
 * the rename retried. The target itself is never opened for writing. On any
 * failure the temp file is removed and an Error is thrown.
 *
 * @param {string} filePath
 * @param {string} contents
 * @param {number} [mode=0o600]
 */
export function atomicWrite(filePath, contents, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  const dropTemp = () => {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      ignore();
    }
  };

  try {
    fs.writeFileSync(temp, contents, { mode });
  } catch (err) {
    dropTemp();
    throw failure(filePath, err);
  }
  try {
    fs.chmodSync(temp, mode);
  } catch {
    ignore();
  }

  let renamed = false;
  try {
    fs.renameSync(temp, filePath);
    renamed = true;
  } catch {
    ignore();
  }
  if (!renamed) {
    try {
      try {
        fs.chmodSync(filePath, 0o666);
      } catch {
        ignore();
      }
      fs.rmSync(filePath, { force: true });
      fs.renameSync(temp, filePath);
    } catch (err) {
      dropTemp();
      throw failure(filePath, err, true);
    }
  }

  try {
    fs.chmodSync(filePath, mode);
  } catch {
    ignore();
  }
}

export default atomicWrite;

/**
 * Promise form of atomicWrite for writes that must not block the event loop.
 * Uses its own temp name (`<file>.<pid>.async.tmp`) so a synchronous write of
 * the same target cannot collide with it. Once the data is on disk and before
 * the rename, `shouldCommit()` is consulted: false means a newer write has
 * superseded this one, so the temp file is deleted and the target left alone.
 *
 * @param {string} filePath
 * @param {string} contents
 * @param {number} [mode=0o600]
 * @param {{ shouldCommit?: () => boolean, fsp?: typeof fs.promises }} [options]
 * @returns {Promise<boolean>} true when the target was replaced.
 */
export async function atomicWriteAsync(filePath, contents, mode = 0o600, options = {}) {
  const { shouldCommit = () => true, fsp = fs.promises } = options;
  const temp = `${filePath}.${process.pid}.async.tmp`;
  const dropTemp = () => fsp.unlink(temp).then(ignore, ignore);

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fsp.writeFile(temp, contents, { mode });
  } catch (err) {
    await dropTemp();
    throw failure(filePath, err);
  }
  await fsp.chmod(temp, mode).then(ignore, ignore);

  if (!shouldCommit()) {
    await dropTemp();
    return false;
  }

  const renamed = await fsp.rename(temp, filePath).then(
    () => true,
    () => false
  );
  if (!renamed) {
    try {
      await fsp.chmod(filePath, 0o666).then(ignore, ignore);
      await fsp.unlink(filePath).catch((err) => {
        if (err?.code !== "ENOENT") throw err;
      });
      await fsp.rename(temp, filePath);
    } catch (err) {
      await dropTemp();
      throw failure(filePath, err, true);
    }
  }
  await fsp.chmod(filePath, mode).then(ignore, ignore);
  return true;
}

/**
 * Keep an unparseable state file for inspection: rename it to
 * `<file>.corrupt-<epoch ms>` so the next save starts fresh without
 * overwriting it. Logs one line; never throws (LIC1 clean-room rewrite).
 * @param {string} filePath
 * @param {string} label Log prefix, e.g. "EventLog".
 * @param {Error} [err] Why the file could not be read.
 * @returns {string|null} Where the file went, or null if it could not be moved.
 */
export function quarantineCorrupt(filePath, label, err) {
  const why = err?.message || "parse error";
  const aside = `${filePath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(filePath, aside);
  } catch (moveErr) {
    console.error(`[${label}] cannot read ${filePath} (${why}) and could not move it aside: ${moveErr?.message}`);
    return null;
  }
  console.error(`[${label}] cannot read ${filePath} (${why}); kept it as ${aside}`);
  return aside;
}
