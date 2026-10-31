import { useMemo } from "react";
import type { AlertInstance, SparkSnapshot } from "../api/types";
import { stripAlerts, type FleetAlert } from "../components/OverviewPage/FleetAlertStrip";

export interface FleetAlertsInput {
  sparks: SparkSnapshot[];
  alertsEnabled: boolean;
  serverAlerts: AlertInstance[] | null;
  showExceptions: boolean;
  temperatureUnit: "celsius" | "fahrenheit";
}

export interface FleetAlertsView {
  /** Same rows the Overview strip renders, computed by the same function. */
  rows: FleetAlert[];
  /**
   * Whether `rows` reflect real data: with server alerts on, once the server's
   * set has arrived; otherwise once a live snapshot with units exists. Before
   * that every unit would look unreachable.
   */
  ready: boolean;
  source: "server" | "browser";
}

/** The fleet's active alerts for the tab badge and desktop notifications. */
export function useFleetAlerts(input: FleetAlertsInput): FleetAlertsView {
  const { sparks, alertsEnabled, serverAlerts, showExceptions, temperatureUnit } = input;
  return useMemo((): FleetAlertsView => {
    const rows = stripAlerts({ sparks, alertsEnabled, serverAlerts, showExceptions, temperatureUnit });
    if (alertsEnabled && serverAlerts !== null) return { rows, ready: true, source: "server" };
    return { rows, ready: !alertsEnabled && sparks.length > 0, source: "browser" };
  }, [sparks, alertsEnabled, serverAlerts, showExceptions, temperatureUnit]);
}
