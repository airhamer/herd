/**
 * recipePlan.js — preview/confirm plans for catalog lifecycle hooks (RECIPE1/2).
 *
 * Builds exact argv lists from a definition's `lifecycle` block. Never uses a
 * shell string, never `curl | sh`. Scripts must be on the allowlist; env values
 * are restricted. Execution is someone else's job (the agent executor).
 */
export const ALLOWED_SCRIPTS = Object.freeze([
  "install.sh",
  "prepare-lane.sh",
  "switch-model.sh",
  "start.sh",
  "stop.sh",
  "start-deepseek-v4-flash-dspark.sh",
  "stop-deepseek-v4-flash-dspark.sh",
  "prepare-dspark-model-cache.sh",
  "status-deepseek-v4-flash-dspark.sh",
]);

export const ALLOWED_ENV = Object.freeze([
  "MODEL_CHOICE",
  "CONTEXT_MODE",
  "FLASH_TIER",
  "DRY_RUN",
  "WORKER",
  "WORKER_HOST",
  "MASTER_ADDR",
  "NCCL_IB_HCA",
  "NCCL_SOCKET_IFNAME",
  "VLLM_HOST_IP",
  "WORKER_VLLM_HOST_IP",
  "HF_CACHE",
  "PORT",
  "TP",
  "ROLE",
]);

