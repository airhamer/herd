/**
 * Decode benchmarks against agent-node LLM lanes (BENCH3).
 *
 * An agent node reports its serving lanes (`snapshot.lanes`, derived from
 * recipes + live containers) and its live LLM services
 * (`snapshot.versions`, kind "llm"). The dashboard benches a lane over the
 * LAN at `<node lanIp>:<lane port>`. Only ports the node itself reports are
 * accepted, so a request cannot point the bench anywhere else.
 *
 * Pure helpers: no network, no registry access.
 */

const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * LLM endpoints a node reports, one per port: running lanes first, then live
 * LLM services that are not lanes.
 * @param {any} snapshot  NodeAgentSnapshot (may be null)
 * @returns {{ port: number, modelId: string | null, engine: string | null, engineVersion: string | null,
 *   quantization: string | null, contextLength: number | null, lane: string | null, pool: string | null }[]}
 */
export function nodeLlmEndpoints(snapshot) {
  /** @type {Map<number, any>} */
  const byPort = new Map();
  const versions = (Array.isArray(snapshot?.versions) ? snapshot.versions : []).filter(
    (v) => v && v.kind === "llm" && validPort(v.port) && v.state !== "stopped"
  );
  const versionAt = (port) => versions.find((v) => v.port === port) || null;

  for (const pool of Array.isArray(snapshot?.lanes?.pools) ? snapshot.lanes.pools : []) {
    for (const lane of Array.isArray(pool?.lanes) ? pool.lanes : []) {
      if (!lane?.running || !validPort(lane.port) || byPort.has(lane.port)) continue;
      const v = versionAt(lane.port);
      byPort.set(lane.port, {
        port: lane.port,
        modelId: str(v?.modelId) ?? str(lane.modelId),
        engine: str(v?.engine),
        engineVersion: str(v?.engineVersion),
        quantization: str(v?.quantization),
        contextLength: Number.isInteger(v?.contextLength) && v.contextLength > 0 ? v.contextLength : null,
        lane: str(lane.recipe),
        pool: str(pool.id),
      });
    }
  }
  for (const v of versions) {
    if (byPort.has(v.port)) continue;
    byPort.set(v.port, {
      port: v.port,
      modelId: str(v.modelId),
      engine: str(v.engine),
      engineVersion: str(v.engineVersion),
      quantization: str(v.quantization),
      contextLength: Number.isInteger(v.contextLength) && v.contextLength > 0 ? v.contextLength : null,
      lane: null,
      pool: null,
    });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

function httpError(status, message) {
  const err = new Error(message);
  /** @type {any} */ (err).status = status;
  return err;
}

/**
 * Pick the lane to bench. `body.port` must be one the node reports; without
 * it the node must report exactly one endpoint.
 * @param {{ id: string, lanIp?: string }} rec  registry record
 * @param {any} snapshot
 * @param {{ port?: unknown }} body
 */
export function resolveNodeBenchTarget(rec, snapshot, body) {
  const host = str(rec?.lanIp);
  if (!host) throw httpError(400, "Node has no LAN IP");
  if (!snapshot) throw httpError(409, "Node has not reported telemetry yet");
  const endpoints = nodeLlmEndpoints(snapshot);
  if (endpoints.length === 0) throw httpError(400, "Node reports no running LLM lane");
  let endpoint;
  if (body?.port != null && body.port !== "") {
    const port = Number(body.port);
    endpoint = endpoints.find((e) => e.port === port);
    if (!endpoint) throw httpError(400, `Port ${body.port} is not a running LLM lane on this node`);
  } else if (endpoints.length === 1) {
    endpoint = endpoints[0];
  } else {
    throw httpError(400, "Node runs several LLM lanes; pass port");
  }
  return { host, ...endpoint };
}

/**
 * Bench-results provenance for a node lane (same shape as
 * describeProvenance). Unknown fields stay null.
 * @param {{ id: string, name?: string, isLocal?: boolean }} rec
 * @param {any} snapshot
 * @param {ReturnType<typeof resolveNodeBenchTarget>} target
 */
export function describeNodeProvenance(rec, snapshot, target) {
  // Agent telemetry carries no GPU model name, so the hardware bucket stays
  // unknown rather than guessed.
  return {
    host: {
      node_id: rec.id,
      node_name: str(snapshot?.nodeName) ?? str(rec.name),
      hw_bucket: null,
      gpu: null,
      gpu_count: null,
      mem_class: null,
      clock_cap_mhz: null,
      power_cap_w: null,
    },
    lane: {
      engine: target.engine,
      engine_version: target.engineVersion,
      image_digest: null,
      model_id: target.modelId,
      weights_hash: null,
      quant: target.quantization,
      recipe_flags: null,
      spec_decode: null,
      kv_dtype: null,
      ctx_len: target.contextLength,
      parallel: null,
    },
    client_location: rec.isLocal ? "local" : "network",
  };
}

/** Decode-bench manager key for a node (kept apart from Spark ids). */
export function nodeBenchKey(nodeId) {
  return `node:${nodeId}`;
}
