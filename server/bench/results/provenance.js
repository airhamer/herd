/**
 * Host + lane provenance for a Herd bench run, read from the live monitor
 * snapshot when the bench starts. Anything the snapshot does not report is
 * null — never guessed.
 */

/**
 * AEON-style hardware bucket ("Single DGX Spark", "2× DGX Spark",
 * "Single <GPU>"). Null when the GPU is unknown on a generic host.
 * @param {{ kind?: string, hardware?: any }} snap
 * @param {number} nodeCount  head + workers
 */
export function hwBucket(snap, nodeCount = 1) {
  const kind = snap?.kind || "spark";
  const label = kind === "spark" ? "DGX Spark" : snap?.hardware?.gpuChip || null;
  if (!label) return null;
  return nodeCount > 1 ? `${nodeCount}× ${label}` : `Single ${label}`;
}

/** "128GB unified" / "64GB" from the reported total memory. */
export function memClass(snap) {
  const gb = snap?.hardware?.totalMemoryGB;
  if (typeof gb !== "number" || !(gb > 0)) return null;
  const rounded = gb >= 16 ? Math.round(gb / 8) * 8 : Math.round(gb);
  return (snap?.kind || "spark") === "spark" ? `${rounded}GB unified` : `${rounded}GB`;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * @param {object} args
 * @param {any} args.snapshot      monitor.snapshot() of the benched node (may be null)
 * @param {any[]} [args.allSnapshots] every node's snapshot (to count cluster workers)
 * @param {string} args.nodeId
 * @param {number|null} [args.port]  LLM port under test
 * @param {number[]} [args.ports]    configured LLM ports of the node (index → llm metrics)
 * @param {boolean} [args.customHost] bench pointed at an explicit host instead of the node
 */
export function describeProvenance({ snapshot, allSnapshots = [], nodeId, port = null, ports = [], customHost = false }) {
  // A custom target host is some other machine: none of this node's
  // hardware applies to it.
  const snap = customHost ? {} : snapshot || {};
  const known = Boolean(snapshot) && !customHost;
  const workers = customHost ? 0 : allSnapshots.filter((s) => s && s.id !== nodeId && s.workerHeadId === nodeId).length;
  const llmList = Array.isArray(snap.metrics?.llm) ? snap.metrics.llm : [];
  const idx = port !== null ? ports.indexOf(port) : -1;
  const llm = customHost ? null : (idx >= 0 ? llmList[idx] : null) || (llmList.length === 1 ? llmList[0] : null);
  const gpu = snap.metrics?.gpu || null;
  const isSpark = (snap.kind || "spark") === "spark";

  return {
    host: {
      node_id: nodeId,
      node_name: str(snap.name),
      hw_bucket: known ? hwBucket(snap, 1 + workers) : null,
      gpu: str(snap.hardware?.gpuChip),
      gpu_count: isSpark && known ? 1 + workers : null,
      mem_class: memClass(snap),
      clock_cap_mhz: num(gpu?.throttle?.clockCapMHz),
      power_cap_w: num(gpu?.power?.limit),
    },
    lane: {
      engine: str(llm?.backend),
      engine_version: null,
      image_digest: null,
      model_id: str(llm?.modelId),
      weights_hash: null,
      quant: null,
      recipe_flags: null,
      spec_decode: null,
      kv_dtype: null,
      ctx_len: Number.isInteger(llm?.contextLength) && llm.contextLength > 0 ? llm.contextLength : null,
      parallel: workers > 0 ? { nodes: 1 + workers } : null,
    },
    client_location: customHost ? "network" : snap.isLocal ? "local" : known ? "network" : null,
  };
}
