// ─── Fleet SSH transport (S1.3) ─────────────────────────────────────────────
//
// The transport behind NodeRecord `protocol:"ssh"` (EVAL §4.4 item 3): the
// agentless collection lane. A registry record is collected over SSH when it
// carries protocol:"ssh" + an ssh connection block ({user, host?, auth});
// SSH passwords resolve ONLY from the encrypted secrets store
// (server/fleet/nodeCredentials.js — never nodes.json, never argv), and key
// auth uses the deployment identity (SSH_IDENTITY_FILE / ssh-agent), same as
// the Spark-side collector.
//
// SEAM CONTRACT — consumed by the S1.4–S1.6 collectors (Linux, macOS/macmon,
// Windows/PowerShell). Each collector builds its remote command set and calls:
//
//   import { createSshTransport, isSshNode } from "./sshTransport.js";
//
//   isSshNode(node)                       -> boolean
//   createSshTransport(node, opts?)       -> NodeTransport | throws (explanatory)
//     NodeTransport = {
//       nodeId: string,
//       protocol: "ssh",
//       // Run one command on the node. `command` is passed to ssh as a
//       // single remote argv element (no dashboard-side shell expansion);
//       // the remote user's login shell interprets it. Resolves the trimmed
//       // stdout; rejects with Error("SSH to <host> failed: ...") or a
//       // credential/config error. maxBuffer 10 MB.
//       exec(command: string, opts?: { timeoutMs?: number }) -> Promise<string>,
//       // Liveness probe for capability reports: { ok, message }.
//       test() -> Promise<{ ok: boolean, message: string }>,
//     }
//   opts (tests override the two boundaries; production uses the defaults):
//     getSecret(nodeId) -> string|null   default: nodeCredentials.getNodeSshPassword
//     run(file, args, {env,timeout,maxBuffer}) -> Promise<string>
//                                        default: child_process.execFile
//
// Transport-level invariants (inherited from the reused exec/multiplex core in
// server/collectors/ssh.js — single implementation, no fork):
//   - execFile + argv arrays; user/host/command never shell-interpolated.
//   - Password auth via sshpass -e with SSHPASS in the child env (whitelisted,
//     minimal env — process.env is never spread); password NEVER on argv.
//   - Multiplexing: ControlMaster=auto + short hand-expanded %C-style
//     ControlPath under /tmp (sun_path-safe); concurrent execs for a node
//     share one login, a dead master is re-probed after any failure.
//   - Target host / user validated at build (isAllowedTargetHost /
//     isValidSshUser) — the transport never dials an unchecked address.
//   - Port: 22 only. The registry refuses ssh.port ≠ 22 on write (S1.3a);
//     this module dials the ssh default like the Spark-side wrapper.
//
// Records WITHOUT protocol:"ssh" are unaffected: the node-agent HTTP/bearer
// poll in connection.js keeps their exact behavior (this module is not in
// that path; the poller simply skips ssh records, they have no /telemetry).

import { execFile } from "node:child_process";
import {
  sshCommandSpec,
  ensureMultiplexReady,
  invalidateMultiplex,
} from "../collectors/ssh.js";
import { getNodeSshPassword } from "./nodeCredentials.js";

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_BUFFER = 10 * 1024 * 1024;

/** @param {object} node @returns {boolean} */
export function isSshNode(node) {
  return Boolean(node) && node.protocol === "ssh";
}

/** Default run(): execFile wrapper matching the collectors/ssh.js error shape. */
function defaultRun(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, opts, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(err.message);
        e.stderr = stderr;
        reject(e);
      } else {
        resolve(String(stdout));
      }
    });
  });
}

/**
 * Build the SSH transport for one registry record.
 * @param {object} node normalized NodeRecord (protocol:"ssh", ssh:{user,host?,auth})
 * @param {{ getSecret?: (nodeId: string) => string|null,
 *           run?: (file: string, args: string[], opts: object) => Promise<string> }} [opts]
 * @returns {{ nodeId: string, protocol: "ssh",
 *            exec: (command: string, o?: {timeoutMs?: number}) => Promise<string>,
 *            test: () => Promise<{ok: boolean, message: string}> }}
 */
