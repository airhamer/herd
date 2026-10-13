import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchFleetUpdates } from "../../api/client";
import type { NodeUpdatesView } from "../../api/types";

// Shared "DGX update available" badge state for fleet cards (SPEC §6.3:
// single badge from view.display === "available", click → /updates).
// One provider-mounted fan-out GET per app load — FleetPage itself is not
// owned by this batch, so the fleet cards read the badge through this
// context instead of new props. Best-effort: a failed fetch hides badges.

export interface FleetUpdatesBadgeValue {
  displayByNode: ReadonlyMap<string, NodeUpdatesView["display"]>;
  openUpdates: () => void;
}

const EMPTY: ReadonlyMap<string, NodeUpdatesView["display"]> = new Map();

const FleetUpdatesBadgeContext = createContext<FleetUpdatesBadgeValue>({
  displayByNode: EMPTY,
  openUpdates: () => {},
});

export function FleetUpdatesProvider({
  openUpdates,
  children,
}: {
  openUpdates: () => void;
  children: ReactNode;
}) {
  const [displayByNode, setDisplayByNode] = useState<FleetUpdatesBadgeValue["displayByNode"]>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    fetchFleetUpdates()
      .then((r) => {
        if (cancelled) return;
        setDisplayByNode(new Map(r.views.map((v) => [v.nodeId, v.display] as const)));
      })
      .catch(() => {
        /* badge is best-effort — keep showing none */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(() => ({ displayByNode, openUpdates }), [displayByNode, openUpdates]);
  return <FleetUpdatesBadgeContext.Provider value={value}>{children}</FleetUpdatesBadgeContext.Provider>;
}

/** Badge display for one node + the navigate-to-/updates callback. */
export function useNodeUpdateDisplay(nodeId: string): FleetUpdatesBadgeValue {
  return useContext(FleetUpdatesBadgeContext);
}

/** Display for a specific node, or null when unknown. */
export function useNodeDisplay(nodeId: string): NodeUpdatesView["display"] | null {
  const { displayByNode } = useContext(FleetUpdatesBadgeContext);
  return displayByNode.get(nodeId) ?? null;
}
