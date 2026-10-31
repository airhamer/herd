/**
 * Bench result record schema (version 1), validation and like-with-like
 * comparison.
 *
 * One record = one measured cell: a run at one fixed set of conditions
 * (e.g. one DecodeBench concurrency level, one PrefillBench context size).
 * Records from the same run share `run.run_id`.
 *
 * Unknown provenance is stored as `null`, never guessed and never 0.
 */

import {
  METRICS,
  SOURCES,
  ORIGINS,
  getDefinition,
  definitionsComparable,
} from "./definitions.js";

export const SCHEMA_VERSION = 1;

export const RUN_FIELDS = Object.freeze([
  "run_id",
  "started_at",
  "completed_at",
  "status",
  "suite",
  "suite_version",
  "bench",
  "bench_version",
  "origin",
  "reference_url",
  "imported_from",
]);

export const HOST_FIELDS = Object.freeze([
  "node_id",
  "node_name",
  "hw_bucket",
  "gpu",
  "gpu_count",
  "mem_class",
  "clock_cap_mhz",
  "power_cap_w",
]);

export const LANE_FIELDS = Object.freeze([
  "engine",
  "engine_version",
  "image_digest",
  "model_id",
  "weights_hash",
  "quant",
  "recipe_flags",
  "spec_decode",
  "kv_dtype",
  "ctx_len",
  "parallel",
]);

/** Conditions that must match for two records to be compared. */
export const CONDITION_FIELDS = Object.freeze([
  "concurrency",
  "context_tokens",
  "max_tokens",
  "temperature",
  "thinking",
  "prompt_set",
  "client_location",
]);

export const METRIC_ROW_FIELDS = Object.freeze([
  "metric",
  "value",
  "unit",
  "n",
  "ci_low",
  "ci_high",
  "source",
  "tier",
  "window_s",
  "approximate",
  "valid",
  "definition",
]);

const TOP_FIELDS = Object.freeze([
  "schema_version",
  "id",
  "recorded_at",
  "run",
  "host",
  "lane",
  "conditions",
  "settings",
  "metrics",
  "quality",
  "raw",
]);

const RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted", "partial", null]);
const CLIENT_LOCATIONS = new Set(["local", "network", null]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function fillSection(src, fields) {
  const out = {};
  const obj = isPlainObject(src) ? src : {};
  for (const f of fields) out[f] = obj[f] === undefined ? null : obj[f];
  return out;
}

/**
 * Fill a metric row: unit and tier are derived from the metric/source so
 * callers cannot get them out of sync; omitted optional fields become null.
 * @param {Record<string, any>} row
 */
export function makeMetricRow(row) {
  const r = fillSection(row, METRIC_ROW_FIELDS);
  if (r.unit === null && METRICS[r.metric]) r.unit = METRICS[r.metric].unit;
  if (r.tier === null && SOURCES[r.source]) r.tier = SOURCES[r.source].tier;
  if (r.approximate === null) r.approximate = false;
  if (r.valid === null) r.valid = typeof r.value === "number" && Number.isFinite(r.value);
  return r;
}

/**
 * Build a complete record from a partial one: every schema field present,
 * unknowns null.
 * @param {Record<string, any>} partial
 */
export function makeResult(partial) {
  const p = isPlainObject(partial) ? partial : {};
  return {
    schema_version: SCHEMA_VERSION,
    id: p.id ?? null,
    recorded_at: p.recorded_at ?? new Date().toISOString(),
    run: fillSection(p.run, RUN_FIELDS),
    host: fillSection(p.host, HOST_FIELDS),
    lane: fillSection(p.lane, LANE_FIELDS),
    conditions: fillSection(p.conditions, CONDITION_FIELDS),
    settings: isPlainObject(p.settings) ? p.settings : {},
    metrics: Array.isArray(p.metrics) ? p.metrics.map((m) => makeMetricRow(m)) : [],
    quality: p.quality ?? null,
    raw: p.raw ?? null,
  };
}

function checkKeys(obj, fields, where, errors) {
  if (!isPlainObject(obj)) {
    errors.push(`${where} must be an object`);
    return false;
  }
  const allowed = new Set(fields);
  for (const f of fields) {
    if (!(f in obj)) errors.push(`${where}.${f} is missing (use null when unknown)`);
  }
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push(`${where}.${k} is not a schema field`);
  }
  return true;
}