export function createSshTransport(node, opts = {}) {
  if (!isSshNode(node)) {
    throw new TypeError(
      `createSshTransport: node ${node && node.id} is not an SSH record (protocol must be "ssh")`
    );
  }
  const ssh = node.ssh && typeof node.ssh === "object" ? node.ssh : {};
  const user = typeof ssh.user === "string" ? ssh.user.trim() : "";
  if (!user) {
    throw new Error(`node ${node.id}: protocol "ssh" without ssh.user`);
  }
  const host =
    typeof ssh.host === "string" && ssh.host.trim() ? ssh.host.trim() : String(node.lanIp || "").trim();
  if (!host) {
    throw new Error(`node ${node.id}: SSH transport has no target host (set ssh.host or lanIp)`);
  }
  const auth = ssh.auth === "pass" ? "pass" : "key";
  const getSecret = typeof opts.getSecret === "function" ? opts.getSecret : getNodeSshPassword;
  const run = typeof opts.run === "function" ? opts.run : defaultRun;

  // Resolve the secret BEFORE building argv so a missing password fails with
  // the actionable fleet message (not the Spark-side "Edit Spark" one).
  let password = null;
  if (auth === "pass") {
    password = getSecret(node.id);
    if (!password) {
      throw new Error(
        `node ${node.id}: ssh.auth is "pass" but no password is stored — set it via PUT /api/fleet/nodes/${node.id}/ssh-password (kept encrypted, never in nodes.json)`
      );
    }
  }

  // Adapt the record to the exec/multiplex core in collectors/ssh.js (same
  // validation, env whitelist, sshpass handling, and multiplex opts as the
  // Spark-side wrapper — one implementation, no fork).
  const record = {
    id: node.id,
    lanIp: node.lanIp || "",
    ssh: { host, user, auth, password },
  };

  /** Build argv for one remote command (sshCommandSpec validates host/user). */
  function specFor(command) {
    if (typeof command !== "string" || !command) {
      throw new Error(`node ${node.id}: SSH command must be a non-empty string`);
    }
    return sshCommandSpec(record, { remoteArgv: [command] });
  }

  async function exec(command, execOpts = {}) {
    const timeoutMs =
      Number.isFinite(execOpts.timeoutMs) && execOpts.timeoutMs > 0
        ? execOpts.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    const { file, args, env, targetHost, multiplex } = specFor(command);
    const runOpts = { timeout: timeoutMs, env, maxBuffer: MAX_BUFFER };

    const execute = (execArgs) =>
      run(file, execArgs, runOpts).then((stdout) => String(stdout).trim());

    try {
      if (multiplex) {
        const probeArgs = [...args];
        probeArgs[probeArgs.length - 1] = "true";
        await ensureMultiplexReady(multiplex, () => execute(probeArgs));
      }
      return await execute(args);
    } catch (err) {
      // A master that died must not poison the next call (mirrors sshExec).
      invalidateMultiplex(multiplex);
      const msg = (err && err.stderr && String(err.stderr).trim()) || (err && err.message) || "unknown error";
      throw new Error(`SSH to ${targetHost} failed: ${msg}`);
    }
  }

  async function test() {
    try {
      const out = await exec("echo ok");
      return { ok: out === "ok", message: out };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  return { nodeId: node.id, protocol: "ssh", exec, test };
}

/**
 * SSH-transport registry view: the records the SSH collectors (S1.4–S1.6)
 * own. The HTTP poller skips exactly this set (connection.js).
 * @param {object[]} nodes
 * @returns {object[]}
 */
export function sshNodes(nodes) {
  return (Array.isArray(nodes) ? nodes : []).filter(isSshNode);
}

