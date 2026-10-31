/**
 * telemetry.js — aggregate all collectors into a NodeAgentSnapshot.
 *
 * Seam type: NodeAgentSnapshot (shared/types.ts), validated against
 * shared/api.schema.json.
 *
 * Ownership notes (Batch 1A scope):
 *  - `versions` is derived from live LLM probes (LlmMetrics) + ComfyUI probe:
 *    the actual running configuration, not recipes.
 *  - `services`, `memory`, `requests`, `topology` are owned by later batches
 *    (1B catalog) or the registry — reported null/[] here, which the seam
 *    contract allows ("null means not available").
 *  - Batch 1A working types that have no NodeAgentSnapshot field yet (LlmMetrics,
 *    ComfyMetrics, SystemdUnit) are attached as ADDITIONAL properties (`llm`,
 *    `comfy`, `systemd`) — permitted by api.schema.json (no
 *    additionalProperties restriction) so the dashboard can consume raw probe
 *    data; Batch 5B can formalize them in types.ts.
 *  - `tailscale` (TailscaleMetrics) is collected from the host's
 *    `tailscale status --json` + config files (hostname, IP, socket, conf/env).
 *    Additive property; null when the host has no tailscaled (degraded, not
 *    an error).
 */
import { collectGpu } from "./collectors/gpu.js";
import { collectCpu } from "./collectors/cpu.js";
import { collectMem } from "./collectors/mem.js";
import { collectDisk } from "./collectors/disk.js";
import { collectNet } from "./collectors/net.js";
import { collectProxy } from "./collectors/proxy.js";
import { collectLibrary } from "./collectors/library.js";
import { collectDocker } from "./collectors/docker.js";
import { collectSystemd } from "./collectors/systemd.js";
import { collectLlm } from "./collectors/llm.js";
import { collectComfy } from "./collectors/comfy.js";
import { collectTailscale } from "./collectors/tailscale.js";
import { loadRecipes } from "./catalog/recipes.js";
import { readTextFile, parseUptimeSeconds } from "./collectors/util.js";

/** Runtime recipes file (agent/config/recipes.json), same default as main.js. */
const DEFAULT_RECIPES_PATH = "agent/config/recipes.json";

export const AGENT_VERSION = "0.4.0";

/**
 * Derive quantization from a model id/path reference.
 * @param {string | null | undefined} s
 * @returns {string | null}
 */
export function detectQuantization(s) {
  if (!s) return null;
  const t = String(s).toLowerCase();
  if (t.includes("nvfp4")) return "nvfp4";
  if (t.includes("fp8")) return "fp8";
  if (t.includes("bf16")) return "bf16";
  if (t.includes("awq") || t.includes("gptq") || t.includes("int4") || t.includes("int8")) {
    return "other";
  }
  return null;
}

/**
 * Map live probe results to VersionInfo[] (seam type).
 * @param {Array<Record<string, any>>} llm LlmMetrics[]
 * @param {object | null} comfy ComfyMetrics | null
 * @param {number} nowMs
 * @returns {Array<object>}
 */
export function buildVersions(llm, comfy, nowMs) {
  const out = [];
  for (const l of Array.isArray(llm) ? llm : []) {
    if (!l || l.backend == null) continue;
    out.push({
      serviceName: `llm:${l.port}`,
      kind: "llm",
      engine: String(l.backend),
      engineVersion: l.version != null ? String(l.version) : null,
      modelId: l.modelId != null ? String(l.modelId) : null,
      modelPath: l.modelPath != null ? String(l.modelPath) : null,
      modelRevision: null,
      quantization: detectQuantization(l.modelPath || l.modelId),
      contextLength: l.contextLength,
      memFraction: l.gpuMemoryUtilization,
      tpSize: null,
      port: l.port,
      state: "running",
      polledAt: nowMs,
    });
  }
  if (comfy && typeof comfy === "object") {
    out.push({
      serviceName: `comfyui:${comfy.port}`,
      kind: "image",
      engine: "comfyui",
      engineVersion: comfy.version != null ? String(comfy.version) : null,
      modelId: null,
      modelPath: null,
      modelRevision: null,
      quantization: null,
      contextLength: null,
      memFraction: null,
      tpSize: null,
      port: comfy.port,
      state: "running",
      polledAt: nowMs,
    });
  }
  return out;
}

/**
 * Assemble a NodeAgentSnapshot from pre-collected pieces.
 * (Exported for tests; collectTelemetry is the production entry point.)
 * @param {object} parts
 * @returns {object} NodeAgentSnapshot
 */
export function assembleSnapshot({
  nodeId,
  nodeName,
  lanIp,
  agentVersion = AGENT_VERSION,
  nowMs = Date.now(),
  uptimeSeconds = null,
  gpu = null,
  cpu = null,
  mem = null,
  disk = [],
  net = [],
  containers = [],
  systemdUnits = [],
  llm = [],
  comfy = null,
  tailscale = null,
  proxy = null,
  library = null,
}) {
  return {
    nodeId,
    nodeName,
    lanIp,
    agentVersion,
    online: true,
    uptimeSeconds,
    gpu,
    cpu,
    mem,
    disk,
    net,
    containers,
    versions: buildVersions(llm, comfy, nowMs),
    services: [], // Batch 1B: agent/catalog/services.js
    memory: null, // Batch 1B: agent/catalog/memory.js
    requests: null, // Batch 1B: agent/catalog/services.js
    topology: null, // registry-owned (manual designation, E11)
    lanes: null, // S3.1: catalog join in main.js enrichSnapshot (deriveLanes)
    polledAt: nowMs,
    // Batch 1A extras (additive; schema permits additional properties):
    llm,
    comfy,
    proxy,
    library,
    systemd: systemdUnits,
    // Tailscale node info (hostname, IP, config); null when no tailscaled.
    tailscale,
  };
}

