/**
 * FleetShowcaseManager — one Prompt Showcase across many LLM lanes at once
 * (SHOW1, #39). Herd's own implementation (MIT), written from the issue spec.
 *
 * A session runs the same prompt set on every selected lane (an SSH Spark
 * port or a node-agent port, any engine): N terminals per lane, all lanes
 * concurrently. Per lane it reports
 *
 *   client timing (every engine) from the streamed responses:
 *     tokens   usage.completion_tokens (stream_options.include_usage), else
 *              the ~4 chars/token estimate
 *     decode   per stream (tokens − 1) / (t_last − t_first)
 *     TTFT     first streamed token − request sent
 *     prefill  prompt_tokens / TTFT
 *     lane tok/s = Σ decode tokens / (max t_last − min t_first)  (SHOW2:
 *              the concurrent-window aggregate, same as DecodeBench; also
 *              pooled per engine and fleet-wide, each with its peak)
 *     estimated  tokens counted from characters are flagged per stream and
 *              carried into every aggregate they feed
 *   server timing where the engine has a generation counter: Δgenerated / Δt
 *     sampled every 400 ms (serverCounters.js). Ollama / LM Studio: client only.
 *
 * Finished sessions are archived (bounded) and handed to `resultSink`, which
 * writes one bench row per lane (source "showcase").
 * Live sessions need a poll at least every 5 s or they are cancelled.
 */

import { randomUUID } from "crypto";
import fs from "fs";
import { atomicWrite } from "../util/atomicWrite.js";
import {
  applyThinkingFlags,
  coerceThinkingFlag,
  llmEndpoint,
  median,
  round2,
  runStreamingRequest,
  stripFillForceFields,
} from "../collectors/LlmStreaming.js";
import { withFillToMaxInstruction } from "../../src/shared/llmPrompts.js";
import { pollGenerationRate, readGeneratedTokens, SERVER_POLL_INTERVAL_MS } from "./serverCounters.js";
import { AggregatePeak, aggregateView, CHARS_PER_TOKEN, concurrentWindow, sampleDue } from "./aggregate.js";

export const FLEET_SHOWCASE_LIMITS = Object.freeze({
  minLanes: 1,
  maxLanes: 16,
  minPrompts: 1,
  maxPrompts: 16,
  maxStreams: 64,
  minPromptLen: 1,
  maxPromptLen: 4000,
  defaultMaxTokens: 512,
  minMaxTokens: 64,
  maxMaxTokens: 2048,
  defaultTemperature: 0.7,
  minTemperature: 0,
  maxTemperature: 2,
  heartbeatTimeoutMs: 5_000,
  historyLimit: 10,
  historyTextChars: 4_000,
  perRequestTimeoutMs: 360_000,
});

const PROMPT_TYPES = new Set(["structural", "text", "mixed"]);
const TERMINAL = new Set(["completed", "error", "cancelled"]);
const LABEL_CHARS = 40;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function labelFromPrompt(prompt) {
  const s = String(prompt || "").replace(/\s+/g, " ").trim();
  return s.length <= LABEL_CHARS ? s : `${s.slice(0, LABEL_CHARS - 1)}…`;
}

const pos = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Tokens came from the ~4 chars/token estimate (live counts always do until usage arrives). */
export function isEstimated(s) {
  return (s?.tokenCount || 0) > 0 && s.tokenSource !== "usage";
}

function windowOf(streams) {
  return concurrentWindow(
    streams.map((s) => ({ tFirst: s._tFirst, tLast: s._tLast, tokens: s.tokenCount, estimated: isEstimated(s), status: s.status }))
  );
}

/** Engine key for the per-engine aggregate. */
export function engineKey(lane) {
  return lane.serverEngine || lane.backend || "unknown";
}

/**
 * Concurrent-window aggregates pooled per engine and fleet-wide (SHOW2).
 * Peaks come from `session._aggPeaks` (sampled while running).
 * @param {any} session
 */
