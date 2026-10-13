import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, flush } from "../../testing/render";
import { PlanDialog, deriveGroups } from "./PlanDialog";
import { WAVE_LOCK_NOTICE } from "./format";
import { makeFetchRouter, nodeRecord, updatesView, type RecordedCall, type Reply } from "./testKit";
import type { FleetUpdatePlan } from "../../api/types";

// ── deriveGroups: pure derivation, known answers ────────────────

describe("deriveGroups (pure wave derivation)", () => {
  it("a lone standalone is exactly one single-member wave", () => {
    expect(deriveGroups([nodeRecord("solo", { role: "standalone" })])).toEqual([["solo"]]);
  });

  it("two lone standalones are two waves sorted by id", () => {
    const g = deriveGroups([
      nodeRecord("zzz", { role: "standalone" }),
      nodeRecord("aaa", { role: "standalone" }),
    ]);
    expect(g).toEqual([["aaa"], ["zzz"]]);
  });

  it("a tp pair (shared groupId) forms ONE wave, head listed first", () => {
    const g = deriveGroups([
      nodeRecord("w0", { role: "worker", groupId: "tp-pair", rank: 1 }),
      nodeRecord("head", { role: "head", groupId: "tp-pair", rank: 0 }),
    ]);
    expect(g).toEqual([["head", "w0"]]);
  });

  it("head-led and standalone waves sort before worker-led waves", () => {
    const g = deriveGroups([
      nodeRecord("wp2", { role: "worker", groupId: "g2", rank: 1 }),
      nodeRecord("wp1", { role: "worker", groupId: "g2", rank: 0 }),
      nodeRecord("solo", { role: "standalone" }),
      nodeRecord("head", { role: "head", groupId: "g1", rank: 0 }),
      nodeRecord("w1", { role: "worker", groupId: "g1", rank: 1 }),
    ]);
    // head-led pair + standalone lead (tie broken by first id: "head" < "solo");
    // the worker-led pair follows.
    expect(g).toEqual([["head", "w1"], ["solo"], ["wp1", "wp2"]]);
  });
});

// ── PlanDialog: store-then-act ordering, wave-1 scoping, delete guard ────

const HEAD = nodeRecord("head", { name: "Head Node", role: "head", groupId: "tp-pair", rank: 0 });
const WORKER = nodeRecord("w0", { name: "Worker 0", role: "worker", groupId: "tp-pair", rank: 1 });
const SOLO = nodeRecord("solo", { name: "Solo", role: "standalone" });
const NODES = [SOLO, WORKER, HEAD]; // unsorted on purpose — derivation normalizes
// Derivation: wave 1 = [head, w0], wave 2 = [solo].

function planOf(groups: string[][]): FleetUpdatePlan {
  return {
    groups: groups.map((nodeIds) => ({ nodeIds, reason: "manual" as const })),
    createdAt: 0,
    startedAt: null,
    waveStates: groups.map(() => "pending" as const),
  };
}

type Route = (call: RecordedCall) => Reply | null;

