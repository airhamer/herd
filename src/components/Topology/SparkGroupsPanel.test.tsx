import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, flush, render } from "../../testing/render";
import { ApiError, type GroupsApi, type GroupsView, type RocePlan, type SparkGroup } from "../../api/client";
import { SparkGroupsPanel } from "./SparkGroupsPanel";
import { TopologyPage } from "./TopologyPage";

const emptyPlan: RocePlan = { links: [], interfaces: [], groups: [], changes: 0, warnings: [], todo: ["verify cabling"] };

function view(groups: SparkGroup[], plan: RocePlan = emptyPlan): GroupsView {
  return {
    version: 1,
    switchPresent: false,
    groups,
    maxGroupSize: 3,
    nodes: [
      { nodeId: "gx10-1c2c", name: "gx10-1c2c", spark: true, reason: "unified memory (GB10)" },
      { nodeId: "gx10-102c", name: "gx10-102c", spark: true, reason: "unified memory (GB10)" },
      { nodeId: "gx10-25ed", name: "gx10-25ed", spark: true, reason: "unified memory (GB10)" },
      { nodeId: "gx10-9999", name: "gx10-9999", spark: true, reason: "unified memory (GB10)" },
      { nodeId: "narthex", name: "narthex", spark: false, reason: "discrete GPU" },
    ],
    plan,
  };
}

const TP2: SparkGroup = { id: "tp2", name: "tp2", members: ["gx10-102c", "gx10-25ed"] };

function fakeApi(initial: GroupsView, overrides: Partial<GroupsApi> = {}) {
  const saves: Array<{ groups: SparkGroup[]; switchPresent: boolean }> = [];
  const api: GroupsApi = {
    fetch: vi.fn(async () => initial),
    save: vi.fn(async (doc) => {
      saves.push(doc);
      return { ...initial, groups: doc.groups };
    }),
    apply: vi.fn(async () => ({ ok: true, dryRun: true, implemented: false, commands: [], message: "RoCE link changes are not implemented yet" })),
    ...overrides,
  };
  return { api, saves };
}

const q = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

function fire(el: Element, type: string) {
  act(() => {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  });
}

async function drag(c: HTMLElement, nodeId: string, page: string) {
  fire(q(c, `group-icon-${nodeId}`)!, "dragstart");
  fire(q(c, `group-page-${page}`)!, "dragover");
  fire(q(c, `group-page-${page}`)!, "drop");
  await flush();
}

afterEach(() => cleanupRenders());

