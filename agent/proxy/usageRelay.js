/**
 * usageRelay.js — opt-in LLM passthrough that meters per-request usage
 * (STAT4 #37).
 *
 * Engines without counters (Ollama, LM Studio, TabbyAPI, and llama.cpp when
 * started without --metrics) publish no token or latency totals. When a
 * client talks to such an engine through this relay, the relay copies every
 * byte through unchanged and reads what the response already says:
 *
 *   - OpenAI-style `usage` (prompt / completion / cached tokens), in a JSON
 *     body or the final SSE chunk;
 *   - Ollama native `/api/generate` and `/api/chat` totals (prompt_eval_count,
 *     prompt_eval_duration, eval_count, eval_duration; durations in ns);
 *   - llama.cpp `timings` (prompt_n, prompt_ms, predicted_n, predicted_ms,
 *     cache_n);
 *   - stream timing: time to the first content event (TTFT) and from the
 *     first to the last (decode time) for SSE and NDJSON streams.
 *
 * Totals use the agent's engine-neutral counter names (llmCounters.js), so
 * the dashboard windows them with the same EngineWindow as engine counters,
 * tagged as the separate `proxy` source tier. Engine counters win per field
 * when both exist (server/fleet/engineWindows.js).
 *
 * herd has no traffic proxy yet (agent/collectors/proxy.js only reports the
 * status of an external keepalive proxy). This is the minimal relay in SC11's
 * direction (#20, "LLM traffic only through the proxy"): off unless
 * LLM_PROXY is set, loopback-bound unless LLM_PROXY_BIND says otherwise, no
 * request or response rewriting, no guard / hold / refusal logic. A full
 * SC11 proxy can replace it and keep feeding the same snapshot fields.
 * The keep-the-relay-transparent rule follows hasso5703's keepalive-proxy
 * (dgx-spark-qwen38, MIT); no code is taken from it.
 *
 * Zero dependencies; Node 18+.
 */

import http from "node:http";
import { performance } from "node:perf_hooks";
import { counterMeta, counterRecord, num } from "../collectors/llmCounters.js";

/** Paths whose responses carry generation usage. Others pass through unmetered. */
export const METERED_PATHS = Object.freeze([
  "/v1/chat/completions",
  "/v1/completions",
  "/chat/completions",
  "/completions",
  "/api/generate",
  "/api/chat",
  "/completion",
  "/v1/messages",
]);

/** Largest non-stream body / stream line the meter reads (bytes). Longer ones pass through unread. */
export const MAX_PARSE_BYTES = 8 * 1024 * 1024;
const RECENT_MAX = 20;
const CLIENTS_MAX = 64;