const isStr = (v) => typeof v === "string" && v.length > 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isIso = (v) => isStr(v) && !Number.isNaN(Date.parse(v));

function nullOr(pred) {
  return (v) => v === null || pred(v);
}

function typeCheck(obj, where, spec, errors) {
  for (const [field, [pred, desc]] of Object.entries(spec)) {
    if (obj && field in obj && !pred(obj[field])) {
      errors.push(`${where}.${field} must be ${desc}`);
    }
  }
}

/**
 * Validate a complete record.
 * @param {unknown} rec
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateResult(rec) {
  /** @type {string[]} */
  const errors = [];
  if (!isPlainObject(rec)) return { ok: false, errors: ["record must be an object"] };
  const r = /** @type {Record<string, any>} */ (rec);

  checkKeys(r, TOP_FIELDS, "record", errors);
  if (r.schema_version !== SCHEMA_VERSION) {
    errors.push(`record.schema_version must be ${SCHEMA_VERSION}`);
  }
  if (!isStr(r.id)) errors.push("record.id must be a non-empty string");
  if (!isIso(r.recorded_at)) errors.push("record.recorded_at must be an ISO date");

  if (checkKeys(r.run, RUN_FIELDS, "run", errors)) {
    typeCheck(r.run, "run", {
      run_id: [isStr, "a non-empty string"],
      started_at: [isIso, "an ISO date"],
      completed_at: [nullOr(isIso), "an ISO date or null"],
      status: [(v) => RUN_STATUSES.has(v), "completed|failed|cancelled|interrupted|partial|null"],
      suite: [isStr, "a non-empty string"],
      suite_version: [isStr, "a non-empty string"],
      bench: [isStr, "a non-empty string"],
      bench_version: [isStr, "a non-empty string"],
      origin: [(v) => ORIGINS.includes(v), ORIGINS.join("|")],
      reference_url: [nullOr(isStr), "a string or null"],
      imported_from: [nullOr(isPlainObject), "an object or null"],
    }, errors);
    if (r.run.origin !== "herd" && !isStr(r.run.reference_url)) {
      errors.push("run.reference_url is required for non-herd origins");
    }
  }

  if (checkKeys(r.host, HOST_FIELDS, "host", errors)) {
    typeCheck(r.host, "host", {
      node_id: [nullOr(isStr), "a string or null"],
      node_name: [nullOr(isStr), "a string or null"],
      hw_bucket: [nullOr(isStr), "a string or null"],
      gpu: [nullOr(isStr), "a string or null"],
      gpu_count: [nullOr((v) => Number.isInteger(v) && v > 0), "a positive integer or null"],
      mem_class: [nullOr(isStr), "a string or null"],
      clock_cap_mhz: [nullOr(isNum), "a number or null"],
      power_cap_w: [nullOr(isNum), "a number or null"],
    }, errors);
    if (r.run?.origin === "herd" && !isStr(r.host.node_id)) {
      errors.push("host.node_id is required for herd results");
    }
  }

  if (checkKeys(r.lane, LANE_FIELDS, "lane", errors)) {
    typeCheck(r.lane, "lane", {
      engine: [nullOr(isStr), "a string or null"],
      engine_version: [nullOr(isStr), "a string or null"],
      image_digest: [nullOr(isStr), "a string or null"],
      model_id: [nullOr(isStr), "a string or null"],
      weights_hash: [nullOr(isStr), "a string or null"],
      quant: [nullOr(isStr), "a string or null"],
      recipe_flags: [nullOr((v) => Array.isArray(v) && v.every((x) => typeof x === "string")), "a string array or null"],
      spec_decode: [nullOr(isStr), "a string or null"],
      kv_dtype: [nullOr(isStr), "a string or null"],
      ctx_len: [nullOr((v) => Number.isInteger(v) && v > 0), "a positive integer or null"],
      parallel: [nullOr(isPlainObject), "an object or null"],
    }, errors);
  }

  if (checkKeys(r.conditions, CONDITION_FIELDS, "conditions", errors)) {
    typeCheck(r.conditions, "conditions", {
      concurrency: [nullOr((v) => Number.isInteger(v) && v > 0), "a positive integer or null"],
      context_tokens: [nullOr((v) => Number.isInteger(v) && v >= 0), "a non-negative integer or null"],
      max_tokens: [nullOr((v) => Number.isInteger(v) && v > 0), "a positive integer or null"],
      temperature: [nullOr(isNum), "a number or null"],
      thinking: [nullOr((v) => typeof v === "boolean"), "a boolean or null"],
      prompt_set: [nullOr(isStr), "a string or null"],
      client_location: [(v) => CLIENT_LOCATIONS.has(v), "local|network|null"],
    }, errors);
  }

  if (!isPlainObject(r.settings)) errors.push("settings must be an object");
  if (r.raw !== null && r.raw !== undefined && !isPlainObject(r.raw)) {
    errors.push("raw must be an object or null");
  }
  validateQuality(r.quality, errors);

  if (!Array.isArray(r.metrics) || r.metrics.length === 0) {
    errors.push("metrics must be a non-empty array");
  } else {
    r.metrics.forEach((m, i) => validateMetricRow(m, `metrics[${i}]`, r.run?.origin, errors));
  }

  return { ok: errors.length === 0, errors };
}

