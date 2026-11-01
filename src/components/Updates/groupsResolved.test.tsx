// GRP1 (#82): update waves and the Updates rows read the resolved group that
// GET /api/fleet/nodes now serves (config/groups.json overlay).
import { afterEach, describe, expect, it } from "vitest";
import { cleanupRenders, render } from "../../testing/render";
import { deriveGroups } from "./PlanDialog";
import { UpdateRow } from "./UpdateRow";
import { FIXED_NOW, nodeRecord, updatesView } from "./testKit";

// Topology tab regrouped the fleet: Pair A = 1c2c (head) + 25ed (worker);
// 102c is standalone now, whatever the registry seed once said.
const RESOLVED = [
  nodeRecord("gx10-102c"),
  nodeRecord("gx10-25ed", { role: "worker", rank: 1, groupId: "pair", groupName: "Pair A", headId: "gx10-1c2c" }),
  nodeRecord("gx10-1c2c", { role: "head", rank: 0, groupId: "pair", groupName: "Pair A" }),
  nodeRecord("narthex"),
];

afterEach(() => cleanupRenders());

describe("deriveGroups on resolved records", () => {
  it("one wave per resolved group, head first; standalones alone", () => {
    expect(deriveGroups(RESOLVED)).toEqual([["gx10-102c"], ["gx10-1c2c", "gx10-25ed"], ["narthex"]]);
  });

  it("a 3-member group orders head, then workers by rank", () => {
    const three = [
      nodeRecord("c", { role: "worker", rank: 2, groupId: "t3" }),
      nodeRecord("a", { role: "worker", rank: 1, groupId: "t3" }),
      nodeRecord("z", { role: "head", rank: 0, groupId: "t3" }),
    ];
    expect(deriveGroups(three)).toEqual([["z", "a", "c"]]);
  });
});

describe("UpdateRow group cell", () => {
  const row = (node: ReturnType<typeof nodeRecord> | null) =>
    render(
      <table>
        <tbody>
          <UpdateRow
            view={updatesView(node?.id ?? "gone")}
            node={node}
            now={FIXED_NOW}
            expanded={false}
            notice={null}
            onToggle={() => {}}
            onSchedule={() => {}}
            onConfirmNow={() => {}}
          />
        </tbody>
      </table>
    ).container;

  it("shows the resolved group name", () => {
    expect(row(RESOLVED[2]).querySelector('[data-testid="update-row-group"]')?.textContent).toBe("Pair A");
  });
  it("falls back to the group id, then a dash", () => {
    const noName = nodeRecord("x", { groupId: "tp2", role: "head", rank: 0 });
    expect(row(noName).querySelector('[data-testid="update-row-group"]')?.textContent).toBe("tp2");
    expect(row(RESOLVED[0]).querySelector('[data-testid="update-row-group"]')?.textContent).toBe("—");
    expect(row(null).querySelector('[data-testid="update-row-group"]')?.textContent).toBe("—");
  });
});