/** @param {unknown} v */
function isObj(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * "18000:11434,18001:1234" → [{ listenPort: 18000, upstreamPort: 11434 }, …].
 * Invalid or duplicate listen ports are dropped.
 * @param {string | null | undefined} raw
 * @returns {{ listenPort: number, upstreamPort: number }[]}
 */
export function parseRelaySpec(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  const out = [];
  const seen = new Set();
  for (const part of raw.split(",")) {
    const m = /^\s*(\d{1,5})\s*:\s*(\d{1,5})\s*$/.exec(part);
    if (!m) continue;
    const listenPort = Number(m[1]);
    const upstreamPort = Number(m[2]);
    const ok = (p) => p >= 1 && p <= 65535;
    if (!ok(listenPort) || !ok(upstreamPort) || listenPort === upstreamPort || seen.has(listenPort)) continue;
    seen.add(listenPort);
    out.push({ listenPort, upstreamPort });
  }
  return out;
}

/** @param {string} url */
export function isMeteredPath(url) {
  const p = String(url || "").split("?")[0].replace(/\/+$/, "");
  return METERED_PATHS.includes(p);
}

/**
 * Does one response event carry generated content? OpenAI chat / completion
 * chunks, Ollama generate / chat lines, llama.cpp /completion lines.
 * @param {Record<string, any>} o
 */
function hasContent(o) {
  const nonEmpty = (s) => typeof s === "string" && s.length > 0;
  if (Array.isArray(o.choices)) {
    for (const c of o.choices) {
      if (!isObj(c)) continue;
      const d = isObj(c.delta) ? c.delta : null;
      if (d && (nonEmpty(d.content) || nonEmpty(d.reasoning_content) || nonEmpty(d.reasoning) || (Array.isArray(d.tool_calls) && d.tool_calls.length > 0))) {
        return true;
      }
      if (nonEmpty(c.text)) return true;
    }
  }
  if (nonEmpty(o.response) || nonEmpty(o.thinking)) return true;
  if (isObj(o.message) && (nonEmpty(o.message.content) || nonEmpty(o.message.thinking))) return true;
  if (nonEmpty(o.content) && o.stop !== true) return true; // llama.cpp /completion stream
  if (o.type === "content_block_delta") return true; // /v1/messages stream
  return false;
}

/**
 * Per-request observer. Feed it the response bytes as they pass and the
 * monotonic times they passed at; `finish` returns the request's usage.
 * @param {{ t0: number, contentType?: string, contentEncoding?: string }} init
 */
export function createRequestMeter({ t0, contentType = "", contentEncoding = "" }) {
  const ct = String(contentType).toLowerCase();
  const mode = ct.includes("text/event-stream") ? "sse" : ct.includes("ndjson") ? "ndjson" : ct.includes("json") ? "json" : "none";
  const encoded = contentEncoding !== "" && String(contentEncoding).toLowerCase() !== "identity";
  const readable = !encoded && mode !== "none";
  const decoder = new TextDecoder();
  let buf = "";
  let overflow = false;
  /** @type {number|null} */
  let tFirst = null;
  /** @type {number|null} */
  let tLast = null;
  let contentEvents = 0;
  /** @type {Record<string, any>} */
  const seen = { usage: null, timings: null, ollama: null, model: null };

  /** @param {Record<string, any>} o @param {number} t */
  function onEvent(o, t) {
    if (!isObj(o)) return;
    if (typeof o.model === "string") seen.model = o.model;
    // Merged: /v1/messages splits input (message_start) and output (message_delta).
    if (isObj(o.usage)) seen.usage = { ...seen.usage, ...o.usage };
    if (o.type === "message_start" && isObj(o.message) && isObj(o.message.usage)) seen.usage = { ...seen.usage, ...o.message.usage };
    if (isObj(o.timings)) seen.timings = o.timings;
    if (o.done === true && (o.eval_count != null || o.prompt_eval_count != null)) seen.ollama = o;
    if (mode !== "json" && hasContent(o)) {
      contentEvents += 1;
      if (tFirst == null) tFirst = t;
      tLast = t;
    }
  }

  /** @param {string} line @param {number} t */
  function onLine(line, t) {
    let s = line.trim();
    if (mode === "sse") {
      if (!s.startsWith("data:")) return;
      s = s.slice(5).trim();
      if (s === "[DONE]") return;
    }
    if (s === "" || s[0] !== "{") return;
    try {
      onEvent(JSON.parse(s), t);
    } catch {
      /* not JSON: pass through unread */
    }
  }

  return {
    /** @param {Uint8Array} chunk @param {number} t */
    chunk(chunk, t) {
      if (!readable || overflow) return;
      buf += decoder.decode(chunk, { stream: true });
      if (mode === "json") {
        if (buf.length > MAX_PARSE_BYTES) {
          overflow = true;
          buf = "";
        }
        return;
      }
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, nl), t);
        buf = buf.slice(nl + 1);
      }
      if (buf.length > MAX_PARSE_BYTES) buf = ""; // one line too long: skip it
    },
    /**
     * @param {{ status: number, t: number, aborted?: boolean }} end
     * @returns {RequestUsage}
     */
    finish({ status, t, aborted = false }) {
      if (readable && !overflow) {
        buf += decoder.decode();
        if (mode === "json") {
          try {
            onEvent(JSON.parse(buf), t);
          } catch {
            /* unreadable body */
          }
        } else if (buf.trim() !== "") onLine(buf, t);
      }
      buf = "";
      return usageOf({ status, aborted, t0, tEnd: t, tFirst, tLast, contentEvents, seen, stream: mode === "sse" || mode === "ndjson" });
    },
  };
}

/**
 * @typedef {{
 *   status: number, ok: boolean, aborted: boolean, model: string|null, stream: boolean,
 *   promptTokens: number|null, completionTokens: number|null, cachedTokens: number|null,
 *   completionEstimated: boolean,
 *   ttftS: number|null, e2eS: number,
 *   decode: { tokens: number, first: number, seconds: number, from: "engine"|"stream" } | null,
 *   prefill: { tokens: number, seconds: number } | null,
 * }} RequestUsage
 */

