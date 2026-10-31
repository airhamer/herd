/**
 * AEON Bench Pod run → bench results records (`origin: "aeon-pod"`).
 *
 * Input is one pod run as the pod serves it at `GET /api/runs/<id>` (its
 * local SQLite `runs` row plus `results[]`). The importer reads three suites:
 *
 *   aeon-perf-v1        perf grid cells `perf.direct.<scope>.c<n>`, the same
 *                       ids and definitions as Herd's own AEON ladder (BENCH3)
 *   aeon-suite-v4       text quality, one record per category + overall,
 *                       with a per-case pass vector for McNemar
 *   aeon-agentic-v2.5   one harness (Hermes / OpenClaw / OpenCode) per pod
 *                       run, one record with a per-task pass vector
 *
 * Everything else (vision, audio, video, harness timing, sustained load) is
 * listed under `skipped` with a reason, never guessed into a Herd metric.
 *
 * Trust: only the AEON board decides whether a run is `attested`. The pod's
 * own `trust_tier` column is kept as `pod_trust_tier` but not believed (the
 * pod's local mirror of perf and agentic runs always writes "attested"). The
 * caller states `board_status`; `attested` needs the board URL.
 *
 * Methodology and field names follow AEON Bench Pod (MIT,
 * https://github.com/AEON-7/Aeon-Bench-Pod); no pod code is copied here.
 */

import { aeonMetrics, AEON_SUITE, round2 } from "../results/adapters.js";
import { makeResult } from "../results/schema.js";

export const POD_BENCHES = Object.freeze({
  "aeon-perf-v1": "AEONPodPerf",
  "aeon-suite-v4": "AEONPodSuite",
  "aeon-agentic-v2.5": "AEONPodAgentic",
});

/** Pod benches whose records carry per-case pass vectors (quality, not throughput). */
export const POD_QUALITY_BENCHES = Object.freeze(["AEONPodSuite", "AEONPodAgentic"]);

/** `not_submitted`: kept on the pod; `self_reported`: on the board as "local"; `attested`: "✓ verified". */
export const BOARD_STATUSES = Object.freeze(["not_submitted", "self_reported", "attested"]);

/** A case counts as passed for McNemar when its 0–1 score reaches this. */
export const PASS_SCORE = 0.5;

/** Max tokens of the pod perf grid (perf_grid.run_direct_grid default, not stored in pod.db). */
const PERF_MAX_TOKENS = 256;

const SCORE_DEFS = {
  "aeon-suite-v4": "aeon.suite_case_mean_score.v1",
  "aeon-agentic-v2.5": "aeon.agentic_task_mean_score.v1",
};

const POD_STATUS = {
  succeeded: "completed",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
  running: "interrupted",
  queued: null,
};

function importError(message) {
  const err = new Error(message);
  /** @type {any} */ (err).status = 400;
  return err;
}

