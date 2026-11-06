/**
 * TP=2 group preflight (RECIPE2). Validates membership and existing
 * interconnect configuration. Never mutates RoCE / OS network settings.
 */
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
