/**
 * Hasso battery v1: the two decode instruments of hasso5703/dgx-spark-qwen38.
 *
 * Adapted from `bench.sh` and `bench-matrix.sh` (MIT License, Copyright (c)
 * 2026 hasso5703, https://github.com/hasso5703/dgx-spark-qwen38). The probe
 * prompts, sampling settings, the two-call delta and the reliability guard
 * are ported from those scripts so Herd's numbers line up with Hasso's
 * BENCHMARKS.md. Licence text: server/collectors/data/NOTICE.md.
 *
 *   bench.sh         single-stream streaming decode. Four probes, two runs
 *                    each: code and reasoning greedy (temperature 0), math
 *                    at temperature 0.6, free prose greedy as a worst case.
 *                    Per run: (out − 1) / (t_last − t_first), where reasoning
 *                    chunks count as tokens. The headline is the median of
 *                    the timed code + reasoning runs ("greedy median"); math
 *                    and prose are reported but never enter it.
 *   bench-matrix.sh  frozen battery v1: 8 workloads over EN/FR/DE, not
 *                    streamed, temperature 0. One discarded warm-up call,
 *                    then per workload two calls with the same prompt at
 *                    80 and 680 max tokens; decode net of prefill =
 *                    Δ completion_tokens / Δ wall seconds. A sample with
 *                    Δtok < 50 or Δt < 2.0 s is refused (no number).
 *
 * DO NOT edit the prompts in place: add a v2 battery instead.
 */

export const HASSO_PROTOCOL = "hasso-battery-v1";
export const HASSO_SUITE_VERSION = "1";
/** bench-matrix.sh BATTERY_VERSION. */
export const HASSO_BATTERY_VERSION = 1;
export const HASSO_PARTS = Object.freeze(["bench", "matrix"]);
export const HASSO_RUNS_PER_PROBE = 2;
export const HASSO_MATRIX_SHORT = 80;
export const HASSO_MATRIX_LONG = 680;
export const HASSO_MIN_DELTA_TOKENS = 50;
export const HASSO_MIN_DELTA_S = 2.0;
export const HASSO_WARMUP = Object.freeze({ prompt: "Say OK.", maxTokens: 24 });
/** Per-request timeout of both scripts (urlopen timeout=900). */
export const HASSO_TIMEOUT_MS = 900_000;
export const HASSO_URLS = Object.freeze({
  bench: "https://github.com/hasso5703/dgx-spark-qwen38/blob/main/bench.sh",
  matrix: "https://github.com/hasso5703/dgx-spark-qwen38/blob/main/bench-matrix.sh",
});

/** bench.sh PROBES, in order. `inMedian`: greedy and not the worst case. */
export const HASSO_BENCH_PROBES = Object.freeze([
  {
    key: "code",
    name: "code (greedy, deterministic)",
    temperature: 0.0,
    prompt: "Write a Python class LRUCache with O(1) get/put using OrderedDict, plus a small test.",
    maxTokens: 1200,
    inMedian: true,
  },
  {
    key: "reasoning",
    name: "reasoning (greedy, deterministic)",
    temperature: 0.0,
    prompt:
      "A train leaves Paris at 14:00 at 160 km/h toward Lyon (465 km). Another leaves Lyon at 14:30 at 120 km/h toward Paris. When do they meet? Show your work.",
    maxTokens: 1200,
    inMedian: true,
  },
  {
    key: "math_peak",
    name: "math peak (temp 0.6, like SGLang's eval setting)",
    temperature: 0.6,
    prompt:
      "Natalia sold clips to 48 friends in April, half as many in May, and 3x May's amount in June. How many clips did she sell in total? Think step by step.",
    maxTokens: 2048,
    inMedian: false,
  },
  {
    key: "prose",
    name: "free prose (greedy, worst-case, excluded from median)",
    temperature: 0.0,
    prompt:
      "Describe in detail a walk through an autumn forest: the colors of the leaves, the sounds, the smell after rain, and the thoughts that cross your mind.",
    maxTokens: 800,
    inMedian: false,
  },
].map((p) => Object.freeze(p)));

