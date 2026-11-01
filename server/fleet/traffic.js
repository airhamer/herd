// ─── SC5c (#74): per-node LLM traffic view ─────────────────────────────────
//
// The Traffic sub-tab shows, for each LLM lane (port) of one node:
//   requests, prompt / cached / generated tokens, tok/s over the 60 s and
//   300 s windows, TTFT, errors, and a token source badge
//   (engine / proxy / estimate);
// and a recent-requests table where the agent's opt-in usage relay (STAT4,
// agent/proxy/usageRelay.js, LLM_PROXY) meters per-request data.
//
// Nothing new is measured here. Lane numbers come from the snapshot the fleet
// poller already annotates (engine counters + `normalized` windows,
// server/fleet/engineWindows.js). The recent rows come from the relay's
// `llmProxy[].recent`, which the agent keeps short (20 per relay). This module
// accumulates them per node across polls.
//
// Decisions (#74):
//   1. The proxy stays opt-in. With no relay the view says proxyEnabled:false
//      and the UI shows a "proxy off" hint. Engine stats still show.
//   2. Rows are metadata only (time, client, path, model, status, tokens,
//      latency). Fields are copied by allow-list, so prompt or response text
//      never lands here even if an agent sent it.
//   3. Retention is the last 200 rows per node, in memory, not persisted.

export const TRAFFIC_RECENT_MAX = 200;