function mountDialog(plan: FleetUpdatePlan | null, waveStates: string[], extra: Route = () => null) {
  const router = makeFetchRouter((call) => {
    const hit = extra(call);
    if (hit) return hit;
    if (call.method === "GET" && call.url === "/api/fleet/updates/plan") {
      return { status: 200, body: { plan, waveStates } };
    }
    if (call.method === "POST" && call.url === "/api/fleet/updates/plan") {
      const groups: string[][] = JSON.parse(call.body ?? "[]").groups;
      return { status: 200, body: { success: true, plan: planOf(groups) } };
    }
    if (call.method === "POST" && /^\/api\/fleet\/nodes\/[^/]+\/updates\/now$/.test(call.url)) {
      return { status: 200, body: { ok: true } };
    }
    if (call.method === "POST" && /^\/api\/fleet\/nodes\/[^/]+\/updates\/schedule$/.test(call.url)) {
      return { status: 200, body: { ok: true } };
    }
    if (call.method === "DELETE" && call.url === "/api/fleet/updates/plan") {
      return { status: 200, body: { success: true, abandoned: true } };
    }
    return { status: 404, body: { error: `unexpected ${call.method} ${call.url}` } };
  });
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(
    <PlanDialog
      open
      nodes={NODES}
      views={[updatesView("head"), updatesView("w0"), updatesView("solo")]}
      onClose={onClose}
      onChanged={onChanged}
    />
  );
  return { calls: router.calls, onClose, onChanged };
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

function buttonWithText(text: string): HTMLButtonElement {
  return Array.from(document.querySelectorAll("button"))
    .filter((b) => (b.textContent ?? "").includes(text))
    .at(-1) as HTMLButtonElement;
}

function click(el: Element | null | undefined) {
  act(() => {
    (el as HTMLElement).click();
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("PlanDialog wave cards", () => {
  it("derives ordered wave cards from node roles when no plan is stored", async () => {
    mountDialog(null, []);
    await flush();
    const cards = Array.from(document.querySelectorAll('[data-testid="wave-card"]'));
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("Wave 1");
    expect(cards[0].textContent).toContain("Head Node");
    expect(cards[0].textContent).toContain("Worker 0");
    expect(cards[1].textContent).toContain("Wave 2");
    expect(cards[1].textContent).toContain("Solo");
  });
});

describe("PlanDialog run-now / start-at ordering", () => {
  it("Run now: saveUpdatePlan FIRST, then trigger wave-1 nodes ONLY", async () => {
    const { calls, onClose, onChanged } = mountDialog(null, []);
    await flush();
    click(byTestId("plan-run-now"));
    await flush();

    const order = calls.map((c) => `${c.method} ${c.url}`);
    const planIdx = order.indexOf("POST /api/fleet/updates/plan");
    expect(planIdx).toBeGreaterThanOrEqual(0);
    const savedBody = JSON.parse(calls[planIdx].body ?? "{}");
    expect(savedBody).toEqual({ groups: [["head", "w0"], ["solo"]] });

    const nowIdxs = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.method === "POST" && /\/updates\/now$/.test(c.url))
      .map(({ i }) => i);
    expect(nowIdxs.length).toBe(2); // wave 1 has exactly 2 members
    for (const i of nowIdxs) expect(i).toBeGreaterThan(planIdx); // AFTER save
    const nowUrls = nowIdxs.map((i) => calls[i].url);
    expect(nowUrls.sort()).toEqual([
      "/api/fleet/nodes/head/updates/now",
      "/api/fleet/nodes/w0/updates/now",
    ]);
    expect(calls.some((c) => c.url.includes("/solo/updates/now"))).toBe(false); // wave-1 only
    expect(onChanged).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("Start at: save plan, then an at-schedule on each wave-1 member", async () => {
    const { calls } = mountDialog(null, []);
    await flush();
    const dt = document.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    const save = buttonWithText("Start at…");
    expect(save.disabled).toBe(true); // no datetime yet
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(dt, "2026-10-13T07:00");
      dt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(save.disabled).toBe(false);
    click(save);
    await flush();

    const order = calls.map((c) => `${c.method} ${c.url}`);
    const planIdx = order.indexOf("POST /api/fleet/updates/plan");
    expect(planIdx).toBeGreaterThanOrEqual(0);
    const sched = calls.filter((c) => c.method === "POST" && /\/updates\/schedule$/.test(c.url));
    expect(sched.map((c) => c.url).sort()).toEqual([
      "/api/fleet/nodes/head/updates/schedule",
      "/api/fleet/nodes/w0/updates/schedule",
    ]);
    for (const c of sched) {
      expect(JSON.parse(c.body ?? "{}")).toEqual({
        kind: "at",
        at: Date.parse("2026-10-13T07:00"),
      });
    }
    const idx = calls.indexOf(sched[0]);
    expect(idx).toBeGreaterThan(planIdx);
    expect(calls.some((c) => c.url.includes("/solo/"))).toBe(false);
  });

  it("a trigger 409 surfaces the WAVE_LOCK_NOTICE, not raw text", async () => {
    mountDialog(null, [], (c) =>
      c.method === "POST" && c.url === "/api/fleet/nodes/head/updates/now"
        ? { status: 409, body: { error: "ignored" } }
        : null
    );
    await flush();
    click(byTestId("plan-run-now"));
    await flush();
    expect(document.body.textContent).toContain(WAVE_LOCK_NOTICE);
    expect(document.body.textContent).not.toContain("ignored");
  });
});

describe("PlanDialog delete-plan guard", () => {
  for (const openState of ["running", "rebooting", "slow"] as const) {
    it(`DELETE is disabled while a wave is ${openState}`, async () => {
      mountDialog(planOf([["head", "w0"], ["solo"]]), [openState, "pending"]);
      await flush();
      expect(buttonWithText("Delete plan").disabled).toBe(true);
    });
  }

  it("DELETE is enabled only when a plan exists and every wave is closed (negative control)", async () => {
    const { calls } = mountDialog(planOf([["head", "w0"], ["solo"]]), ["healthy", "healthy"]);
    await flush();
    expect(buttonWithText("Delete plan").disabled).toBe(false);
    click(buttonWithText("Delete plan"));
    await flush();
    expect(calls.some((c) => c.method === "DELETE" && c.url === "/api/fleet/updates/plan")).toBe(true);
  });
});
