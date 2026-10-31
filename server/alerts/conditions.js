// What the alert engine watches, per unit: the Overview strip's exceptions
// (src/shared/fleetExceptions.js) and HealthEvaluator's findings. No
// thresholds live here; severities and texts come from those two sources.
// docs/specs/alerts.md §3. Clean-room implementation (LIC1).
import { fleetExceptions } from "../../src/shared/fleetExceptions.js";
import { MAX_SUMMARY_CHARS, capText } from "./text.js";

/** Longest "wait before notifying" a rule may have: one day. */
export const MAX_FOR_SEC = 86_400;

const rule = (id, source, name, description, forSec, enabled = true) =>
  Object.freeze({ id, source, name, description, defaults: Object.freeze({ enabled, forSec }) });

/** Rule catalogue in display order: strip exceptions first, then Health findings. */
export const RULES = Object.freeze([
  rule("offline", "strip", "Unit offline", "The unit stopped answering herd's liveness checks.", 60),
  rule("throttle", "strip", "GPU throttling", "The GPU is slowed down for heat or by a hardware signal (a power cap alone does not count).", 60),
  rule("disk", "strip", "Storage", "A volume on the unit is 90% full or more.", 300),
  rule("llm", "strip", "LLM unavailable", "None of the unit's monitored LLM endpoints respond.", 120),
  rule("tailnet", "strip", "Tailnet unavailable", "The unit is not connected to the tailnet (when tailnet monitoring is on).", 120),
  rule("thermal", "health", "GPU temperature", "Health reports the GPU running hot or near its shutdown temperature.", 60),
  rule("memory", "health", "Unified memory low", "Health reports little unified memory left.", 60),
  rule("low-power", "health", "GPU stuck in low power", "Health sees a busy GPU drawing idle-level power.", 0),
  rule("xid", "health", "NVIDIA Xid error", "The kernel logged a new NVIDIA Xid error.", 0),
  rule("oom", "health", "Out-of-memory kill", "The kernel killed a process for lack of memory.", 0),
  rule("roce-link", "health", "RoCE link down", "A RoCE port lost its link.", 60),
  rule("roce-loss", "health", "RoCE packet loss", "A RoCE port is dropping or retransmitting packets.", 120),
  rule("link-speed", "health", "Slow network link", "A network port negotiated below its expected speed.", 300),
  rule("concurrency", "health", "Several models loaded", "More than one model is being served while memory is tight.", 300, false),
]);

const BY_ID = new Map(RULES.map((r) => [r.id, r]));
const STRIP_IDS = new Set(RULES.filter((r) => r.source === "strip").map((r) => r.id));

/** Catalogue entry, or undefined for a finding id the catalogue does not list. */
export const ruleById = (id) => BY_ID.get(id);

/**
 * Defaults merged with a user's overrides. Unknown ids (a Health finding added
 * after this catalogue) are on, with no wait.
 */
export function effectiveRuleConfig(id, overrides = {}) {
  const defaults = BY_ID.get(id)?.defaults ?? { enabled: true, forSec: 0 };
  const own = overrides?.[id] ?? {};
  return {
    enabled: typeof own.enabled === "boolean" ? own.enabled : defaults.enabled,
    forSec: Number.isFinite(own.forSec) ? own.forSec : defaults.forSec,
  };
}

const toAlertSeverity = (severity) => (severity === "critical" ? "critical" : "warning");

function fromException(unit, exception) {
  let summary = exception.detail || exception.label;
  if (exception.id === "offline" && unit.offlineReason) summary = `Unreachable: ${unit.offlineReason}`;
  return {
    ruleId: exception.id,
    ruleName: BY_ID.get(exception.id)?.name ?? exception.id,
    severity: exception.severity,
    label: capText(exception.label, MAX_SUMMARY_CHARS),
    summary: capText(summary, MAX_SUMMARY_CHARS),
  };
}

function fromFinding(finding) {
  const title = capText(finding.title, MAX_SUMMARY_CHARS);
  return {
    ruleId: String(finding.id),
    ruleName: BY_ID.get(finding.id)?.name ?? title,
    severity: toAlertSeverity(finding.severity),
    label: title,
    summary: capText(finding.detail, MAX_SUMMARY_CHARS),
  };
}

/**
 * Current conditions for one unit plus which rules this reading can decide.
 * A rule that is not judged keeps whatever alert it has (neither fires nor
 * clears): an unreachable unit's other readings are stale, and before the
 * first liveness check nothing is known at all.
 */
export function collectConditions(unit) {
  if (!unit.online) {
    if (!unit.offlineReason) return { conditions: [], judged: () => false };
    const offline = fleetExceptions(unit).find((e) => e.id === "offline");
    return {
      conditions: offline ? [fromException(unit, offline)] : [],
      judged: (ruleId) => ruleId === "offline",
    };
  }
  const conditions = fleetExceptions(unit)
    .filter((e) => STRIP_IDS.has(e.id))
    .map((e) => fromException(unit, e));
  for (const finding of unit.health ?? []) {
    if (finding && finding.id != null) conditions.push(fromFinding(finding));
  }
  return { conditions, judged: () => true };
}
