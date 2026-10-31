/**
 * QualityBench: accuracy bench for a Spark's LLM (#42).
 *
 * Clean-room rebuild from the sparkDash README's feature description (no
 * upstream code). Six default categories (QA 150, Reasoning 40, Arithmetic
 * chain 40, State tracking 40, GSM8K 200, MMLU 285 = 755 requests) plus
 * opt-in Instruction following (40) and Long-context recall (20).
 *
 * - OpenAI chat API, non-streaming, temperature 0, top_p 1, fixed seed,
 *   thinking off.
 * - Each reply is scored pass/fail (scoring.js). An item whose request fails
 *   is not scored (pass: null) and does not count against the model.
 * - Category % = 100 × passed / scored; overall = mean of category %.
 * - Finished runs go to the bench results store (BENCH1) with their per-item
 *   vectors; the store is the history. McNemar exact p compares two runs.
 */

import { randomUUID } from "crypto";
import { fetch as undiciFetch } from "undici";
import { LLM_STREAM_AGENT, applyThinkingFlags, thinkingOffFallbackBody } from "./LlmStreaming.js";
import { buildQualityItems, QUALITY_SEED, QUALITY_SUITE_VERSION } from "./quality/items.js";
import { finalAnswerSegment, expectedText, scoreItem } from "./quality/scoring.js";
import {
  QUALITY_CATEGORIES,
  QUALITY_CONCURRENCY_OPTIONS,
  QUALITY_DEFAULT_CATEGORIES,
  QUALITY_DEFAULT_CONCURRENCY,
  QUALITY_HISTORY_LIMIT,
  QUALITY_NOISE_P,
  normalizeQualityCategories,
  qualityRequestCount,
} from "../../src/shared/qualityBench.js";
import { formatLlmBaseUrl } from "../../src/shared/llmTarget.js";
import { mcnemarCompare } from "../bench/results/mcnemar.js";

export const QUALITY_BENCH_DEFAULTS = {
  categories: QUALITY_CATEGORIES.map((c) => ({ ...c })),
  defaultCategories: [...QUALITY_DEFAULT_CATEGORIES],
  concurrencyOptions: [...QUALITY_CONCURRENCY_OPTIONS],
  defaultConcurrency: QUALITY_DEFAULT_CONCURRENCY,
  seed: QUALITY_SEED,
  suiteVersion: QUALITY_SUITE_VERSION,
  noiseP: QUALITY_NOISE_P,
  historyLimit: QUALITY_HISTORY_LIMIT,
};

/** Stop a run after this many request failures in a row (endpoint down). */
export const MAX_CONSECUTIVE_ERRORS = 12;
/** Finished jobs kept in memory for GET /:benchId (the store keeps every run). */
const FINISHED_KEEP = 20;
const ANSWER_PREVIEW = 120;

/** Per-request timeout: 60 s + 0.2 s per allowed output token + prompt size, 10 min cap. */
export function timeoutMsForItem(item) {
  const promptTokens = Math.ceil(item.prompt.length / 4);
  return Math.min(600_000, 60_000 + item.maxTokens * 200 + promptTokens * 4);
}

function replyText(json) {
  const msg = json?.choices?.[0]?.message;
  const c = msg?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
  return "";
}

/**
 * One chat completion. Returns the reply text or an error string; never throws
 * (except when the parent signal aborts).
 * @param {{ baseUrl: string, modelId: string|null, item: { prompt: string, maxTokens: number }, signal: AbortSignal, apiKey?: string|null, fetchImpl?: Function }} opts
 */