/** @returns {RequestUsage} */
function usageOf({ status, aborted, t0, tEnd, tFirst, tLast, contentEvents, seen, stream }) {
  const u = isObj(seen.usage) ? seen.usage : {};
  const tm = isObj(seen.timings) ? seen.timings : {};
  const ol = isObj(seen.ollama) ? seen.ollama : {};
  const details = isObj(u.prompt_tokens_details) ? u.prompt_tokens_details : {};

  const cacheN = num(tm.cache_n);
  const promptN = num(tm.prompt_n);
  const llamaPrompt = promptN != null ? promptN + (cacheN ?? 0) : null;
  // Anthropic-style usage: input_tokens excludes cache reads.
  const anthropicPrompt =
    num(u.input_tokens) != null ? num(u.input_tokens) + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0) : null;
  const promptTokens = num(u.prompt_tokens) ?? anthropicPrompt ?? num(ol.prompt_eval_count) ?? llamaPrompt;
  const cachedTokens = num(details.cached_tokens) ?? num(u.cached_tokens) ?? num(u.cache_read_input_tokens) ?? cacheN;
  let completionTokens = num(u.completion_tokens) ?? num(u.output_tokens) ?? num(ol.eval_count) ?? num(tm.predicted_n);
  let completionEstimated = false;
  if (completionTokens == null && stream && contentEvents > 0) {
    // No usage in the stream: one content event ≈ one token.
    completionTokens = contentEvents;
    completionEstimated = true;
  }

  /** @type {RequestUsage["decode"]} */
  let decode = null;
  const evalN = num(ol.eval_count);
  const evalNs = num(ol.eval_duration);
  const predN = num(tm.predicted_n);
  const predMs = num(tm.predicted_ms);
  if (evalN != null && evalNs != null && evalNs > 0) decode = { tokens: evalN, first: 0, seconds: evalNs / 1e9, from: "engine" };
  else if (predN != null && predMs != null && predMs > 0) decode = { tokens: predN, first: 0, seconds: predMs / 1000, from: "engine" };
  else if (stream && tFirst != null && tLast != null && tLast > tFirst && completionTokens != null && completionTokens > 1) {
    // Stream timing: tokens after the first, over first → last content event.
    decode = { tokens: completionTokens, first: 1, seconds: (tLast - tFirst) / 1000, from: "stream" };
  }

  /** @type {RequestUsage["prefill"]} */
  let prefill = null;
  const pN = num(ol.prompt_eval_count);
  const pNs = num(ol.prompt_eval_duration);
  const pMs = num(tm.prompt_ms);
  if (pN != null && pNs != null && pNs > 0) prefill = { tokens: pN, seconds: pNs / 1e9 };
  else if (promptN != null && pMs != null && pMs > 0) prefill = { tokens: promptN, seconds: pMs / 1000 };

  const ok = status >= 200 && status < 300 && !aborted;
  return {
    status,
    ok,
    aborted,
    model: seen.model,
    stream,
    promptTokens,
    completionTokens,
    cachedTokens,
    completionEstimated,
    ttftS: stream && tFirst != null ? (tFirst - t0) / 1000 : null,
    e2eS: Math.max(0, (tEnd - t0) / 1000),
    decode,
    prefill,
  };
}

const round = (v, d = 4) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * Cumulative usage of one relay: engine-neutral counters, per-client totals,
 * the latest requests, and requests in flight.
 * @param {{ listenPort?: number|null, upstreamPort?: number|null }} [ids]
 */