export function sessionAggregates(session) {
  const peaks = session._aggPeaks || new Map();
  const byEngine = new Map();
  for (const lane of session.lanes) {
    const key = engineKey(lane);
    if (!byEngine.has(key)) byEngine.set(key, []);
    byEngine.get(key).push(lane);
  }
  const engines = [...byEngine.entries()]
    .map(([engine, lanes]) => ({
      engine,
      laneIds: lanes.map((l) => l.laneId),
      ...aggregateView(windowOf(lanes.flatMap((l) => l.streams)), peaks.get(`engine:${engine}`)),
    }))
    .sort((a, b) => a.engine.localeCompare(b.engine));
  return {
    fleet: aggregateView(windowOf(session.lanes.flatMap((l) => l.streams)), peaks.get("fleet")),
    engines,
  };
}

/**
 * Client + server figures for one lane (live or final).
 * @param {any} lane
 */
export function laneSummary(lane) {
  const streams = lane.streams || [];
  const ok = streams.filter((s) => s.status === "completed" && s.tokenCount > 0);
  // SHOW2: the concurrent-window aggregate, live (t_last so far) and final.
  const win = windowOf(streams);
  const aggregate = aggregateView(win, lane._aggPeak);
  const rates = streams.map((s) => s.decodeTps || s.liveTokPerSec || 0).filter(pos);
  const ttfts = streams.map((s) => s.ttftMs).filter(pos);
  const prefills = ok.map((s) => s.prefillTps).filter(pos);
  const sources = new Set(ok.map((s) => s.tokenSource).filter(Boolean));
  return {
    clientTps: aggregate.tps,
    clientTpsPeak: aggregate.peakTps,
    estimated: aggregate.estimated,
    aggregate,
    streamTpsMean: rates.length ? round2(rates.reduce((a, b) => a + b, 0) / rates.length) : null,
    ttftP50Ms: ttfts.length ? round2(median(ttfts)) : null,
    prefillTps: prefills.length ? round2(prefills.reduce((a, b) => a + b, 0) / prefills.length) : null,
    totalTokens: streams.reduce((n, s) => n + (s.tokenCount || 0), 0),
    streamsDone: streams.filter((s) => TERMINAL.has(s.status)).length,
    streamsOk: ok.length,
    streamCount: streams.length,
    tokenSource: sources.size === 0 ? null : sources.size === 1 ? [...sources][0] : "mixed",
  };
}

function publicLane(lane, streams) {
  return {
    laneId: lane.laneId,
    kind: lane.kind,
    nodeId: lane.nodeId,
    nodeName: lane.nodeName,
    host: lane.host,
    port: lane.port,
    modelId: lane.modelId,
    backend: lane.backend,
    via: lane.via,
    status: lane.status,
    statusText: lane.statusText ?? null,
    error: lane.error,
    serverCounters: lane.serverCounters,
    serverTps: lane.serverTps,
    serverTpsMax: lane.serverTpsMax,
    serverSamples: lane.serverSamples,
    serverEngine: lane.serverEngine ?? null,
    ...laneSummary(lane),
    streams,
  };
}

function streamFields(s) {
  return {
    streamId: s.streamId,
    label: s.label,
    prompt: s.prompt,
    status: s.status,
    contentLength: s.content.length,
    reasoningLength: s.reasoning.length,
    tokenCount: s.tokenCount,
    tokenSource: s.tokenSource,
    estimated: isEstimated(s),
    promptTokenSource: s.promptTokenSource,
    ttftMs: s.ttftMs,
    decodeTps: s.decodeTps,
    prefillTps: s.prefillTps,
    prefillTokens: s.prefillTokens,
    liveTokPerSec: s.liveTokPerSec,
    peakTokPerSec: s.peakTokPerSec,
    model: s.model,
    error: s.error,
  };
}

function sessionHead(session) {
  return {
    sessionId: session.sessionId,
    status: session.status,
    rev: session.rev,
    maxTokens: session.maxTokens,
    temperature: session.temperature,
    thinking: session.thinking,
    promptType: session.promptType,
    prompts: session.prompts,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    error: session.error,
    aggregates: sessionAggregates(session),
  };
}