export async function askChat({ baseUrl, modelId, item, signal, apiKey = null, fetchImpl = null }) {
  const doFetch = fetchImpl || ((url, init) => undiciFetch(url, { ...init, dispatcher: LLM_STREAM_AGENT }));
  const body = {
    model: modelId || undefined,
    messages: [{ role: "user", content: item.prompt }],
    max_tokens: item.maxTokens,
    temperature: 0,
    top_p: 1,
    seed: QUALITY_SEED,
    stream: false,
  };
  applyThinkingFlags(body, modelId, false);
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = timeoutMsForItem(item);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const t0 = performance.now();
  try {
    const post = (b) =>
      doFetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(b),
        signal: ctrl.signal,
      });
    let res = await post(body);
    if (res.status === 400) {
      // Thinking-off fields rejected: retry once with the smaller off switch.
      await res.text().catch(() => "");
      res = await post(thinkingOffFallbackBody(body));
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { text: null, error: `HTTP ${res.status}${txt ? `: ${txt.slice(0, 120)}` : ""}`, ms: performance.now() - t0 };
    }
    const json = await res.json();
    return {
      text: replyText(json),
      error: null,
      ms: performance.now() - t0,
      model: typeof json?.model === "string" ? json.model : null,
      finishReason: json?.choices?.[0]?.finish_reason ?? null,
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    return {
      text: null,
      error: timedOut ? `Timed out after ${Math.round(timeoutMs / 1000)}s` : err?.message || String(err),
      ms: performance.now() - t0,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Per-category and overall scores from item rows.
 * @param {string[]} categories
 * @param {Array<{ category: string, pass: boolean|null, attempted: boolean }>} items
 * @param {Record<string, number>} maxTokensByCategory
 */
export function summarize(categories, items, maxTokensByCategory = {}) {
  const cats = categories.map((key) => {
    const rows = items.filter((it) => it.category === key);
    const scored = rows.filter((it) => typeof it.pass === "boolean");
    const passed = scored.filter((it) => it.pass).length;
    const errored = rows.filter((it) => it.attempted && it.pass === null).length;
    return {
      key,
      label: QUALITY_CATEGORIES.find((c) => c.key === key)?.label ?? key,
      total: rows.length,
      attempted: rows.filter((it) => it.attempted).length,
      scored: scored.length,
      passed,
      errored,
      accuracy: scored.length ? Math.round((10000 * passed) / scored.length) / 100 : null,
      maxTokens: maxTokensByCategory[key] ?? null,
    };
  });
  const scoredCats = cats.filter((c) => c.accuracy !== null);
  const itemsScored = cats.reduce((a, c) => a + c.scored, 0);
  const passed = cats.reduce((a, c) => a + c.passed, 0);
  return {
    categories: cats,
    overall: scoredCats.length
      ? Math.round((100 * scoredCats.reduce((a, c) => a + c.accuracy, 0)) / scoredCats.length) / 100
      : null,
    itemsTotal: items.length,
    itemsScored,
    itemsErrored: cats.reduce((a, c) => a + c.errored, 0),
    passed,
  };
}

function publicJob(job) {
  return {
    benchId: job.benchId,
    sparkId: job.sparkId,
    status: job.status,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    config: { ...job.config },
    progress: { ...job.progress },
    summary: summarize(job.config.categories, job.items, job.maxTokensByCategory),
    error: job.error,
    durationMs: (job.completedAt ?? Date.now()) - job.startedAt,
    owner: job.owner || null,
  };
}

/** Public job plus every item row (what the results store records). */
function fullJob(job) {
  return { ...publicJob(job), items: job.items.map((it) => ({ ...it })) };
}

export class QualityBenchManager {
  constructor() {
    /** @type {Map<string, any>} */
    this.jobs = new Map();
    /** @type {Map<string, string>} */
    this.activeBySpark = new Map();
    /** @type {((record: any) => void) | null} set by server/index.js */
    this.resultSink = null;
    /** @type {import("../bench/results/store.js").BenchResultsStore | null} set by server/index.js */
    this.store = null;
    /** Test hook: replace the HTTP client. */
    this.fetchImpl = null;
  }

  activeCount() {
    return this.activeBySpark.size;
  }

  getActive(sparkId) {
    const id = this.activeBySpark.get(sparkId);
    const job = id ? this.jobs.get(id) : null;
    return job ? publicJob(job) : null;
  }

  /** @param {string} benchId @param {{ items?: boolean }} [opts] */
  getJob(benchId, opts = {}) {
    const job = this.jobs.get(benchId);
    if (!job) return null;
    return opts.items ? fullJob(job) : publicJob(job);
  }

  /**
   * @param {{
   *   sparkId: string, lanIp: string, port: number, modelId: string|null,
   *   categories?: unknown, concurrency?: unknown, apiKey?: string|null,
   *   host?: string|null, tls?: boolean, owner?: any,
   *   resolveTarget?: (ctx: { onStatus?: Function, signal?: AbortSignal }) => Promise<{ host: string, port: number, tls?: boolean, via?: string, close: () => void }>,
   * }} opts
   */
  start(opts) {
    const { sparkId, lanIp, port, modelId, apiKey = null, resolveTarget = null, host = null, tls = false, owner = null } = opts;
    if (this.activeBySpark.has(sparkId)) {
      const err = new Error("A quality benchmark is already running for this Spark");
      err.status = 409;
      throw err;
    }
    const categories = opts.categories === undefined ? [...QUALITY_DEFAULT_CATEGORIES] : normalizeQualityCategories(opts.categories);
    if (categories.length === 0) {
      const err = new Error("Select at least one quality category");
      err.status = 400;
      throw err;
    }
    const concurrency = opts.concurrency === undefined ? QUALITY_DEFAULT_CONCURRENCY : Number(opts.concurrency);
    if (!QUALITY_CONCURRENCY_OPTIONS.includes(concurrency)) {
      const err = new Error(`Concurrency must be one of ${QUALITY_CONCURRENCY_OPTIONS.join(", ")}`);
      err.status = 400;
      throw err;
    }
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      const err = new Error("Invalid LLM port");
      err.status = 400;
      throw err;
    }

    const items = buildQualityItems(categories);
    /** @type {Record<string, number>} */
    const maxTokensByCategory = {};
    for (const it of items) maxTokensByCategory[it.category] = Math.max(maxTokensByCategory[it.category] ?? 0, it.maxTokens);
    const benchId = randomUUID();
    const job = {
      benchId,
      sparkId,
      status: "running",
      startedAt: Date.now(),
      completedAt: null,
      config: {
        port: p,
        modelId: modelId || null,
        categories,
        concurrency,
        seed: QUALITY_SEED,
        suiteVersion: QUALITY_SUITE_VERSION,
        requests: qualityRequestCount(categories),
        ...(host ? { host: String(host).trim(), tls: Boolean(tls) } : {}),
      },
      progress: { done: 0, total: items.length, errored: 0, currentCategory: null, message: "Starting…" },
      items: items.map((it) => ({
        id: it.id,
        category: it.category,
        attempted: false,
        pass: null,
        expected: expectedText(it),
        answer: null,
        ms: null,
        error: null,
      })),
      maxTokensByCategory,
      error: null,
      owner: owner ? { id: owner.id, via: owner.via } : null,
      _items: items,
      _abort: new AbortController(),
      _apiKey: apiKey != null && String(apiKey).trim() ? String(apiKey).trim() : null,
      _resolveTarget: typeof resolveTarget === "function" ? resolveTarget : null,
      _closeTarget: null,
      _finished: false,
    };
    this.jobs.set(benchId, job);
    this.activeBySpark.set(sparkId, benchId);
    this._runJob(job, lanIp).catch(() => {
      /* recorded on the job */
    });
    return publicJob(job);
  }

  cancel(sparkId, benchId) {
    const job = this.jobs.get(benchId);
    if (!job || job.sparkId !== sparkId) return null;
    if (job.status === "running") {
      job._abort.abort();
      job.progress.message = "Cancelling…";
    }
    return publicJob(job);
  }

  interruptAll(reason = "Interrupted — server shutting down") {
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      job.status = "interrupted";
      job.error = reason;
      job.progress.message = "Interrupted";
      job._abort.abort();
      this._finish(job);
    }
  }

  async _runJob(job, lanIp) {
    let host = job.config.host || lanIp;
    let port = job.config.port;
    let tls = Boolean(job.config.tls);
    try {
      if (job._resolveTarget) {
        job.progress.message = "Connecting to LLM…";
        const target = await job._resolveTarget({
          onStatus: (msg) => {
            if (typeof msg === "string" && msg) job.progress.message = msg;
          },
          signal: job._abort.signal,
        });
        host = target?.host || host;
        port = Number.isInteger(target?.port) ? target.port : port;
        if (target?.tls != null) tls = Boolean(target.tls);
        job._closeTarget = typeof target?.close === "function" ? target.close : null;
      }
      const baseUrl = formatLlmBaseUrl({ host, port, tls });
      await this._runItems(job, baseUrl);
      if (job.status === "running") {
        if (job._abort.signal.aborted) {
          job.status = "cancelled";
          job.error = "Cancelled by user";
          job.progress.message = "Cancelled";
        } else if (job._tooManyErrors) {
          job.status = "failed";
          job.error = `Stopped after ${MAX_CONSECUTIVE_ERRORS} failed requests in a row (last: ${job._lastError})`;
          job.progress.message = "Failed";
        } else {
          job.status = "completed";
          job.progress.message = job.progress.errored ? `Done (${job.progress.errored} errored)` : "Done";
        }
      }
    } catch (err) {
      if (job.status === "running") {
        job.status = job._abort.signal.aborted ? "cancelled" : "failed";
        job.error = job._abort.signal.aborted ? "Cancelled by user" : err?.message || String(err);
        job.progress.message = job.status === "cancelled" ? "Cancelled" : "Failed";
      }
    } finally {
      this._finish(job);
    }
  }

  async _runItems(job, baseUrl) {
    let next = 0;
    let consecutive = 0;
    const signal = job._abort.signal;
    const worker = async () => {
      while (!signal.aborted && !job._tooManyErrors && job.status === "running") {
        const idx = next++;
        if (idx >= job._items.length) return;
        const item = job._items[idx];
        const row = job.items[idx];
        job.progress.currentCategory = item.category;
        job.progress.message = `Scoring ${QUALITY_CATEGORIES.find((c) => c.key === item.category)?.label ?? item.category}…`;
        let res;
        try {
          res = await askChat({
            baseUrl,
            modelId: job.config.modelId,
            item,
            signal,
            apiKey: job._apiKey,
            fetchImpl: this.fetchImpl,
          });
        } catch {
          return; // aborted
        }
        if (signal.aborted || job.status !== "running") return;
        row.attempted = true;
        row.ms = Math.round(res.ms);
        if (res.error) {
          row.error = res.error;
          job.progress.errored += 1;
          consecutive += 1;
          job._lastError = res.error;
          if (consecutive >= MAX_CONSECUTIVE_ERRORS) job._tooManyErrors = true;
        } else {
          consecutive = 0;
          row.pass = scoreItem(item, res.text);
          row.answer = finalAnswerSegment(res.text).slice(0, ANSWER_PREVIEW);
          if (res.model && !job.config.modelId) job.config.modelId = res.model;
        }
        job.progress.done += 1;
      }
    };
    await Promise.all(Array.from({ length: job.config.concurrency }, worker));
  }

  _finish(job) {
    if (job._finished) return;
    job._finished = true;
    try {
      job._closeTarget?.();
    } catch {
      /* ignore */
    }
    job._closeTarget = null;
    job.completedAt ??= Date.now();
    job.progress.currentCategory = null;
    if (this.activeBySpark.get(job.sparkId) === job.benchId) this.activeBySpark.delete(job.sparkId);
    job._items = null;
    this._emitResult(fullJob(job));
    const finished = [...this.jobs.values()].filter((j) => j._finished);
    for (const old of finished.slice(0, Math.max(0, finished.length - FINISHED_KEEP))) this.jobs.delete(old.benchId);
  }

  _emitResult(record) {
    if (typeof this.resultSink !== "function") return;
    try {
      this.resultSink(record);
    } catch (err) {
      console.warn(`[bench-results] sink failed: ${err?.message || err}`);
    }
  }

  // ─── history + comparison (read from the results store) ─────────────

  /** Overall records of this node's quality runs, newest first. */
  _overallRecords(sparkId) {
    if (!this.store) return [];
    return this.store
      .list({ bench: "QualityBench", node_id: sparkId, limit: 1000 })
      .results.filter((r) => r.id === r.run.run_id);
  }

  /** Run summaries for the dialog's history list. */
  history(sparkId, limit = QUALITY_HISTORY_LIMIT) {
    return this._overallRecords(sparkId).slice(0, limit).map(runSummary);
  }

  /**
   * Compare two runs category by category with exact McNemar.
   * @param {string} sparkId
   * @param {string} baselineId  benchId
   * @param {string} candidateId benchId
   */
  compare(sparkId, baselineId, candidateId) {
    const a = this.store?.get(`quality:${baselineId}`);
    const b = this.store?.get(`quality:${candidateId}`);
    if (!a || !b || a.host.node_id !== sparkId || b.host.node_id !== sparkId) {
      const err = new Error(`Unknown quality run: ${!a || a.host.node_id !== sparkId ? baselineId : candidateId}`);
      err.status = 404;
      throw err;
    }
    return compareQualityRecords(a, b, (id) => this.store.get(id));
  }
}

