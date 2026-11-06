/**
 * runtimeProfile.js — Component runtime profile vs variant subcomponents (COMP2 / #118).
 *
 * A Component owns a reusable runtime profile (endpoints, adapters, credential
 * *references*, recording policy, lifecycle hooks). Weights (stock ↔ uncensored
 * and similar compatible checkpoints) are variants: swapping them must not
 * rewrite the parent profile. Incompatible engine/protocol/topology/ports
 * yield an explicit error, never a silent rewrite.
 *
 * Pure functions, no I/O, no new dependencies.
 */
export const RECORDING_CONTENTS = Object.freeze(["off", "metadata", "prompts", "prompts+responses"]);

/** Higher number = more content captured (looser). Stricter-wins picks the lower rank. */
const CONTENT_RANK = Object.freeze({
  off: 0,
  metadata: 1,
  prompts: 2,
  "prompts+responses": 3,
});

const SECRET_KEY_RE = /(?:api[_-]?key|password|secret|token|authorization|bearer|private[_-]?key)$/i;
const RAW_SECRET_RE = /^(?:sk-|hf_|ghp_|gho_|Bearer\s)/i;

/**
 * @param {unknown} raw catalog component JSON
 * @returns {{ok: true, component: object} | {ok: false, issues: string[]}}
 */
export function normalizeComponent(raw) {
  const issues = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: ["component must be a JSON object"] };
  }
  if (typeof raw.id !== "string" || raw.id.trim() === "") issues.push("id is required");
  const secretIssue = findEmbeddedSecret(raw);
  if (secretIssue) issues.push(secretIssue);
  if (issues.length) return { ok: false, issues };

  const profile = synthesizeRuntimeProfile(raw);
  const variants = extractVariants(raw, profile);
  const activeVariantId =
    typeof raw.activeVariantId === "string" && variants.some((v) => v.id === raw.activeVariantId)
      ? raw.activeVariantId
      : variants[0]?.id ?? null;

  return {
    ok: true,
    component: {
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name : raw.id,
      tp: Number.isFinite(raw.tp) ? raw.tp : 1,
      machineClass: typeof raw.machineClass === "string" ? raw.machineClass : null,
      engine: profile.engine,
      runtimeProfile: profile,
      variants,
      activeVariantId,
      recording: profile.recording,
      source: raw.source ?? null,
    },
  };
}

/**
 * Defaults from existing catalog JSON when `runtimeProfile` is absent (backward compatible).
 * @param {object} raw
 */
export function synthesizeRuntimeProfile(raw) {
  const declared = raw.runtimeProfile && typeof raw.runtimeProfile === "object" ? raw.runtimeProfile : {};
  const engine = typeof declared.engine === "string" ? declared.engine : typeof raw.engine === "string" ? raw.engine : null;
  const enginePort = Number.isFinite(declared.ports?.engine)
    ? declared.ports.engine
    : Number.isFinite(raw.ports?.engine)
      ? raw.ports.engine
      : null;
  const guardPort = Number.isFinite(declared.ports?.guard)
    ? declared.ports.guard
    : enginePort != null
      ? enginePort + 1
      : null;
  const adapters = Array.isArray(declared.adapters) && declared.adapters.length
    ? declared.adapters.map(normalizeAdapter)
    : defaultAdapters(engine);
  const recording = normalizeRecording(declared.recording);
  return {
    engine,
    protocol: typeof declared.protocol === "string" ? declared.protocol : protocolOf(engine),
    topology: {
      tp: Number.isFinite(declared.topology?.tp) ? declared.topology.tp : Number.isFinite(raw.tp) ? raw.tp : 1,
      machineClass:
        typeof declared.topology?.machineClass === "string"
          ? declared.topology.machineClass
          : typeof raw.machineClass === "string"
            ? raw.machineClass
            : null,
    },
    ports: {
      engine: enginePort,
      guard: guardPort,
      placeholder: raw.ports ? raw.ports.placeholder !== false : true,
    },
    endpoints: {
      engine: declared.endpoints?.engine ?? null,
      guard: declared.endpoints?.guard ?? null,
      litellm: declared.endpoints?.litellm ?? null,
    },
    adapters,
    credentialRefs: Array.isArray(declared.credentialRefs) ? declared.credentialRefs.filter((r) => isCredentialRef(r)) : [],
    recording,
    litellmRouteAssumedDeployed: declared.litellmRouteAssumedDeployed === true,
  };
}

