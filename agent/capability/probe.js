/**
 * Read-only engine health/metrics probe (COMP2 / #118).
 *
 * Reuses the existing llm collector HTTP scrape (GET /health, /metrics,
 * /v1/models, engine-native info) through a caller-supplied fetch. Declared
 * adapters stay separate from detected availability and freshness. TensorFold
 * is never reported as a verified numeric source.
 */
import { collectLlm } from "../collectors/llm.js";
import { discoverCapabilities } from "../../shared/runtimeProfile.js";
import { isCredentialRef } from "../../shared/runtimeProfile.js";

const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Resolve an env:/file: credential *reference* to a header value.
 * Raw secrets in the catalog are rejected — only refs are honored.
 */
export function resolveAuthRef(ref, env = process.env, readFile) {
  if (!ref || typeof ref !== "string") return null;
  if (!isCredentialRef(ref)) return null;
  if (ref.startsWith("env:")) {
    const name = ref.slice(4);
    if (!name || !(name in env) || !env[name]) return null;
    return String(env[name]);
  }
  if (ref.startsWith("file:")) {
    const filePath = ref.slice(5);
    if (!filePath || typeof readFile !== "function") return null;
    try {
      const v = readFile(filePath);
      return v ? String(v).trim() : null;
    } catch {
      return null;
    }
  }
  return null;
}

function abortableFetch(fetchImpl, timeoutMs) {
  return async (url, init = {}) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: ac.signal });
    } finally {
      clearTimeout(t);
    }
  };
}

/**
 * @param {object} profile runtimeProfile
 * @param {{fetchImpl?: Function, now?: Function, env?: object, readFile?: Function, timeoutMs?: number, lastDetected?: object|null}} [opts]
 */
export async function probeRuntimeCapabilities(profile, opts = {}) {
  const now = typeof opts.now === "function" ? opts.now() : Date.now();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl || fetch;
  const port = profile?.ports?.engine;
  const declared = Array.isArray(profile?.adapters) ? profile.adapters : [];

  if (!Number.isFinite(port)) {
    return {
      declared,
      detected: {
        reachable: false,
        reason: "no-engine-port",
        observedAt: now,
        freshness: "fresh",
        metrics: null,
        backend: null,
      },
      capabilities: discoverCapabilities(declared, {}),
    };
  }

  const token = resolveAuthRef(profile?.credentialRef || profile?.authRef, opts.env, opts.readFile);
  const authTokens = token ? { [String(port)]: token } : null;
  let entries = [];
  let error = null;
  try {
    entries = await collectLlm([port], {
      fetch: abortableFetch(fetchImpl, timeoutMs),
      authTokens,
      clock: () => now,
    });
  } catch (err) {
    error = String(err?.message || err);
  }

  const entry = entries[0] || null;
  const reachable = Boolean(entry && entry.backend);
  const engineName = (entry?.backend || profile?.engine || "").toLowerCase();
  const tensorfold = engineName.includes("tensorfold") || /tensorfold/i.test(String(entry?.ownedBy || ""));

  const observed = {};
  for (const adapter of declared) {
    if (tensorfold) {
      observed[adapter.id] = {
        reachable,
        supported: false,
        enabled: false,
        metrics: null,
        observedAt: now,
        provenance: "unverified-tensorfold",
      };
      continue;
    }
    if (error) {
      observed[adapter.id] = {
        reachable: false,
        supported: adapter.support !== "unsupported",
        enabled: false,
        metrics: null,
        observedAt: now,
        provenance: "probe-error",
        reason: error,
      };
      continue;
    }
    if (!reachable) {
      observed[adapter.id] = {
        reachable: false,
        supported: adapter.support !== "unsupported",
        enabled: false,
        metrics: null,
        observedAt: now,
        provenance: "http-probe",
        reason: entry?.error || "unreachable",
      };
      continue;
    }
    const counters = entry.engineCounters || null;
    observed[adapter.id] = {
      reachable: true,
      supported: adapter.support !== "unsupported",
      enabled: true,
      metrics: pickAdapterMetric(adapter, entry, counters),
      observedAt: now,
      provenance: "http-probe",
    };
  }

  return {
    declared,
    detected: {
      reachable,
      backend: entry?.backend ?? null,
      reason: error || (reachable ? null : "unreachable"),
      observedAt: now,
      freshness: "fresh",
      metrics: tensorfold ? null : entry?.engineCounters ?? null,
      servedModel: entry?.model ?? entry?.servedModelName ?? null,
      tensorfoldUnverified: tensorfold,
    },
    capabilities: discoverCapabilities(declared, observed),
    observed,
  };
}

function pickAdapterMetric(adapter, entry, counters) {
  if (counters && typeof counters === "object") {
    const tokens = counters.prompt_tokens ?? counters.generation_tokens ?? counters.num_requests;
    if (typeof tokens === "number" && Number.isFinite(tokens)) return tokens;
    return { counters };
  }
  if (entry?.tokensPerSecond != null && Number.isFinite(entry.tokensPerSecond)) return entry.tokensPerSecond;
  return entry?.model ?? null;
}

/**
 * Persist detected availability separately from catalog declarations.
 * A reset clears freshness back to unknown without inventing zeros.
 */
export function persistDetected(instance, detected) {
  return {
    ...(instance || {}),
    detectedCapabilities: detected
      ? {
          observedAt: detected.observedAt ?? null,
          freshness: detected.freshness ?? (detected.observedAt ? "fresh" : "unknown"),
          reachable: detected.reachable ?? null,
          backend: detected.backend ?? null,
          reason: detected.reason ?? null,
          tensorfoldUnverified: Boolean(detected.tensorfoldUnverified),
          // Never persist invented numeric tiles; keep raw counters or null.
          metrics: detected.metrics ?? null,
        }
      : null,
  };
}

export function resetDetected(instance) {
  return persistDetected(instance, null);
}