export function createUsageLedger({ listenPort = null, upstreamPort = null } = {}) {
  /** @type {Record<string, number|null>} */
  const c = {
    generated: null, prompt: null, cached: null, decoded: null, first: null, itlSum: null,
    prefillComputed: null, prefillSeconds: null, ttftSum: null, ttftCount: null,
    e2eSum: null, e2eCount: null, requestsFinished: null,
  };
  const add = (k, v) => {
    if (v == null || !Number.isFinite(v)) return;
    c[k] = (c[k] ?? 0) + v;
  };
  let inFlight = 0;
  let requests = 0;
  let errors = 0;
  let estimated = 0;
  /** @type {Map<string, { client: string, requests: number, errors: number, prompt: number, generated: number, lastSeenMs: number }>} */
  const clients = new Map();
  /** @type {object[]} */
  const recent = [];

  return {
    begin() {
      inFlight += 1;
    },
    /**
     * @param {RequestUsage} r
     * @param {{ client?: string, path?: string, wallMs?: number }} [ctx]
     */
    record(r, ctx = {}) {
      inFlight = Math.max(0, inFlight - 1);
      requests += 1;
      const client = ctx.client || "unknown";
      let cl = clients.get(client);
      if (!cl) {
        if (clients.size >= CLIENTS_MAX) {
          let oldest = null;
          for (const v of clients.values()) if (!oldest || v.lastSeenMs < oldest.lastSeenMs) oldest = v;
          if (oldest) clients.delete(oldest.client);
        }
        cl = { client, requests: 0, errors: 0, prompt: 0, generated: 0, lastSeenMs: 0 };
        clients.set(client, cl);
      }
      cl.requests += 1;
      cl.lastSeenMs = ctx.wallMs ?? Date.now();
      if (!r.ok) {
        errors += 1;
        cl.errors += 1;
      } else {
        add("requestsFinished", 1);
        add("prompt", r.promptTokens);
        add("cached", r.cachedTokens);
        add("generated", r.completionTokens);
        if (r.completionEstimated) estimated += 1;
        if (r.decode) {
          add("decoded", r.decode.tokens);
          add("first", r.decode.first);
          add("itlSum", r.decode.seconds);
        }
        if (r.prefill) {
          add("prefillComputed", r.prefill.tokens);
          add("prefillSeconds", r.prefill.seconds);
        }
        if (r.ttftS != null) {
          add("ttftSum", r.ttftS);
          add("ttftCount", 1);
        }
        add("e2eSum", r.e2eS);
        add("e2eCount", 1);
        cl.prompt += r.promptTokens ?? 0;
        cl.generated += r.completionTokens ?? 0;
      }
      recent.push({
        wallMs: ctx.wallMs ?? Date.now(),
        client,
        path: ctx.path ?? null,
        model: r.model,
        status: r.status,
        aborted: r.aborted,
        stream: r.stream,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        cachedTokens: r.cachedTokens,
        completionEstimated: r.completionEstimated,
        ttftS: round(r.ttftS),
        decodeS: round(r.decode?.seconds ?? null),
        decodeFrom: r.decode?.from ?? null,
        e2eS: round(r.e2eS),
      });
      if (recent.length > RECENT_MAX) recent.shift();
    },
    /**
     * Snapshot for telemetry.
     * @param {Parameters<typeof counterMeta>[1]} [clock]
     */
    snapshot(clock) {
      const counters = counterRecord(c);
      return {
        listenPort,
        upstreamPort,
        counters,
        meta: counters ? counterMeta("proxy", clock) : null,
        inFlight,
        requests,
        errors,
        estimatedRequests: estimated,
        clients: [...clients.values()].sort((a, b) => b.lastSeenMs - a.lastSeenMs).map((x) => ({ ...x })),
        recent: recent.map((x) => ({ ...x })),
      };
    },
  };
}

/** Hop-by-hop headers a proxy must not forward (RFC 9110 §7.6.1). */
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate"]);

function forwardHeaders(h) {
  /** @type {Record<string, string|string[]>} */
  const out = {};
  for (const [k, v] of Object.entries(h)) if (v != null && !HOP.has(k.toLowerCase())) out[k] = v;
  return out;
}

/**
 * One relay: listens on `listenPort`, forwards every request to
 * `upstreamHost:upstreamPort` byte for byte, meters generation responses.
 * @param {{ listenPort: number, upstreamPort: number, upstreamHost?: string, bind?: string,
 *   now?: () => number, wallNow?: () => number }} opts
 */