export function defaultAdapters(engine) {
  const e = String(engine || "").toLowerCase();
  if (e === "sglang") {
    return [
      { id: "sglang", kind: "engine", support: "verified", capabilities: ["engine-native", "metrics", "queue"] },
    ];
  }
  if (e === "vllm") {
    return [
      { id: "vllm", kind: "engine", support: "verified", capabilities: ["metrics", "queue"] },
    ];
  }
  if (e === "ollama") {
    return [{ id: "ollama", kind: "engine", support: "partial", capabilities: [] }];
  }
  if (e === "llama.cpp" || e === "llamacpp") {
    return [{ id: "llama.cpp", kind: "engine", support: "partial", capabilities: ["timings"] }];
  }
  if (e === "tensorfold") {
    return [{ id: "tensorfold", kind: "engine", support: "unverified", capabilities: [] }];
  }
  return [];
}

function protocolOf(engine) {
  const e = String(engine || "").toLowerCase();
  if (e === "sglang") return "sglang-http";
  if (e === "vllm") return "vllm-http";
  if (e === "tensorfold") return "tensorfold-http";
  if (e === "ollama") return "ollama-http";
  if (e === "llama.cpp" || e === "llamacpp") return "llamacpp-http";
  return engine ? `${e}-http` : "unknown";
}

function normalizeAdapter(a) {
  if (!a || typeof a !== "object") return { id: "unknown", kind: "engine", support: "unknown", capabilities: [] };
  return {
    id: typeof a.id === "string" ? a.id : "unknown",
    kind: typeof a.kind === "string" ? a.kind : "engine",
    support: typeof a.support === "string" ? a.support : "unknown",
    capabilities: Array.isArray(a.capabilities) ? a.capabilities.filter((c) => typeof c === "string") : [],
  };
}

export function normalizeRecording(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const content = RECORDING_CONTENTS.includes(r.content) ? r.content : "metadata";
  const retentionHours =
    typeof r.retentionHours === "number" && Number.isFinite(r.retentionHours) && r.retentionHours > 0
      ? r.retentionHours
      : null;
  const maxBytes =
    typeof r.maxBytes === "number" && Number.isFinite(r.maxBytes) && r.maxBytes > 0 ? r.maxBytes : null;
  return {
    content,
    retentionHours,
    maxBytes,
    observer: r.observer === "litellm" || r.observer === "relay" ? r.observer : null,
  };
}

/**
 * Effective policy: scoped inheritance, stricter limits win.
 * Content: off beats any recording. Shorter retention and smaller byte caps win.
 * @param {Array<object|null|undefined>} scopes most-general first, most-specific last (specific can only tighten)
 */
export function resolveRecordingPolicy(scopes) {
  let content = "metadata";
  let retentionHours = null;
  let maxBytes = null;
  let observer = null;
  let first = true;
  for (const scope of scopes) {
    if (!scope) continue;
    const rec = normalizeRecording(scope);
    if (first) {
      content = rec.content;
      retentionHours = rec.retentionHours;
      maxBytes = rec.maxBytes;
      observer = rec.observer;
      first = false;
      continue;
    }
    if (CONTENT_RANK[rec.content] < CONTENT_RANK[content]) content = rec.content;
    if (rec.retentionHours != null) {
      retentionHours = retentionHours == null ? rec.retentionHours : Math.min(retentionHours, rec.retentionHours);
    }
    if (rec.maxBytes != null) {
      maxBytes = maxBytes == null ? rec.maxBytes : Math.min(maxBytes, rec.maxBytes);
    }
    if (rec.observer) observer = rec.observer;
  }
  if ((content === "prompts" || content === "prompts+responses") && !observer) {
    return {
      content: "metadata",
      retentionHours,
      maxBytes,
      observer: null,
      blockedReason: "content recording requires a request-level observer (LiteLLM or a compatible optional proxy/relay); passive metrics cannot record payloads",
    };
  }
  return { content, retentionHours, maxBytes, observer, blockedReason: null };
}

export function canRecordContent(policy) {
  return policy && (policy.content === "prompts" || policy.content === "prompts+responses") && policy.observer && !policy.blockedReason;
}

