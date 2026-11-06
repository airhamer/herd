/**
 * TP=2 group preflight (RECIPE2). Validates membership and existing
 * interconnect configuration. Never mutates RoCE / OS network settings.
 */

/**
 * Named TP=2 env keys and whether inventory LAN may ever supply them.
 *
 * GLM WORKER is an SSH control target; start.sh also discovers the RoCE
 * fabric from the *route to WORKER*, so it is not an inventory management
 * address. DeepSeek WORKER_HOST / MASTER_ADDR / MASTER_PORT / NCCL_* are
 * distributed / data-plane and must come from an explicit overlay.
 *
 * @see https://github.com/MiaAI-Lab/GLM-5.3-Flash-DGX-Sparks-1104/blob/02dac3879852b8c5713318d3d64a5a791002e954/scripts/config.sh
 * @see https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark/blob/a8b4636710068fd30edb98e1365d567086cc208e/start-deepseek-v4-flash-dspark.sh
 */
export const NETWORK_ENV_PLANES = Object.freeze({
  WORKER: {
    plane: "control",
    note: "SSH target for rank 1. start.sh discovers the interconnect from the route to WORKER. Set explicitly; never filled from inventory lanIp.",
  },
  WORKER_HOST: {
    plane: "data",
    note: "DeepSeek worker address (default WORKER_VLLM_HOST_IP). Required in .env.dspark; not inventory LAN.",
  },
  MASTER_ADDR: {
    plane: "data",
    note: "Distributed rendezvous / default VLLM_HOST_IP. Not inventory LAN.",
  },
  MASTER_PORT: {
    plane: "data",
    note: "Required alongside MASTER_ADDR by the pinned start/stop scripts.",
  },
  NCCL_IB_HCA: {
    plane: "data",
    note: "RoCE HCA name. Never invent from inventory LAN IPs.",
  },
  NCCL_SOCKET_IFNAME: {
    plane: "data",
    note: "NCCL socket netdev. Never invent from inventory LAN IPs.",
  },
});

export function classifyNetworkPreview(definition, ctx = {}) {
  const raw = definition.raw || definition;
  const required = Array.isArray(raw.lifecycle?.requiredEnv) ? raw.lifecycle.requiredEnv : [];
  const provided = ctx.network?.config && typeof ctx.network.config === "object" ? ctx.network.config : {};
  const nodes = Array.isArray(ctx.listNodes) ? ctx.listNodes : [];
  const management = nodes.map((n) => ({
    nodeId: n.id,
    address: n.lanIp && n.agentPort ? `${n.lanIp}:${n.agentPort}` : n.endpoint || null,
    plane: "management",
    purpose: "dashboard ↔ agent health and control",
    source: "inventory",
  }));
  const named = required.map((name) => {
    const meta = NETWORK_ENV_PLANES[name] || {
      plane: "unknown",
      note: "explicit named overlay required; not filled from inventory LAN",
    };
    return {
      name,
      plane: meta.plane,
      note: meta.note,
      provided: Boolean(provided[name]),
    };
  });
  return {
    management,
    named,
    control: named.filter((x) => x.plane === "control"),
    dataPlane: named.filter((x) => x.plane === "data"),
  };
}

export function planGroupRecipe(definition, ctx = {}) {
  const raw = definition.raw || definition;
  const life = raw.lifecycle || {};
  const group = ctx.group || {};
  const members = Array.isArray(group.members) ? group.members : [];
  if (members.length !== 2) {
    return {
      ok: false,
      code: "incompatible-topology",
      error: `tp=2 recipe '${raw.id}' needs exactly two group members (got ${members.length})`,
    };
  }
  const headId = group.headId || group.head || members[0];
  const workerId = members.find((m) => m !== headId) || members[1];
  if (!headId || !workerId || headId === workerId) {
    return { ok: false, code: "incompatible-topology", error: "group must name distinct head and worker" };
  }

  const network = ctx.network || {};
  if (network.mutateHardware || network.wouldChangeHardware) {
    return {
      ok: false,
      code: "network-mutation-forbidden",
      error: "refusing to change RoCE or host network configuration; validate existing links only",
    };
  }
  const required = Array.isArray(life.requiredEnv) ? life.requiredEnv : [];
  const provided = network.config && typeof network.config === "object" ? network.config : {};
  const missing = required.filter((k) => !provided[k]);
  if (missing.length) {
    return {
      ok: false,
      code: "missing-interconnect",
      error: `missing already-configured interconnect values: ${missing.join(", ")}`,
    };
  }
  if (network.prereqOk === false) {
    return {
      ok: false,
      code: "missing-interconnect",
      error: network.reason || "interconnect prerequisites not met",
    };
  }

  const startOrder = Array.isArray(life.startOrder) && life.startOrder.length ? life.startOrder : ["worker", "head"];
  const nodeOf = { head: headId, worker: workerId };
  const action = ctx.action || "install";
  const order = action === "stop" ? [...startOrder].reverse() : startOrder;
  const nodes = order.map((role) => ({ role, nodeId: nodeOf[role] }));

  return {
    ok: true,
    plan: {
      componentId: raw.id,
      groupId: group.id || group.groupId || null,
      headId,
      workerId,
      order: nodes,
      recordingIdentity: group.id || group.groupId || raw.id,
      notes: [
        "Group recording policy and history identity persist across a compatible switch (#118).",
        "Orchestration uses the pinned upstream entry point; herd does not rewrite NCCL/RoCE device names.",
      ],
    },
  };
}


/**
 * Per-member argv + allowlisted env for a TP=2 role.
 * Worker/head entrypoints come from lifecycle.roles (pinned by source.upstreamCommit).
 */
export function memberRolePlan(definition, role, ctx = {}) {
  const raw = definition.raw || definition;
  const life = raw.lifecycle || {};
  const roles = life.roles && typeof life.roles === "object" ? life.roles : {};
  const spec = roles[role] || {};
  const action = ctx.action || "install";
  const dryRun = Boolean(ctx.dryRun);
  let argv = null;
  if (action === "stop") {
    argv = spec.runsStop === false ? null : (spec.stopArgv || life.stop?.argv || null);
  } else if (spec.runsInstaller === false && action !== "stop") argv = null;
  else if (dryRun) argv = spec.previewArgv || life.install?.argv || spec.installArgv || null;
  else argv = spec.installArgv || life.install?.executeArgv || life.install?.argv || null;

  const env = { ...(life.install?.env || {}), ...(ctx.env || {}), ROLE: role };
  if (dryRun && spec.previewEnv) Object.assign(env, spec.previewEnv);
  if (action === "stop" && spec.runsStop === false) argv = null;
  return {
    role,
    argv,
    env,
    runsInstaller: argv != null,
    note: spec.note || null,
    pinned: raw.source
      ? { origin: raw.source.origin, commit: raw.source.upstreamCommit, license: raw.source.license }
      : null,
  };
}

export function planGroupFanout(definition, ctx = {}) {
  const base = planGroupRecipe(definition, ctx);
  if (!base.ok) return base;
  const members = base.plan.order.map((m) => ({
    ...m,
    ...memberRolePlan(definition, m.role, {
      action: ctx.action,
      dryRun: ctx.dryRun,
      env: ctx.network?.config,
      workerHost: ctx.network?.config?.WORKER || ctx.workerHost,
    }),
  }));
  return {
    ok: true,
    plan: {
      ...base.plan,
      members,
      paths: classifyNetworkPreview(definition, ctx),
      allOrNothingPreflight: true,
      mocksOnlyNote: "Integration coverage is mock HTTP to two member agents; no live GPU success is claimed.",
    },
  };
}