/** Dialog-facing summary of one stored run (overall record). */
export function runSummary(rec) {
  const s = rec.settings || {};
  const job = rec.raw?.job || {};
  const overall = rec.metrics.find((m) => m.definition === "herd.quality.category_mean.v1");
  return {
    benchId: String(rec.run.run_id).replace(/^quality:/, ""),
    runId: rec.run.run_id,
    status: rec.run.status,
    startedAt: rec.run.started_at,
    completedAt: rec.run.completed_at,
    modelId: rec.lane.model_id,
    engine: rec.lane.engine,
    hwBucket: rec.host.hw_bucket,
    concurrency: rec.conditions.concurrency,
    categories: Array.isArray(s.category_summary) ? s.category_summary : [],
    overall: overall?.valid ? overall.value : null,
    itemsScored: s.items_scored ?? null,
    itemsErrored: s.items_errored ?? null,
    passed: s.passed ?? null,
    durationMs: typeof job.durationMs === "number" ? job.durationMs : null,
    suiteVersion: rec.run.suite_version,
  };
}

/**
 * McNemar per shared category and over all shared items, plus the item ids
 * that flipped. Differences in run conditions are reported as warnings, not
 * refusals: comparing a model before and after an upgrade is the point.
 */
export function compareQualityRecords(a, b, getRecord) {
  const sa = runSummary(a);
  const sb = runSummary(b);
  const shared = sa.categories.map((c) => c.key).filter((k) => sb.categories.some((c) => c.key === k));
  const sharedSet = new Set(shared);
  const catOf = (id) => id.replace(/-.*$/, "");
  const warnings = [];
  if (a.run.suite_version !== b.run.suite_version) warnings.push(`suite_version differs (${a.run.suite_version} vs ${b.run.suite_version})`);
  if (a.conditions.concurrency !== b.conditions.concurrency) {
    warnings.push(`concurrency differs (${a.conditions.concurrency} vs ${b.conditions.concurrency}); batching can change greedy outputs`);
  }
  if (a.host.hw_bucket !== b.host.hw_bucket) warnings.push(`hardware differs (${a.host.hw_bucket ?? "unknown"} vs ${b.host.hw_bucket ?? "unknown"})`);
  const onlyA = sa.categories.filter((c) => !sharedSet.has(c.key)).map((c) => c.key);
  const onlyB = sb.categories.filter((c) => !sharedSet.has(c.key)).map((c) => c.key);
  if (onlyA.length || onlyB.length) warnings.push(`categories differ; compared ${shared.join(", ") || "none"}`);

  const categories = shared.map((key) => {
    const ra = getRecord(`${a.run.run_id}:${key}`);
    const rb = getRecord(`${b.run.run_id}:${key}`);
    const ca = sa.categories.find((c) => c.key === key);
    const cb = sb.categories.find((c) => c.key === key);
    return {
      key,
      label: ca.label,
      baseline: ca.accuracy,
      candidate: cb.accuracy,
      delta: ca.accuracy != null && cb.accuracy != null ? Math.round((cb.accuracy - ca.accuracy) * 100) / 100 : null,
      mcnemar: mcnemarCompare(ra?.quality?.items || [], rb?.quality?.items || []),
    };
  });
  const itemsA = (a.quality?.items || []).filter((it) => sharedSet.has(catOf(it.id)));
  const itemsB = (b.quality?.items || []).filter((it) => sharedSet.has(catOf(it.id)));
  const passB = new Map(itemsB.filter((it) => typeof it.pass === "boolean").map((it) => [it.id, it.pass]));
  const regressed = [];
  const improved = [];
  for (const it of itemsA) {
    if (typeof it.pass !== "boolean" || !passB.has(it.id)) continue;
    if (it.pass && !passB.get(it.id)) regressed.push(it.id);
    if (!it.pass && passB.get(it.id)) improved.push(it.id);
  }
  const meanOf = (s) => {
    const xs = s.categories.filter((c) => sharedSet.has(c.key) && c.accuracy != null).map((c) => c.accuracy);
    return xs.length ? Math.round((100 * xs.reduce((x, y) => x + y, 0)) / xs.length) / 100 : null;
  };
  const oa = meanOf(sa);
  const ob = meanOf(sb);
  return {
    baseline: sa,
    candidate: sb,
    warnings,
    overall: {
      baseline: oa,
      candidate: ob,
      delta: oa != null && ob != null ? Math.round((ob - oa) * 100) / 100 : null,
      mcnemar: mcnemarCompare(itemsA, itemsB),
    },
    categories,
    regressed,
    improved,
    noiseP: QUALITY_NOISE_P,
  };
}

export const qualityBenchManager = new QualityBenchManager();
