import { useEffect, useMemo, useRef, useState } from "react";
import type { AlertInstance, SparkSnapshot } from "../../api/types";
import { fleetExceptions } from "../../shared/fleetExceptions";
import { AlertTriangleIcon, ChevronRightIcon } from "../ui/icons";

type TempUnit = "celsius" | "fahrenheit";

/** One row of the exceptions strip (also what the tab badge and desktop notifications count). */
export type FleetAlert = {
  /** unitId + ":" + exception id; the server keys its alerts the same way. */
  key: string;
  unitId: string;
  unitName: string;
  label: string;
  detail?: string;
  severity: "critical" | "warning";
  /** Set on throttle rows, which stay visible even when the full list is hidden. */
  throttle?: boolean;
  /** Server-reported start (epoch ms); null when only this page has seen it. */
  startsAt: number | null;
};

function toRow(unitId: string, unitName: string, id: string, label: string, severity: FleetAlert["severity"], detail: string | undefined, startsAt: number | null): FleetAlert {
  const row: FleetAlert = { key: `${unitId}:${id}`, unitId, unitName, label, severity, startsAt };
  if (detail) row.detail = detail;
  if (id === "throttle") row.throttle = true;
  return row;
}

/** Rows computed in the browser from live snapshots, via the shared fleetExceptions rules. */
export function deriveAlerts(sparks: SparkSnapshot[], unit: TempUnit = "celsius"): FleetAlert[] {
  return sparks.flatMap((spark) =>
    fleetExceptions(spark, unit).map((ex) => toRow(spark.id, spark.name, ex.id, ex.label, ex.severity, ex.detail, null))
  );
}

/**
 * Rows for the server's firing alerts. When the same condition is visible in
 * the live snapshot its wording comes from there (so the user's temperature
 * unit applies); otherwise the server's label and summary are used.
 */
export function serverAlertRows(alerts: AlertInstance[], sparks: SparkSnapshot[], unit: TempUnit = "celsius"): FleetAlert[] {
  const local = new Map<string, FleetAlert>();
  for (const row of deriveAlerts(sparks, unit)) local.set(row.key, row);
  return alerts.map((alert) => {
    const seen = local.get(alert.key);
    const detail = seen ? seen.detail : alert.summary !== alert.label ? alert.summary : undefined;
    return toRow(alert.unitId, seen?.unitName ?? alert.unitName, alert.ruleId, seen?.label ?? alert.label, alert.severity, detail, alert.startsAt);
  });
}

/**
 * The strip's rows. Server alerts win once notifications are on and the
 * server's set has arrived; before that, and while off, the browser derives
 * them. With `showExceptions` off only throttle rows remain.
 */
export function stripAlerts({
  sparks,
  alertsEnabled = false,
  serverAlerts = null,
  showExceptions = true,
  temperatureUnit = "celsius",
}: {
  sparks: SparkSnapshot[];
  alertsEnabled?: boolean;
  serverAlerts?: AlertInstance[] | null;
  showExceptions?: boolean;
  temperatureUnit?: TempUnit;
}): FleetAlert[] {
  const useServer = alertsEnabled && serverAlerts != null;
  const rows = useServer ? serverAlertRows(serverAlerts, sparks, temperatureUnit) : deriveAlerts(sparks, temperatureUnit);
  if (showExceptions) return rows;
  return rows.filter((row) => row.throttle === true);
}

function minutesActive(since: number, now: number): string {
  return `${Math.max(0, Math.floor((now - since) / 60_000))}m active`;
}

/** Overview banner listing the fleet's active exceptions; clicking a row opens that unit. */
export function FleetAlertStrip({
  sparks,
  onSelect,
  showExceptions = true,
  temperatureUnit = "celsius",
  alertsEnabled = false,
  serverAlerts = null,
}: {
  sparks: SparkSnapshot[];
  onSelect?: (id: string) => void;
  showExceptions?: boolean;
  temperatureUnit?: TempUnit;
  /** When true (and `serverAlerts` is loaded) the strip shows the server's alerts and their start times. */
  alertsEnabled?: boolean;
  serverAlerts?: AlertInstance[] | null;
}) {
  const alerts = useMemo(
    () => stripAlerts({ sparks, alertsEnabled, serverAlerts, showExceptions, temperatureUnit }),
    [sparks, alertsEnabled, serverAlerts, showExceptions, temperatureUnit]
  );
  const firstSeen = useRef(new Map<string, number>());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const active = new Set(alerts.map((alert) => alert.key));
    for (const alert of alerts) if (!firstSeen.current.has(alert.key)) firstSeen.current.set(alert.key, Date.now());
    for (const key of firstSeen.current.keys()) if (!active.has(key)) firstSeen.current.delete(key);
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [alerts]);
  if (alerts.length === 0) return null;
  return (
    <section className="ov-alerts" aria-label="Active fleet exceptions">
      {alerts.map((alert) => {
        const since = alert.startsAt ?? firstSeen.current.get(alert.key) ?? now;
        const meta = alert.detail ? `${alert.detail} · ${minutesActive(since, now)}` : minutesActive(since, now);
        const tone = alert.severity === "critical" ? " ov-alert--bad" : "";
        return (
          <div key={alert.key} role="status" className={`alert-strip ov-alert${tone}`}>
            <AlertTriangleIcon className="h-[18px] w-[18px] shrink-0" />
            <div className="ov-alert__text">
              <b>{alert.unitName}</b> {alert.label}.<small>{meta}</small>
            </div>
            <button type="button" className="btn btn--sm" onClick={() => onSelect?.(alert.unitId)}>
              Open {alert.unitName}
              <ChevronRightIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </section>
  );
}
