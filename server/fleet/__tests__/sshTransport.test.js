// S1.3 tests — server/fleet/sshTransport.js (EVAL §4.4 item 3).
//
// Seam under test: createSshTransport(node) → { nodeId, protocol:"ssh",
// exec(cmd,{timeoutMs}) -> trimmed stdout, test() -> {ok,message} } consumed
// by the S1.4–S1.6 collectors. The spawn boundary is injected via opts.run
// (real execFile is the default); credentials via opts.getSecret (the real
// encrypted-store path is proven in nodeCredentials.test.js). No real SSH,
// no network, no timers.

import test from "node:test";
import assert from "node:assert/strict";

import { createSshTransport, isSshNode, sshNodes } from "../sshTransport.js";

function sshNode(over = {}) {
  return {
    id: "narthex-ssh",
    name: "Narthex",
    lanIp: "192.168.50.150",
    protocol: "ssh",
    ssh: { user: "steve", auth: "key" },
    ...over,
  };
}

function collectRun(stdout = "  result\n") {
  const calls = [];
  return {
    calls,
    run: (file, args, opts) => {
      calls.push({ file, args, opts });
      return Promise.resolve(stdout);
    },
  };
}

// The multiplex gate reads SSH_CONTROL_PERSIST_SECONDS at config load (60s
// default): exec() probes the master with `true` first, then runs the command.
// One login per (node,credential) window — callers never see the probe.
function countProbes(calls) {
  return calls.filter((c) => c.args[c.args.length - 1] === "true").length;
}

// ─── dispatch ──────────────────────────────────────────────────────

test("isSshNode/sshNodes: only explicit protocol:\"ssh\" dispatches to SSH", () => {
  assert.equal(isSshNode(sshNode()), true);
  assert.equal(isSshNode({ id: "a", lanIp: "10.0.0.1" }), false);
  assert.equal(isSshNode({ id: "a", protocol: "http" }), false);
  assert.equal(isSshNode({ id: "a", protocol: "SSH " }), false); // normalized at registry, not here
  assert.equal(isSshNode(null), false);
  const view = sshNodes([sshNode({ id: "n1" }), { id: "n2" }, null]);
  assert.deepEqual(view.map((n) => n.id), ["n1"]);
});

// ─── construction validation (explanatory errors before any spawn) ───

test("non-ssh record is refused with a pointer to the HTTP transport", () => {
  assert.throws(
    () => createSshTransport({ id: "h1", lanIp: "10.0.0.2" }),
    /not an SSH record/
  );
});

test("ssh record without user or host fails before any spawn", () => {
  assert.throws(
    () => createSshTransport(sshNode({ ssh: {} })),
    /without ssh\.user/
  );
  assert.throws(
    () => createSshTransport({ id: "nohost", protocol: "ssh", ssh: { user: "steve" } }),
    /no target host/
  );
});

test("password auth without a stored secret fails with the ssh-password pointer", () => {
  assert.throws(
    () =>
      createSshTransport(sshNode({ ssh: { user: "steve", auth: "pass" } }), {
        getSecret: () => null,
        run: () => assert.fail("must not spawn"),
      }),
    /ssh-password/
  );
});

test("disallowed target host is refused by the reused validator", () => {
  const t = createSshTransport(sshNode({ lanIp: "169.254.169.254" }), {
    run: () => assert.fail("must not spawn"),
  });
  return t.exec("echo hi").then(
    () => assert.fail("expected rejection"),
    (err) => assert.match(err.message, /not allowed|SSH to .* failed/)
  );
});

// ─── exec: argv/env shape through the reused exec core ───

test("exec: key auth → ssh, BatchMode, --, user@host, trimmed stdout, env whitelist", async () => {
  const { calls, run } = collectRun();
  const t = createSshTransport(sshNode(), { run });
  const out = await t.exec("uptime");
  assert.equal(out, "result", "stdout trimmed");

  const real = calls[calls.length - 1];
  assert.equal(real.file, "ssh");
  assert.ok(real.args.includes("BatchMode=yes"));
  const dash = real.args.indexOf("--");
  assert.ok(dash > 0);
  assert.equal(real.args[dash + 1], "steve@192.168.50.150");
  assert.equal(real.args[dash + 2], "uptime");
  assert.equal(real.opts.env.SSHPASS, undefined);
  assert.equal("PATH" in real.opts.env, true, "PATH present");
  assert.equal("SSHPASS" in real.opts.env, false);
  assert.equal(real.opts.timeout, 10000, "default timeout");
  assert.equal(real.opts.maxBuffer, 10 * 1024 * 1024);
  // Multiplex master: a probe (`true`) ran first, once, and the command
  // rode the same connection config (ControlMaster=auto + ControlPath).
  assert.equal(countProbes(calls), 1);
  assert.ok(real.args.some((a) => a.startsWith("ControlPath=")));
  assert.ok(real.args.some((a) => a === "ControlMaster=auto"));
});

