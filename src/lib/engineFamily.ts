/**
 * Engine-family labeling for raw containers (CONT1, issue #96).
 *
 * The Containers rows across the fleet card and the node detail page show
 * raw docker names (`qwen38-flash`, `sparkdash-node-…`) which say nothing
 * about what engine a container runs. Owner decision: label by engine
 * FAMILY (sglang / vllm / …), with a distinguisher when several containers
 * share a family on one node; the real container name stays visible as the
 * tooltip.
 *
 * Family is derived from the image reference — the same image vocabulary
 * the catalog and recipes use (shared/types.ts engine vocabulary:
 * sglang / vllm / comfyui / …; the component catalog pins
 * `lmsysorg/sglang…` and `vllm/vllm-openai…` images). This file is the ONE
 * image→family table: FleetCard and NodeDetail both consume
 * `containerLabels`, never their own matching. The label is the family id
 * itself (`sglang`, `vllm`) per the owner decision on issue #96 — the same
 * lowercase vocabulary services[].engine and component defs carry, NOT the
 * prettized display names of src/lib/llmBackend.ts.
 */
import type { ContainerInfo, ServiceInstance } from "../../shared/types";

/**
 * Ordered image-reference → family rules, first match wins. Patterns test
 * against the lowercased full image reference (repo + tag), matching the
 * substring style of agent/collectors/library.js INFERENCE_ENGINE_MATCHES.
 */
const FAMILY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sglang/, "sglang"],
  [/\bvllm\b|vllm-openai/, "vllm"],
  [/comfy/, "comfyui"],
  [/llama[.\-_]?cpp/, "llama.cpp"],
  [/ollama/, "ollama"],
  [/lightllm/, "lightllm"],
  [/tabbyapi/, "tabbyapi"],
];

/** Repo basename with registry host, path, tag and digest stripped. */
export function imageBasename(image: string): string {
  let s = String(image ?? "").trim();
  // Drop digest, then tag (a tag never contains "/", a registry host does:
  // strip the tag before splitting on path).
  s = s.split("@")[0] ?? s;
  const slashParts = s.split("/");
  const last = slashParts[slashParts.length - 1] ?? s;
  // Only strip ":tag" from the last path element — a registry host carries
  // a port colon (registry.local:5000/foo) but sits in an earlier element.
  return (last.split(":")[0] ?? "").toLowerCase() || "container";
}

/**
 * Engine family of a container image: known engines per FAMILY_PATTERNS,
 * anything else falls back to the image basename (e.g. qdrant/qdrant:1.11
 * → "qdrant"). Never throws; null/empty image → "container".
 */
export function engineFamilyFromImage(image: string | null | undefined): string {
  const s = String(image ?? "").toLowerCase();
  if (!s.trim()) return "container";
  for (const [re, family] of FAMILY_PATTERNS) {
    if (re.test(s)) return family;
  }
  return imageBasename(s);
}

/** One container annotated for display. */
export interface ContainerLabel {
  /** Real docker container name (tooltip material). */
  name: string;
  /** Engine family id (sglang / vllm / basename…). */
  family: string;
  /** Display label: family, or family + distinguisher on a family collision. */
  label: string;
  /** Container status, passed through for the row. */
  status: ContainerInfo["status"];
}

/** Host-side port of a docker port mapping ("8084:11235" → 8084); null when unparsable. */
function hostPort(mapping: string | undefined): number | null {
  if (!mapping) return null;
  const first = mapping.trim().split(":")[0] ?? "";
  // "ip:host:container" form: the leading element is an address, not a port.
  if (/^\d+\.\d+/.test(first)) return null;
  const n = parseInt(first, 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

/**
 * Label every container of one node by engine family. A family used by a
 * single container on the node renders as the bare family; when several
 * containers share a family each gets a distinguisher suffix — the served
 * model of the service on the container's host port (SRV1 services[] row),
 * else that port (`:8080`), else the container name.
 *
 * Pure; order follows the input array.
 */
export function containerLabels(
  containers: readonly ContainerInfo[],
  services: readonly ServiceInstance[] = [],
): ContainerLabel[] {
  const families = containers.map((c) => engineFamilyFromImage(c.image));
  const counts = new Map<string, number>();
  for (const f of families) counts.set(f, (counts.get(f) ?? 0) + 1);

  return containers.map((c, i) => {
    const family = families[i] as string;
    if ((counts.get(family) ?? 1) <= 1) {
      return { name: c.name, family, label: family, status: c.status };
    }
    const port = c.ports.map(hostPort).find((p): p is number => p != null) ?? null;
    const svc = port != null ? services.find((s) => s.port === port) : undefined;
    const suffix = svc?.modelId ?? svc?.name ?? (port != null ? `:${port}` : c.name);
    return { name: c.name, family, label: `${family} ${suffix}`, status: c.status };
  });
}
