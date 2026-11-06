/**
 * Allowlisted git checkout of a pinned upstream recipe (RECIPE1 / #119).
 *
 * Only https://github.com origins on the trust list may be cloned. Destinations
 * come from the catalog workdir (`~/…`), never from an arbitrary user path.
 * Every invocation is an argv array (`git`, subcommand, …) — never a shell
 * string and never curl|sh.
 */
import path from "node:path";

export const ALLOWED_GIT_ORIGINS = Object.freeze([
  "https://github.com/hasso5703/alzeo",
  "https://github.com/hasso5703/dgx-spark-qwen38",
  "https://github.com/MiaAI-Lab/GLM-5.3-Flash-DGX-Sparks-1104",
  "https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark",
]);

const PIN_RE = /^[a-f0-9]{40}$/;
const META = /[;&|`$()<>\n\\]/;
const SAFE_PATH = /^[A-Za-z0-9._:@\/+-]+$/;

export function normalizeOrigin(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let s = raw.trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) s = `https://github.com/${s}`;
  s = s.replace(/\.git$/i, "").replace(/\/$/, "");
  return s;
}

export function isAllowedOrigin(raw) {
  const n = normalizeOrigin(raw);
  return Boolean(n && ALLOWED_GIT_ORIGINS.includes(n));
}

export function expandCatalogWorkdir(workdir, home) {
  if (typeof workdir !== "string" || !workdir.startsWith("~/")) {
    return { ok: false, error: "workdir must be a catalog ~/path (not an arbitrary filesystem path)" };
  }
  const rest = workdir.slice(2);
  if (!rest || rest.includes("..") || path.isAbsolute(rest)) {
    return { ok: false, error: "workdir path rejected" };
  }
  if (typeof home !== "string" || !home) {
    return { ok: false, error: "HOME is required to expand the catalog workdir" };
  }
  return { ok: true, dest: path.join(home, rest) };
}

/**
 * Reject anything that is not a reviewed git argv.
 * @param {string[]} argv
 * @param {{dest?: string, origin?: string, commit?: string}} bound
 */
export function validateGitArgv(argv, bound = {}) {
  if (!Array.isArray(argv) || argv[0] !== "git") {
    return { ok: false, error: "git argv must start with 'git'" };
  }
  for (const part of argv) {
    if (typeof part !== "string" || part === "" || META.test(part)) {
      return { ok: false, error: `git argv rejects ${part}` };
    }
  }
  const rest = argv.slice(1);
  // git --version
  if (rest.length === 1 && rest[0] === "--version") return { ok: true };
  // git clone -- <origin> <dest>
  if (rest[0] === "clone") {
    if (rest[1] !== "--" || rest.length !== 4) return { ok: false, error: "git clone must be ['git','clone','--',origin,dest]" };
    if (!isAllowedOrigin(rest[2])) return { ok: false, error: `origin '${rest[2]}' is not allowlisted` };
    if (bound.origin && normalizeOrigin(rest[2]) !== normalizeOrigin(bound.origin)) {
      return { ok: false, error: "clone origin does not match the catalog pin" };
    }
    if (bound.dest && path.resolve(rest[3]) !== path.resolve(bound.dest)) {
      return { ok: false, error: "clone dest does not match the catalog workdir" };
    }
    return { ok: true };
  }
  // git -C <dest> …
  if (rest[0] !== "-C" || rest.length < 3) {
    return { ok: false, error: "unsupported git argv" };
  }
  if (bound.dest && path.resolve(rest[1]) !== path.resolve(bound.dest)) {
    return { ok: false, error: "git -C dest does not match the catalog workdir" };
  }
  const sub = rest.slice(2);
  if (sub[0] === "remote" && sub[1] === "get-url" && sub[2] === "origin" && sub.length === 3) return { ok: true };
  if (sub[0] === "status" && sub[1] === "--porcelain" && sub.length === 2) return { ok: true };
  if (sub[0] === "rev-parse" && (sub[1] === "HEAD" || sub[1] === "--is-inside-work-tree") && sub.length === 2) return { ok: true };
  if (sub[0] === "fetch" && sub[1] === "--" && sub[2] === "origin" && sub.length === 3) return { ok: true };
  if (sub[0] === "checkout" && sub.length === 3 && sub[1] === "--" && PIN_RE.test(sub[2])) {
    if (bound.commit && sub[2] !== bound.commit) return { ok: false, error: "checkout pin mismatch" };
    return { ok: true };
  }
  return { ok: false, error: `git subcommand not allowlisted: ${sub.join(" ")}` };
}

export function validateHostArgv(argv) {
  const ok = [
    ["git", "--version"],
    ["docker", "--version"],
    ["sudo", "-n", "true"],
  ];
  if (!Array.isArray(argv)) return { ok: false, error: "host argv required" };
  if (ok.some((a) => a.length === argv.length && a.every((v, i) => v === argv[i]))) return { ok: true };
  return { ok: false, error: `host preflight command not allowlisted: ${argv.join(" ")}` };
}