function validateQuality(q, errors) {
  if (q === null || q === undefined) return;
  if (!isPlainObject(q) || !Array.isArray(q.items)) {
    errors.push("quality must be null or { items: [{ id, pass }] }");
    return;
  }
  const seen = new Set();
  q.items.forEach((it, i) => {
    if (!isPlainObject(it) || !isStr(it.id) || !(it.pass === true || it.pass === false || it.pass === null)) {
      errors.push(`quality.items[${i}] must be { id: string, pass: boolean|null }`);
    } else if (seen.has(it.id)) {
      errors.push(`quality.items[${i}].id "${it.id}" is duplicated`);
    } else {
      seen.add(it.id);
    }
  });
}

function validateMetricRow(m, where, origin, errors) {
  if (!checkKeys(m, METRIC_ROW_FIELDS, where, errors)) return;
  const metric = METRICS[m.metric];
  if (!metric) {
    errors.push(`${where}.metric "${m.metric}" is not a known metric`);
    return;
  }
  const def = getDefinition(m.definition);
  if (!def) {
    errors.push(`${where}.definition must name a registered definition (got ${JSON.stringify(m.definition)})`);
  } else if (def.metric !== m.metric) {
    errors.push(`${where}.definition "${m.definition}" defines ${def.metric}, not ${m.metric}`);
  }
  if (m.unit !== metric.unit) errors.push(`${where}.unit must be "${metric.unit}" for ${m.metric}`);
  const source = SOURCES[m.source];
  if (!source) {
    errors.push(`${where}.source must be one of ${Object.keys(SOURCES).join("|")}`);
  } else if (m.tier !== source.tier) {
    errors.push(`${where}.tier must be ${source.tier} for source ${m.source}`);
  }
  if (origin === "herd" && m.source === "reference") {
    errors.push(`${where}.source "reference" is not allowed on herd results`);
  }
  if (origin === "reference" && m.source !== "reference") {
    errors.push(`${where}.source must be "reference" on reference results`);
  }
  if (!(m.value === null || isNum(m.value))) errors.push(`${where}.value must be a finite number or null`);
  if (typeof m.valid !== "boolean") errors.push(`${where}.valid must be a boolean`);
  if (m.value === null && m.valid) errors.push(`${where}.valid must be false when value is null`);
  if (!(m.n === null || (Number.isInteger(m.n) && m.n > 0))) errors.push(`${where}.n must be a positive integer or null`);
  for (const k of ["ci_low", "ci_high", "window_s"]) {
    if (!(m[k] === null || isNum(m[k]))) errors.push(`${where}.${k} must be a number or null`);
  }
  if (isNum(m.value) && isNum(m.ci_low) && m.ci_low > m.value) errors.push(`${where}.ci_low exceeds value`);
  if (isNum(m.value) && isNum(m.ci_high) && m.ci_high < m.value) errors.push(`${where}.ci_high is below value`);
  if (typeof m.approximate !== "boolean") errors.push(`${where}.approximate must be a boolean`);
}