/** Archived record: stream text kept but capped. */
function archiveRecord(session) {
  const cap = FLEET_SHOWCASE_LIMITS.historyTextChars;
  return {
    ...sessionHead(session),
    lanes: session.lanes.map((lane) =>
      publicLane(
        lane,
        lane.streams.map((s) => ({
          ...streamFields(s),
          content: s.content.slice(0, cap),
          reasoning: s.reasoning.slice(0, cap),
        }))
      )
    ),
    fromHistory: true,
  };
}

function historySummary(rec) {
  const lanes = Array.isArray(rec.lanes) ? rec.lanes : [];
  return {
    sessionId: rec.sessionId,
    status: rec.status,
    startedAt: rec.startedAt ?? null,
    completedAt: rec.completedAt ?? null,
    promptType: rec.promptType ?? null,
    maxTokens: rec.maxTokens ?? null,
    laneCount: lanes.length,
    fleetTps: rec.aggregates?.fleet?.tps ?? null,
    fleetPeakTps: rec.aggregates?.fleet?.peakTps ?? null,
    fleetPeakEstimated: Boolean(rec.aggregates?.fleet?.peakEstimated),
    fleetEstimated: Boolean(rec.aggregates?.fleet?.estimated),
    streamsPerLane: Array.isArray(rec.prompts) ? rec.prompts.length : 0,
    lanes: lanes.map((l) => ({
      laneId: l.laneId,
      nodeName: l.nodeName,
      port: l.port,
      modelId: l.modelId ?? null,
      backend: l.backend ?? null,
      clientTps: l.clientTps ?? null,
      clientTpsPeak: l.clientTpsPeak ?? null,
      estimated: Boolean(l.estimated),
      serverTps: l.serverTps ?? null,
      ttftP50Ms: l.ttftP50Ms ?? null,
      status: l.status,
    })),
    error: rec.error ?? null,
  };
}

export class FleetShowcaseManager {
  /**
   * @param {object} [opts]
   * @param {string | null} [opts.historyPath]  null = no persistence
   * @param {typeof runStreamingRequest} [opts.runStream]
   * @param {(baseUrl: string, o: { apiKey?: string | null }) => Promise<{ generated: number, engine: string } | null>} [opts.readCounter]
   * @param {(ms: number, signal: AbortSignal) => Promise<void>} [opts.wait]   poller sleep (tests)
   * @param {number} [opts.pollIntervalMs]
   * @param {() => number} [opts.now]  wall clock (ms)
   * @param {boolean} [opts.heartbeat]  run the 5 s heartbeat watch (default true)
   */
  constructor(opts = {}) {
    this.historyPath = opts.historyPath ?? null;
    this._streamFn = opts.runStream || runStreamingRequest;
    this._readCounter = opts.readCounter || readGeneratedTokens;
    this._wait = opts.wait;
    this._pollMs = opts.pollIntervalMs ?? SERVER_POLL_INTERVAL_MS;
    this._now = opts.now || (() => Date.now());
    /** @type {Map<string, any>} */
    this.sessions = new Map();
    /** @type {string | null} */
    this.activeId = null;
    /** @type {any[]} newest first */
    this.history = [];
    /** @type {((record: any) => void) | null} */
    this.resultSink = null;
    /** @type {((session: any) => void) | null} */
    this.eventSink = null;
    this._timer = null;
    this._loadHistory();
    if (opts.heartbeat !== false) {
      this._timer = setInterval(() => this.checkHeartbeats(), 1_000);
      this._timer.unref?.();
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this.activeId) this.cancel(this.activeId, "Server shutting down");
  }

