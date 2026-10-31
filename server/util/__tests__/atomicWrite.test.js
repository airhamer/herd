import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWrite, atomicWriteAsync } from "../atomicWrite.js";

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-atomic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const leftovers = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

test("sync: creates the directory, replaces the target and leaves no temp file", (t) => {
  const dir = scratch(t);
  const file = path.join(dir, "nested", "state.json");
  atomicWrite(file, "one");
  atomicWrite(file, "two", 0o640);
  assert.equal(fs.readFileSync(file, "utf8"), "two");
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.deepEqual(leftovers(path.dirname(file)), []);
});

test("sync: a stale temp file from a crash is reused, not piled up", (t) => {
  const dir = scratch(t);
  const file = path.join(dir, "state.json");
  fs.writeFileSync(`${file}.${process.pid}.tmp`, "half a write");
  atomicWrite(file, "whole");
  assert.equal(fs.readFileSync(file, "utf8"), "whole");
  assert.deepEqual(leftovers(dir), []);
});

test("sync: a failed write throws, keeps the old target and cleans up", (t) => {
  const dir = scratch(t);
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "old");
  // A directory where the temp file should go makes the temp write fail.
  fs.mkdirSync(`${file}.${process.pid}.tmp`);
  assert.throws(() => atomicWrite(file, "new"), new RegExp(`Failed to write ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(fs.readFileSync(file, "utf8"), "old");
});

test("async: replaces the target with the given mode and resolves true", async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, "a", "b.json");
  assert.equal(await atomicWriteAsync(file, "{}", 0o600), true);
  assert.equal(fs.readFileSync(file, "utf8"), "{}");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(leftovers(path.dirname(file)), []);
});

test("async: shouldCommit=false discards the data and leaves the target alone", async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, "b.json");
  fs.writeFileSync(file, "newer");
  let asked = 0;
  const ok = await atomicWriteAsync(file, "older", 0o600, {
    shouldCommit: () => {
      asked++;
      // The data is on disk under the async temp name when we are asked.
      assert.equal(fs.readFileSync(`${file}.${process.pid}.async.tmp`, "utf8"), "older");
      return false;
    },
  });
  assert.equal(ok, false);
  assert.equal(asked, 1);
  assert.equal(fs.readFileSync(file, "utf8"), "newer");
  assert.deepEqual(leftovers(dir), []);
});

test("async: falls back to unlink + rename when the rename over the target fails", async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, "c.json");
  fs.writeFileSync(file, "old");
  let renames = 0;
  const fsp = {
    ...fs.promises,
    rename: async (from, to) => {
      renames++;
      if (renames === 1) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return fs.promises.rename(from, to);
    },
  };
  assert.equal(await atomicWriteAsync(file, "new", 0o600, { fsp }), true);
  assert.equal(renames, 2);
  assert.equal(fs.readFileSync(file, "utf8"), "new");
});

test("async: when every rename fails it throws with the chown hint and removes the temp file", async (t) => {
  const dir = scratch(t);
  const file = path.join(dir, "d.json");
  fs.writeFileSync(file, "old");
  const fsp = {
    ...fs.promises,
    rename: async () => {
      throw new Error("EACCES");
    },
  };
  await assert.rejects(atomicWriteAsync(file, "new", 0o600, { fsp }), /Failed to write .*sudo chown/);
  assert.deepEqual(leftovers(dir), []);
});