const SAFE_ENV_VAL = /^[A-Za-z0-9._:@\/+-]+$/;
const META = /[;&|`$()<>\n\\]/;

/**
 * @param {string[]} argv
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { ok: false, error: "argv must be a non-empty array" };
  for (const part of argv) {
    if (typeof part !== "string" || part === "") return { ok: false, error: "argv entries must be non-empty strings" };
    if (META.test(part)) return { ok: false, error: `argv rejects shell metacharacters: ${part}` };
  }
  const script = argv[0];
  if (!script.startsWith("./") || script.includes("/", 2)) {
    return { ok: false, error: `script must be a ./basename (got ${script})` };
  }
  const base = script.slice(2);
  if (!ALLOWED_SCRIPTS.includes(base)) return { ok: false, error: `script './${base}' is not on the installer allowlist` };
  return { ok: true };
}

export function validateEnv(env) {
  if (env == null) return { ok: true, env: {} };
  if (typeof env !== "object" || Array.isArray(env)) return { ok: false, error: "env must be an object" };
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!ALLOWED_ENV.includes(k)) return { ok: false, error: `env '${k}' is not allowlisted` };
    if (typeof v !== "string" || !SAFE_ENV_VAL.test(v)) return { ok: false, error: `env '${k}' has an unsafe value` };
    out[k] = v;
  }
  return { ok: true, env: out };
}

/**
 * @param {object} definition normalized or raw catalog component (raw.lifecycle)
 * @param {"install"|"prepare"|"switch"|"start"|"stop"} action
 * @param {object} [ctx]
 */
export function buildRecipePlan(definition, action, ctx = {}) {
  const raw = definition.raw || definition;
  const life = raw.lifecycle;
  if (!life || typeof life !== "object") {
    return { ok: false, error: `component '${raw.id || "?"}' has no lifecycle block`, code: "no-lifecycle" };
  }
  const spec = life[action === "configure" ? "switch" : action] || (action === "install" ? life.install : null);
  if (!spec || typeof spec !== "object") {
    return { ok: false, error: `no lifecycle.${action} plan`, code: "no-step" };
  }

  const baseEnv = { ...(spec.env || {}), ...(ctx.env || {}) };
  if (!ctx.execute && spec.previewEnv && typeof spec.previewEnv === "object") {
    Object.assign(baseEnv, spec.previewEnv);
  }
  const envCheck = validateEnv(baseEnv);
  if (!envCheck.ok) return { ok: false, error: envCheck.error, code: "unsafe-env" };

  const argv = Array.isArray(spec.executeArgv) && ctx.execute ? spec.executeArgv : spec.argv;
  const argvCheck = validateArgv(argv);
  if (!argvCheck.ok) return { ok: false, error: argvCheck.error, code: "unsafe-argv" };

  const joined = [...(spec.argv || []), ...(spec.executeArgv || [])].join(" ");
  if (/\bcurl\b/.test(joined) && joined.includes("|")) {
    return { ok: false, error: "lifecycle must not use curl|sh", code: "curl-pipe" };
  }

  const workdir = typeof life.workdir === "string" ? life.workdir : null;
  const exclusivePorts = Array.isArray(life.exclusivePorts) ? life.exclusivePorts : [];
  const notes = [...(spec.notes || []), ...(life.notes || [])];
  const steps = [
    {
      id: action,
      argv,
      env: envCheck.env,
      cwd: workdir,
      requiresSudo: spec.requiresSudo === true,
      startsEngine: spec.startsEngine === true,
      note: spec.note || null,
    },
  ];

  const occupier = ctx.portOccupier || null;
  const blocked = [];
  const exclusiveWith = Array.isArray(life.exclusiveWith) ? life.exclusiveWith : [];
  const displace = [];
  if (action === "install" || action === "start" || action === "switch") {
    for (const p of exclusivePorts) {
      const heldBy = occupier && occupier[p];
      if (!heldBy || heldBy === raw.id) continue;
      if (exclusiveWith.includes(heldBy) || ctx.allowDisplace === heldBy) {
        if (!displace.some((d) => d.componentId === heldBy)) {
          displace.push({
            id: "stop-peer",
            kind: "stop-component",
            componentId: heldBy,
            port: p,
            argv: null,
            note: `coordinated stop of ${heldBy} so this recipe can take :${p} (stop old → start new)`,
          });
        }
      } else {
        blocked.push(`port ${p} is held by ${heldBy} (not an exclusiveWith peer; refusing to preempt)`);
      }
    }
  }

  if (displace.length) {
    steps.unshift(...displace);
  }

  const checkout = {
    id: "checkout",
    kind: "git-checkout",
    origin: raw.source?.origin ?? null,
    commit: raw.source?.upstreamCommit ?? null,
    workdir,
    argv: null,
    note: "pinned git clone/fetch/checkout of the allowlisted origin; never curl|sh",
  };
  if (action === "install") {
    steps.unshift(checkout);
    steps.unshift({
      id: "preflight",
      kind: "host-preflight",
      argv: null,
      note: "requires host git; docker when the upstream scripts use it; sudo -n for install.sh (no TTY for sudo -v)",
      requiresSudo: spec.requiresSudo === true,
    });
  }

  if (life.topology === "tp2") {
    const group = ctx.group || {};
    const members = Array.isArray(group.members) ? group.members : [];
    if (members.length !== 2 && ctx.requireGroup === true) {
      blocked.push(`tp=2 recipe needs a group with exactly two members (got ${members.length})`);
    }
    if (ctx.network && ctx.network.mutateHardware) {
      blocked.push("RoCE/hardware mutation is forbidden; validate existing link prerequisites only");
    }
    if (ctx.network && ctx.network.prereqOk === false) {
      blocked.push(ctx.network.reason || "interconnect prerequisites not met");
    }
  }

  return {
    ok: blocked.length === 0,
    error: blocked[0] || null,
    code: blocked.length ? "preflight" : null,
    plan: {
      componentId: raw.id,
      action,
      workdir,
      steps,
      notes,
      pinned: raw.source
        ? { origin: raw.source.origin, commit: raw.source.upstreamCommit, license: raw.source.license }
        : null,
      requiresSudo: steps.some((s) => s.requiresSudo),
      estDiskGB: Number.isFinite(spec.estDiskGB) ? spec.estDiskGB : null,
      estBootMs: Number.isFinite(spec.estBootMs) ? spec.estBootMs : life.loadingDeadlineMs ?? null,
      loadingDeadlineMs: Number.isFinite(life.loadingDeadlineMs) ? life.loadingDeadlineMs : 20 * 60 * 1000,
      exclusivePorts,
      exclusiveWith: life.exclusiveWith || [],
      displace,
      distinguish: {
        checkout: "allowlisted git clone/fetch/checkout of the pinned commit into the catalog ~/workdir",
        install: "runs ./install.sh --no-start after the pin is verified (writes images/units/weights; needs sudo -n)",
        switch: "rewrites the unit/launcher for a target; does not start the engine (alzeo switch-model.sh)",
        start: "starts the unit after a switch or install --no-start",
        launch: "not part of the install confirm when --no-start is used; start separately and wait for health",
      },
      blocked,
      sideEffects: {
        checkout: action === "install",
        install: action === "install",
        launch: spec.startsEngine === true,
      },
    },
  };
}

/**
 * Run one allowlisted argv via an injected exec (never a shell string).
 * @param {{argv: string[], env: object, cwd: string|null}} step
 * @param {(file: string, args: string[], opts: object) => Promise<{ok: boolean, stdout?: string, stderr?: string, code?: number}>} exec
 */
export async function executePlanStep(step, exec) {
  if (step && (step.kind === "git-checkout" || step.kind === "host-preflight" || step.kind === "stop-component")) {
    return { ok: false, error: `step '${step.kind}' must be run by the specialized executor, not executePlanStep` };
  }
  const check = validateArgv(step.argv);
  if (!check.ok) return { ok: false, error: check.error };
  const envCheck = validateEnv(step.env);
  if (!envCheck.ok) return { ok: false, error: envCheck.error };
  if (typeof exec !== "function") return { ok: false, error: "no executor" };
  const file = step.argv[0];
  const args = step.argv.slice(1);
  return exec(file, args, { cwd: step.cwd || undefined, env: envCheck.env });
}