/** bench-matrix.sh PROBES (battery v1), in order. */
export const HASSO_MATRIX_PROBES = Object.freeze([
  {
    key: "math_en",
    name: "math (EN, eval-style)",
    lang: "EN",
    prompt:
      "Natalia sold clips to 48 friends in April, half as many in May, and 3x May's amount in June. How many clips did she sell in total? Think step by step.",
  },
  {
    key: "code_en",
    name: "code (EN)",
    lang: "EN",
    prompt: "Write a Python class implementing an LRU cache with O(1) get and put, with docstrings and a small usage example.",
  },
  {
    key: "code_de",
    name: "code (DE)",
    lang: "DE",
    prompt: "Schreibe eine Python-Klasse RingBuffer mit push/pop in O(1), Docstrings und einem kleinen Test.",
  },
  {
    key: "tech_fr",
    name: "technical explain (FR)",
    lang: "FR",
    prompt:
      "Explique en détail comment fonctionne un index B-tree dans une base de données relationnelle, avec un exemple concret d'insertion.",
  },
  {
    key: "reasoning_fr",
    name: "reasoning (FR)",
    lang: "FR",
    prompt:
      "Un train part de Paris à 14h00 à 160 km/h vers Lyon (465 km). Un autre part de Lyon à 14h30 à 120 km/h vers Paris. À quelle heure se croisent-ils ? Montre ton raisonnement.",
  },
  {
    key: "prose_en",
    name: "free prose (EN)",
    lang: "EN",
    prompt:
      "Describe in detail a walk through an autumn forest: the colors of the leaves, the sounds, the smell after rain, and the thoughts that cross your mind.",
  },
  {
    key: "prose_fr",
    name: "free prose (FR)",
    lang: "FR",
    prompt:
      "Décris en détail une promenade dans une forêt d'automne : les couleurs des feuilles, les sons, l'odeur après la pluie, et les pensées qui traversent l'esprit.",
  },
  {
    key: "prose_de",
    name: "free prose (DE)",
    lang: "DE",
    prompt:
      "Beschreibe ausführlich einen Spaziergang durch einen herbstlichen Wald: die Farben der Blätter, die Geräusche, den Geruch nach Regen, und die Gedanken, die einem dabei durch den Kopf gehen.",
  },
].map((p) => Object.freeze(p)));

import { fetch as undiciFetch } from "undici";
import { LLM_STREAM_AGENT, runStreamingRequest } from "./LlmStreaming.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Hasso's published precision: one decimal. */
export function round1(v) {
  return isNum(v) ? Math.round(v * 10) / 10 : null;
}

