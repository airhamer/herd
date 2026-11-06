/**
 * Bind a usage-relay capture to exactly one component instance.
 *
 * Matching is request → upstream/listen port (engine or guard) and, when
 * still ambiguous, served model name. Unbound or many matches fail closed.
 * LiteLLM spend-log pull is not implemented; this only describes relay capture.
 */
import { resolveRecordingPolicy } from "./runtimeProfile.js";

export function listInstancesForBind(store, definitions) {
  const defsById = new Map();
  const list = Array.isArray(definitions)
    ? definitions
    : Array.isArray(definitions?.definitions)
      ? definitions.definitions
      : [];
  for (const d of list) {
    const raw = d && (d.raw || d);
    const id = d?.id || raw?.id;
    if (id) defsById.set(id, d);
  }
  const out = [];
  for (const [key, rec] of Object.entries(store?.instances || {})) {
    const parts = String(key).split("/");
    const nodeId = parts[0];
    const componentId = parts.slice(1).join("/");
    const def = defsById.get(componentId) || {};
    const raw = def.raw || def;
    const ports = rec.ports || def.runtimeProfile?.ports || raw.runtimeProfile?.ports || raw.ports || {};
    const served = rec.servedModelName || raw.model?.servedModelName || null;
    out.push({
      key,
      nodeId,
      componentId,
      variantId: rec.variantId,
      variantGeneration: Number.isFinite(rec.variantGeneration) ? rec.variantGeneration : 0,
      recording: rec.recording,
      ports: {
        engine: ports.engine != null ? Number(ports.engine) : null,
        guard: ports.guard != null ? Number(ports.guard) : null,
      },
      servedModelName: served,
    });
  }
  return out;
}

/**
 * @param {{ listenPort?: number, upstreamPort?: number, path?: string, servedModel?: string }} evt
 * @param {Array<object>} instances
 */
export function bindRelayCapture(evt, instances) {
  const upstreamPort = Number(evt?.upstreamPort);
  const listenPort = Number(evt?.listenPort);
  if (!Number.isFinite(upstreamPort)) {
    return { ok: false, code: "unbound", reason: "relay event has no upstream port" };
  }
  const rows = Array.isArray(instances) ? instances : [];
  let matches = rows.filter((inst) => {
    const pe = Number(inst.ports?.engine);
    const pg = Number(inst.ports?.guard);
    return pe === upstreamPort || pg === upstreamPort;
  });
  if (matches.length > 1 && typeof evt?.servedModel === "string" && evt.servedModel) {
    const named = matches.filter((inst) => inst.servedModelName === evt.servedModel);
    if (named.length === 1) matches = named;
    else if (named.length === 0) {
      return { ok: false, code: "unbound", reason: "no instance bound to this relay route/model" };
    } else {
      return { ok: false, code: "ambiguous", reason: "multiple instances share this relay route/model" };
    }
  }
  if (matches.length === 0) {
    return { ok: false, code: "unbound", reason: "no instance bound to this relay upstream port" };
  }
  if (matches.length > 1) {
    return { ok: false, code: "ambiguous", reason: "multiple instances share this relay upstream port" };
  }
  const inst = matches[0];
  const policy = resolveRecordingPolicy([inst.recording].filter(Boolean));
  return {
    ok: true,
    componentId: inst.componentId,
    variantId: inst.variantId,
    variantGeneration: inst.variantGeneration ?? 0,
    nodeId: inst.nodeId,
    policy,
    listenPort: Number.isFinite(listenPort) ? listenPort : null,
    upstreamPort,
    path: typeof evt?.path === "string" ? evt.path : null,
  };
}