export function createUsageRelay({ listenPort, upstreamPort, upstreamHost = "127.0.0.1", bind = "127.0.0.1", now = () => performance.now(), wallNow = () => Date.now() }) {
  const ledger = createUsageLedger({ listenPort, upstreamPort });
  /** @type {http.Server|null} */
  let server = null;

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  function handle(req, res) {
    const t0 = now();
    const metered = req.method === "POST" && isMeteredPath(req.url);
    const client = req.socket?.remoteAddress ?? "unknown";
    let done = false;
    /** @type {ReturnType<typeof createRequestMeter> | null} */
    let meter = null;
    if (metered) ledger.begin();
    const finish = (status, aborted) => {
      if (done || !metered) return;
      done = true;
      const m = meter ?? createRequestMeter({ t0 });
      ledger.record(m.finish({ status, t: now(), aborted }), { client, path: req.url.split("?")[0], wallMs: wallNow() });
    };

    const up = http.request(
      { host: upstreamHost, port: upstreamPort, method: req.method, path: req.url, headers: forwardHeaders(req.headers) },
      (upRes) => {
        const status = upRes.statusCode ?? 502;
        if (metered) {
          meter = createRequestMeter({
            t0,
            contentType: String(upRes.headers["content-type"] ?? ""),
            contentEncoding: String(upRes.headers["content-encoding"] ?? ""),
          });
          upRes.on("data", (chunk) => meter.chunk(chunk, now()));
        }
        res.writeHead(status, upRes.statusMessage, forwardHeaders(upRes.headers));
        upRes.pipe(res);
        upRes.on("end", () => finish(status, false));
        upRes.on("aborted", () => finish(status, true));
        upRes.on("error", () => finish(status, true));
      }
    );
    up.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "upstream unavailable" }));
      } else res.destroy();
      finish(502, false);
    });
    // Client gone before the answer ended: stop the upstream request too.
    res.on("close", () => {
      if (!res.writableFinished) {
        up.destroy();
        finish(res.statusCode || 499, true);
      }
    });
    req.pipe(up);
  }

  return {
    listenPort,
    upstreamPort,
    ledger,
    /** @returns {Promise<{ port: number, address: string }>} */
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer(handle);
        server.once("error", reject);
        server.listen(listenPort, bind, () => {
          const a = server.address();
          resolve({ port: typeof a === "object" && a ? a.port : listenPort, address: bind });
        });
      });
    },
    /** @returns {Promise<void>} */
    stop() {
      return new Promise((resolve) => {
        if (!server) return resolve();
        server.closeAllConnections?.();
        server.close(() => resolve());
        server = null;
      });
    },
  };
}

/**
 * All relays from env: LLM_PROXY="listen:upstream,…", LLM_PROXY_BIND
 * (default 127.0.0.1). Empty LLM_PROXY → no relays.
 * @param {Record<string, string|undefined>} [env]
 */
export function createUsageRelays(env = process.env) {
  const bind = env.LLM_PROXY_BIND || "127.0.0.1";
  const relays = parseRelaySpec(env.LLM_PROXY).map((s) => createUsageRelay({ ...s, bind }));
  return {
    relays,
    async start() {
      const out = [];
      for (const r of relays) {
        try {
          out.push({ ...(await r.start()), upstreamPort: r.upstreamPort });
        } catch (e) {
          console.warn(`[node-agent] LLM usage relay :${r.listenPort} → :${r.upstreamPort} failed to start: ${String(e?.message ?? e)}`);
        }
      }
      return out;
    },
    async stop() {
      await Promise.all(relays.map((r) => r.stop()));
    },
    /** @param {object} [clock] */
    snapshot(clock) {
      return relays.map((r) => r.ledger.snapshot(clock));
    },
  };
}

/**
 * Attach relay usage to the LLM probe entries whose port a relay forwards to.
 * Entries without a relay are returned unchanged.
 * @param {object[]} llm
 * @param {ReturnType<ReturnType<typeof createUsageLedger>["snapshot"]>[]} relays
 */
export function attachProxyUsage(llm, relays) {
  if (!Array.isArray(llm) || !Array.isArray(relays) || relays.length === 0) return llm;
  return llm.map((e) => {
    if (!isObj(e)) return e;
    const mine = relays.filter((r) => r.upstreamPort === e.port);
    if (mine.length === 0) return e;
    // Several relays to one engine: sum their counters.
    let counters = null;
    let meta = null;
    let inFlight = 0;
    for (const r of mine) {
      inFlight += r.inFlight;
      if (!r.counters) continue;
      meta = r.meta;
      counters = counters
        ? Object.fromEntries(Object.entries(counters).map(([k, v]) => [k, v == null && r.counters[k] == null ? null : (v ?? 0) + (r.counters[k] ?? 0)]))
        : { ...r.counters };
    }
    return { ...e, proxyCounters: counters, proxyCountersMeta: meta, proxyInFlight: inFlight };
  });
}
