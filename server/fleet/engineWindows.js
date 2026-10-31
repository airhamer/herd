// ─── Fleet engine windows (STAT2, #35) ─────────────────────────────────────
//
// Node agents export each LLM port's raw cumulative engine counters
// (`llm[i].engineCounters`, agent/collectors/llm.js). This module keeps one
// set of 60 s / 300 s EngineWindows per node and port, and annotates each
// llm entry of a polled snapshot with its normalized record (`normalized`).
// Entries without counters still get levels (running / waiting / KV); an
// entry with nothing to measure reads every value null, never 0.

import { EngineWindows } from "../metrics/EngineWindow.js";

/** @param {unknown} v */
function fin(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Source tier of the agent's level readings: vLLM levels come from its
 * Prometheus page, SGLang's from its own /v1/loads JSON.
 * @param {string} backend
 */
function levelTier(backend) {
  return backend === "vllm" ? "counter" : "native";
}

/**
 * @param {{ spansS?: readonly number[], now?: () => number }} [opts]
 */
export function createFleetEngineWindows(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  /** @type {Map<string, EngineWindows>} `${nodeId}:${port}` → windows */
  const windows = new Map();

  /**
   * Feed one snapshot and return it with `normalized` on every llm entry.
   * Snapshots without an llm array are returned unchanged.
   * @template {Record<string, any>} S
   * @param {string} nodeId
   * @param {S} snapshot
   * @returns {S}
   */
  function annotate(nodeId, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.llm) || snapshot.llm.length === 0) return snapshot;
    const t = fin(snapshot.polledAt) ?? now();
    const seen = new Set();
    const llm = snapshot.llm.map((entry) => {
      if (!entry || typeof entry !== "object" || !Number.isInteger(entry.port)) return entry;
      const id = `${nodeId}:${entry.port}`;
      seen.add(id);
      const backend = typeof entry.backend === "string" ? entry.backend : null;
      if (!backend) {
        windows.delete(id);
        return { ...entry, normalized: null };
      }
      let w = windows.get(id);
      if (!w) {
        w = new EngineWindows(opts.spansS);
        windows.set(id, w);
      }
      const counters = entry.engineCounters && typeof entry.engineCounters === "object" ? entry.engineCounters : null;
      const kv = fin(entry.kvCacheUsage);
      const tier = levelTier(backend);
      w.add({
        t,
        key: `${backend}|${entry.modelId ?? ""}`,
        counters,
        counterSource: "counter",
        levels: {
          running: fin(entry.requestsRunning),
          waiting: fin(entry.requestsWaiting),
          kvPct: kv == null ? null : kv * 100,
        },
        levelSources: { running: tier, waiting: tier, kvPct: "counter" },
      });
      return { ...entry, normalized: w.records() };
    });
    // Ports this node no longer reports lose their windows.
    for (const id of windows.keys()) {
      if (id.startsWith(`${nodeId}:`) && !seen.has(id)) windows.delete(id);
    }
    return { ...snapshot, llm };
  }

  /** @param {string} nodeId */
  function forget(nodeId) {
    for (const id of windows.keys()) if (id.startsWith(`${nodeId}:`)) windows.delete(id);
  }

  return { annotate, forget, size: () => windows.size };
}