export async function hostPreflight(exec, { needDocker = false, needSudo = true } = {}) {
  const run = async (argv) => {
    const v = validateHostArgv(argv);
    if (!v.ok) return v;
    if (typeof exec !== "function") return { ok: false, error: "no executor" };
    return exec(argv);
  };
  const git = await run(["git", "--version"]);
  if (!git || git.ok === false) {
    return { ok: false, error: "host git is required to acquire the pinned recipe checkout", detail: git?.error };
  }
  if (needDocker) {
    const docker = await run(["docker", "--version"]);
    if (!docker || docker.ok === false) {
      return { ok: false, error: "host docker is required by this recipe's upstream installer", detail: docker?.error };
    }
  }
  if (needSudo) {
    const sudo = await run(["sudo", "-n", "true"]);
    if (!sudo || sudo.ok === false) {
      return {
        ok: false,
        error:
          "install.sh requires sudo -n (passwordless sudo or a still-valid timestamp). Upstream alzeo install.sh (sudo -n, then sudo -v around lines 1808–1814) calls sudo -v when sudo -n fails; sudo -v needs a TTY and cannot be answered from the dashboard agent. Configure passwordless sudo for the install user or run the installer once on a TTY.",
        code: "upstream-sudo-tty",
      };
    }
  }
  return { ok: true };
}

/**
 * Acquire dest at the pinned commit using only allowlisted git argv.
 * @param {{origin: string, commit: string, workdir: string}} input
 * @param {{home: string, exists: (p: string) => boolean, execGit: (argv: string[]) => Promise<{ok:boolean, stdout?: string, stderr?: string, error?: string}>}} io
 */
export async function acquirePinnedCheckout(input, io) {
  const origin = normalizeOrigin(input.origin);
  if (!isAllowedOrigin(origin)) {
    return { ok: false, error: `source origin '${input.origin}' is not an allowlisted recipe remote` };
  }
  if (!PIN_RE.test(input.commit || "")) {
    return { ok: false, error: "upstreamCommit must be a 40-character git sha" };
  }
  const destR = expandCatalogWorkdir(input.workdir, io.home);
  if (!destR.ok) return destR;
  const dest = destR.dest;
  const bound = { dest, origin, commit: input.commit };
  const git = async (argv) => {
    const v = validateGitArgv(argv, bound);
    if (!v.ok) return v;
    return io.execGit(argv);
  };

  const httpsOrigin = `${origin}.git`;

  if (!io.exists(dest)) {
    const clone = await git(["git", "clone", "--", httpsOrigin, dest]);
    if (!clone.ok) {
      const retry = await git(["git", "clone", "--", origin, dest]);
      if (!retry.ok) return { ok: false, error: retry.error || clone.error || "git clone failed", dest };
    }
    const co = await git(["git", "-C", dest, "checkout", "--", input.commit]);
    if (!co.ok) return { ok: false, error: co.error || "git checkout of pin failed", dest };
    const head = await git(["git", "-C", dest, "rev-parse", "HEAD"]);
    if (!head.ok || String(head.stdout || "").trim() !== input.commit) {
      return { ok: false, error: `HEAD ${String(head.stdout || "").trim()} does not match pin ${input.commit}`, dest };
    }
    return { ok: true, dest, created: true, alreadyPinned: false };
  }

  const inside = await git(["git", "-C", dest, "rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || String(inside.stdout || "").trim() !== "true") {
    return {
      ok: false,
      error: `refusing to overwrite existing path ${dest} (not a git checkout); user files and secrets preserved`,
      dest,
    };
  }
  const remote = await git(["git", "-C", dest, "remote", "get-url", "origin"]);
  if (!remote.ok || !isAllowedOrigin(remote.stdout) || normalizeOrigin(remote.stdout) !== origin) {
    return { ok: false, error: `existing checkout origin does not match pin ${origin}`, dest };
  }
  const status = await git(["git", "-C", dest, "status", "--porcelain"]);
  if (!status.ok) return { ok: false, error: status.error || "git status failed", dest };
  if (String(status.stdout || "").trim()) {
    return { ok: false, error: "checkout is dirty; refusing to clobber local changes, user files, or secrets", dest };
  }
  const head = await git(["git", "-C", dest, "rev-parse", "HEAD"]);
  const current = String(head.stdout || "").trim();
  if (current === input.commit) return { ok: true, dest, created: false, alreadyPinned: true };
  const fetch = await git(["git", "-C", dest, "fetch", "--", "origin"]);
  if (!fetch.ok) return { ok: false, error: fetch.error || "git fetch failed", dest };
  const co = await git(["git", "-C", dest, "checkout", "--", input.commit]);
  if (!co.ok) return { ok: false, error: co.error || "git checkout of pin failed", dest };
  const head2 = await git(["git", "-C", dest, "rev-parse", "HEAD"]);
  if (String(head2.stdout || "").trim() !== input.commit) {
    return { ok: false, error: `HEAD does not match pin ${input.commit} after checkout`, dest };
  }
  return { ok: true, dest, created: false, alreadyPinned: false };
}
