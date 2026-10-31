// ─── Fleet engine windows (STAT2 #35, STAT3 #36) ───────────────────────────
//
// Node agents export each LLM port's raw cumulative engine counters
// (`llm[i].engineCounters`, agent/collectors/llmCounters.js). This module
// keeps one set of 60 s / 300 s EngineWindows per node and port, and
// annotates each llm entry of a polled snapshot with its normalized record
// (`normalized`). Entries without counters still get levels (running /
// waiting / KV); an entry with nothing to measure reads every value null,
// never 0.
//
// Payload versions (all accepted):
//   agent < 0.3   no engineCounters: levels only
//   agent 0.3     engineCounters (vLLM / SGLang), timed by snapshot.polledAt
//   agent 0.4+    engineCounters for every engine with counters, plus
//                 engineCountersMeta { schema: 2, source, monoMs, wallMs, bootId }:
//                 reads are timed by the agent's monotonic clock, so a wall
//                 clock step on the node never bends a rate.

import { EngineWindows } from "../metrics/EngineWindow.js";

/** @param {unknown} v */
function fin(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** @param {unknown} v */
function isObj(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Source tier of the agent's level readings: Prometheus gauges are "counter"
 * (same as the Spark probe), engine JSON (SGLang /v1/loads, /health,
 * /v1/stats, /stats) is "native".
 * @param {string} backend
 * @param {string | null} metaSource
 */
function levelTier(backend, metaSource) {
  if (backend === "vllm") return "counter";
  if (backend === "sglang") return "native";
  return metaSource === "prometheus" ? "counter" : "native";
}

/**
 * Valid STAT3 counter meta, or null (older agent / malformed).
 * @param {unknown} meta
 * @returns {{ schema: number, source: string|null, monoMs: number, wallMs: number|null, bootId: string } | null}
 */
export function counterMetaOf(meta) {
  if (!isObj(meta)) return null;
  const schema = fin(meta.schema);
  const monoMs = fin(meta.monoMs);
  if (schema == null || schema < 2 || monoMs == null || monoMs < 0) return null;
  if (typeof meta.bootId !== "string" || meta.bootId === "") return null;
  return {
    schema,
    source: typeof meta.source === "string" ? meta.source : null,
    monoMs,
    wallMs: fin(meta.wallMs),
    bootId: meta.bootId,
  };
}

/**
 * @param {{ spansS?: readonly number[], now?: () => number }} [opts]
 */
export function createFleetEngineWindows(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  /**
   * `${nodeId}:${port}` → windows, the agent clock anchor (monotonic ms →
   * timeline ms) and the previous counter read for per-poll rates.
   * @type {Map<string, { w: EngineWindows, bootId: string|null, anchorMono: number, anchorT: number,
   *   prev: { t: number, generated: number|null, prefill: number|null } | null }>}
   */
  const ports = new Map();

  /**
   * Timeline ms of a read. With STAT3 meta: the agent's monotonic clock,
   * anchored once per agent boot to its wall clock (a new boot re-anchors
   * just after the previous read). Without: the snapshot's polledAt.
   */
  function readTime(st, meta, polledAt) {
    if (!meta) return polledAt;
    if (st.bootId !== meta.bootId) {
      const lastT = st.prev?.t ?? -Infinity;
      st.bootId = meta.bootId;
      st.anchorMono = meta.monoMs;
      st.anchorT = Math.max(meta.wallMs ?? polledAt, lastT + 1);
    }
    return st.anchorT + (meta.monoMs - st.anchorMono);
  }

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
    const polledAt = fin(snapshot.polledAt) ?? now();
    const seen = new Set();
    const llm = snapshot.llm.map((entry) => {
      if (!isObj(entry) || !Number.isInteger(entry.port)) return entry;
      const id = `${nodeId}:${entry.port}`;
      seen.add(id);
      const backend = typeof entry.backend === "string" ? entry.backend : null;
      if (!backend) {
        ports.delete(id);
        return { ...entry, normalized: null };
      }
      let st = ports.get(id);
      if (!st) {
        st = { w: new EngineWindows(opts.spansS), bootId: null, anchorMono: 0, anchorT: 0, prev: null };
        ports.set(id, st);
      }
      const counters = isObj(entry.engineCounters) ? entry.engineCounters : null;
      const meta = counters ? counterMetaOf(entry.engineCountersMeta) : null;
      const t = readTime(st, meta, polledAt);

      // Per-poll counter rates: the decode / prefill fallback for engines
      // without a decode or prefill stopwatch (EngineWindow prefers the
      // stopwatch formulas whenever both counters exist).
      const generated = fin(counters?.generated);
      const prefill = fin(counters?.prefillComputed);
      /** @type {{ decodeTps: number|null, prefillTps: number|null }} */
      const rates = { decodeTps: null, prefillTps: null };
      const p = st.prev;
      if (p && t > p.t) {
        const dt = (t - p.t) / 1000;
        if (generated != null && p.generated != null && generated >= p.generated) rates.decodeTps = (generated - p.generated) / dt;
        if (prefill != null && p.prefill != null && prefill >= p.prefill) rates.prefillTps = (prefill - p.prefill) / dt;
      }
      if (!p || t > p.t) st.prev = { t, generated, prefill };

      const kv = fin(entry.kvCacheUsage);
      const tier = levelTier(backend, meta?.source ?? null);
      st.w.add({
        t,
        key: `${backend}|${entry.modelId ?? ""}`,
        counters,
        counterSource: "counter",
        rates,
        rateSources: { decodeTps: "counter", prefillTps: "counter" },
        levels: {
          running: fin(entry.requestsRunning),
          waiting: fin(entry.requestsWaiting),
          kvPct: kv == null ? null : kv * 100,
        },
        // KV of vLLM / SGLang comes from their Prometheus page.
        levelSources: { running: tier, waiting: tier, kvPct: backend === "vllm" || backend === "sglang" ? "counter" : tier },
      });
      return { ...entry, normalized: st.w.records() };
    });
    // Ports this node no longer reports lose their windows.
    for (const id of ports.keys()) {
      if (id.startsWith(`${nodeId}:`) && !seen.has(id)) ports.delete(id);
    }
    return { ...snapshot, llm };
  }

  /** @param {string} nodeId */
  function forget(nodeId) {
    for (const id of ports.keys()) if (id.startsWith(`${nodeId}:`)) ports.delete(id);
  }

  return { annotate, forget, size: () => ports.size };
}
