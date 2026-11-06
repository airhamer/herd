/**
 * TP=2 fan-out: preview/confirm against two group member agents.
 * All-or-nothing preflight, worker-then-head (or reverse for stop),
 * no RoCE mutation, mocks-friendly proxy injection. Never claims live GPU success.
 */
import { planGroupFanout } from "../../shared/groupRecipe.js";
import { validateEnv } from "../../shared/recipePlan.js";
import { mintConfirmationToken } from "../../agent/actions/component.js";

export async function dispatchGroupComponentAction(opts) {
  const { definition, group, network, request, listNodes, proxy, probeHealth, confirmSecret } = opts;
  const secret = confirmSecret || process.env.HERD_ACTION_SECRET || "herd-component-action";
  const action = request.type === "configure" ? "switch" : request.type;
  const fan = planGroupFanout(definition, { action, group, network, dryRun: request.dryRun });
  if (!fan.ok) return { status: 400, body: { ok: false, error: fan.error, code: fan.code } };

  const recs = [];
  for (const m of fan.plan.members) {
    const rec = (listNodes || []).find((n) => n.id === m.nodeId);
    if (!rec) {
      return {
        status: 409,
        body: { ok: false, error: `all-or-nothing preflight: group member '${m.nodeId}' is not registered` },
      };
    }
    recs.push({ ...m, rec });
  }

  const health = [];
  for (const m of recs) {
    if (typeof probeHealth !== "function") {
      health.push({ nodeId: m.nodeId, role: m.role, ok: false, error: "no health probe" });
      continue;
    }
    const h = await probeHealth(m.rec);
    health.push({ nodeId: m.nodeId, role: m.role, ok: h?.ok !== false, error: h?.error || null });
  }
  if (health.some((h) => !h.ok)) {
    return {
      status: 409,
      body: {
        ok: false,
        error: `all-or-nothing preflight failed: ${health.filter((h) => !h.ok).map((h) => h.nodeId).join(", ")}`,
        health,
        plan: fan.plan,
      },
    };
  }

  if (request.dryRun) {
    return {
      status: 200,
      body: {
        ok: true,
        status: "success",
        message: `plan ${action} on ${fan.plan.members.map((m) => `${m.role}=${m.nodeId}`).join(", ")} (mocks-only integration; no live GPU claim)`,
        plan: {
          willDo: fan.plan.members.flatMap((m) => [`${m.role}:checkout`, m.runsInstaller ? `${m.role}:${action}` : `${m.role}:ready`]),
          displaces: null,
          confirm: "required",
          confirmationToken: mintConfirmationToken(request, secret),
          estDowntimeMs: definition.raw?.lifecycle?.loadingDeadlineMs || definition.lifecycle?.loadingDeadlineMs || 20 * 60 * 1000,
          memoryDeltaMB: 0,
          inflightRequests: null,
          scopeBlocked: null,
          group: fan.plan,
        },
        health,
      },
    };
  }

  const steps = [];
  // Stop old component safely across the group (reverse order) before a new install/start.
  if (action === "install" || action === "start") {
    for (const m of [...recs].reverse()) {
      const stopBody = {
        ...request,
        type: "stop",
        dryRun: false,
        role: m.role,
        nodeId: m.nodeId,
        groupRef: group.id || group.groupId || request.groupRef,
        env: m.env,
      };
      stopBody.confirmationToken = mintConfirmationToken(stopBody, secret);
      const stopped = await proxy(m.rec, stopBody);
      steps.push({
        step: `stop-${m.role}`,
        nodeId: m.nodeId,
        status: stopped.body?.ok === false || stopped.status >= 400 ? "failure" : "success",
        message: stopped.body?.message || stopped.body?.error || "stop",
      });
    }
  }

  for (const m of recs) {
    const envCheck = validateEnv(m.env);
    if (!envCheck.ok) {
      return { status: 400, body: { ok: false, error: envCheck.error, steps } };
    }
    const memberReq = {
      ...request,
      dryRun: false,
      role: m.role,
      nodeId: m.nodeId,
      groupRef: group.id || group.groupId || request.groupRef,
      env: envCheck.env,
    };
    memberReq.confirmationToken = mintConfirmationToken(memberReq, secret);
    const proxied = await proxy(m.rec, memberReq);
    const failed = proxied.body?.ok === false || proxied.status >= 400;
    steps.push({
      step: `${action}-${m.role}`,
      nodeId: m.nodeId,
      role: m.role,
      argv: m.argv,
      status: failed ? "failure" : "success",
      message: proxied.body?.message || proxied.body?.error || `${m.role} ${action}`,
      body: proxied.body,
    });
    if (failed) {
      return {
        status: 502,
        body: {
          ok: false,
          error: `${m.role} (${m.nodeId}) failed; group action is not all-success. Hardware rollback is not claimed.`,
          hardwareRolledBack: false,
          steps,
          mocksOnly: true,
        },
      };
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      status: "success",
      message: `group ${action} dispatched to ${recs.map((m) => m.role).join(" then ")} (mock-able agent round-trip; no live GPU success claimed)`,
      steps,
      health,
      plan: { group: fan.plan },
      mocksOnly: true,
    },
  };
}