function parseJson(v, fallback) {
  if (v && typeof v === "object") return v;
  if (typeof v !== "string" || !v) return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function isoFromEpoch(s) {
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString() : null;
}

const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Same model whatever the org prefix or case ("Qwen/Qwen3-8B" ≈ "qwen3-8b"). */
function sameModel(a, b) {
  const key = (v) => (typeof v === "string" ? v.split("/").pop().toLowerCase() : null);
  return key(a) !== null && key(a) === key(b);
}

function caseIdSafe(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
}

/**
 * @param {any} podRun  pod `GET /api/runs/<id>` JSON
 * @param {object} [opts]
 * @param {{ host?: object, lane?: object }|null} [opts.provenance]  Herd's view of the benched lane
 * @param {"local"|"network"|null} [opts.clientLocation]  where the pod ran relative to the lane
 * @param {string} [opts.boardStatus]   one of BOARD_STATUSES (default not_submitted)
 * @param {string|null} [opts.boardUrl] the run on the AEON board (required for attested)
 * @param {string|null} [opts.podUrl]   base URL of the pod dashboard the run came from
 * @param {string} [opts.importedAt]
 * @param {string} [opts.recordedAt]
 * @returns {{ records: any[], skipped: { case_id: string, reason: string }[], suite: string, bench: string, run_id: string, warnings: string[] }}
 */
export function fromAeonPodRun(podRun, opts = {}) {
  if (!podRun || typeof podRun !== "object" || Array.isArray(podRun)) throw importError("run must be a pod run object");
  if (typeof podRun.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(podRun.id)) throw importError("run.id must be the pod run id");
  if (!Array.isArray(podRun.results)) throw importError("run.results must be an array (GET /api/runs/<id> on the pod)");
  const suite = podRun.suite_id;
  const bench = POD_BENCHES[suite];
  if (!bench) {
    throw importError(`suite ${JSON.stringify(suite)} is not imported; supported: ${Object.keys(POD_BENCHES).join(", ")}`);
  }
  const boardStatus = opts.boardStatus ?? "not_submitted";
  if (!BOARD_STATUSES.includes(boardStatus)) throw importError(`board_status must be one of ${BOARD_STATUSES.join("|")}`);
  const boardUrl = typeof opts.boardUrl === "string" && opts.boardUrl.trim() ? opts.boardUrl.trim() : null;
  if (boardUrl && !/^https:\/\//.test(boardUrl)) throw importError("board_url must be an https URL");
  if (boardStatus === "attested" && !boardUrl) {
    throw importError("board_status attested needs board_url: only the AEON board grants attested");
  }
  const podUrl = typeof opts.podUrl === "string" && /^https?:\/\//.test(opts.podUrl) ? opts.podUrl.replace(/\/+$/, "") : null;

  const params = parseJson(podRun.params_json ?? podRun.params, {}) || {};
  const env = parseJson(podRun.env_json ?? podRun.env, {}) || {};
  const prov = opts.provenance || {};
  const warnings = [];
  const podModel = typeof podRun.model === "string" && podRun.model ? podRun.model : null;
  let lane = { ...(prov.lane || {}) };
  if (podModel && lane.model_id && ![podModel, podRun.hf_repo].some((m) => sameModel(m, lane.model_id))) {
    warnings.push(`lane now serves ${lane.model_id}, the pod benched ${podModel}: lane details other than the engine were dropped`);
    lane = { engine: lane.engine ?? null, model_id: podModel };
  }
  if (!lane.model_id) lane.model_id = podModel;
  const host = { ...(prov.host || {}) };
  if (!host.node_id) warnings.push("no Herd node given: host details are unknown, so these records compare with nothing");

  const runId = `aeon-pod:${podRun.id}`;
  const scored = podRun.results.filter((x) => x && typeof x.case_id === "string");
  const run = {
    run_id: runId,
    started_at: isoFromEpoch(podRun.started_at) ?? opts.importedAt ?? new Date().toISOString(),
    completed_at: isoFromEpoch(podRun.finished_at),
    status: POD_STATUS[podRun.status] ?? null,
    suite,
    // Perf shares Herd's ladder suite so the two compare; quality suites pin the
    // exact case set by its hash (a --limit / --category subset hashes differently).
    suite_version: suite === AEON_SUITE.suite ? AEON_SUITE.suite_version : String(podRun.suite_hash || "unknown"),
    bench,
    bench_version: "1",
    origin: "aeon-pod",
    reference_url: boardUrl ?? (podUrl ? `${podUrl}/api/runs/${podRun.id}` : `aeon-pod:${podRun.id}`),
    imported_from: {
      source: "aeon-pod",
      pod_run_id: podRun.id,
      pod_url: podUrl,
      imported_at: opts.importedAt ?? new Date().toISOString(),
    },
  };
  const aeon = {
    pod_run_id: podRun.id,
    suite_id: suite,
    suite_hash: podRun.suite_hash ?? null,
    board: podRun.board ?? null,
    board_status: boardStatus,
    board_url: boardUrl,
    pod_trust_tier: podRun.trust_tier ?? null,
    model_verified: podRun.model_verified ?? null,
    hf_repo: podRun.hf_repo ?? null,
    pod_model: podModel,
    target_url: podRun.target_url ?? null,
    judge_model: podRun.judge_model ?? null,
    harness: podRun.harness ?? null,
    harness_version: podRun.harness_version ?? null,
    bench_seed: podRun.bench_seed ?? null,
    pod_hardware: env.hardware ?? null,
    pod_engine: env.engine ?? null,
  };
  const skipped = [];
  const records = [];
  const base = (id, conditions, extra) =>
    makeResult({
      id: `${runId}:${id}`,
      recorded_at: opts.recordedAt,
      run,
      host,
      lane,
      conditions: { context_tokens: null, thinking: null, client_location: opts.clientLocation ?? null, ...conditions },
      ...extra,
    });

  if (suite === AEON_SUITE.suite) {
    let anyErrors = false;
    for (const row of scored) {
      const m = /^perf\.direct\.([a-z]+)\.c(\d+)$/.exec(row.case_id);
      const ev = row.evidence && typeof row.evidence === "object" ? row.evidence : null;
      if (!m || !ev) {
        skipped.push({ case_id: row.case_id, reason: m ? "no evidence" : "not a direct perf cell (harness timing / sustained load have no Herd metric)" });
        continue;
      }
      const conc = Number(m[2]);
      if ((ev.n_errors || 0) > 0) anyErrors = true;
      records.push(
        base(row.case_id, {
          concurrency: conc,
          max_tokens: PERF_MAX_TOKENS,
          temperature: 0,
          prompt_set: `${AEON_SUITE.suite}/${m[1]}`,
        }, {
          settings: {
            case_id: row.case_id,
            scope: ev.scope ?? m[1],
            isolation: "per_category",
            agg_source: ev.agg_source ?? null,
            tokens_source: ev.tokens_source ?? "client",
            wave_count: ev.wave_count ?? null,
            n_errors: ev.n_errors ?? 0,
            cell_wall_s: m[1] === "overall" ? num(ev.wall_clock_s) : num(ev.cell_wall_s),
            tokens_per_wall_s: num(ev.tokens_per_wall_s),
            aeon_pod: aeon,
          },
          metrics: aeonMetrics(ev),
          raw: { pod_run: podRun.id, evidence: ev },
        })
      );
    }
    if (anyErrors && run.status === "completed") for (const r of records) r.run.status = "partial";
  } else {
    const def = SCORE_DEFS[suite];
    const isAgentic = suite === "aeon-agentic-v2.5";
    const conds = (promptSet) => ({
      concurrency: posInt(params.concurrency) ?? posInt(env.concurrency),
      max_tokens: posInt(params.max_tokens),
      temperature: num(params.temperature) ?? 0,
      prompt_set: promptSet,
    });
    const caseScore = (x) => (typeof x.score === "number" && Number.isFinite(x.score) ? Math.min(1, Math.max(0, x.score)) : null);
    const vector = (rows) => ({ items: rows.map((x) => ({ id: x.case_id, pass: caseScore(x) === null ? null : caseScore(x) >= PASS_SCORE })) });
    const summary = (rows) => {
      const s = rows.map(caseScore).filter((v) => v !== null);
      const statuses = {};
      for (const x of rows) if (caseScore(x) === null) statuses[x.status || "unscored"] = (statuses[x.status || "unscored"] || 0) + 1;
      return {
        metric: s.length
          ? { metric: "accuracy_pct", definition: def, source: "client", value: round2((100 * s.reduce((a, b) => a + b, 0)) / s.length), n: s.length }
          : { metric: "accuracy_pct", definition: def, source: "client", value: null, valid: false },
        settings: {
          cases_total: rows.length,
          cases_scored: s.length,
          passed: s.filter((v) => v >= PASS_SCORE).length,
          pass_score: PASS_SCORE,
          unscored_by_status: statuses,
        },
      };
    };
    const harness = caseIdSafe(podRun.harness || "unknown");
    const groups = new Map();
    for (const row of scored) {
      const key = isAgentic ? `agentic.${harness}` : caseIdSafe(row.category || "uncategorised");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const promptBase = isAgentic ? `${suite}/${harness}` : suite;
    for (const [key, rows] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const s = summary(rows);
      records.push(
        base(key, conds(isAgentic ? promptBase : `${suite}/${key}`), {
          settings: { category: isAgentic ? "agentic" : key, ...s.settings, aeon_pod: aeon },
          metrics: [s.metric],
          quality: vector(rows),
          raw: { pod_run: podRun.id, params, cases: rows.map((x) => ({ case_id: x.case_id, category: x.category, tier: x.tier, status: x.status, score: x.score })) },
        })
      );
    }
    if (!isAgentic && records.length > 0) {
      const s = summary(scored);
      records.push(
        base("overall", conds(`${suite}/overall`), {
          settings: { category: "overall", categories: [...groups.keys()].sort(), ...s.settings, aeon_pod: aeon },
          metrics: [s.metric],
          quality: vector(scored),
          raw: { pod_run: podRun.id, params },
        })
      );
    }
  }
  if (records.length === 0) throw importError(`run ${podRun.id} has no importable ${suite} results`);
  return { records, skipped, suite, bench, run_id: runId, warnings };
}

const RUN_KEEP = [
  "id", "model", "target_url", "judge_model", "suite_id", "suite_hash", "bench_seed", "trust_tier",
  "status", "n_cases", "params_json", "env_json", "started_at", "finished_at", "board", "hf_repo",
  "hf_revision", "model_verified", "harness", "harness_version",
];

/**
 * The part of a pod run the importer reads: drops model outputs and checker
 * evidence (a full aeon-suite-v4 run is ~1 MB; Herd's JSON body limit is
 * 100 kB), keeping perf evidence, which holds the perf numbers.
 * @param {any} podRun
 */
export function slimPodRun(podRun) {
  if (!podRun || typeof podRun !== "object" || !Array.isArray(podRun.results)) return podRun;
  const out = {};
  for (const k of RUN_KEEP) if (k in podRun) out[k] = podRun[k];
  out.results = podRun.results.map((x) => {
    const row = { case_id: x?.case_id, category: x?.category ?? null, tier: x?.tier ?? null, status: x?.status ?? null, score: x?.score ?? null };
    if (typeof x?.case_id === "string" && x.case_id.startsWith("perf.")) row.evidence = x.evidence ?? null;
    return row;
  });
  return out;
}
