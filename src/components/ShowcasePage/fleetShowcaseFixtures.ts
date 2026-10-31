import type { FleetShowcaseLaneState, FleetShowcaseSessionState, FleetShowcaseStreamState } from "../../api/types";

export function fleetStream(over: Partial<FleetShowcaseStreamState> = {}): FleetShowcaseStreamState {
  return {
    streamId: "0:0",
    label: "Write a haiku",
    prompt: "Write a haiku",
    status: "completed",
    contentLength: 0,
    tokenCount: 64,
    ttftMs: 120,
    decodeTps: 40,
    liveTokPerSec: 40,
    peakTokPerSec: 42,
    model: "m",
    error: null,
    tokenSource: "usage",
    estimated: false,
    ...over,
  };
}

export function fleetLane(over: Partial<FleetShowcaseLaneState> = {}): FleetShowcaseLaneState {
  return {
    laneId: "spark:s1:8000",
    kind: "spark",
    nodeId: "s1",
    nodeName: "spark-a",
    host: "10.0.0.5",
    port: 8000,
    modelId: "Qwen3-30B",
    backend: "vllm",
    via: "ssh-tunnel",
    status: "completed",
    statusText: null,
    error: null,
    serverCounters: true,
    serverTps: 88.4,
    serverTpsMax: 95,
    serverSamples: 12,
    serverEngine: "vllm",
    clientTps: 80.2,
    clientTpsPeak: 84.6,
    estimated: false,
    streamTpsMean: 40.1,
    ttftP50Ms: 120,
    prefillTps: 900,
    totalTokens: 128,
    streamsDone: 2,
    streamsOk: 2,
    streamCount: 2,
    tokenSource: "usage",
    streams: [fleetStream(), fleetStream({ streamId: "0:1" })],
    ...over,
  };
}

export function fleetSession(over: Partial<FleetShowcaseSessionState> = {}): FleetShowcaseSessionState {
  return {
    sessionId: "sid-1",
    status: "completed",
    rev: 5,
    maxTokens: 512,
    temperature: 0.7,
    thinking: false,
    promptType: "mixed",
    prompts: ["Write a haiku"],
    startedAt: 1,
    completedAt: 2,
    error: null,
    lanes: [fleetLane()],
    ...over,
  };
}
