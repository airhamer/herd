// Shared test helpers for the alert suites (LIC1 clean-room rewrite).
import http from "node:http";
import { HealthEvaluator } from "../../health/HealthEvaluator.js";

/** Marker a misbehaving receiver puts in its reply; it must never surface. */
export const SECRET_MARKER = "tok_should-never-appear_9f8e7d6c";

export const silentLog = { log() {}, warn() {}, error() {} };

/**
 * A unit snapshot shaped like SparkMonitor's, healthy by default. `metrics`
 * entries are merged one level deep (gpu, unifiedMemory) or replaced (storage,
 * llm, tailscale).
 */
export function makeUnit(patch = {}) {
  const { metrics: m = {}, ...top } = patch;
  const gpu = {
    temperature: 45,
    usage: 5,
    power: { draw: 15, limit: 100 },
    throttle: { active: false, reason: "ok", thermal: false, hwSlowdown: false, powerCap: false, detail: "", smClockPct: 100 },
    ...m.gpu,
  };
  return {
    id: "spark-1",
    name: "spark-1",
    kind: "spark",
    role: "head",
    workerNode: false,
    online: true,
    offlineReason: null,
    llmMonitoring: true,
    llmPort: 8888,
    llmPorts: [8888],
    tailscaleMonitoring: false,
    health: [],
    ...top,
    metrics: {
      gpu,
      unifiedMemory: { total: 124_610, available: 40_000, percentage: 68, ...m.unifiedMemory },
      storage: m.storage ?? [{ device: "/dev/nvme0n1p2", label: "/", used: 300, total: 1000, available: 700, percentage: 30 }],
      llm: m.llm ?? [{ available: true, modelId: "model", error: null }],
      tailscale: m.tailscale ?? null,
    },
  };
}

/** What HealthEvaluator reports for these metrics. */
export const healthFor = (metrics) => new HealthEvaluator().evaluate(metrics);

/** A unit whose GPU sits at `celsius`, with the matching Health findings. */
export function unitAt(celsius, patch = {}) {
  return makeUnit({ ...patch, metrics: { gpu: { temperature: celsius } }, health: healthFor({ gpu: { temperature: celsius } }) });
}

export const offlineUnit = (reason = "timeout", patch = {}) => makeUnit({ ...patch, online: false, offlineReason: reason });

/** now() that only moves when told to. */
export function manualClock(startMs = 5_000_000) {
  let current = startMs;
  const now = () => current;
  now.tick = (ms) => (current += ms);
  now.jump = (ms) => (current = ms);
  return now;
}

/** fetch replacement: records each call, answers `status` (or throws `error`). */
export function recordingFetch(status = 200, { body = "fine", headers, error } = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (error) throw error;
    return new Response(body, { status, headers });
  };
  fetchFn.calls = calls;
  return fetchFn;
}

/** DNS replacement answering every name with `addresses`; remembers the names. */
export function fakeDns(addresses) {
  const names = [];
  const lookup = async (name) => {
    names.push(name);
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  lookup.names = names;
  return lookup;
}

/** An HTTP server on 127.0.0.1 that records requests (with bodies). */
export async function localServer(handler = (_req, res) => res.end("fine")) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      handler(req, res);
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { port: server.address().port, seen, stop: () => new Promise((done) => server.close(done)) };
}