test("exec: timeoutMs override honored", async () => {
  const { calls, run } = collectRun();
  const t = createSshTransport(sshNode({ id: "tmo-" + Math.random() }), { run });
  await t.exec("sleep 1", { timeoutMs: 1234 });
  assert.equal(calls[calls.length - 1].opts.timeout, 1234);
});

test("exec: multiplexed — second exec skips the probe (shared master)", async () => {
  const { calls, run } = collectRun();
  const t = createSshTransport(sshNode({ id: "mux-" + Math.random().toString(36).slice(2) }), { run });
  await t.exec("cmd-a");
  await t.exec("cmd-b");
  assert.equal(countProbes(calls), 1, "one login for the credential window");
  assert.equal(calls.length, 3, "probe + 2 commands");
});

test("exec: password from the secret store, never on argv", async () => {
  const { calls, run } = collectRun();
  const seen = [];
  const t = createSshTransport(sshNode({ id: "pw-" + Math.random().toString(36).slice(2), ssh: { user: "steve", auth: "pass" } }), {
    getSecret: (id) => {
      seen.push(id);
      return "s3cr3t-pw";
    },
    run,
  });
  // sshCommandSpec (reused core) requires sshpass on the host for pass auth.
  // Both branches are real: where sshpass exists the password rides the child
  // env (sshpass -e) and NEVER argv; where it is missing the spec layer
  // refuses with its explanatory error before any argv is ever built.
  let passwordViaEnv = null;
  let argvJoined = "";
  try {
    await t.exec("uptime");
    const real = calls[calls.length - 1];
    passwordViaEnv = real.opts.env.SSHPASS;
    argvJoined = real.args.join(" ");
  } catch (err) {
    assert.match(err.message, /sshpass is not installed/);
  }
  assert.equal(seen.length, 1, "secret resolved exactly once for this node");
  assert.equal(seen[0], t.nodeId);
  assert.equal(argvJoined.includes("s3cr3t-pw"), false, "never in argv");
  if (passwordViaEnv !== null) assert.equal(passwordViaEnv, "s3cr3t-pw", "password via env");
});

test("exec: failure wraps stderr and clears the multiplex state", async () => {
  const calls = [];
  let failNext = false;
  const run = (file, args) => {
    calls.push({ file, args });
    if (failNext) {
      const e = new Error("Command failed");
      e.stderr = "Permission denied (publickey)";
      return Promise.reject(e);
    }
    return Promise.resolve("ok\n");
  };
  // Deterministic sequence: probe ok → cmd fail → next exec re-probes.
  const t = createSshTransport(sshNode({ id: "fail-" + Math.random().toString(36).slice(2) }), { run });
  await t.exec("first"); // succeeds (probe ok + cmd ok)
  failNext = true;
  await assert.rejects(t.exec("second"), /SSH to 192.168.50.150 failed: Permission denied/);
  // After a failed command the cached master state must be dropped: a fresh
  // probe precedes the next command.
  failNext = false;
  await t.exec("third");
  const probes = calls.filter((c) => c.args[c.args.length - 1] === "true").length;
  assert.equal(probes, 2, "re-probe after transport failure");
});

test("test(): ok true on echo ok, structured failure otherwise", async () => {
  const okT = createSshTransport(sshNode({ id: "t-ok" }), {
    run: () => Promise.resolve("ok\n"),
  });
  assert.deepEqual(await okT.test(), { ok: true, message: "ok" });

  const badT = createSshTransport(sshNode({ id: "t-bad" }), {
    run: () => Promise.reject(Object.assign(new Error("x"), { stderr: "Connection refused" })),
  });
  const res = await badT.test();
  assert.equal(res.ok, false);
  assert.match(res.message, /Connection refused/);
});
