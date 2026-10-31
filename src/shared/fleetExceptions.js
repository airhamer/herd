// Overview "exceptions": the per-unit problems the fleet strip shows and the
// alert engine watches (docs/specs/alerts.md §2). Shared by browser and server
// so both always agree. Evolved from herd's MIT FleetAlertStrip derive();
// clean-room rewrite for LIC1.

/**
 * Whole-degree temperature in the chosen unit, e.g. "71°C" or "161°F".
 * @param {number} celsius
 * @param {"celsius"|"fahrenheit"} [unit]
 */
export function formatTemperature(celsius, unit = "celsius") {
  if (unit === "fahrenheit") return `${Math.round((celsius * 9) / 5 + 32)}°F`;
  return `${Math.round(celsius)}°C`;
}

/** Text after the unit name for a throttling GPU, plus the supporting figures. */
function throttleRow(gpu, unit) {
  const flags = gpu?.throttle;
  // A software power cap on its own is normal operation, not an exception.
  if (!flags || !(flags.thermal || flags.hwSlowdown)) return null;
  const facts = [];
  if (typeof flags.detail === "string" && flags.detail) facts.push(flags.detail);
  if (Number.isFinite(gpu.temperature)) facts.push(`GPU at ${formatTemperature(gpu.temperature, unit)}`);
  if (flags.smClockMHz) {
    const share = flags.smClockPct == null ? "" : ` (${Math.round(flags.smClockPct)}% of max)`;
    facts.push(`SM clock ${(flags.smClockMHz / 1000).toFixed(1)} GHz${share}`);
  }
  return {
    id: "throttle",
    label: flags.thermal ? "is thermal throttling" : "has a hardware slowdown",
    detail: facts.join(" · "),
    severity: "critical",
  };
}

function llmDown(spark) {
  const ports = spark.metrics?.llm ?? [];
  return spark.llmMonitoring !== false && ports.length > 0 && !ports.some((port) => port.available);
}

function tailnetDown(spark) {
  const ts = spark.metrics?.tailscale;
  return Boolean(spark.tailscaleMonitoring && ts && (!ts.available || ts.online === false));
}

/**
 * Exceptions for one unit, in display order.
 * @param {import("../api/types").SparkSnapshot} spark
 * @param {"celsius"|"fahrenheit"} [unit]
 * @returns {Array<{ id: "offline"|"throttle"|"disk"|"llm"|"tailnet", label: string, detail?: string, severity: "critical"|"warning" }>}
 */
export function fleetExceptions(spark, unit = "celsius") {
  const found = [];
  if (!spark.online) found.push({ id: "offline", label: "Host unreachable", severity: "critical" });
  const throttle = throttleRow(spark.metrics?.gpu, unit);
  if (throttle) found.push(throttle);
  if ((spark.metrics?.storage ?? []).some((volume) => volume.percentage >= 90)) {
    found.push({ id: "disk", label: "storage is at or above 90%", severity: "warning" });
  }
  if (llmDown(spark)) found.push({ id: "llm", label: "LLM is unavailable", severity: "warning" });
  if (tailnetDown(spark)) found.push({ id: "tailnet", label: "tailnet is unavailable", severity: "warning" });
  return found;
}
