// GRP1 (#82): Manage Nodes shows the resolved spark group read-only and never
// writes the group keys, so it cannot diverge from config/groups.json.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, flush, render } from "../../testing/render";
import { makeFetchRouter, nodeRecord, type RecordedCall } from "../Updates/testKit";
import { ManageNodesDialog, groupSummary } from "./ManageNodesDialog";

const NODES = [
  nodeRecord("gx10-1c2c", { role: "head", rank: 0, groupId: "pair", groupName: "Pair A" }),
  nodeRecord("gx10-25ed", { role: "worker", rank: 1, groupId: "pair", groupName: "Pair A", headId: "gx10-1c2c" }),
  nodeRecord("gx10-102c"),
];

let calls: RecordedCall[] = [];

async function mount(props: { onOpenTopology?: () => void; onClose?: () => void } = {}) {
  const router = makeFetchRouter((call) => {
    if (call.url === "/api/fleet/nodes" && call.method === "GET") return { status: 200, body: { nodes: NODES } };
    if (call.method === "PUT" || call.method === "POST") return { status: 200, body: { success: true, node: NODES[0] } };
    return { status: 404, body: { error: "unexpected" } };
  });
  calls = router.calls;
  render(<ManageNodesDialog open onClose={props.onClose ?? (() => {})} onOpenTopology={props.onOpenTopology} />);
  for (let i = 0; i < 4; i++) await flush();
}

const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null;
const buttonWith = (text: string) =>
  Array.from(document.body.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(text)) as
    | HTMLElement
    | undefined;
const click = (el: Element | null | undefined) =>
  act(() => {
    (el as HTMLElement).click();
  });

afterEach(() => {
  cleanupRenders();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("groupSummary", () => {
  it("standalone / head / worker", () => {
    expect(groupSummary(NODES[2])).toBe("Standalone");
    expect(groupSummary(NODES[0])).toBe("Pair A · head · rank 0");
    expect(groupSummary({ ...NODES[1], groupName: null })).toBe("pair · worker · rank 1");
  });
});

describe("ManageNodesDialog (GRP1)", () => {
  it("lists each node with its resolved group", async () => {
    await mount();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Pair A · head · rank 0");
    expect(text).toContain("Pair A · worker · rank 1");
    expect(text).toContain("Standalone");
  });

  it("edit form shows the group read-only: no role/rank/group/head inputs", async () => {
    await mount();
    click(buttonWith("Pair A · worker"));
    expect(q('[data-testid="manage-node-group-summary"]')?.textContent).toBe("Pair A · worker · rank 1");
    expect(q('[data-testid="manage-node-group"]')?.textContent).toContain("Head: gx10-1c2c");
    const labels = Array.from(document.body.querySelectorAll("label")).map((l) => l.textContent ?? "");
    for (const gone of ["Role", "Rank (TP, 0 = head)", "Group ID", "Head ID"]) expect(labels).not.toContain(gone);
    expect(document.body.querySelector("select")).toBeNull();
  });

  it("Save sends no group keys", async () => {
    await mount();
    click(buttonWith("Pair A · head"));
    await act(async () => {
      buttonWith("Save")!.click();
    });
    for (let i = 0; i < 4; i++) await flush();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/fleet/nodes/gx10-1c2c");
    const body = JSON.parse(put!.body!);
    expect(body.name).toBe("gx10-1c2c");
    for (const k of ["role", "rank", "groupId", "headId", "groupName"]) expect(body).not.toHaveProperty(k);
  });

  it("Add node sends no group keys", async () => {
    await mount();
    click(buttonWith("+ Add node"));
    expect(q('[data-testid="manage-node-group-summary"]')?.textContent).toBe("Standalone");
    const idInput = document.body.querySelector('input[type="text"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(idInput, "gx10-new");
      idInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      Array.from(document.body.querySelectorAll("button"))
        .filter((b) => b.textContent === "Add node")
        .pop()!
        .click();
    });
    for (let i = 0; i < 4; i++) await flush();
    const post = calls.find((c) => c.method === "POST");
    expect(post).toBeTruthy();
    const body = JSON.parse(post!.body!);
    expect(body.id).toBe("gx10-new");
    for (const k of ["role", "rank", "groupId", "headId"]) expect(body).not.toHaveProperty(k);
  });

  it("the Topology pointer closes the dialog and opens the Topology tab", async () => {
    const onOpenTopology = vi.fn();
    const onClose = vi.fn();
    await mount({ onOpenTopology, onClose });
    click(buttonWith("Pair A · head"));
    click(q('[data-testid="manage-node-open-topology"]'));
    expect(onClose).toHaveBeenCalled();
    expect(onOpenTopology).toHaveBeenCalledTimes(1);
  });

  it("without onOpenTopology the pointer is plain text", async () => {
    await mount();
    click(buttonWith("Pair A · head"));
    expect(q('[data-testid="manage-node-open-topology"]')).toBeNull();
    expect(q('[data-testid="manage-node-group"]')?.textContent).toContain("Topology tab");
  });
});
