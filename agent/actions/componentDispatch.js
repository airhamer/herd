/**
 * v2 ComponentActionRequest dispatcher (COMP2 / #118).
 *
 * The dashboard posts v2 bodies to POST /actions. Legacy dispatchAction
 * understands v1 serviceName verbs only. This module:
 *   - validates the v2 envelope
 *   - dry-run preview + confirmation tokens
 *   - swap-variant (profile-preserving, no installer)
 *   - start/stop/restart via downgradeToV1 → dispatchAction
 */
import {
  validateComponentActionRequest,
  mintConfirmationToken,
  verifyConfirmationToken,
  downgradeToV1,
  componentResultEnvelope,
} from "./component.js";
import {
  swapVariant,
  discoverCapabilities,
  resolveRecordingPolicy,
} from "../../shared/runtimeProfile.js";
import { planHardwareSwitch } from "../../shared/switchLifecycle.js";
import { runSwitchModel } from "./switchModelExec.js";
import { probeRuntimeCapabilities, persistDetected } from "../capability/probe.js";
import { loadDefinitions, getDefinition, DEFAULT_CATALOG_DIR } from "../catalog/definitions.js";
import {
  loadInstanceStore,
  saveInstanceStore,
  readInstance,
  writeInstance,
  nextVariantGeneration,
  defaultInstancePath,
} from "../catalog/componentInstance.js";

const LONG_BOOT_MS = 20 * 60 * 1000;

export function isV2ComponentAction(raw) {
  return Boolean(raw && typeof raw === "object" && raw.version === 2 && typeof raw.componentId === "string");
}

/**
 * @param {object} raw
 * @param {object} deps
 */
export async function dispatchComponentAction(raw, deps = {}) {
  const started = Date.now();
  const check = validateComponentActionRequest(raw);
  if (!check.ok) {
    const env = componentResultEnvelope(raw);
    env.error = check.issues.join("; ");
    env.message = env.error;
    env.durationMs = Date.now() - started;
    return env;
  }
  const request = raw;
  const catalogDir = deps.catalogDir || DEFAULT_CATALOG_DIR;
  const { definitions, warnings } = (typeof deps.loadDefinitions === "function"
    ? deps.loadDefinitions(catalogDir)
    : loadDefinitions(catalogDir));
  const def = getDefinition(definitions, request.componentId);
  const env = componentResultEnvelope(request);
  env.type = request.type;
  if (!def) {
    env.error = `unknown component '${request.componentId}'${warnings.length ? ` (${warnings[0]})` : ""}`;
    env.message = env.error;
    env.durationMs = Date.now() - started;
    return env;
  }

  const configDir = deps.configDir || pathFallback(deps);
  const instancePath = deps.instancePath || defaultInstancePath(configDir);
  const store = typeof deps.loadStore === "function" ? deps.loadStore() : loadInstanceStore(instancePath);
  const instance = readInstance(store, request.nodeId, request.componentId) || {
    variantId: def.activeVariantId,
    recording: def.runtimeProfile.recording,
    segments: [],
    servedModelName: def.variants.find((v) => v.id === def.activeVariantId)?.model.servedModelName ?? null,
  };

  if (request.type === "swap-variant") {
    return handleSwapVariant(request, def, instance, store, instancePath, deps, env, started);
  }

  return handleLifecycleVerb(request, def, instance, deps, env, started);
}

function pathFallback(deps) {
  return deps.configDir || process.env.HERD_AGENT_CONFIG || "agent/config";
}

