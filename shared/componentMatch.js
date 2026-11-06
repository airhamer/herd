/**
 * Match a live service / version row to a catalog component.
 *
 * Shared by the dashboard server (componentCatalog.js) and the UI
 * (ServiceManagerPage) so grouping and status stay on one set of rules.
 *
 * A live engine is NOT identified by the recipe's placeholder port. Hasso
 * catalog files record ports.engine = 30000 as a host placeholder; the
 * 1c2c box serves on 8080 behind a keepalive proxy on 8081, and the
 * served model id may be an alias (flash-nvda) rather than the catalog's
 * servedModelName (qwen3.8-flash-next). Matching by placeholder port
 * alone would also pin every sglang lane to the same live process.
 *
 * Order of pins (first catalog entry that scores highest wins):
 *   4  live model id equals servedModelName (normalized)
 *   3  live model id equals an explicit alias
 *   2  live service / container name equals an explicit alias
 *   1  engine port equals a non-placeholder catalog port
 * Engine family must match in every case.
 */

export function normalizeModelId(id) {
  if (typeof id !== "string") return "";
  let s = id.trim().toLowerCase();
  if (!s) return "";
  const slash = s.lastIndexOf("/");
  if (slash >= 0 && slash < s.length - 1) s = s.slice(slash + 1);
  s = s.replace(/_/g, "-");
  s = s.replace(/\.service$/i, "");
  return s;
}

function uniq(xs) {
  const out = [];
  const seen = new Set();
  for (const x of xs) {
    const n = normalizeModelId(x);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** Model ids this component answers to, including servedModelName. */
export function modelAliasesOf(component) {
  if (!component || typeof component !== "object") return [];
  const extra = Array.isArray(component.modelAliases) ? component.modelAliases : [];
  return uniq([component.servedModelName, ...extra]);
}

/** Service / container names this component answers to. */
export function nameAliasesOf(component) {
  if (!component || typeof component !== "object") return [];
  const extra = Array.isArray(component.nameAliases) ? component.nameAliases : [];
  return uniq(extra);
}

export function isPlaceholderPort(component) {
  if (!component || typeof component !== "object") return true;
  if (component.portPlaceholder === true) return true;
  if (component.portPlaceholder === false) return false;
  // Untagged ports.engine values from Hasso recipes are host placeholders
  // (documented as such on the two gx10 definitions). Do not use them as
  // the only pin.
  return true;
}

function engineOf(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function scoreMatch(component, service) {
  const want = engineOf(component?.engine);
  const have = engineOf(service?.engine);
  if (!want || !have || want !== have) return 0;

  const liveModel = normalizeModelId(service?.modelId);
  const models = modelAliasesOf(component);
  if (liveModel && models.length) {
    const served = normalizeModelId(component.servedModelName);
    if (served && liveModel === served) return 4;
    if (models.includes(liveModel)) return 3;
  }

  const liveName = normalizeModelId(service?.name || service?.serviceName || service?.containerName);
  if (liveName && nameAliasesOf(component).includes(liveName)) return 2;

  const port = Number(service?.port);
  const catalogPort = Number(component?.port);
  if (
    Number.isFinite(port) &&
    Number.isFinite(catalogPort) &&
    port === catalogPort &&
    !isPlaceholderPort(component)
  ) {
    return 1;
  }
  return 0;
}

/**
 * Map one configured / observed service to its owning catalog component.
 * @param {object[]} components
 * @param {{engine?: string|null, port?: number|null, modelId?: string|null, name?: string|null, serviceName?: string|null, containerName?: string|null}} service
 * @returns {object|null}
 */
export function matchServiceToComponent(components, service) {
  if (!Array.isArray(components) || !service || typeof service !== "object") return null;
  let best = null;
  let bestScore = 0;
  for (const c of components) {
    const score = scoreMatch(c, service);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

export default {
  normalizeModelId,
  modelAliasesOf,
  nameAliasesOf,
  isPlaceholderPort,
  matchServiceToComponent,
};
