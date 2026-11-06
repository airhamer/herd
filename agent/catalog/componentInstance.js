/**
 * Persist per-node component instance state (active variant, recording,
 * counter segments) without rewriting the catalog definition.
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_FILE = "component-instances.json";

export function emptyStore() {
  return { version: 1, instances: {} };
}

export function instanceKey(nodeId, componentId) {
  return `${nodeId}/${componentId}`;
}

export function loadInstanceStore(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object" || typeof raw.instances !== "object") return emptyStore();
    return { version: 1, instances: raw.instances };
  } catch {
    return emptyStore();
  }
}

export function saveInstanceStore(filePath, store) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
  fs.renameSync(tmp, filePath);
}

export function defaultInstancePath(configDir) {
  return path.join(configDir, DEFAULT_FILE);
}

export function readInstance(store, nodeId, componentId) {
  return store.instances[instanceKey(nodeId, componentId)] ?? null;
}

export function writeInstance(store, nodeId, componentId, rec) {
  const next = { version: 1, instances: { ...store.instances } };
  next.instances[instanceKey(nodeId, componentId)] = rec;
  return next;
}

export function nextVariantGeneration(prev, variantId) {
  const rec = prev && typeof prev === "object" ? prev : {};
  const gen = Number.isFinite(rec.variantGeneration) ? rec.variantGeneration : 0;
  if (rec.variantId === variantId) return gen;
  return gen + 1;
}