export function extractVariants(raw, profile = synthesizeRuntimeProfile(raw)) {
  if (Array.isArray(raw.variants) && raw.variants.length > 0) {
    return raw.variants.map((v, i) => normalizeVariant(v, raw, profile, i));
  }
  return [normalizeVariant(null, raw, profile, 0)];
}

function normalizeVariant(v, raw, profile, index) {
  const src = v && typeof v === "object" ? v : {};
  const model = src.model && typeof src.model === "object" ? src.model : raw.model || {};
  const id =
    typeof src.id === "string" && src.id
      ? src.id
      : typeof model.servedModelName === "string"
        ? slug(model.servedModelName)
        : `variant-${index}`;
  const requires = src.requires && typeof src.requires === "object" ? src.requires : {};
  return {
    id,
    label: typeof src.label === "string" ? src.label : typeof model.servedModelName === "string" ? model.servedModelName : id,
    role: typeof src.role === "string" ? src.role : "default",
    model: {
      repo: typeof model.repo === "string" ? model.repo : null,
      revision: typeof model.revision === "string" ? model.revision : null,
      servedModelName: typeof model.servedModelName === "string" ? model.servedModelName : null,
      aliases: Array.isArray(model.aliases) ? model.aliases.filter((a) => typeof a === "string") : [],
    },
    memory_estimate_mb: src.memory_estimate_mb ?? raw.memory_estimate_mb ?? null,
    context_length: src.context_length ?? raw.flags?.context_length ?? null,
    tokenizer: src.tokenizer ?? null,
    requires: {
      engine: requires.engine ?? null,
      protocol: requires.protocol ?? null,
      tp: Number.isFinite(requires.tp) ? requires.tp : null,
      ports: requires.ports && typeof requires.ports === "object" ? requires.ports : null,
    },
    switchTarget: typeof src.switchTarget === "string" ? src.switchTarget : null,
  };
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "variant";
}

/**
 * Compatible variant swap: preserve profile identity, routes, adapters, credential refs, recording.
 * @returns {{ok: true, result: object} | {ok: false, error: string, code: string}}
 */
export function swapVariant(normalized, variantId, instance = {}) {
  if (!normalized?.runtimeProfile) {
    return { ok: false, error: "component has no runtime profile", code: "missing-profile" };
  }
  const next = (normalized.variants || []).find((v) => v.id === variantId);
  if (!next) {
    return { ok: false, error: `unknown variant '${variantId}'`, code: "unknown-variant" };
  }
  const compat = variantCompatibility(normalized.runtimeProfile, next);
  if (!compat.ok) return compat;

  const estimates = revalidateEstimates(next);
  const prevVariantId = instance.variantId ?? normalized.activeVariantId;
  const segments = nextCounterSegments(instance.segments || [], {
    previousVariantId: prevVariantId,
    nextVariantId: next.id,
  });
  const recording = instance.recording
    ? resolveRecordingPolicy([normalized.runtimeProfile.recording, instance.recording])
    : { ...normalized.runtimeProfile.recording, blockedReason: null };

  return {
    ok: true,
    result: {
      componentId: normalized.id,
      runtimeProfile: normalized.runtimeProfile,
      previousVariantId: prevVariantId,
      variantId: next.id,
      servedModelName: next.model.servedModelName,
      aliases: next.model.aliases,
      recording,
      segments,
      estimates,
      profileUnchanged: true,
    },
  };
}

export function variantCompatibility(profile, variant) {
  const req = variant?.requires || {};
  if (req.engine && profile.engine && req.engine !== profile.engine) {
    return {
      ok: false,
      code: "incompatible-engine",
      error: `variant requires engine '${req.engine}' but the component profile uses '${profile.engine}'; migrate the component explicitly`,
    };
  }
  if (req.protocol && profile.protocol && req.protocol !== profile.protocol) {
    return {
      ok: false,
      code: "incompatible-protocol",
      error: `variant requires protocol '${req.protocol}' but the component profile uses '${profile.protocol}'`,
    };
  }
  if (req.tp != null && profile.topology?.tp != null && req.tp !== profile.topology.tp) {
    return {
      ok: false,
      code: "incompatible-topology",
      error: `variant requires tp=${req.tp} but the component profile is tp=${profile.topology.tp}`,
    };
  }
  if (req.ports?.engine != null && profile.ports?.engine != null && req.ports.engine !== profile.ports.engine) {
    return {
      ok: false,
      code: "incompatible-ports",
      error: `variant requires engine port ${req.ports.engine} but the profile binds ${profile.ports.engine}`,
    };
  }
  if (req.ports?.guard != null && profile.ports?.guard != null && req.ports.guard !== profile.ports.guard) {
    return {
      ok: false,
      code: "incompatible-ports",
      error: `variant requires guard port ${req.ports.guard} but the profile binds ${profile.ports.guard}`,
    };
  }
  return { ok: true };
}

