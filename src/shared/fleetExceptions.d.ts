import type { SparkSnapshot } from "../api/types";

export type TemperatureUnit = "celsius" | "fahrenheit";

/** Overview exception kinds; also the alert rule ids with source "strip". */
export type FleetExceptionId = "offline" | "throttle" | "disk" | "llm" | "tailnet";

export interface FleetException {
  id: FleetExceptionId;
  severity: "critical" | "warning";
  /** Phrase shown after the unit name. */
  label: string;
  /** Supporting figures (throttle only). */
  detail?: string;
}

export function formatTemperature(celsius: number, unit?: TemperatureUnit): string;
export function fleetExceptions(spark: SparkSnapshot, unit?: TemperatureUnit): FleetException[];
