import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, flush } from "../../testing/render";
import { UpdatesPage } from "./UpdatesPage";
import { WAVE_LOCK_NOTICE } from "./format";
import { FIXED_NOW, makeFetchRouter, nodeRecord, snapshot, updatesView, type RecordedCall, type Reply } from "./testKit";

// Deterministic suite: fake timers only; the page takes `now` as a prop.
// Every fetch is the recorded router — zero real timers/clocks/network.

let calls: RecordedCall[];

function mountPage(
  views: () => ReturnType<typeof updatesView>[],
  extra: (call: RecordedCall) => Reply | null = () => null
) {
  const router = makeFetchRouter((call) => {
    if (call.url === "/api/fleet/updates") return { status: 200, body: { views: views() } };
    if (call.url === "/api/fleet/nodes") return { status: 200, body: { nodes: [nodeRecord("n1"), nodeRecord("n2", { groupId: "g1" }), nodeRecord("n3", { groupId: "g1" })] } };
    const hit = extra(call);
    if (hit) return hit;
    return { status: 404, body: { error: `unexpected ${call.method} ${call.url}` } };
  });
  calls = router.calls;
  return render(<UpdatesPage now={FIXED_NOW} />);
}

function updatesGetCalls(): number {
  return calls.filter((c) => c.method === "GET" && c.url === "/api/fleet/updates").length;
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(el: Element | null | undefined) {
  act(() => {
    (el as HTMLElement).click();
  });
}

function findButton(root: ParentNode, text: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(text)) as HTMLElement | undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("UpdatesPage refresh cadence (seed-and-diff, fake timers)", () => {
  it("idle: no refetch at 5 s, exactly one refetch at 60 s", async () => {
    mountPage(() => [updatesView("n1"), updatesView("n2", { display: "available" })]);
    await flush();
    const seeded = updatesGetCalls();
    expect(seeded).toBe(1); // mount fetch

    await advance(5_000);
    expect(updatesGetCalls()).toBe(seeded); // 5 s must NOT fire while idle

    await advance(55_000); // now at 60 s
    expect(updatesGetCalls()).toBe(seeded + 1); // 60 s idle cadence fires

    await advance(60_000);
    expect(updatesGetCalls()).toBe(seeded + 2);
  });

  it("active (updating/rebooting/slow) switches to the 5 s cadence", async () => {
    for (const display of ["updating", "rebooting", "slow"] as const) {
      calls = [];
      mountPage(() => [updatesView("n1", { display })]);
      await flush();
      const seeded = updatesGetCalls();
      expect(seeded).toBe(1);
      await advance(5_000);
      expect(updatesGetCalls()).toBe(seeded + 1);
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.useFakeTimers();
    }
  });

  it("idle→active→idle recreates ONE interval that follows the mode", async () => {
    let active = false;
    mountPage(() => [updatesView("n1", active ? { display: "rebooting" } : { display: "current" })]);
    await flush();
    expect(updatesGetCalls()).toBe(1);

    await advance(5_000);
    expect(updatesGetCalls()).toBe(1); // still idle mode

    active = true; // server starts reporting rebooting
    await advance(60_000); // idle tick fires → views flip to active
    expect(updatesGetCalls()).toBe(2);

    await advance(5_000); // active mode → 5 s interval
    expect(updatesGetCalls()).toBe(3);

    active = false;
    await advance(5_000); // the active tick fires, views flip back to idle
    const afterFlip = updatesGetCalls();
    expect(afterFlip).toBe(4);
    await advance(5_000); // idle mode again: no 5 s refetch
    expect(updatesGetCalls()).toBe(afterFlip);
    await advance(60_000);
    expect(updatesGetCalls()).toBe(afterFlip + 1);
  });

  it("unmount clears the interval (no fetches after teardown)", async () => {
    const { root } = mountPage(() => [updatesView("n1")]);
    await flush();
    expect(updatesGetCalls()).toBe(1);

    act(() => root.unmount());
    await advance(65_000);
    await advance(10_000);
    expect(updatesGetCalls()).toBe(1); // nothing fired after unmount
  });
});

describe("UpdatesPage trigger errors", () => {
  async function triggerWith(reply: Reply) {
    const { container } = mountPage(() => [updatesView("n1")], (c) =>
      c.method === "POST" && c.url === "/api/fleet/nodes/n1/updates/now" ? reply : null
    );
    await flush();
    click(findButton(container, "Update now")); // opens the two-step confirm
    click(findButton(document, "Trigger update")); // portal dialog on body
    await flush();
    return container;
  }

  it("409 → inline WAVE_LOCK_NOTICE (exact string), not the server body", async () => {
    const container = await triggerWith({ status: 409, body: { error: "LOCKED-BY-SOMETHING-ELSE" } });
    const alerts = Array.from(document.querySelectorAll('[role="alert"]')).map((a) => a.textContent ?? "");
    expect(alerts.join("|")).toContain(WAVE_LOCK_NOTICE);
    expect(alerts.join("|")).not.toContain("LOCKED-BY-SOMETHING-ELSE");
    expect(container.textContent).toBeDefined();
  });

  it("non-409 → the server's own message", async () => {
    await triggerWith({ status: 500, body: { error: "agent exploded" } });
    const alerts = Array.from(document.querySelectorAll('[role="alert"]')).map((a) => a.textContent ?? "");
    expect(alerts.join("|")).toContain("agent exploded");
    expect(alerts.join("|")).not.toContain(WAVE_LOCK_NOTICE);
  });
});

describe("UpdatesPage detail expander + grace rendering", () => {
  it("expander renders package and firmware tables from the snapshot", async () => {
    const { container } = mountPage(() => [
      updatesView("n1", {
        display: "available",
        snapshot: snapshot({
          packages: [
            { name: "openssl", currentVersion: "3.0.2", availableVersion: "3.0.11", sizeBytes: 2097152 },
          ],
          firmware: [{ component: "UEFI", currentVersion: "1.2", availableVersion: "1.4" }],
        }),
      }),
    ]);
    await flush();
    expect(container.textContent).not.toContain("openssl"); // collapsed: hidden
    const toggle = Array.from(container.querySelectorAll('button[aria-expanded="false"]'))[0];
    click(toggle);
    await flush();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Packages");
    expect(text).toContain("openssl");
    expect(text).toContain("3.0.2");
    expect(text).toContain("3.0.11");
    expect(text).toContain("2.0 MB");
    expect(text).toContain("Firmware");
    expect(text).toContain("UEFI");
    expect(text).toContain("1.4");
  });

  it("expander on a snapshot-less view shows the stale/unreachable line", async () => {
    const { container } = mountPage(() => [updatesView("n1", { display: "stale", snapshot: null })]);
    await flush();
    click(Array.from(container.querySelectorAll('button[aria-expanded="false"]'))[0]);
    await flush();
    expect(document.body.textContent).toContain("probe stale/unreachable");
  });

  it("graceElapsedMs 252000 renders 'REBOOTING 4:12' (injected clock)", async () => {
    const { container } = mountPage(() => [
      updatesView("n1", { display: "rebooting", graceElapsedMs: 252_000 }),
    ]);
    await flush();
    const state = container.querySelector('[data-testid="update-row-state"]')?.textContent;
    expect(state).toBe("REBOOTING 4:12");
  });

  it("negative: a current view never renders SLOW", async () => {
    const { container } = mountPage(() => [
      updatesView("n1", { display: "current", graceElapsedMs: 1_361_000 }),
    ]);
    await flush();
    expect(container.querySelector('[data-testid="update-row-state"]')?.textContent).toBe("current");
    expect(container.textContent).not.toContain("SLOW");
    expect(container.textContent).not.toContain("REBOOTING");
  });
});
