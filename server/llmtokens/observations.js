// FLEET3 (#38): turn live fleet snapshots into ledger observations.
//
// SSH Sparks: LlmProbe's cumulative totalOutputTokens / totalPromptTokens /
// totalCachedTokens per configured port (STAT1). Agent nodes: STAT3
// engineCounters; where the engine has no counter for a field, the STAT4
// relay's proxyCounters fill in (counters win, per field). An agent node on a
// Spark's LAN IP that reports the same port is the same engine and is skipped.

const finite = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

function sparkObservations(snapshot, claimed) {
  const out = [];
  if (!snapshot || snapshot.online === false) return out;
  const entries = snapshot.metrics?.llm;
  const ports = snapshot.llmPorts;
  if (!Array.isArray(entries) || !Array.isArray(ports)) return out;
  ports.forEach((port, i) => {
    const e = entries[i];
    if (!e || e.available !== true || !Number.isInteger(port)) return;
    const epoch = `engine:${e.backend ?? "?"}`;
    const field = (value, key) =>
      finite(value) ? { value, epoch, source: e.valueSources?.[key]?.source ?? "counter" } : null;
    const fields = {
      generated: field(e.totalOutputTokens, "totalOutputTokens"),
      prompt: field(e.totalPromptTokens, "totalPromptTokens"),
      cached: field(e.totalCachedTokens, "totalCachedTokens"),
    };
    if (!fields.generated && !fields.prompt) return;
    if (snapshot.lanIp) claimed.add(`${snapshot.lanIp}:${port}`);
    out.push({
      seriesId: `${snapshot.id}:${port}`,
      nodeId: snapshot.id,
      nodeName: snapshot.name ?? null,
      port,
      backend: e.backend ?? null,
      model: e.modelId ?? null,
      fields,
    });
  });
  return out;
}

const COUNTER_FIELDS = { generated: "generated", prompt: "prompt", cached: "cached" };

function nodeObservations(node, claimed) {
  const out = [];
  if (!node || node.online === false || !Array.isArray(node.llm)) return out;
  const ips = [node.registryLanIp, node.lanIp].filter(Boolean);
  for (const e of node.llm) {
    if (!e || !Number.isInteger(e.port)) continue;
    if (ips.some((ip) => claimed.has(`${ip}:${e.port}`))) continue;
    const engine = e.engineCounters ?? null;
    const proxy = e.proxyCounters ?? null;
    const proxyEpoch = `proxy:${e.proxyCountersMeta?.bootId ?? "?"}`;
    const fields = {};
    for (const [name, key] of Object.entries(COUNTER_FIELDS)) {
      if (finite(engine?.[key])) fields[name] = { value: engine[key], epoch: `engine:${e.backend ?? "?"}`, source: "counter" };
      else if (finite(proxy?.[key])) fields[name] = { value: proxy[key], epoch: proxyEpoch, source: "proxy" };
      else fields[name] = null;
    }
    if (!fields.generated && !fields.prompt) continue;
    out.push({
      seriesId: `${node.nodeId}:${e.port}`,
      nodeId: node.nodeId,
      nodeName: node.nodeName ?? null,
      port: e.port,
      backend: e.backend ?? null,
      model: e.modelId ?? null,
      fields,
    });
  }
  return out;
}

/**
 * @param {{ sparks?: object[], nodes?: object[] }} input
 *   sparks: SparkMonitor snapshots; nodes: fleet node snapshots keyed on the
 *   registry id (`nodeId`) with `registryLanIp`.
 */
export function collectTokenObservations({ sparks = [], nodes = [] } = {}) {
  const claimed = new Set();
  const out = [];
  for (const s of sparks) out.push(...sparkObservations(s, claimed));
  for (const n of nodes) out.push(...nodeObservations(n, claimed));
  return out;
}
