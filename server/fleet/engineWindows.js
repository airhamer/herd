// ─── Fleet engine windows (STAT2 #35, STAT3 #36, STAT4 #37) ────────────────
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
//   agent 0.4     engineCounters for every engine with counters, plus
//                 engineCountersMeta { schema: 2, source, monoMs, wallMs, bootId }:
//                 reads are timed by the agent's monotonic clock, so a wall
//                 clock step on the node never bends a rate.
//   agent 0.5+    proxyCounters / proxyCountersMeta / proxyInFlight on ports
//                 the agent's opt-in usage relay forwards to (STAT4 #37):
//                 a second lane per port, source tier "proxy", merged per
//                 field under the engine counters (counters win).

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
 * Per field, the engine-counter value when it has one, else the relay's
 * (STAT4): counter sources take precedence over the proxy tier.
 * @param {Record<string, any>} engine normalized windows from engine counters
 * @param {Record<string, any> | null} proxy normalized windows from relay usage
 */
export function mergeProxyWindows(engine, proxy) {
  if (!proxy) return engine;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [span, rec] of Object.entries(engine)) {
    const pr = proxy[span];
    if (!pr) {
      out[span] = rec;
      continue;
    }
    /** @type {Record<string, any>} */
    const values = {};
    for (const [field, ev] of Object.entries(rec.values)) {
      const pv = pr.values?.[field];
      values[field] = ev?.value == null && pv?.value != null ? pv : ev;
    }
    out[span] = { ...rec, values };
  }
  return out;
}

/** One counter source of one port: its windows and its clock anchor. */
function newLane(spansS) {
  return {
    w: new EngineWindows(spansS),
    /** @type {string|null} */
    bootId: null,
    anchorMono: 0,
    anchorT: 0,
    /** @type {{ t: number, generated: number|null, prefill: number|null } | null} */
    prev: null,
  };
}

/**
 * Timeline ms of a read. With STAT3 meta: the agent's monotonic clock,
 * anchored once per agent boot to its wall clock (a new boot re-anchors just
 * after the previous read). Without: the snapshot's polledAt.
 * @param {ReturnType<typeof newLane>} lane
 * @param {ReturnType<typeof counterMetaOf>} meta
 * @param {number} polledAt
 */
function readTime(lane, meta, polledAt) {
  if (!meta) return polledAt;
  if (lane.bootId !== meta.bootId) {
    const lastT = lane.prev?.t ?? -Infinity;
    lane.bootId = meta.bootId;
    lane.anchorMono = meta.monoMs;
    lane.anchorT = Math.max(meta.wallMs ?? polledAt, lastT + 1);
  }
  return lane.anchorT + (meta.monoMs - lane.anchorMono);
}

/**
 * Add one read to a lane. Per-poll counter rates are the decode / prefill
 * fallback for sources without a decode or prefill stopwatch (EngineWindow
 * prefers the stopwatch formulas whenever both counters exist).
 * @param {ReturnType<typeof newLane>} lane
 * @param {{ t: number, key: string, counters: Record<string, any>|null, source: "counter"|"proxy",
 *   levels: Record<string, number|null>, levelSources: Record<string, string> }} read
 */
function feedLane(lane, { t, key, counters, source, levels, levelSources }) {
  const generated = fin(counters?.generated);
  const prefill = fin(counters?.prefillComputed);
  /** @type {{ decodeTps: number|null, prefillTps: number|null }} */
  const rates = { decodeTps: null, prefillTps: null };
  const p = lane.prev;
  if (p && t > p.t) {
    const dt = (t - p.t) / 1000;
    if (generated != null && p.generated != null && generated >= p.generated) rates.decodeTps = (generated - p.generated) / dt;
    if (prefill != null && p.prefill != null && prefill >= p.prefill) rates.prefillTps = (prefill - p.prefill) / dt;
  }
  if (!p || t > p.t) lane.prev = { t, generated, prefill };
  lane.w.add({
    t,
    key,
    counters,
    counterSource: source,
    rates,
    rateSources: { decodeTps: source, prefillTps: source },
    levels,
    levelSources,
  });
  return lane.w.records();
}

/**
 * @param {{ spansS?: readonly number[], now?: () => number }} [opts]
 */
export function createFleetEngineWindows(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  /**
   * `${nodeId}:${port}` → the engine-counter lane and, when the agent's
   * usage relay forwards to the port (STAT4), the proxy lane.
   * @type {Map<string, { engine: ReturnType<typeof newLane>, proxy: ReturnType<typeof newLane> | null }>}
   */
  const ports = new Map();

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
        st = { engine: newLane(opts.spansS), proxy: null };
        ports.set(id, st);
      }

      const counters = isObj(entry.engineCounters) ? entry.engineCounters : null;
      const meta = counters ? counterMetaOf(entry.engineCountersMeta) : null;
      const kv = fin(entry.kvCacheUsage);
      const tier = levelTier(backend, meta?.source ?? null);
      const engineRecs = feedLane(st.engine, {
        t: readTime(st.engine, meta, polledAt),
        key: `${backend}|${entry.modelId ?? ""}`,
        counters,
        source: "counter",
        levels: {
          running: fin(entry.requestsRunning),
          waiting: fin(entry.requestsWaiting),
          kvPct: kv == null ? null : kv * 100,
        },
        // KV of vLLM / SGLang comes from their Prometheus page.
        levelSources: { running: tier, waiting: tier, kvPct: backend === "vllm" || backend === "sglang" ? "counter" : tier },
      });

      // STAT4: usage the agent's relay metered for this port (agent 0.5+).
      const pc = isObj(entry.proxyCounters) ? entry.proxyCounters : null;
      const inFlight = fin(entry.proxyInFlight);
      let proxyRecs = null;
      if (pc || inFlight != null) {
        if (!st.proxy) st.proxy = newLane(opts.spansS);
        const pmeta = pc ? counterMetaOf(entry.proxyCountersMeta) : null;
        proxyRecs = feedLane(st.proxy, {
          t: readTime(st.proxy, pmeta, polledAt),
          // The relay sums every model it forwards: only the engine resets it.
          key: `proxy|${backend}`,
          counters: pc,
          source: "proxy",
          levels: { running: inFlight, waiting: null, kvPct: null },
          levelSources: { running: "proxy", waiting: "proxy", kvPct: "proxy" },
        });
      } else st.proxy = null;

      return { ...entry, normalized: mergeProxyWindows(engineRecs, proxyRecs) };
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