  _loadHistory() {
    if (!this.historyPath) return;
    try {
      if (!fs.existsSync(this.historyPath)) return;
      const data = JSON.parse(fs.readFileSync(this.historyPath, "utf8"));
      const list = Array.isArray(data?.sessions) ? data.sessions : [];
      this.history = list
        .filter((r) => r && typeof r === "object" && typeof r.sessionId === "string" && Array.isArray(r.lanes))
        .slice(0, FLEET_SHOWCASE_LIMITS.historyLimit)
        .map((r) => ({ ...r, status: r.status === "running" ? "cancelled" : r.status, fromHistory: true }));
    } catch (err) {
      console.warn("[fleet-showcase] failed to load history:", err?.message || err);
    }
  }

  _saveHistory() {
    if (!this.historyPath) return;
    try {
      atomicWrite(this.historyPath, JSON.stringify({ schema: 1, sessions: this.history }, null, 2), 0o600);
    } catch (err) {
      console.warn("[fleet-showcase] failed to save history:", err?.message || err);
    }
  }

  getActive() {
    const s = this.activeId ? this.sessions.get(this.activeId) : null;
    return s && s.status === "running" ? { sessionId: s.sessionId, status: s.status } : null;
  }

  /** Spark ids with a lane in the running session (the per-Spark benches refuse them). */
  busySparkIds() {
    const s = this.activeId ? this.sessions.get(this.activeId) : null;
    if (!s || s.status !== "running") return new Set();
    return new Set(s.lanes.filter((l) => l.kind === "spark").map((l) => l.nodeId));
  }

  getHistory() {
    return this.history.map(historySummary);
  }

  clearHistory() {
    if (this.getActive()) throw httpError(409, "Cannot clear history while a fleet showcase is running");
    this.history = [];
    for (const [id, s] of this.sessions) if (s.status !== "running") this.sessions.delete(id);
    this._saveHistory();
  }

  checkHeartbeats() {
    const s = this.activeId ? this.sessions.get(this.activeId) : null;
    if (s && s.status === "running" && this._now() - s._lastTouchAt >= FLEET_SHOWCASE_LIMITS.heartbeatTimeoutMs) {
      this.cancel(s.sessionId, "Heartbeat timeout");
    }
  }

