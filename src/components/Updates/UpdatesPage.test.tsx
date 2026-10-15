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

// ─── Batch 10-A: effective build display ───────────────────────────────────
// latestOtaApplied.version is the authoritative effective build; swBuild is
// the /etc/dgx-release FILE value (live fleet: 7.2.3/7.5.0 file vs 7.6.0
// applied fleet-wide). The build cell must LEAD with the effective value and
// keep the stale file value visible but clearly labeled.

describe("Batch 10-A effective build display", () => {
  it("applied OTA present → build cell shows the EFFECTIVE build, file value labeled stale", async () => {
    const { container } = mountPage(() => [
      updatesView("n1", {
        snapshot: snapshot({
          swBuild: "7.2.3",
          latestOtaApplied: { version: "7.6.0", date: "2026-09-30" },
        }),
      }),
    ]);
    await flush();
    const build = container.querySelector('[data-testid="update-row-build"]')?.textContent ?? "";
    expect(build.startsWith("7.6.0")).toBe(true); // effective value leads
    expect(build).toContain("file 7.2.3 (stale)"); // both visible, stale clearly labeled
  });

  it("fallback: no applied OTA → build cell shows swBuild alone, no stale label", async () => {
    const { container } = mountPage(() => [
      updatesView("n1", { snapshot: snapshot({ swBuild: "7.5.0", latestOtaApplied: null }) }),
    ]);
    await flush();
    const build = container.querySelector('[data-testid="update-row-build"]')?.textContent ?? "";
    expect(build.trim()).toBe("7.5.0");
    expect(build).not.toContain("stale");
  });

  it("negative: file value EQUAL to the applied OTA is not labeled stale", async () => {
    const { container } = mountPage(() => [
      updatesView("n1", {
        snapshot: snapshot({ swBuild: "7.6.0", latestOtaApplied: { version: "7.6.0", date: "2026-09-30" } }),
      }),
    ]);
    await flush();
    const build = container.querySelector('[data-testid="update-row-build"]')?.textContent ?? "";
    expect(build.trim()).toBe("7.6.0");
    expect(build).not.toContain("stale");
  });
});

// ─── Batch 10-A: per-spark status + Update Now wiring ──────────────────────

describe("Batch 10-A per-spark status + Update Now wiring", () => {
  it("snapshot.listError set → one visible per-spark warning (role=alert); clean snapshot renders none", async () => {
    // listError is emitted by the agent's /list fail-soft path (producer-
    // asserted in agent/updates/__tests__/dgx.test.js) and passed verbatim by
    // server/fleet/updatesProxy.js buildView; not yet declared on the TS type,
    // so the fixture adds it structurally (Object.assign skips excess-property
    // checks without casting the seam input).
    const failing = Object.assign(snapshot({ swBuild: "7.2.3" }), {
      listError: "GET http://127.0.0.1:11000/updates/list -> HTTP 500",
    });
    const { container } = mountPage(() => [
      updatesView("n1", { snapshot: failing }),
      updatesView("n2", { snapshot: snapshot() }),
    ]);
    await flush();
    const alerts = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(alerts).toHaveLength(1); // negative case: n2's clean snapshot is silent
    expect(alerts[0].textContent).toContain("GET http://127.0.0.1:11000/updates/list -> HTTP 500");
  });

  it("pending package count + last-check time (probedAt) render per spark", async () => {
    const packages = ["a", "b", "c"].map((name) => ({
      name,
      currentVersion: "1.0",
      availableVersion: "2.0",
      sizeBytes: 1024,
    }));
    const { container } = mountPage(() => [
      updatesView("n1", { display: "available", snapshot: snapshot({ probedAt: FIXED_NOW, packages }) }),
    ]);
    await flush();
    expect(container.querySelector('[data-testid="update-row-pkgs"]')?.textContent).toBe("3");
    // now={FIXED_NOW} prop and probedAt={FIXED_NOW} → zero-elapsed label
    expect(container.querySelector('[data-testid="update-row-lastcheck"]')?.textContent).toBe("just now");
  });

  it("row 'Update now' + confirm POSTs the existing route /api/fleet/nodes/:id/updates/now", async () => {
    const { container } = mountPage(() => [updatesView("n1")], (c) =>
      c.method === "POST" && c.url === "/api/fleet/nodes/n1/updates/now"
        ? { status: 200, body: { ok: true } }
        : null
    );
    await flush();
    click(findButton(container, "Update now")); // two-step confirm (SPEC §6.3)
    click(findButton(document, "Trigger update"));
    await flush();
    const post = calls.find((c) => c.method === "POST" && c.url === "/api/fleet/nodes/n1/updates/now");
    expect(post).toBeDefined();
    expect(Array.from(document.querySelectorAll('[role="alert"]'))).toHaveLength(0); // success → no alert
  });
});