/**
 * Collect the full telemetry snapshot for this node.
 *
 * @param {string} nodeId
 * @param {string} nodeName
 * @param {string} lanIp
 * @param {number[] | string} ports LLM server ports to probe
 * @param {number | null} comfyPort ComfyUI port (null/0 = skip)
 * @param {{ now?: () => number, readFile?: (path: string) => Promise<string>, inject?: object, llmAuthTokens?: Record<string, string> }} [opts]
 *   `inject` maps collector names to override fns (test hook):
 *   gpu/cpu/mem/disk/net/docker/systemd/uptime → () => result; llm → (ports) => result; comfy → (port) => result.
 *   `llmAuthTokens` (Record<"port", token>) adds per-port bearer auth to the
 *   LLM probes for servers that gate their info endpoints behind an api-key.
 * @returns {Promise<object>} NodeAgentSnapshot
 */
export async function collectTelemetry(nodeId, nodeName, lanIp, ports = [], comfyPort = null, opts = {}) {
  const nowMs = opts.now ? opts.now() : Date.now();
  const inj = opts.inject || {};
  const readFile = opts.readFile || readTextFile;

  // SC6: pin claims for the library collector come from the node's recipe
  // store — the same file and the same validated loader the catalog seam
  // uses (main.js loadCatalog). Fail-soft exactly like the catalog: an
  // unreadable/invalid recipes file yields an empty pin set plus a
  // reported note, never a broken snapshot. opts.recipes overrides the
  // read (tests, and a caller that already loaded the catalog).
  let libraryRecipes = Array.isArray(opts.recipes) ? opts.recipes : null;
  let libraryPinNote = null;
  if (!libraryRecipes) {
    try {
      libraryRecipes = loadRecipes(opts.recipePath || DEFAULT_RECIPES_PATH).recipes;
    } catch (e) {
      libraryRecipes = [];
      libraryPinNote = `recipes unavailable: ${e.message} — library reports disk truth with no pins`;
    }
  }

  const [
    gpu,
    cpu,
    mem,
    disk,
    net,
    containers,
    systemdUnits,
    llm,
    comfy,
    tailscale,
    proxy,
    library,
  ] = await Promise.all([
    inj.gpu ? inj.gpu() : collectGpu(opts),
    inj.cpu ? inj.cpu() : collectCpu(opts),
    inj.mem ? inj.mem() : collectMem(opts),
    inj.disk ? inj.disk() : collectDisk(opts),
    inj.net ? inj.net() : collectNet(opts),
    inj.docker ? inj.docker() : collectDocker(opts),
    inj.systemd ? inj.systemd() : collectSystemd(opts),
    inj.llm ? inj.llm(ports) : collectLlm(ports, { authTokens: opts.llmAuthTokens }),
    inj.comfy ? inj.comfy(comfyPort) : collectComfy(comfyPort, opts),
    inj.tailscale ? inj.tailscale() : collectTailscale(opts),
    inj.proxy ? inj.proxy() : collectProxy(opts),
    inj.library ? inj.library() : collectLibrary({
      ...opts,
      recipes: libraryRecipes,
      ...(libraryPinNote ? { pinsNote: libraryPinNote } : {}),
    }),
  ]);

  let uptimeSeconds = null;
  if (inj.uptime) {
    uptimeSeconds = await inj.uptime();
  } else {
    try {
      uptimeSeconds = parseUptimeSeconds(await readFile("/proc/uptime"));
    } catch {
      /* unknown */
    }
  }

  // Rigorous primary/lan IP selection for the snapshot top-level field (used by UIs for
  // "Primary" display and sometimes to highlight the management adapter).
  // Prefer the 192.168 management IP on the wireless iface (common on these RoCE DGX Sparks).
  // Fall back to any 192.168, then a 10.x. This avoids the os.networkInterfaces() order lottery
  // that was putting a RoCE 10.200 on the primary/wl row.
  let effectiveLanIp = lanIp;
  if (Array.isArray(net) && net.length > 0) {
    const wl192 = net.find(n => n.ip && /^192\.168\./.test(n.ip) && (n.kind === "wireless" || /^wl/.test(n.iface || "")));
    if (wl192) {
      effectiveLanIp = wl192.ip;
    } else {
      const any192 = net.find(n => n.ip && /^192\.168\./.test(n.ip));
      if (any192) effectiveLanIp = any192.ip;
      else {
        const first10 = net.find(n => n.ip && /^10\./.test(n.ip));
        if (first10) effectiveLanIp = first10.ip;
      }
    }
  }

  return assembleSnapshot({
    nodeId,
    nodeName,
    lanIp: effectiveLanIp,
    nowMs,
    uptimeSeconds,
    gpu,
    cpu,
    mem,
    disk,
    net,
    containers,
    systemdUnits,
    llm,
    comfy,
    tailscale,
    proxy,
    library,
  });
}