  /**
   * @param {object} opts
   * @param {Array<{ laneId: string, kind: "spark"|"node", nodeId: string, nodeName?: string, host?: string|null, port: number,
   *   modelId?: string|null, backend?: string|null, serverCounters?: boolean, apiKey?: string|null,
   *   resolveTarget: (o: { signal: AbortSignal, onStatus: (m: string) => void }) => Promise<{ host: string, port: number, tls?: boolean, via?: string, close?: () => void }> }>} opts.lanes
   * @param {string[]} opts.prompts   shared prompt set: one terminal per prompt on every lane
   * @param {number} [opts.maxTokens]
   * @param {number} [opts.temperature]
   * @param {boolean} [opts.thinking]
   * @param {string | null} [opts.promptType]
   */
  start(opts) {
    const L = FLEET_SHOWCASE_LIMITS;
    if (this.getActive()) throw httpError(409, "A fleet showcase is already running");
    const lanesIn = Array.isArray(opts?.lanes) ? opts.lanes : [];
    if (lanesIn.length < L.minLanes || lanesIn.length > L.maxLanes) {
      throw httpError(400, `Pick ${L.minLanes}–${L.maxLanes} lanes`);
    }
    const ids = new Set(lanesIn.map((l) => l.laneId));
    if (ids.size !== lanesIn.length) throw httpError(400, "Duplicate lane");
    const prompts = normalizePrompts(opts.prompts);
    if (!prompts) {
      throw httpError(400, `prompts must be ${L.minPrompts}–${L.maxPrompts} strings of ${L.minPromptLen}–${L.maxPromptLen} chars`);
    }
    if (prompts.length * lanesIn.length > L.maxStreams) {
      throw httpError(400, `At most ${L.maxStreams} streams per session (lanes × terminals)`);
    }
    let maxTokens = Number(opts.maxTokens ?? L.defaultMaxTokens);
    if (!Number.isFinite(maxTokens)) maxTokens = L.defaultMaxTokens;
    maxTokens = Math.round(maxTokens);
    if (maxTokens < L.minMaxTokens || maxTokens > L.maxMaxTokens) {
      throw httpError(400, `maxTokens must be between ${L.minMaxTokens} and ${L.maxMaxTokens}`);
    }
    let temperature = Number(opts.temperature ?? L.defaultTemperature);
    if (!Number.isFinite(temperature)) temperature = L.defaultTemperature;
    temperature = Math.round(temperature * 100) / 100;
    if (temperature < L.minTemperature || temperature > L.maxTemperature) {
      throw httpError(400, `temperature must be between ${L.minTemperature} and ${L.maxTemperature}`);
    }
    for (const l of lanesIn) {
      if (typeof l.resolveTarget !== "function") throw httpError(400, `Lane ${l.laneId} has no target`);
    }

    const now = this._now();
    const session = {
      sessionId: randomUUID(),
      status: "running",
      rev: 0,
      maxTokens,
      temperature,
      thinking: coerceThinkingFlag(opts.thinking),
      promptType: typeof opts.promptType === "string" && PROMPT_TYPES.has(opts.promptType) ? opts.promptType : null,
      prompts,
      startedAt: now,
      completedAt: null,
      error: null,
      _abort: new AbortController(),
      _lastTouchAt: now,
      /** @type {Map<string, [number, number]>} sent content / reasoning lengths per stream */
      _sent: new Map(),
      lanes: lanesIn.map((l, li) => ({
        laneId: l.laneId,
        kind: l.kind,
        nodeId: l.nodeId,
        nodeName: l.nodeName || l.nodeId,
        host: l.host ?? null,
        port: l.port,
        modelId: l.modelId ?? null,
        backend: l.backend ?? null,
        via: null,
        status: "pending",
        statusText: null,
        error: null,
        serverCounters: l.serverCounters !== false,
        serverTps: null,
        serverTpsMax: null,
        serverSamples: 0,
        serverEngine: null,
        _apiKey: l.apiKey ?? null,
        _resolve: l.resolveTarget,
        streams: prompts.map((prompt, i) => ({
          streamId: `${li}:${i}`,
          label: labelFromPrompt(prompt),
          prompt,
          status: "pending",
          content: "",
          reasoning: "",
          tokenCount: 0,
          tokenSource: null,
          promptTokenSource: null,
          ttftMs: null,
          decodeTps: 0,
          prefillTps: null,
          prefillTokens: null,
          liveTokPerSec: 0,
          peakTokPerSec: 0,
          model: null,
          error: null,
          _t0: null,
          _tFirst: null,
          _tLast: null,
        })),
      })),
    };
    this.sessions.set(session.sessionId, session);
    this.activeId = session.sessionId;
    this._emitEvent(session);
    session._done = this._run(session).catch((err) => {
      session.error = session.error || String(err?.message || err);
    });
    return { sessionId: session.sessionId, status: "running" };
  }

  /** Resolves when the session has settled (tests / shutdown). */
  async settled(sessionId) {
    await this.sessions.get(sessionId)?._done;
  }

