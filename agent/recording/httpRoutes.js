import {
  handleListRecordings,
  handleGetRecording,
  handleDeleteRecording,
  handleRecordingStatus,
  observerIsPresent,
  loadRecordingStore,
  saveRecordingStore,
  defaultRecordingPath,
} from "./handlers.js";
import {
  loadInstanceStore,
  saveInstanceStore,
  readInstance,
  writeInstance,
  defaultInstancePath,
} from "../catalog/componentInstance.js";
import { resolveRecordingPolicy } from "../../shared/runtimeProfile.js";
import { probeRuntimeCapabilities } from "../capability/probe.js";
import { getDefinition, loadDefinitions, DEFAULT_CATALOG_DIR } from "../catalog/definitions.js";

export function recordingFilePath(opts) {
  return opts.recordingPath || defaultRecordingPath(opts.configDir || process.env.HERD_AGENT_CONFIG || "agent/config");
}

export function instanceFilePath(opts) {
  return opts.instancePath || defaultInstancePath(opts.configDir || process.env.HERD_AGENT_CONFIG || "agent/config");
}

export async function routeRecording(req, res, pathname, searchParams, ctx) {
  const { json, authorized, readBody, opts } = ctx;
  const file = recordingFilePath(opts);
  if (req.method === "GET" && pathname === "/recording-status") {
    if (!authorized) return json(res, 401, { error: "unauthorized" });
    const policy = parsePolicy(searchParams);
    const shown = handleRecordingStatus({
      policy,
      levels: [],
      ctx: { observerPresent: observerIsPresent({ env: opts.env, observerPresent: opts.observerPresent }) },
    });
    return json(res, shown.status, shown.body);
  }
  if (req.method === "GET" && pathname === "/recordings") {
    const store = loadRecordingStore(file);
    const out = handleListRecordings(
      store,
      {
        componentId: searchParams.get("componentId") || undefined,
        nodeId: searchParams.get("nodeId") || undefined,
      },
      { authorized, observerPresent: observerIsPresent({ env: opts.env, observerPresent: opts.observerPresent }) }
    );
    return json(res, out.status, out.body);
  }
  if (req.method === "GET" && pathname.startsWith("/recordings/")) {
    const id = decodeURIComponent(pathname.slice("/recordings/".length));
    const store = loadRecordingStore(file);
    const out = handleGetRecording(store, id, { authorized, contentAuthorized: authorized });
    return json(res, out.status, out.body);
  }
  if (req.method === "DELETE" && pathname.startsWith("/recordings/")) {
    if (!authorized) return json(res, 401, { error: "unauthorized" });
    const id = decodeURIComponent(pathname.slice("/recordings/".length));
    const store = loadRecordingStore(file);
    const out = handleDeleteRecording(store, id, { authorized: true });
    if (out.store) saveRecordingStore(file, out.store);
    return json(res, out.status, out.body);
  }
  if ((req.method === "PUT" || req.method === "POST") && pathname === "/recording-policy") {
    if (!authorized) return json(res, 401, { error: "unauthorized" });
    const raw = await readBody(req, 16 * 1024);
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid JSON body" });
    }
    const instPath = instanceFilePath(opts);
    const store = loadInstanceStore(instPath);
    const rec = readInstance(store, body.nodeId, body.componentId) || {};
    const policy = resolveRecordingPolicy([
      rec.recording,
      {
        content: body.content,
        retentionHours: body.retentionHours ?? null,
        maxBytes: body.maxBytes ?? null,
        observer: body.observer ?? rec.recording?.observer ?? "relay",
      },
    ]);
    const next = writeInstance(store, body.nodeId, body.componentId, { ...rec, recording: policy });
    saveInstanceStore(instPath, next);
    const avail = handleRecordingStatus({
      policy,
      ctx: { observerPresent: observerIsPresent({ env: opts.env, observerPresent: opts.observerPresent }) },
    });
    return json(res, 200, { ok: true, recording: policy, status: avail.body });
  }
  if (req.method === "GET" && pathname === "/capability-probe") {
    if (!authorized) return json(res, 401, { error: "unauthorized" });
    const componentId = searchParams.get("componentId");
    const catalogDir = opts.catalogDir || DEFAULT_CATALOG_DIR;
    const { definitions } = loadDefinitions(catalogDir);
    const def = getDefinition(definitions, componentId);
    if (!def) return json(res, 404, { error: "unknown component" });
    const probed = await probeRuntimeCapabilities(def.runtimeProfile, {
      fetchImpl: opts.fetchImpl,
      env: opts.env,
    });
    const instPath = instanceFilePath(opts);
    const store = loadInstanceStore(instPath);
    const rec = readInstance(store, searchParams.get("nodeId") || "local", componentId) || {};
    const next = writeInstance(store, searchParams.get("nodeId") || "local", componentId, {
      ...rec,
      detectedCapabilities: {
        observedAt: probed.detected.observedAt,
        freshness: probed.detected.freshness,
        reachable: probed.detected.reachable,
        backend: probed.detected.backend,
        reason: probed.detected.reason,
        tensorfoldUnverified: probed.detected.tensorfoldUnverified,
        metrics: probed.detected.metrics,
      },
    });
    saveInstanceStore(instPath, next);
    return json(res, 200, { ok: true, declared: probed.declared, detected: probed.detected, capabilities: probed.capabilities });
  }
  return false;
}

function parsePolicy(searchParams) {
  return {
    content: searchParams.get("content") || "metadata",
    retentionHours: searchParams.get("retentionHours") ? Number(searchParams.get("retentionHours")) : null,
    maxBytes: searchParams.get("maxBytes") ? Number(searchParams.get("maxBytes")) : null,
    observer: searchParams.get("observer") || "relay",
  };
}