export function revalidateEstimates(variant) {
  const mem = variant?.memory_estimate_mb;
  const perSpark = mem && Number.isFinite(mem.perSpark) ? mem.perSpark : null;
  const context = Number.isFinite(variant?.context_length) ? variant.context_length : null;
  return {
    memoryPerSparkMB: perSpark,
    memoryBasis: mem && typeof mem.basis === "string" ? mem.basis : perSpark == null ? "unknown" : null,
    contextLength: context,
    tokenizer: variant?.tokenizer ?? null,
    unknown: perSpark == null || context == null,
  };
}

/**
 * Close the previous variant's counter segment and open a new one.
 * Does not zero historical totals (that would double-count or look like a wipe).
 */
export function nextCounterSegments(existing, { previousVariantId, nextVariantId, at = Date.now() }) {
  const segs = Array.isArray(existing) ? existing.map((s) => ({ ...s })) : [];
  const open = segs.find((s) => s.open && s.variantId === previousVariantId);
  if (open) {
    open.open = false;
    open.endedAt = at;
  }
  if (nextVariantId) {
    segs.push({
      variantId: nextVariantId,
      startedAt: at,
      endedAt: null,
      open: true,
      baseline: "inherit",
    });
  }
  return segs;
}

/**
 * @param {object[]} declared adapters from the profile
 * @param {Record<string, {reachable?: boolean, enabled?: boolean, supported?: boolean, metrics?: unknown, observedAt?: number, provenance?: string}>} observed
 */
export function discoverCapabilities(declared, observed = {}) {
  const list = Array.isArray(declared) ? declared : [];
  return list.map((adapter) => {
    const obs = observed[adapter.id];
    let status = "unknown";
    if (!obs) status = "unknown";
    else if (obs.supported === false) status = "unsupported";
    else if (obs.enabled === false) status = "disabled";
    else if (obs.reachable === false) status = "unreachable";
    else if (obs.reachable === true && (obs.supported !== false)) status = "supported+enabled";
    const value = capabilityValue(obs);
    return {
      id: adapter.id,
      support: adapter.support,
      status,
      value,
      provenance: typeof obs?.provenance === "string" ? obs.provenance : obs ? "probe" : "declared",
      freshness: obs?.observedAt != null ? "fresh" : "unknown",
      observedAt: obs?.observedAt ?? null,
    };
  });
}

function capabilityValue(obs) {
  if (!obs) return { kind: "unknown", numeric: null };
  if (obs.reachable === false || obs.supported === false || obs.enabled === false) {
    return { kind: "unavailable", numeric: null };
  }
  if (obs.metrics == null) return { kind: "unknown", numeric: null };
  if (typeof obs.metrics === "number" && Number.isFinite(obs.metrics)) {
    return { kind: "measured", numeric: obs.metrics };
  }
  return { kind: "measured", numeric: null, detail: obs.metrics };
}

export function unknownIsNotZero(reading) {
  if (!reading || reading.kind === "unknown" || reading.kind === "unavailable") return null;
  return reading.numeric;
}

export function isCredentialRef(value) {
  if (typeof value !== "string") return false;
  return value.startsWith("env:") || value.startsWith("file:");
}

export function findEmbeddedSecret(value, path = "") {
  if (value == null) return null;
  if (typeof value === "string") {
    if (RAW_SECRET_RE.test(value.trim())) return `embedded secret at ${path || "<root>"}`;
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findEmbeddedSecret(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k) && typeof v === "string" && v && !isCredentialRef(v)) {
        return `raw secret field '${k}' at ${path || "<root>"} (use env: or file: refs only)`;
      }
      const hit = findEmbeddedSecret(v, path ? `${path}.${k}` : k);
      if (hit) return hit;
    }
  }
  return null;
}