  /**
   * Live snapshot; with `since`, stream text is sent as appends since the
   * last poll. Archived sessions return their full record.
   * @param {string} sessionId
   * @param {number | null} [since]
   */
  getSession(sessionId, since = null) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      const rec = this.history.find((r) => r.sessionId === sessionId);
      return rec ? { ...rec, fromHistory: true } : null;
    }
    session._lastTouchAt = this._now();
    const full = since == null || !Number.isFinite(Number(since));
    return {
      ...sessionHead(session),
      lanes: session.lanes.map((lane) =>
        publicLane(
          lane,
          lane.streams.map((s) => {
            const [sentC, sentR] = full ? [0, 0] : session._sent.get(s.streamId) || [0, 0];
            const reset = !full && (sentC > s.content.length || sentR > s.reasoning.length);
            session._sent.set(s.streamId, [s.content.length, s.reasoning.length]);
            const out = { ...streamFields(s), resetContent: reset };
            if (full || reset) {
              out.content = s.content;
              out.reasoning = s.reasoning;
              out.contentAppend = "";
              out.reasoningAppend = "";
            } else {
              out.contentAppend = s.content.slice(sentC);
              out.reasoningAppend = s.reasoning.slice(sentR);
            }
            return out;
          })
        )
      ),
      fromHistory: false,
    };
  }

  cancel(sessionId, reason = "Cancelled by user") {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.status === "running") {
      session.status = "cancelled";
      session.error = reason;
      session.completedAt = this._now();
      for (const lane of session.lanes) {
        for (const s of lane.streams) {
          if (!TERMINAL.has(s.status)) {
            s.status = "cancelled";
            s.error = s.error || reason;
          }
        }
        if (!TERMINAL.has(lane.status)) lane.status = "cancelled";
      }
      session._abort.abort();
      this._bump(session);
      if (this.activeId === sessionId) this.activeId = null;
    }
    return this.getSession(sessionId);
  }

  _bump(session) {
    session.rev += 1;
  }

  /**
   * Feed lane / engine / fleet peaks (SHOW2). Throttled while running;
   * `final` always counts the settled aggregates.
   */
  _sampleAggregates(session, final = false) {
    if (!final && !sampleDue(session, performance.now())) return;
    if (!session._aggPeaks) session._aggPeaks = new Map();
    const peaks = session._aggPeaks;
    const feed = (holder, key, streams) => {
      let p = holder.get(key);
      if (!p) holder.set(key, (p = new AggregatePeak()));
      const win = windowOf(streams);
      if (final) p.final(win);
      else p.observe(win);
      return p;
    };
    const byEngine = new Map();
    for (const lane of session.lanes) {
      if (!lane._aggPeak) lane._aggPeak = new AggregatePeak();
      const win = windowOf(lane.streams);
      if (final) lane._aggPeak.final(win);
      else lane._aggPeak.observe(win);
      const key = engineKey(lane);
      if (!byEngine.has(key)) byEngine.set(key, []);
      byEngine.get(key).push(...lane.streams);
    }
    for (const [engine, streams] of byEngine) feed(peaks, `engine:${engine}`, streams);
    feed(peaks, "fleet", session.lanes.flatMap((l) => l.streams));
  }

  _emitEvent(session) {
    if (!this.eventSink) return;
    try {
      this.eventSink({
        sessionId: session.sessionId,
        status: session.status,
        lanes: session.lanes.map((l) => ({ laneId: l.laneId, nodeName: l.nodeName, port: l.port, modelId: l.modelId })),
        error: session.error,
      });
    } catch {
      /* a sink must not affect the run */
    }
  }

  async _run(session) {
    try {
      await Promise.all(session.lanes.map((lane) => this._runLane(session, lane)));
    } finally {
      if (session.status === "running") {
        const lanes = session.lanes;
        const anyOk = lanes.some((l) => l.streams.some((s) => s.status === "completed" && s.tokenCount > 0));
        session.status = anyOk ? "completed" : "error";
        if (!anyOk) {
          session.error =
            lanes.flatMap((l) => [l.error, ...l.streams.map((s) => s.error)]).find(Boolean) || "All streams failed";
        }
        session.completedAt = this._now();
        this._bump(session);
      }
      if (this.activeId === session.sessionId) this.activeId = null;
      this._sampleAggregates(session, true);
      this._archive(session);
    }
  }

  _archive(session) {
    const record = archiveRecord(session);
    this.history = [record, ...this.history.filter((r) => r.sessionId !== record.sessionId)].slice(
      0,
      FLEET_SHOWCASE_LIMITS.historyLimit
    );
    this._saveHistory();
    this._emitEvent(session);
    if (typeof this.resultSink === "function") {
      try {
        this.resultSink(record);
      } catch (err) {
        console.warn(`[bench-results] fleet showcase sink failed: ${err?.message || err}`);
      }
    }
    // Live shell no longer needed; history serves later reads.
    this.sessions.delete(session.sessionId);
  }

  async _runLane(session, lane) {
    const signal = session._abort.signal;
    let target;
    lane.status = "connecting";
    this._bump(session);
    try {
      target = await lane._resolve({
        signal,
        onStatus: (m) => {
          lane.statusText = m;
          this._bump(session);
        },
      });
    } catch (err) {
      if (lane.status !== "cancelled") {
        lane.status = "error";
        lane.error = String(err?.message || err);
        for (const s of lane.streams) {
          s.status = "error";
          s.error = lane.error;
        }
      }
      this._bump(session);
      return;
    }
    if (signal.aborted) {
      target?.close?.();
      return;
    }

    let endpoint;
    try {
      endpoint = llmEndpoint({ ...target, apiKey: lane._apiKey });
    } catch (err) {
      target?.close?.();
      lane.status = "error";
      lane.error = String(err?.message || err);
      for (const s of lane.streams) Object.assign(s, { status: "error", error: lane.error });
      this._bump(session);
      return;
    }
    lane.via = target.via || "direct";
    lane.status = "running";
    lane.statusText = null;
    this._bump(session);

    const pollAbort = new AbortController();
    const stopPoll = () => pollAbort.abort();
    signal.addEventListener("abort", stopPoll, { once: true });
    const pollPromise = lane.serverCounters
      ? pollGenerationRate({
          read: async () => {
            const r = await this._readCounter(endpoint.baseUrl, { apiKey: endpoint.apiKey });
            if (r?.engine && !lane.serverEngine) lane.serverEngine = r.engine;
            return r;
          },
          signal: pollAbort.signal,
          intervalMs: this._pollMs,
          ...(this._wait ? { wait: this._wait } : {}),
          onSample: (info) => {
            if (session.status !== "running") return;
            lane.serverTps = info.median;
            lane.serverTpsMax = info.max;
            lane.serverSamples = info.samples;
            this._bump(session);
          },
        })
      : Promise.resolve(null);

    try {
      await Promise.all(lane.streams.map((stream) => this._runStream(session, lane, stream, endpoint)));
    } finally {
      pollAbort.abort();
      signal.removeEventListener("abort", stopPoll);
      const stats = await pollPromise;
      if (stats) {
        if (stats.median != null) lane.serverTps = stats.median;
        if (stats.max != null) lane.serverTpsMax = stats.max;
        lane.serverSamples = stats.samples;
        if (!stats.available) lane.serverCounters = false;
      }
      try {
        target.close?.();
      } catch {
        /* ignore */
      }
      if (lane.status === "running") {
        const ok = lane.streams.some((s) => s.status === "completed" && s.tokenCount > 0);
        lane.status = ok ? "completed" : "error";
        if (!ok) lane.error = lane.streams.map((s) => s.error).find(Boolean) || "No tokens streamed";
      }
      this._bump(session);
    }
  }

  async _runStream(session, lane, stream, endpoint) {
    const ctrl = new AbortController();
    const parent = session._abort.signal;
    const onAbort = () => ctrl.abort();
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => ctrl.abort(), FLEET_SHOWCASE_LIMITS.perRequestTimeoutMs);
    timeout.unref?.();

    const body = {
      model: lane.modelId || undefined,
      messages: [{ role: "user", content: withFillToMaxInstruction(stream.prompt) }],
      max_tokens: session.maxTokens,
      min_tokens: session.maxTokens,
      ignore_eos: true,
      stop: [],
      temperature: session.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
    applyThinkingFlags(body, lane.modelId, session.thinking);

    const onDelta = (info) => {
      if (session.status !== "running") return;
      if (info?.reasoning) stream.reasoning += info.reasoning;
      if (info?.answer) stream.content += info.answer;
      this._liveMetrics(stream, info);
      this._sampleAggregates(session);
      this._bump(session);
    };
    const runOpts = {
      collectContent: true,
      retryOnThinking400: true,
      thinking: session.thinking,
      apiKey: endpoint.apiKey,
      onDelta,
    };

    stream.status = "streaming";
    stream._t0 = performance.now();
    this._bump(session);
    try {
      let result = await this._runStream_(endpoint.chatUrl, body, ctrl.signal, runOpts);
      // Engines that reject vLLM's fill-to-max fields get one retry without them.
      if (result.error && /^HTTP 400\b/.test(result.error) && !ctrl.signal.aborted) {
        stream.content = "";
        stream.reasoning = "";
        result = await this._runStream_(endpoint.chatUrl, stripFillForceFields(body), ctrl.signal, runOpts);
      }
      if (stream.status === "cancelled" || session.status !== "running") {
        stream.status = "cancelled";
        stream.error = stream.error || "Cancelled";
        return;
      }
      stream.status = result.error ? "error" : "completed";
      stream.error = result.error || null;
      stream.tokenCount = result.completionTokens ?? stream.tokenCount;
      stream.tokenSource = result.tokenSource ?? (result.completionTokens ? "estimate" : null);
      if (pos(result.ttftMs)) stream.ttftMs = result.ttftMs;
      stream.decodeTps = result.decodeTps || 0;
      stream.liveTokPerSec = stream.decodeTps;
      stream.peakTokPerSec = Math.max(stream.peakTokPerSec, stream.decodeTps);
      stream.prefillTokens = result.prefillTokens ?? null;
      stream.promptTokenSource = result.promptTokenSource ?? null;
      stream.prefillTps = pos(result.prefillTps) ? result.prefillTps : null;
      if (result.tFirst != null) stream._tFirst = result.tFirst;
      if (result.tLast != null) stream._tLast = result.tLast;
      if (result.model) stream.model = result.model;
      if (typeof result.answer === "string" && result.answer.length > stream.content.length) stream.content = result.answer;
      if (typeof result.reasoning === "string" && result.reasoning.length > stream.reasoning.length) {
        stream.reasoning = result.reasoning;
      }
      const cap = Math.min(session.maxTokens * 16, 200_000);
      if (stream.content.length + stream.reasoning.length > cap) {
        stream.reasoning = stream.reasoning.slice(0, cap);
        stream.content = stream.content.slice(0, Math.max(0, cap - stream.reasoning.length));
      }
    } catch (err) {
      stream.status = session.status === "running" ? "error" : "cancelled";
      stream.error = String(err?.message || err);
    } finally {
      clearTimeout(timeout);
      parent.removeEventListener("abort", onAbort);
      this._bump(session);
    }
  }

  /** Wrapper so tests can inject the streaming function. */
  _runStream_(url, body, signal, opts) {
    return this._streamFn(url, body, signal, opts);
  }

  _liveMetrics(stream, info) {
    if (info?.tFirst != null) stream._tFirst = info.tFirst;
    if (info?.tLast != null) stream._tLast = info.tLast;
    if (info?.model) stream.model = info.model;
    const chars = stream.content.length + stream.reasoning.length;
    stream.tokenCount = Math.max(info?.tokenCount || 0, chars > 0 ? Math.max(1, Math.round(chars / CHARS_PER_TOKEN)) : 0);
    if (stream._t0 != null && stream._tFirst != null && stream.ttftMs == null) {
      stream.ttftMs = round2(stream._tFirst - stream._t0);
    }
    if (stream._tFirst != null && stream._tLast != null && stream._tLast > stream._tFirst) {
      stream.liveTokPerSec = round2(((stream.tokenCount - 1) / (stream._tLast - stream._tFirst)) * 1000);
      stream.peakTokPerSec = Math.max(stream.peakTokPerSec, stream.liveTokPerSec);
    }
  }
}

/** @param {unknown} raw */
export function normalizePrompts(raw) {
  const L = FLEET_SHOWCASE_LIMITS;
  if (!Array.isArray(raw) || raw.length < L.minPrompts || raw.length > L.maxPrompts) return null;
  const out = [];
  for (const p of raw) {
    if (typeof p !== "string") return null;
    const t = p.trim();
    if (t.length < L.minPromptLen || t.length > L.maxPromptLen) return null;
    out.push(t);
  }
  return out;
}
