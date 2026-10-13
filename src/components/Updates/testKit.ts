// Test-only builders + fetch router for the Updates suite. Named without
// *.test.* so vitest's include glob never runs it by itself. Deterministic:
// FIXED_NOW is a constant epoch; no test may read the real clock.

import { vi } from "vitest";
import type { NodeRecord } from "../../api/client";
import type {
  DgxUpdateSnapshot,
  NodeUpdatesView,
  NodeUpdateSchedule,
} from "../../api/types";

export const FIXED_NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

export interface RecordedCall {
  url: string;
  method: string;
  body: string | null;
}

export type Reply = { status: number; body: unknown };

/** Stub global fetch with a router; records every call in order. */
export function makeFetchRouter(handler: (call: RecordedCall) => Reply) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body == null ? null : String(init.body),
    };
    calls.push(call);
    const { status, body } = handler(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

export function updatesView(
  nodeId: string,
  over: Partial<NodeUpdatesView> = {}
): NodeUpdatesView {
  return {
    nodeId,
    reachable: true,
    snapshot: null,
    state: {
      inProgress: false,
      stage: null,
      startedAt: null,
      finishedAt: null,
      bootId: null,
      lastOutcome: null,
      lastOutcomeDetail: null,
      events: [],
    },
    schedules: [],
    display: "current",
    graceElapsedMs: null,
    waveIndex: null,
    ...over,
  };
}

export function snapshot(over: Partial<DgxUpdateSnapshot> = {}): DgxUpdateSnapshot {
  return {
    probedAt: FIXED_NOW,
    agentReachable: true,
    swBuild: "R3.1.0",
    latestOtaApplied: null,
    otaAvailable: null,
    packages: [],
    firmware: [],
    updatesDisabled: false,
    ...over,
  };
}

export function nodeRecord(id: string, over: Partial<NodeRecord> = {}): NodeRecord {
  return {
    id,
    name: id,
    endpoint: `http://${id}.local`,
    lanIp: "192.168.50.44",
    role: "standalone",
    rank: null,
    groupId: null,
    headId: null,
    links: [],
    agentPort: 8898,
    isLocal: false,
    ...over,
  };
}

export function schedule(
  over: Partial<NodeUpdateSchedule> & { id: string }
): NodeUpdateSchedule {
  return {
    action: "dgx-update",
    kind: "at",
    at: null,
    cron: null,
    nextFire: 0,
    status: "pending",
    mirrorCron: false,
    createdAt: 0,
    firedAt: null,
    lastFireResult: null,
    ...over,
  };
}