async function handleSwapVariant(request, def, instance, store, instancePath, deps, env, started) {
  const variantId = typeof request.variantId === "string" ? request.variantId : "";
  if (!variantId) {
    env.error = "variantId is required for swap-variant";
    env.message = env.error;
    env.durationMs = Date.now() - started;
    return env;
  }
  const preview = swapVariant(def, variantId, instance);
  if (!preview.ok) {
    env.error = preview.error;
    env.message = preview.error;
    env.durationMs = Date.now() - started;
    env.plan = {
      willDo: [],
      displaces: null,
      confirm: "required",
      confirmationToken: null,
      estDowntimeMs: 0,
      memoryDeltaMB: 0,
      inflightRequests: null,
      scopeBlocked: preview.error,
    };
    return env;
  }

  const secret = deps.confirmSecret || process.env.HERD_ACTION_SECRET || "herd-component-action";
  const planToken = mintConfirmationToken(
    { ...request, recipeName: request.variantId },
    secret,
    deps.now
  );
  const capObserved = deps.observedCapabilities || {};
  let capabilities = discoverCapabilities(def.runtimeProfile.adapters, capObserved);
  const estimates = preview.result.estimates;
  const variant = (def.variants || []).find((v) => v.id === variantId);
  const hw = variant?.switchTarget ? planHardwareSwitch(variant) : null;
  if (variant?.switchTarget && !hw.ok) {
    env.error = hw.error;
    env.message = hw.error;
    env.durationMs = Date.now() - started;
    return env;
  }

  if (request.dryRun) {
    env.ok = true;
    env.status = "success";
    env.message = hw
      ? `preview switch ${preview.result.previousVariantId} → ${preview.result.variantId} via ${hw.argv.join(" ")} (confirmed downtime; long load allowed)`
      : `swap ${preview.result.previousVariantId} → ${preview.result.variantId} preserves profile ${def.id}`;
    env.plan = {
      willDo: hw ? ["swap-variant", ...hw.willDo] : ["swap-variant"],
      displaces: null,
      confirm: "required",
      confirmationToken: planToken,
      estDowntimeMs: hw ? hw.estDowntimeMs : 0,
      memoryDeltaMB: 0,
      inflightRequests: null,
      scopeBlocked: null,
      servedModelName: preview.result.servedModelName,
      recording: preview.result.recording,
      capabilities,
      estimates,
      argv: hw ? hw.argv : null,
      confirmedDowntime: Boolean(hw),
    };
    env.durationMs = Date.now() - started;
    return env;
  }

  const verify = verifyConfirmationToken(
    request.confirmationToken,
    { ...request, recipeName: request.variantId },
    secret,
    { now: deps.now }
  );
  if (!verify.ok) {
    env.error = `confirmation ${verify.reason || "failed"}`;
    env.message = env.error;
    env.durationMs = Date.now() - started;
    return env;
  }

  const previousRec = {
    variantId: instance.variantId ?? preview.result.previousVariantId,
    recording: instance.recording ?? preview.result.recording,
    segments: instance.segments ?? [],
    servedModelName: instance.servedModelName ?? null,
    profileId: def.id,
    updatedAt: instance.updatedAt ?? null,
  };

  if (hw) {
    const exec = typeof deps.execSwitch === "function"
      ? await deps.execSwitch({ argv: hw.argv, cwd: deps.switchCwd })
      : await runSwitchModel(hw.argv, { cwd: deps.switchCwd, execFile: deps.execFile });
    if (!exec || exec.ok === false) {
      // Desired metadata stays on the previous variant. We do not claim the
      // hardware was rolled back — switch-model.sh does not provide a
      // verified undo in this path.
      env.ok = false;
      env.status = "failure";
      env.error = exec?.error || "switch-model failed";
      env.message = `switch-model failed (${env.error}); desired variant left as ${previousRec.variantId}; hardware rollback not claimed`;
      env.hardwareRolledBack = false;
      env.steps = [{
        step: "switch-model",
        status: "failure",
        message: env.message,
        argv: hw.argv,
        durationMs: Date.now() - started,
      }];
      env.state = {
        componentId: def.id,
        variantId: previousRec.variantId,
        servedModelName: previousRec.servedModelName,
        recording: previousRec.recording,
        capabilities,
      };
      env.durationMs = Date.now() - started;
      return env;
    }

    let ready = { ready: false, loading: true };
    if (typeof deps.probeReady === "function") {
      ready = await deps.probeReady({ componentId: def.id, variantId: preview.result.variantId });
    } else if (deps.probeCapabilities !== false) {
      try {
        const probed = typeof deps.probeCapabilities === "function"
          ? await deps.probeCapabilities(def.runtimeProfile)
          : await probeRuntimeCapabilities(def.runtimeProfile, {
              fetchImpl: deps.fetchImpl,
              env: deps.env,
            });
        capabilities = probed.capabilities || capabilities;
        ready = {
          ready: Boolean(probed.detected?.reachable),
          loading: !probed.detected?.reachable,
          detected: probed.detected,
        };
      } catch {
        ready = { ready: false, loading: true };
      }
    }

    const nextRec = {
      variantId: preview.result.variantId,
      variantGeneration: nextVariantGeneration(instance, preview.result.variantId),
      recording: preview.result.recording,
      segments: preview.result.segments,
      servedModelName: preview.result.servedModelName,
      profileId: def.id,
      updatedAt: (deps.now || Date.now)(),
      detectedCapabilities: ready.detected
        ? persistDetected({}, ready.detected).detectedCapabilities
        : instance.detectedCapabilities ?? null,
    };
    const nextStore = writeInstance(store, request.nodeId, request.componentId, nextRec);
    if (typeof deps.saveStore === "function") deps.saveStore(nextStore);
    else saveInstanceStore(instancePath, nextStore);

    env.ok = true;
    env.status = ready.ready ? "success" : "running";
    env.canaryState = ready.ready ? "ready" : "loading";
    env.message = ready.ready
      ? `hardware switch to ${hw.target} completed; serving ${preview.result.servedModelName}`
      : `hardware switch to ${hw.target} completed; engine loading (long load allowed). selected model is not serving yet`;
    env.steps = [
      { step: "switch-model", status: "success", message: exec.stdout || hw.argv.join(" "), argv: hw.argv, durationMs: null },
      { step: "canary", status: ready.ready ? "success" : "running", message: env.canaryState, durationMs: null },
    ];
    env.state = {
      componentId: def.id,
      variantId: nextRec.variantId,
      servedModelName: nextRec.servedModelName,
      recording: nextRec.recording,
      capabilities,
    };
    env.durationMs = Date.now() - started;
    return env;
  }

  const nextRec = {
    variantId: preview.result.variantId,
    variantGeneration: nextVariantGeneration(instance, preview.result.variantId),
    recording: preview.result.recording,
    segments: preview.result.segments,
    servedModelName: preview.result.servedModelName,
    profileId: def.id,
    updatedAt: (deps.now || Date.now)(),
  };
  const nextStore = writeInstance(store, request.nodeId, request.componentId, nextRec);
  if (typeof deps.saveStore === "function") deps.saveStore(nextStore);
  else saveInstanceStore(instancePath, nextStore);

  env.ok = true;
  env.status = "success";
  env.message = `variant is now ${preview.result.variantId}; profile, routes, adapters, credential refs and recording policy unchanged`;
  env.steps = [{ step: "swap-variant", status: "success", message: env.message, durationMs: Date.now() - started }];
  env.state = {
    componentId: def.id,
    variantId: nextRec.variantId,
    servedModelName: nextRec.servedModelName,
    recording: nextRec.recording,
    capabilities,
  };
  env.durationMs = Date.now() - started;
  return env;
}