/** @param {unknown} v */
function fin(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
/** @param {unknown} v */
function isObj(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}
const str = (v) => (typeof v === "string" ? v : null);

/**
 * One relay row reduced to its metadata (decision 2).
 * @param {Record<string, any>} r
 * @param {{ listenPort: number|null, upstreamPort: number|null }} relay
 */
export function requestRow(r, relay) {
  return {
    wallMs: fin(r.wallMs) ?? 0,
    listenPort: relay.listenPort,
    upstreamPort: relay.upstreamPort,
    client: str(r.client) ?? "unknown",
    path: str(r.path),
    model: str(r.model),
    status: fin(r.status) ?? 0,
    aborted: r.aborted === true,
    stream: r.stream === true,
    promptTokens: fin(r.promptTokens),
    completionTokens: fin(r.completionTokens),
    cachedTokens: fin(r.cachedTokens),
    completionEstimated: r.completionEstimated === true,
    ttftS: fin(r.ttftS),
    decodeS: fin(r.decodeS),
    e2eS: fin(r.e2eS),
  };
}

const rowKey = (r) => `${r.listenPort}|${r.wallMs}|${r.client}|${r.path}|${r.status}|${r.e2eS}`;

/** Per-node ring of recent relay requests (decision 3). */
export function createTrafficLog({ max = TRAFFIC_RECENT_MAX } = {}) {
  /** @type {Map<string, { rows: ReturnType<typeof requestRow>[], keys: Set<string> }>} */
  const nodes = new Map();

  return {
    /**
     * Merge one polled snapshot's relay rows. Rows already seen are skipped,
     * so polling faster than the agent's 20-row window rolls loses nothing
     * and duplicates nothing.
     * @param {string} nodeId
     * @param {Record<string, any> | null | undefined} snapshot
     */
    ingest(nodeId, snapshot) {
      const relays = Array.isArray(snapshot?.llmProxy) ? snapshot.llmProxy : [];
      if (relays.length === 0) return 0;
      let n = nodes.get(nodeId);
      if (!n) {
        n = { rows: [], keys: new Set() };
        nodes.set(nodeId, n);
      }
      let added = 0;
      for (const relay of relays) {
        if (!isObj(relay) || !Array.isArray(relay.recent)) continue;
        const ids = { listenPort: fin(relay.listenPort), upstreamPort: fin(relay.upstreamPort) };
        for (const raw of relay.recent) {
          if (!isObj(raw)) continue;
          const row = requestRow(raw, ids);
          const k = rowKey(row);
          if (n.keys.has(k)) continue;
          n.keys.add(k);
          n.rows.push(row);
          added += 1;
        }
      }
      if (added > 0) {
        n.rows.sort((a, b) => a.wallMs - b.wallMs);
        while (n.rows.length > max) n.keys.delete(rowKey(/** @type {any} */ (n.rows.shift())));
      }
      return added;
    },
    /** Newest first. @param {string} nodeId */
    recent(nodeId) {
      const n = nodes.get(nodeId);
      return n ? [...n.rows].reverse() : [];
    },
    /** @param {string} nodeId */
    forget(nodeId) {
      nodes.delete(nodeId);
    },
    size: (nodeId) => nodes.get(nodeId)?.rows.length ?? 0,
  };
}

/**
 * One normalized value reduced to { value, source }.
 * @param {Record<string, any> | null | undefined} rec
 * @param {string} field
 */
function nv(rec, field) {
  const v = rec?.values?.[field];
  if (!isObj(v)) return { value: null, source: null };
  return { value: fin(v.value), source: str(v.source) };
}

/** @param {Record<string, any> | null | undefined} rec */
function windowOf(rec) {
  return {
    coveredS: fin(rec?.coveredS),
    decodeTps: nv(rec, "decode_tps"),
    prefillTps: nv(rec, "prefill_tps"),
    throughputTps: nv(rec, "throughput_tps"),
    ttftS: nv(rec, "ttft_s"),
  };
}

const hasAny = (c, keys) => isObj(c) && keys.some((k) => fin(c[k]) != null);
const TOKEN_KEYS = ["generated", "prompt", "cached"];

/**
 * The Traffic view of one node snapshot.
 * @param {Record<string, any> | null | undefined} snapshot
 * @param {ReturnType<typeof requestRow>[]} recent newest first
 */
export function buildTrafficView(snapshot, recent = []) {
  const llm = Array.isArray(snapshot?.llm) ? snapshot.llm : [];
  const relays = (Array.isArray(snapshot?.llmProxy) ? snapshot.llmProxy : []).filter(isObj);
  const relayByUpstream = new Map(relays.map((r) => [fin(r.upstreamPort), r]));

  const lanes = llm
    .filter((e) => isObj(e) && Number.isInteger(e.port))
    .map((e) => {
      const relay = relayByUpstream.get(e.port) ?? null;
      const eng = isObj(e.engineCounters) ? e.engineCounters : null;
      const prx = isObj(e.proxyCounters) ? e.proxyCounters : isObj(relay?.counters) ? relay.counters : null;
      const engineTokens = hasAny(eng, TOKEN_KEYS);
      const proxyTokens = hasAny(prx, TOKEN_KEYS);
      /** Token source badge: engine counters win; relay numbers are "estimate" when it had to count content events. */
      const tokenSource = engineTokens
        ? "engine"
        : proxyTokens
          ? fin(relay?.estimatedRequests) > 0
            ? "estimate"
            : "proxy"
          : null;
      const tok = engineTokens ? eng : proxyTokens ? prx : null;
      const pick = (k) => (tok ? fin(tok[k]) : null);
      const requests = fin(eng?.requestsFinished) ?? (relay ? fin(relay.requests) : null) ?? fin(prx?.requestsFinished);
      const norm = isObj(e.normalized) ? e.normalized : null;
      return {
        port: e.port,
        backend: str(e.backend),
        modelId: str(e.modelId),
        proxied: relay != null,
        listenPort: relay ? fin(relay.listenPort) : null,
        tokenSource,
        requests,
        requestsSource: fin(eng?.requestsFinished) != null ? "engine" : requests != null ? "proxy" : null,
        errors: relay ? fin(relay.errors) : null,
        inFlight: relay ? fin(relay.inFlight) : fin(e.requestsRunning),
        promptTokens: pick("prompt"),
        cachedTokens: pick("cached"),
        generatedTokens: pick("generated"),
        windows: { 60: windowOf(norm?.["60"]), 300: windowOf(norm?.["300"]) },
      };
    });

  return {
    nodeId: str(snapshot?.nodeId),
    polledAt: fin(snapshot?.polledAt),
    proxyEnabled: relays.length > 0,
    relays: relays.map((r) => ({
      listenPort: fin(r.listenPort),
      upstreamPort: fin(r.upstreamPort),
      requests: fin(r.requests) ?? 0,
      errors: fin(r.errors) ?? 0,
      inFlight: fin(r.inFlight) ?? 0,
      clients: Array.isArray(r.clients) ? r.clients.length : 0,
    })),
    lanes,
    recent,
    recentMax: TRAFFIC_RECENT_MAX,
  };
}

/**
 * GET /api/fleet/nodes/:id/traffic → buildTrafficView. 404 for a node not in
 * the registry. A registered node with no snapshot yet reads an empty view.
 * @param {import("express").Express} app
 * @param {{ getNode: (id: string) => unknown, getSnapshot: (id: string) => any, log: ReturnType<typeof createTrafficLog> }} deps
 */
export function registerTrafficRoutes(app, { getNode, getSnapshot, log }) {
  app.get("/api/fleet/nodes/:id/traffic", (req, res) => {
    const id = req.params.id;
    if (!getNode(id)) return res.status(404).json({ error: "Node not found" });
    const snap = getSnapshot(id) ?? null;
    if (snap) log.ingest(id, snap);
    res.json(buildTrafficView(snap ?? { nodeId: id }, log.recent(id)));
  });
}
