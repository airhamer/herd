/**
 * Load host-independent catalog definitions from agent/catalog/components.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeComponent } from "../../shared/runtimeProfile.js";

export const DEFAULT_CATALOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "components");

export function loadDefinitions(dir = DEFAULT_CATALOG_DIR) {
  const definitions = [];
  const warnings = [];
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (err) {
    return { definitions, warnings: [`catalog unreadable: ${err.message}`] };
  }
  for (const file of files.sort()) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const norm = normalizeComponent(raw);
      if (!norm.ok) {
        warnings.push(`${file}: ${norm.issues.join("; ")}`);
        continue;
      }
      definitions.push({ raw, ...norm.component });
    } catch (err) {
      warnings.push(`${file}: ${err.message}`);
    }
  }
  return { definitions, warnings };
}

export function getDefinition(definitions, componentId) {
  return definitions.find((d) => d.id === componentId) ?? null;
}
