/**
 * componentCatalog.js — dashboard-server reader for the POC1 component
 * definition catalog (agent/catalog/components/*.json, issue #5) joined with
 * live per-node state (issue #7 seam for the Components tab).
 *
 * A component definition file is a host-independent definition (what to
 * serve, pinned to the commit); see agent/catalog/components/README.md for
 * the copy-on-TP-or-machine-change rule. This module only PROJECTS those
 * files to the CatalogComponent shape the dashboard consumes — it never
 * validates or mutates them; the catalog files remain the source of truth.
 *
 * Live join: a node's NodeAgentSnapshot carries `versions` (VersionInfo[]).
 * A component is observed on a node when a version entry matches the
 * component's engine + served model name. Missing live data degrades to
 * state "unknown" — the list still renders.
 *
 * Style mirrors server/fleet/registry.js: plain ESM, dependency-free fs.
 */
import fs from "node:fs";
import path from "node:path";

const CATALOG_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "agent",
  "catalog",
  "components"
);

/**
 * One catalog component projected for the dashboard (POC shape). Field names
 * mirror shared/types.ts vocabulary (ComponentActionRequest.componentId
 * refers to `id`).
 *
 * @typedef {object} CatalogComponent
 * @property {string} id component definition id (file name, action componentId)
 * @property {string} name human name
 * @property {string} purpose e.g. "code"
 * @property {string} kind llm / image / … (catalog kind)
 * @property {number} tp tensor-parallel size of the definition
 * @property {string} machineClass definition scope (copy-on-machine-change)
 * @property {string} engine sglang / vllm / …
 * @property {string|null} image docker image reference (pinned)
 * @property {string|null} servedModelName model id as served
 * @property {number|null} memoryPerSparkMB memory_estimate_mb.perSpark
 * @property {string} description definition description
 * @property {string[]} nodes node ids where this component is currently observed
 */

/**
 * Load all component definitions from the catalog directory.
 * Unreadable/malformed files are skipped with a warning (the tab must still
 * serve the healthy half of the catalog).
 *
 * @param {string} [dir] catalog directory override (tests)
 * @returns {{components: object[], warnings: string[]}}
 */
export function loadComponentCatalog(dir = CATALOG_DIR) {
  const components = [];
  const warnings = [];
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (err) {
    return { components, warnings: [`component catalog unreadable: ${err.message}`] };
  }
  for (const file of entries.sort()) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch (err) {
      warnings.push(`${file}: skipped (${err.message})`);
      continue;
    }
    if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string") {
      warnings.push(`${file}: skipped (missing id/name)`);
      continue;
    }
    components.push({
      id: raw.id,
      name: raw.name,
      purpose: typeof raw.purpose === "string" ? raw.purpose : "other",
      kind: typeof raw.kind === "string" ? raw.kind : "other",
      tp: Number.isFinite(raw.tp) ? raw.tp : 1,

      machineClass: typeof raw.machineClass === "string" ? raw.machineClass : null,
      engine: typeof raw.engine === "string" ? raw.engine : null,
      image: typeof raw.image === "string" ? raw.image : null,
      servedModelName: raw.model && typeof raw.model.servedModelName === "string" ? raw.model.servedModelName : null,
      memoryPerSparkMB:
        raw.memory_estimate_mb && Number.isFinite(raw.memory_estimate_mb.perSpark)

          ? raw.memory_estimate_mb.perSpark
          : null,
      description: typeof raw.description === "string" ? raw.description : "",
      nodes: [], // filled by joinComponentState
    });
  }
  return { components, warnings };
}

/**
 * Join catalog entries with live node snapshots: for each component, list
 * the node ids where a matching version entry is observed, with the live
 * state word. Mutates and returns `components` (order preserved).
 *
 * @param {object[]} components CatalogComponent[] from loadComponentCatalog
 * @param {object[]} nodeSnaps NodeAgentSnapshot[] from the fleet connection
 * @returns {object[]} the same components array
 */
export function joinComponentState(components, nodeSnaps = []) {
  for (const comp of components) {
    comp.nodes = [];
    for (const snap of nodeSnaps) {
      const versions = Array.isArray(snap?.versions) ? snap.versions : [];
      const match = versions.find(
        (v) =>
          v &&
          (comp.servedModelName ? v.modelId === comp.servedModelName : false) &&
          (!comp.engine || v.engine === comp.engine)
      );
      if (match) {
        comp.nodes.push({ nodeId: snap.nodeId, nodeName: snap.nodeName || snap.nodeId, state: match.state });
      }
    }
  }
  return components;
}
