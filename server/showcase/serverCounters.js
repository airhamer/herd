/**
 * Server-side generation counters for the fleet Prompt Showcase (SHOW1, #39).
 *
 * Reads one engine's cumulative output-token counter through the same
 * engine-neutral counter adapter the node agents use (STAT2/STAT3,
 * agent/collectors/llmCounters.js), so every engine with a counter gives the
 * same number: vLLM, SGLang, llama.cpp (--metrics), ds4, q27, Tensorfold,
 * Splash on Prometheus; EXL3 and SGLang JSON endpoints as fallbacks.
 * Ollama and LM Studio publish no counters, so their lanes are client-only.
 *
 * `pollGenerationRate` turns successive reads into a server tok/s figure
 * (Δgenerated / Δt every 400 ms), ignoring idle and reset samples.
 */

import {
  countersFromJson,
  countersFromPrometheus,
  engineFromPrometheus,
} from "../../agent/collectors/llmCounters.js";
import { median, round2, sleep } from "../collectors/LlmStreaming.js";

/** Engines with no cumulative counter endpoint. */
export const CLIENT_ONLY_BACKENDS = Object.freeze(["ollama", "lmstudio", "lm-studio", "lm studio"]);

export const SERVER_POLL_INTERVAL_MS = 400;

/** @param {string | null | undefined} backend */
export function hasServerCounters(backend) {
  if (!backend) return true; // unknown: try, and fall back to client-only if nothing answers
  return !CLIENT_ONLY_BACKENDS.includes(String(backend).toLowerCase());
}

/**
 * Cumulative generated tokens from an OpenAI-compatible engine, or null.
 * @param {string} baseUrl
 * @param {{ apiKey?: string | null, fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<{ generated: number, engine: string } | null>}
 */
export async function readGeneratedTokens(baseUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs ?? 3_000;
  /** @type {Record<string, string>} */
  const headers = {};
  const key = opts.apiKey != null ? String(opts.apiKey).trim() : "";
  if (key) headers.Authorization = `Bearer ${key}`;
  const get = async (path) => {
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
      return res.ok ? res : null;
    } catch {
      return null;
    }
  };

  const metrics = await get("/metrics");
  if (metrics) {
    const txt = await metrics.text().catch(() => "");
    const engine = engineFromPrometheus(txt);
    if (engine) {
      const c = countersFromPrometheus(engine, txt);
      if (c && Number.isFinite(c.generated)) return { generated: c.generated, engine };
    }
  }

  const health = await get("/health");
  if (health) {
    const data = await health.json().catch(() => null);
    // Same EXL3 detection as the agent: backend tag, or { ok, busy } health.
    if (data && (data.backend === "exl3" || (data.ok === true && typeof data.busy === "boolean"))) {
      const c = countersFromJson("exl3", data);
      if (c && Number.isFinite(c.generated)) return { generated: c.generated, engine: "exl3" };
    }
  }

  for (const path of ["/server_info", "/get_server_info"]) {
    const res = await get(path);
    if (!res) continue;
    const data = await res.json().catch(() => null);
    const v = Number(data?.total_output_tokens);
    if (data?.total_output_tokens != null && Number.isFinite(v)) return { generated: v, engine: "sglang" };
  }
  return null;
}

/**
 * Poll a counter reader and report server generation tok/s until `signal` aborts.
 * A sample counts only when the counter moved forward within 10 s of the last read.
 *
 * @param {object} opts
 * @param {() => Promise<{ generated: number } | number | null>} opts.read
 * @param {AbortSignal} opts.signal
 * @param {number} [opts.intervalMs]
 * @param {() => number} [opts.now]  ms clock (default performance.now)
 * @param {(ms: number, signal: AbortSignal) => Promise<void>} [opts.wait]
 * @param {(s: { rate: number, median: number, max: number, samples: number }) => void} [opts.onSample]
 * @returns {Promise<{ median: number | null, max: number | null, samples: number, available: boolean }>}
 */
export async function pollGenerationRate({
  read,
  signal,
  intervalMs = SERVER_POLL_INTERVAL_MS,
  now = () => performance.now(),
  wait = sleep,
  onSample = null,
}) {
  const value = async () => {
    try {
      const r = await read();
      const v = typeof r === "number" ? r : r?.generated;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  };
  /** @type {number[]} */
  const rates = [];
  let available = false;
  let last = await value();
  let lastT = now();
  if (last != null) available = true;

  while (!signal.aborted) {
    try {
      await wait(intervalMs, signal);
    } catch {
      break;
    }
    const v = await value();
    const t = now();
    if (v == null) continue;
    available = true;
    if (last != null) {
      const dt = (t - lastT) / 1000;
      const d = v - last;
      if (dt > 0 && dt < 10 && d > 0) {
        const rate = d / dt;
        rates.push(rate);
        if (onSample) {
          try {
            onSample({ rate: round2(rate), median: round2(median(rates)), max: round2(Math.max(...rates)), samples: rates.length });
          } catch {
            /* non-fatal */
          }
        }
      }
    }
    last = v;
    lastT = t;
  }
  return rates.length
    ? { median: round2(median(rates)), max: round2(Math.max(...rates)), samples: rates.length, available }
    : { median: null, max: null, samples: 0, available };
}