// ─── Like-with-like comparison ────────────────────────────────────────

/**
 * Why two records may not be compared at all (empty = comparable).
 * Lanes (engine, model, quant…) may differ — that is what a comparison
 * is for. Hardware bucket, suite version and conditions must match.
 * @param {any} a
 * @param {any} b
 */
export function incomparabilityReasons(a, b) {
  const reasons = [];
  if (!a.host.hw_bucket || !b.host.hw_bucket) {
    reasons.push("hw_bucket unknown on one side");
  } else if (a.host.hw_bucket !== b.host.hw_bucket) {
    reasons.push(`hw_bucket differs (${a.host.hw_bucket} vs ${b.host.hw_bucket})`);
  }
  if (a.run.suite !== b.run.suite) reasons.push(`suite differs (${a.run.suite} vs ${b.run.suite})`);
  else if (a.run.suite_version !== b.run.suite_version) {
    reasons.push(`suite_version differs (${a.run.suite_version} vs ${b.run.suite_version})`);
  }
  for (const f of CONDITION_FIELDS) {
    if (a.conditions[f] !== b.conditions[f]) {
      reasons.push(`conditions.${f} differs (${fmt(a.conditions[f])} vs ${fmt(b.conditions[f])})`);
    }
  }
  return reasons;
}

function fmt(v) {
  return v === null ? "unknown" : String(v);
}

/** Stable key: records with equal keys are like-with-like. */
export function comparabilityKey(rec) {
  return JSON.stringify([
    rec.host.hw_bucket,
    rec.run.suite,
    rec.run.suite_version,
    ...CONDITION_FIELDS.map((f) => rec.conditions[f]),
  ]);
}

/**
 * Compare a candidate against a baseline, metric by metric. Metrics whose
 * definitions are not in the same comparable group are refused, never
 * diffed.
 * @param {any} baseline
 * @param {any} candidate
 */
export function compareResults(baseline, candidate) {
  const reasons = incomparabilityReasons(baseline, candidate);
  if (reasons.length) return { comparable: false, reasons, rows: [], refused: [] };

  const rows = [];
  const refused = [];
  for (const bm of baseline.metrics) {
    if (!bm.valid) continue;
    const sameMetric = candidate.metrics.filter((cm) => cm.metric === bm.metric && cm.valid);
    if (sameMetric.length === 0) continue;
    const match = sameMetric.find((cm) => definitionsComparable(bm.definition, cm.definition));
    if (!match) {
      refused.push({
        metric: bm.metric,
        baseline_definition: bm.definition,
        candidate_definitions: sameMetric.map((cm) => cm.definition),
        reason: "definitions are not comparable",
      });
      continue;
    }
    const delta = match.value - bm.value;
    const better = METRICS[bm.metric].better;
    rows.push({
      metric: bm.metric,
      unit: bm.unit,
      baseline: bm.value,
      candidate: match.value,
      delta: round(delta, 4),
      delta_pct: bm.value !== 0 ? round((delta / Math.abs(bm.value)) * 100, 2) : null,
      improved: delta === 0 ? null : better === "higher" ? delta > 0 : delta < 0,
      baseline_definition: bm.definition,
      candidate_definition: match.definition,
    });
  }
  return { comparable: true, reasons: [], rows, refused };
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