describe("SparkGroupsPanel (SC5d)", () => {
  it("shows Home with the individuals, the carried-over group page and the + button", async () => {
    const { api } = fakeApi(view([TP2]));
    const { container } = render(<SparkGroupsPanel api={api} />);
    await flush();
    const home = q(container, "group-page-home")!;
    expect(home.textContent).toContain("Home");
    expect(home.querySelectorAll("li[data-node-id]")).toHaveLength(3); // 1c2c, 9999, narthex
    const tp2 = q(container, "group-page-tp2")!;
    expect([...tp2.querySelectorAll("li[data-node-id]")].map((l) => l.getAttribute("data-node-id"))).toEqual([
      "gx10-102c",
      "gx10-25ed",
    ]);
    expect(tp2.textContent).toContain("head · rank 0");
    expect(q(container, "group-summary-tp2")?.textContent).toContain("200G");
    // + sits after the last page
    const pages = q(container, "group-pages")!;
    expect(pages.lastElementChild?.getAttribute("data-testid")).toBe("add-group");
  });

  it("+ creates an empty page; drag and drop moves sparks onto it and back", async () => {
    const { api, saves } = fakeApi(view([]));
    const onSaved = vi.fn();
    const { container } = render(<SparkGroupsPanel api={api} onSaved={onSaved} />);
    await flush();
    act(() => q(container, "add-group")!.click());
    await flush();
    expect(saves.at(-1)?.groups).toEqual([{ id: "group-1", name: "Group 1", members: [] }]);
    expect(q(container, "group-page-group-1")?.textContent).toContain("Drag 2–3 sparks here");

    await drag(container, "gx10-102c", "group-1");
    await drag(container, "gx10-25ed", "group-1");
    expect(saves.at(-1)?.groups[0].members).toEqual(["gx10-102c", "gx10-25ed"]);
    expect(q(container, "group-summary-group-1")?.textContent).toContain("TP2");

    await drag(container, "gx10-25ed", "home");
    expect(saves.at(-1)?.groups[0].members).toEqual(["gx10-102c"]);
    expect(q(container, "group-summary-group-1")?.textContent).toContain("inactive");
    expect(onSaved).toHaveBeenCalledTimes(4);
  });

  it("refuses a 4th spark and non-Spark hosts without saving", async () => {
    const trio: SparkGroup = { id: "trio", name: "Trio", members: ["gx10-1c2c", "gx10-102c", "gx10-25ed"] };
    const { api, saves } = fakeApi(view([trio, { id: "g2", name: "G2", members: [] }]));
    const { container } = render(<SparkGroupsPanel api={api} />);
    await flush();
    await drag(container, "gx10-9999", "trio");
    expect(q(container, "groups-error")?.textContent).toContain("Trio already has 3 sparks");
    await drag(container, "narthex", "g2");
    expect(q(container, "groups-error")?.textContent).toContain("narthex is not a GB10 Spark");
    expect(saves).toHaveLength(0);
    expect(q(container, "group-summary-trio")?.textContent).toContain("100G");
  });

  it("the Move-to menu moves a spark without dragging", async () => {
    const { api, saves } = fakeApi(view([TP2]));
    const { container } = render(<SparkGroupsPanel api={api} />);
    await flush();
    const select = q(container, "move-gx10-9999") as unknown as HTMLSelectElement;
    act(() => {
      select.value = "tp2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(saves.at(-1)?.groups[0].members).toEqual(["gx10-102c", "gx10-25ed", "gx10-9999"]);
  });

  it("make-head reorders, delete returns members to Home", async () => {
    const { api, saves } = fakeApi(view([TP2]));
    const { container } = render(<SparkGroupsPanel api={api} />);
    await flush();
    act(() => q(container, "make-head-gx10-25ed")!.click());
    await flush();
    expect(saves.at(-1)?.groups[0].members).toEqual(["gx10-25ed", "gx10-102c"]);
    act(() => q(container, "delete-tp2")!.click());
    await flush();
    expect(saves.at(-1)?.groups).toEqual([]);
    expect(q(container, "group-page-home")!.querySelectorAll("li[data-node-id]")).toHaveLength(5);
  });

  it("reverts and shows the server's reason when a save is refused", async () => {
    const { api } = fakeApi(view([TP2]), {
      save: vi.fn(async () => {
        throw new ApiError("gx10-9999 cannot join group \"tp2\": unknown node", 400);
      }),
    });
    const { container } = render(<SparkGroupsPanel api={api} />);
    await flush();
    await drag(container, "gx10-9999", "tp2");
    expect(q(container, "groups-error")?.textContent).toContain("unknown node");
    expect(q(container, "group-page-tp2")!.querySelectorAll("li[data-node-id]")).toHaveLength(2);
  });

  it("shows a load error", async () => {
    const { api } = fakeApi(view([]), { fetch: vi.fn(async () => Promise.reject(new Error("boom"))) });
    const { container } = render(<SparkGroupsPanel api={api} />);
    await flush();
    expect(container.textContent).toContain("Couldn't load groups: boom");
  });
});

describe("RocePlanPanel (SC5d)", () => {
  const plan: RocePlan = {
    links: [
      { from: "gx10-102c", to: "gx10-25ed", fromIf: "enp1s0f0np0", toIf: "enp1s0f0np0", groupId: "tp2", action: "enable", targetSpeedMbps: 200000, currentSpeedMbps: 200000, currentUp: true, change: false, reason: "tp2: 2-spark group" },
      { from: "gx10-1c2c", to: "gx10-102c", fromIf: "enp1s0f1np1", toIf: "enp1s0f1np1", groupId: null, action: "disable", targetSpeedMbps: null, currentSpeedMbps: 200000, currentUp: true, change: true, reason: "not inside a group" },
    ],
    interfaces: [],
    groups: [],
    changes: 1,
    warnings: ["gx10-9999 has no RoCE cable to tp2"],
    todo: ["verify cabling"],
  };

  it("shows the plan and runs a dry run by default after an explicit confirm", async () => {
    const { api } = fakeApi(view([TP2], plan));
    const { container } = render(<SparkGroupsPanel api={api} />);
    await flush();
    expect(q(container, "plan-gx10-102c-gx10-25ed")?.textContent).toContain("enable @ 200G");
    expect(q(container, "plan-gx10-1c2c-gx10-102c")?.getAttribute("data-change")).toBe("true");
    expect(q(container, "plan-warnings")?.textContent).toContain("no RoCE cable");
    expect(q(container, "roce-apply-confirm")).toBeNull();

    act(() => q(container, "roce-apply-open")!.click());
    expect((q(container, "roce-dry-run") as unknown as HTMLInputElement).checked).toBe(true);
    act(() => q(container, "roce-apply-run")!.click());
    await flush();
    expect(api.apply).toHaveBeenCalledWith({ dryRun: true });
    expect(q(container, "roce-commands-none")?.textContent).toContain("(none)");
    expect(q(container, "roce-apply-result")?.textContent).toContain("not implemented");
  });

  it("a real apply sends confirm and surfaces 'not implemented'", async () => {
    const { api } = fakeApi(view([TP2], plan), {
      apply: vi.fn(async () => {
        throw new ApiError("RoCE link changes are not implemented yet", 501);
      }),
    });
    const { container } = render(<SparkGroupsPanel api={api} />);
    await flush();
    act(() => q(container, "roce-apply-open")!.click());
    act(() => q(container, "roce-dry-run")!.click());
    expect(q(container, "roce-apply-run")?.textContent).toBe("Apply for real");
    act(() => q(container, "roce-apply-run")!.click());
    await flush();
    expect(api.apply).toHaveBeenCalledWith({ dryRun: false, confirm: true });
    expect(q(container, "roce-apply-error")?.textContent).toContain("not implemented");
  });
});

describe("TopologyPage + groups", () => {
  it("renders the groups panel only when an API is passed", async () => {
    const { api } = fakeApi(view([TP2]));
    const without = render(<TopologyPage nodes={[]} links={[]} />);
    expect(q(without.container, "spark-groups")).toBeNull();
    const withApi = render(<TopologyPage nodes={[]} links={[]} groupsApi={api} />);
    await flush();
    expect(q(withApi.container, "group-page-tp2")).not.toBeNull();
  });
});
