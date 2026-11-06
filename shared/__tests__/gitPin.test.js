import test from "node:test";
import assert from "node:assert/strict";
import {
  isAllowedOrigin,
  validateGitArgv,
  validateHostArgv,
  acquirePinnedCheckout,
  hostPreflight,
  expandCatalogWorkdir,
} from "../gitPin.js";

test("untrusted remotes and arbitrary paths are rejected", () => {
  assert.equal(isAllowedOrigin("https://evil.example/x"), false);
  assert.equal(isAllowedOrigin("hasso5703/alzeo"), true);
  assert.equal(expandCatalogWorkdir("/tmp/foo", "/home/u").ok, false);
  assert.equal(expandCatalogWorkdir("~/dgx-spark-qwen38", "/home/u").dest, "/home/u/dgx-spark-qwen38");
  assert.equal(validateGitArgv(["git", "clone", "--", "https://evil.example/x", "/tmp/x"]).ok, false);
  assert.equal(validateHostArgv(["bash", "-c", "evil"]).ok, false);
});

test("acquirePinnedCheckout clones then verifies the pin", async () => {
  const calls = [];
  const io = {
    home: "/home/u",
    exists: () => false,
    execGit: async (argv) => {
      calls.push(argv);
      if (argv[1] === "clone") return { ok: true, stdout: "" };
      if (argv.includes("checkout")) return { ok: true, stdout: "" };
      if (argv.includes("rev-parse") && argv.at(-1) === "HEAD") {
        return { ok: true, stdout: "01902c67709c4164c30ccf036422bfed6f172158\n" };
      }
      return { ok: true, stdout: "" };
    },
  };
  const r = await acquirePinnedCheckout(
    { origin: "hasso5703/alzeo", commit: "01902c67709c4164c30ccf036422bfed6f172158", workdir: "~/dgx-spark-qwen38" },
    io
  );
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.ok(calls[0].includes("clone"));
  assert.equal(calls.at(-1).at(-1), "HEAD");
});

test("dirty or mismatched existing checkouts are refused", async () => {
  const io = {
    home: "/home/u",
    exists: () => true,
    execGit: async (argv) => {
      if (argv.includes("--is-inside-work-tree")) return { ok: true, stdout: "true\n" };
      if (argv.includes("get-url")) return { ok: true, stdout: "https://github.com/hasso5703/alzeo.git\n" };
      if (argv.includes("--porcelain")) return { ok: true, stdout: " M secrets.env\n" };
      return { ok: true, stdout: "" };
    },
  };
  const r = await acquirePinnedCheckout(
    { origin: "hasso5703/alzeo", commit: "01902c67709c4164c30ccf036422bfed6f172158", workdir: "~/dgx-spark-qwen38" },
    io
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /dirty/);
});

test("sudo -n failure reports the upstream TTY blocker", async () => {
  const r = await hostPreflight(async (argv) => {
    if (argv[0] === "git") return { ok: true };
    if (argv[0] === "sudo") return { ok: false, error: "sudo: a password is required" };
    return { ok: false };
  }, { needSudo: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, "upstream-sudo-tty");
  assert.match(r.error, /sudo -v/);
});