/** Python statistics.median: middle value, or the mean of the middle pair. */
export function pyMedian(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Normalise a `parts` request field; default both, order fixed. */
export function normalizeHassoParts(raw) {
  if (raw == null) return [...HASSO_PARTS];
  const list = Array.isArray(raw) ? raw.map(String) : [String(raw)];
  return HASSO_PARTS.filter((p) => list.includes(p));
}

/** Requests a run sends: 4 probes × 2 runs; matrix 1 warm-up + 8 × 2. */
export function hassoRequestCount(parts) {
  let n = 0;
  if (parts.includes("bench")) n += HASSO_BENCH_PROBES.length * HASSO_RUNS_PER_PROBE;
  if (parts.includes("matrix")) n += 1 + HASSO_MATRIX_PROBES.length * 2;
  return n;
}

/** Output-token budget of a run (sum of every request's max_tokens). */
export function hassoTokenBudget(parts) {
  let n = 0;
  if (parts.includes("bench")) {
    n += HASSO_BENCH_PROBES.reduce((s, p) => s + p.maxTokens * HASSO_RUNS_PER_PROBE, 0);
  }
  if (parts.includes("matrix")) {
    n += HASSO_WARMUP.maxTokens + HASSO_MATRIX_PROBES.length * (HASSO_MATRIX_SHORT + HASSO_MATRIX_LONG);
  }
  return n;
}

/** bench.sh stream() body: no thinking flags, no top_p. */
export function hassoStreamBody(modelId, prompt, temperature, maxTokens) {
  return {
    ...(modelId ? { model: modelId } : {}),
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    temperature,
    stream: true,
    stream_options: { include_usage: true },
  };
}

/** bench-matrix.sh call() body: not streamed, greedy. */
export function hassoCallBody(modelId, prompt, maxTokens) {
  return {
    ...(modelId ? { model: modelId } : {}),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.0,
    max_tokens: maxTokens,
  };
}

/**
 * bench.sh rate of one streamed run: (out − 1) / (t_last − t_first) with out
 * = usage.completion_tokens or the chunk count; null where bench.sh prints
 * "not timed" (no token, or the first and last token at the same instant).
 * @param {{ completionTokens?: number, tFirst?: number|null, tLast?: number|null }} r  ms marks
 */
export function hassoStreamRate(r) {
  if (!r || !isNum(r.tFirst) || !isNum(r.tLast) || !(r.tLast > r.tFirst)) return null;
  const out = isNum(r.completionTokens) ? r.completionTokens : 0;
  return (out - 1) / ((r.tLast - r.tFirst) / 1000);
}

/**
 * bench.sh summary over the probes' runs: the greedy median of the timed
 * runs of the probes in the median, plus how many of those runs were not
 * timed. Per probe, the median of its timed runs.
 * @param {{ key: string, inMedian: boolean, runs: { tps: number|null }[] }[]} probes
 */
export function hassoBenchSummary(probes) {
  const greedy = [];
  let untimed = 0;
  const perProbe = probes.map((p) => {
    const timed = p.runs.map((r) => r.tps).filter((x) => isNum(x) && x > 0);
    if (p.inMedian) {
      greedy.push(...timed);
      untimed += p.runs.length - timed.length;
    }
    return { key: p.key, median: round1(pyMedian(timed)), timed: timed.length };
  });
  return { greedyMedian: round1(pyMedian(greedy)), greedyRuns: greedy.length, untimed, perProbe };
}

/**
 * bench-matrix.sh two-call delta with its reliability guard.
 * @param {{ wallS: number, tokens: number }} short  80-token call
 * @param {{ wallS: number, tokens: number }} long   680-token call
 */
export function hassoTwoCallDelta(short, long) {
  const dTok = long.tokens - short.tokens;
  const dS = long.wallS - short.wallS;
  if (dTok < HASSO_MIN_DELTA_TOKENS || dS < HASSO_MIN_DELTA_S) {
    return {
      deltaTokens: dTok,
      deltaS: Math.round(dS * 100) / 100,
      tps: null,
      reliable: false,
      reason: `unreliable sample (Δtok=${dTok}, Δt=${dS.toFixed(2)}s: short answer, cold start or cache artifact)`,
    };
  }
  return { deltaTokens: dTok, deltaS: Math.round(dS * 100) / 100, tps: round1(dTok / dS), reliable: true, reason: null };
}

function linkSignal(parent, timeoutMs) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * bench-matrix.sh call(): one non-streamed completion, timed wall clock.
 * Throws on HTTP errors and when the endpoint returns no
 * usage.completion_tokens, as the script exits there.
 * @returns {Promise<{ wallS: number, tokens: number, model: string|null }>}
 */
export async function hassoTimedCall(url, body, signal, { apiKey = null, timeoutMs = HASSO_TIMEOUT_MS } = {}) {
  const link = linkSignal(signal, timeoutMs);
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const t0 = performance.now();
  try {
    // Same dispatcher as the streaming benches: no 300 s headers timeout,
    // so a slow 680-token call is limited by the scripts' 900 s only.
    const res = await undiciFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: link.signal,
      dispatcher: LLM_STREAM_AGENT,
    });
    const text = await res.text();
    const wallS = (performance.now() - t0) / 1000;
    if (!res.ok) throw new Error(`HTTP ${res.status} from the server: ${text.slice(0, 300)}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("endpoint returned no JSON, cannot measure");
    }
    const ct = json?.usage?.completion_tokens;
    if (ct == null || !isNum(Number(ct))) {
      throw new Error("endpoint returns no usage.completion_tokens, cannot measure");
    }
    return { wallS, tokens: Number(ct), model: typeof json.model === "string" ? json.model : null };
  } finally {
    link.done();
  }
}

/** Served model id from /v1/models, as both scripts ask it; null if none. */
export async function hassoServedModel(baseUrl, apiKey, signal) {
  const link = linkSignal(signal, 10_000);
  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: link.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    const id = Array.isArray(json?.data) ? json.data[0]?.id : null;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  } finally {
    link.done();
  }
}

function checkAbort(signal) {
  if (signal?.aborted) {
    const err = new Error("Cancelled by user");
    err.name = "AbortError";
    throw err;
  }
}

/**
 * Run the battery's parts in order (bench.sh, then bench-matrix.sh),
 * filling `state` as it goes so a cancelled or failed run keeps what it
 * measured. Each part's request errors are fatal, as in the scripts.
 *
 * @param {{
 *   baseUrl: string, modelId?: string|null, parts: string[], apiKey?: string|null,
 *   signal?: AbortSignal, state: { model?: string|null, bench?: any, matrix?: any },
 *   streamImpl?: Function, callImpl?: Function, modelsImpl?: Function,
 *   onStep?: (part: string, label: string) => void, onRequestDone?: () => void,
 * }} opts
 */
export async function runHassoBattery({
  baseUrl,
  modelId = null,
  parts,
  apiKey = null,
  signal,
  state,
  streamImpl = runStreamingRequest,
  callImpl = hassoTimedCall,
  modelsImpl = hassoServedModel,
  onStep = () => {},
  onRequestDone = () => {},
}) {
  const url = `${baseUrl}/v1/chat/completions`;
  const model = modelId || (await modelsImpl(baseUrl, apiKey, signal)) || null;
  state.model = model;

  if (parts.includes("bench")) {
    const probes = HASSO_BENCH_PROBES.map((p) => ({
      key: p.key,
      name: p.name,
      temperature: p.temperature,
      maxTokens: p.maxTokens,
      inMedian: p.inMedian,
      runs: [],
      median: null,
    }));
    state.bench = { probes, greedyMedian: null, greedyRuns: 0, untimed: 0 };
    for (let i = 0; i < HASSO_BENCH_PROBES.length; i++) {
      const def = HASSO_BENCH_PROBES[i];
      for (let run = 0; run < HASSO_RUNS_PER_PROBE; run++) {
        checkAbort(signal);
        onStep("bench", `${def.key} ${run + 1}/${HASSO_RUNS_PER_PROBE}`);
        const link = linkSignal(signal, HASSO_TIMEOUT_MS);
        let r;
        try {
          r = await streamImpl(url, hassoStreamBody(model, def.prompt, def.temperature, def.maxTokens), link.signal, {
            apiKey,
          });
        } finally {
          link.done();
        }
        checkAbort(signal);
        if (r?.error) throw new Error(`bench.sh ${def.key}: ${r.error}`);
        const tps = hassoStreamRate(r);
        probes[i].runs.push({
          tps: tps !== null && tps > 0 ? Math.round(tps * 100) / 100 : null,
          completionTokens: isNum(r.completionTokens) ? r.completionTokens : null,
          ttftMs: isNum(r.ttftMs) ? Math.round(r.ttftMs) : null,
          decodeMs: isNum(r.tFirst) && isNum(r.tLast) ? Math.round(r.tLast - r.tFirst) : null,
        });
        onRequestDone();
      }
      const sum = hassoBenchSummary(probes);
      sum.perProbe.forEach((pp, j) => (probes[j].median = pp.median));
      Object.assign(state.bench, { greedyMedian: sum.greedyMedian, greedyRuns: sum.greedyRuns, untimed: sum.untimed });
    }
  }

  if (parts.includes("matrix")) {
    state.matrix = { batteryVersion: HASSO_BATTERY_VERSION, warmup: null, probes: [] };
    checkAbort(signal);
    onStep("matrix", "warm-up");
    const w = await callImpl(url, hassoCallBody(model, HASSO_WARMUP.prompt, HASSO_WARMUP.maxTokens), signal, { apiKey });
    state.matrix.warmup = { wallS: Math.round(w.wallS * 1000) / 1000, tokens: w.tokens, discarded: true };
    onRequestDone();
    for (const def of HASSO_MATRIX_PROBES) {
      checkAbort(signal);
      onStep("matrix", `${def.key} · ${HASSO_MATRIX_SHORT}`);
      const a = await callImpl(url, hassoCallBody(model, def.prompt, HASSO_MATRIX_SHORT), signal, { apiKey });
      onRequestDone();
      checkAbort(signal);
      onStep("matrix", `${def.key} · ${HASSO_MATRIX_LONG}`);
      const b = await callImpl(url, hassoCallBody(model, def.prompt, HASSO_MATRIX_LONG), signal, { apiKey });
      onRequestDone();
      const d = hassoTwoCallDelta(a, b);
      state.matrix.probes.push({
        key: def.key,
        name: def.name,
        lang: def.lang,
        short: { wallS: Math.round(a.wallS * 1000) / 1000, tokens: a.tokens },
        long: { wallS: Math.round(b.wallS * 1000) / 1000, tokens: b.tokens },
        ...d,
      });
    }
  }
  return state;
}
