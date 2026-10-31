/**
 * Reference-numbers registry (BENCH5, #45).
 *
 * `registry.json` holds published figures that Herd did NOT measure: each
 * with the URL it was read from and the named definition it was published
 * under. The loader validates the file and turns every figure into a
 * bench results store record with `run.origin = "reference"` and
 * `source = "reference"` on every metric row, so the store's own schema
 * keeps it apart from Herd results (BENCH1): a reference row can never be
 * saved as `origin: herd`, carries no node, and its definitions are owned
 * by the publisher, never by Herd.
 *
 * Only numbers, dates and short setup facts are kept; no text is copied
 * from the sources (see NOTICE.md).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeResult, validateResult } from "../results/schema.js";
import { getDefinition } from "../results/definitions.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REGISTRY_FORMAT = "herd.bench-references";
export const REGISTRY_VERSION = 1;
export const DEFAULT_REGISTRY_PATH = path.join(HERE, "registry.json");
/** Every store id written by the registry starts with this; nothing else may. */
export const REGISTRY_ID_PREFIX = "reference:registry:";
export const REGISTRY_BENCH = "Reference";

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_FIELDS = new Set([
  "id",
  "source",
  "title",
  "url",
  "section",
  "see_also",
  "file",
  "measured_on",
  "suite",
  "suite_version",
  "host",
  "lane",
  "conditions",
  "settings",
  "figures",
]);
const FIGURE_FIELDS = new Set(["key", "suite", "suite_version", "conditions", "settings", "metrics"]);
const FIGURE_METRIC_FIELDS = new Set(["metric", "value", "definition", "n"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isUrl = (v) => isStr(v) && /^https:\/\/\S+$/.test(v);
const isDate = (v) => isStr(v) && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** Store id of one figure. */
export function referenceRecordId(entryId, figureKey) {
  return `${REGISTRY_ID_PREFIX}${entryId}:${figureKey}`;
}

/** True for ids the registry owns (user POSTs may not use them). */
export function isRegistryId(id) {
  return typeof id === "string" && id.startsWith(REGISTRY_ID_PREFIX);
}

/**
 * Read the registry file.
 * @param {string} [file]
 */
export function readRegistry(file = DEFAULT_REGISTRY_PATH) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Structural checks of a registry document (records are checked separately
 * against the store schema by `registryRecords`).
 * @param {any} doc
 * @returns {string[]} errors
 */
export function validateRegistry(doc) {
  const errors = [];
  if (!isObj(doc)) return ["registry must be an object"];
  if (doc.format !== REGISTRY_FORMAT) errors.push(`format must be "${REGISTRY_FORMAT}"`);
  if (doc.registry_version !== REGISTRY_VERSION) errors.push(`registry_version must be ${REGISTRY_VERSION}`);
  if (!isDate(doc.retrieved_at)) errors.push("retrieved_at must be a YYYY-MM-DD date");
  if (!Array.isArray(doc.entries) || doc.entries.length === 0) {
    errors.push("entries must be a non-empty array");
    return errors;
  }
  const ids = new Set();
  doc.entries.forEach((e, i) => {
    const at = `entries[${i}]`;
    if (!isObj(e)) return errors.push(`${at} must be an object`);
    for (const k of Object.keys(e)) if (!ENTRY_FIELDS.has(k)) errors.push(`${at}.${k} is not a registry field`);
    if (!isStr(e.id) || !ID_RE.test(e.id)) errors.push(`${at}.id must match ${ID_RE}`);
    else if (ids.has(e.id)) errors.push(`${at}.id "${e.id}" is duplicated`);
    else ids.add(e.id);
    for (const k of ["source", "title", "file", "suite", "suite_version"]) {
      if (!isStr(e[k])) errors.push(`${at}.${k} must be a non-empty string`);
    }
    if (!isUrl(e.url)) errors.push(`${at}.url must be an https URL`);
    if (e.see_also !== undefined && !isUrl(e.see_also)) errors.push(`${at}.see_also must be an https URL`);
    if (!(e.measured_on === null || isDate(e.measured_on))) errors.push(`${at}.measured_on must be YYYY-MM-DD or null`);
    for (const k of ["host", "lane", "conditions", "settings"]) {
      if (!isObj(e[k])) errors.push(`${at}.${k} must be an object`);
    }
    if (isObj(e.host) && "node_id" in e.host) errors.push(`${at}.host.node_id is not allowed: references have no Herd node`);
    if (!Array.isArray(e.figures) || e.figures.length === 0) {
      errors.push(`${at}.figures must be a non-empty array`);
      return;
    }
    const keys = new Set();
    e.figures.forEach((f, j) => {
      const fat = `${at}.figures[${j}]`;
      if (!isObj(f)) return errors.push(`${fat} must be an object`);
      for (const k of Object.keys(f)) if (!FIGURE_FIELDS.has(k)) errors.push(`${fat}.${k} is not a registry field`);
      if (!isStr(f.key) || !ID_RE.test(f.key)) errors.push(`${fat}.key must match ${ID_RE}`);
      else if (keys.has(f.key)) errors.push(`${fat}.key "${f.key}" is duplicated`);
      else keys.add(f.key);
      if (!Array.isArray(f.metrics) || f.metrics.length === 0) {
        errors.push(`${fat}.metrics must be a non-empty array`);
        return;
      }
      f.metrics.forEach((m, k) => {
        const mat = `${fat}.metrics[${k}]`;
        if (!isObj(m)) return errors.push(`${mat} must be an object`);
        for (const x of Object.keys(m)) if (!FIGURE_METRIC_FIELDS.has(x)) errors.push(`${mat}.${x} is not a registry field`);
        if (typeof m.value !== "number" || !Number.isFinite(m.value)) errors.push(`${mat}.value must be a number`);
        const def = getDefinition(m.definition);
        if (!def) errors.push(`${mat}.definition must name a registered definition`);
        else if (def.owner === "herd") errors.push(`${mat}.definition ${m.definition} is a Herd definition; references keep their publisher's`);
      });
    });
  });
  return errors;
}

/**
 * Turn a registry document into bench results store records.
 * Throws when the document or any record is invalid: a bad registry is a
 * build error, not something to half-load.
 * @param {any} doc
 * @param {{ recordedAt?: string, file?: string }} [opts]
 */
export function registryRecords(doc, opts = {}) {
  const errors = validateRegistry(doc);
  if (errors.length) throw registryError(errors);
  const recordedAt = opts.recordedAt ?? new Date().toISOString();
  const file = opts.file ?? "server/bench/references/registry.json";
  const out = [];
  for (const e of doc.entries) {
    const measured = e.measured_on ?? null;
    for (const f of e.figures) {
      const suiteOverride = typeof f.suite === "string";
      const rec = makeResult({
        id: referenceRecordId(e.id, f.key),
        recorded_at: recordedAt,
        run: {
          run_id: `registry:${e.id}`,
          started_at: `${measured ?? doc.retrieved_at}T00:00:00.000Z`,
          completed_at: null,
          status: null,
          suite: suiteOverride ? f.suite : e.suite,
          suite_version: f.suite_version ?? (suiteOverride ? "unversioned" : e.suite_version),
          bench: REGISTRY_BENCH,
          bench_version: `registry-v${doc.registry_version}`,
          origin: "reference",
          reference_url: e.url,
          imported_from: {
            registry: REGISTRY_FORMAT,
            registry_version: doc.registry_version,
            file,
            entry: e.id,
            figure: f.key,
            retrieved_at: doc.retrieved_at,
          },
        },
        host: { ...e.host, node_id: null, node_name: null },
        lane: { ...e.lane },
        conditions: { ...e.conditions, ...(f.conditions || {}) },
        settings: {
          reference: {
            source: e.source,
            title: e.title,
            url: e.url,
            section: e.section ?? null,
            see_also: e.see_also ?? null,
            source_file: e.file,
            measured_on: measured,
            date_basis: measured ? "measured_on" : "retrieved_at",
          },
          ...e.settings,
          ...(f.settings || {}),
        },
        metrics: f.metrics.map((m) => ({
          metric: getDefinition(m.definition).metric,
          value: m.value,
          n: m.n ?? null,
          definition: m.definition,
          source: "reference",
        })),
        quality: null,
        raw: null,
      });
      const v = validateResult(rec);
      if (!v.ok) throw registryError(v.errors.map((x) => `${rec.id}: ${x}`));
      out.push(rec);
    }
  }
  return out;
}

function registryError(errors) {
  const err = new Error(`invalid reference registry: ${errors.slice(0, 5).join("; ")}`);
  /** @type {any} */ (err).errors = errors;
  return err;
}

/** Comparable view of a record (recorded_at is store bookkeeping). */
function contentKey(rec) {
  const { recorded_at: _r, ...rest } = rec;
  return JSON.stringify(rest);
}

/**
 * Bring the store in line with the registry: add new figures, replace
 * changed ones, drop registry ids no longer in the file. Ids outside the
 * registry prefix (Herd results, user-POSTed references) are never
 * touched. One write at most; none when nothing changed.
 * @param {import("../results/store.js").BenchResultsStore} store
 * @param {any[]} records output of registryRecords
 */
export function syncRegistryIntoStore(store, records) {
  const summary = { added: 0, updated: 0, unchanged: 0, removed: 0 };
  const want = new Map(records.map((r) => [r.id, r]));
  const changed = [];
  for (const rec of records) {
    if (!isRegistryId(rec.id) || rec.run.origin !== "reference") {
      throw new Error(`refusing to seed ${rec.id}: not a registry reference record`);
    }
    const prev = store.get(rec.id);
    if (prev && contentKey(prev) === contentKey(rec)) summary.unchanged++;
    else changed.push(rec);
  }
  const staleIds = [...store.byId.keys()].filter((id) => isRegistryId(id) && !want.has(id));
  if (changed.length) {
    const res = store.upsertMany(changed);
    if (res.rejected.length) throw registryError(res.rejected.flatMap((r) => r.errors.map((e) => `${r.id}: ${e}`)));
    summary.added = res.added;
    summary.updated = res.updated;
  }
  for (const id of staleIds) summary.removed += store.remove({ id });
  return summary;
}

/**
 * Load the registry file and seed the store. Returns the summary plus the
 * parsed registry (for the API).
 * @param {import("../results/store.js").BenchResultsStore} store
 * @param {{ file?: string }} [opts]
 */
export function seedReferenceRegistry(store, opts = {}) {
  const doc = readRegistry(opts.file);
  const records = registryRecords(doc);
  return { registry: doc, records, ...syncRegistryIntoStore(store, records) };
}