async function handleLifecycleVerb(request, def, instance, deps, env, started) {
  const serviceName =
    request.recipeName ||
    def.raw?.runtimeAliases?.serviceNames?.[0] ||
    def.id;
  const port = def.runtimeProfile.ports.engine;
  const secret = deps.confirmSecret || process.env.HERD_ACTION_SECRET || "herd-component-action";

  const willDo = [];
  if (request.type === "start" && request.exclusiveWith) willDo.push("stop");
  if (request.type === "restart") willDo.push("stop", "start", "canary");
  else if (request.type === "start") willDo.push("start", "canary");
  else willDo.push("stop");

  if (request.dryRun) {
    env.ok = true;
    env.status = "success";
    env.message = `plan ${request.type} ${def.id}`;
    env.plan = {
      willDo,
      displaces: request.exclusiveWith,
      confirm: "required",
      confirmationToken: mintConfirmationToken(request, secret, deps.now),
      estDowntimeMs: request.type === "stop" ? 0 : LONG_BOOT_MS,
      memoryDeltaMB: 0,
      inflightRequests: null,
      scopeBlocked: null,
    };
    env.durationMs = Date.now() - started;
    return env;
  }

  const verify = verifyConfirmationToken(request.confirmationToken, request, secret, { now: deps.now });
  if (!verify.ok) {
    env.error = `confirmation ${verify.reason || "failed"}`;
    env.message = env.error;
    env.durationMs = Date.now() - started;
    return env;
  }

  const dispatchAction = deps.dispatchAction;
  if (typeof dispatchAction !== "function") {
    env.error = "lifecycle verbs require dispatchAction (agent executor)";
    env.message = env.error;
    env.durationMs = Date.now() - started;
    return env;
  }

  const steps = [];
  try {
    if (request.type === "start" && request.exclusiveWith) {
      const peer = deps.getDefinition?.(request.exclusiveWith) || null;
      const peerService = peer?.raw?.runtimeAliases?.serviceNames?.[0] || request.exclusiveWith;
      const stopPeer = await dispatchAction(
        downgradeToV1({ ...request, type: "stop" }, { serviceName: peerService, port }),
        deps.dispatchDeps || {}
      );
      steps.push({
        step: "stop",
        status: stopPeer.ok === false ? "failure" : "success",
        message: stopPeer.message || `stop ${peerService}`,
        durationMs: null,
      });
    }
    const v1 = downgradeToV1(request, { serviceName, port });
    const result = await dispatchAction(v1, deps.dispatchDeps || {});
    steps.push({
      step: request.type,
      status: result.status === "failure" || result.ok === false ? "failure" : "success",
      message: result.message || request.type,
      durationMs: result.durationMs ?? null,
    });
    env.ok = result.ok !== false && result.status !== "failure";
    env.status = result.status === "running" ? "running" : env.ok ? "success" : "failure";
    env.message = result.message || "";
    env.error = env.ok ? null : result.error || result.message || "action failed";
    env.canaryState = result.status === "running" ? "loading" : env.ok ? "ready" : "stopped";
    env.steps = steps;
    env.durationMs = Date.now() - started;
    // recording persists across start/stop
    env.state = {
      componentId: def.id,
      variantId: instance.variantId,
      servedModelName: instance.servedModelName,
      recording: resolveRecordingPolicy([def.runtimeProfile.recording, instance.recording]),
    };
    return env;
  } catch (err) {
    env.error = String(err?.message || err);
    env.message = env.error;
    env.steps = steps;
    env.durationMs = Date.now() - started;
    return env;
  }
}
