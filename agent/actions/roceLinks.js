/**
 * roceLinks.js — RoCE link-plan apply seam for the node agent (SC5d, #75).
 *
 * The dashboard computes a per-link plan from the user's spark grouping
 * (server/fleet/rocePlan.js): which RoCE interfaces stay enabled and at what
 * speed (2-spark group: the one pair link at 200G; 3-spark group: all three
 * links at 100G, the GB10/ConnectX-7 hardware limit). This module is where
 * that plan would be turned into host commands.
 *
 * There is NO verified, safe command path for changing link state or speed
 * on a GB10 today, so this module deliberately does not guess at network
 * commands (no `ip link`, `ethtool -s`, `mlxconfig`, netplan, …):
 *   - a dry run validates the plan and returns the exact commands it would
 *     run — currently none — together with the reason;
 *   - a real apply always answers 501 "not implemented".
 *
 * TODO(SC5d follow-up): add the command path once it is verified on real
 * hardware, and physical-cable / link-type verification (later feature).
 *
 * Zero dependencies, Node 18+.
 */

/** Whether a non-dry-run apply can change hardware. Flip only with a verified command path. */
export const ROCE_APPLY_IMPLEMENTED = false;

export const NOT_IMPLEMENTED_MESSAGE =
  "not implemented: no verified command path for changing RoCE link state or speed on this host; " +
  "the plan was not applied and nothing on the host was changed";

/** Linux netdev name rule (IFNAMSIZ 16 incl. NUL). */
const IFNAME_RE = /^[A-Za-z0-9._-]{1,15}$/;
/** Speeds the GB10 RoCE ports run at in a 2- or 3-spark mesh. */
export const ALLOWED_SPEEDS_MBPS = Object.freeze([100000, 200000]);
const ACTIONS = new Set(["enable", "disable"]);

/**
 * Validate one host's slice of a link plan.
 * Entry shape: { ifName: string, action: "enable"|"disable", speedMbps: number|null }.
 * @param {unknown} entries
 * @returns {{ ok: true, entries: Array<{ifName: string, action: string, speedMbps: number|null}> } | { ok: false, errors: string[] }}
 */
export function validateLinkPlan(entries) {
  if (!Array.isArray(entries)) return { ok: false, errors: ["interfaces must be an array"] };
  const errors = [];
  const out = [];
  const seen = new Set();
  entries.forEach((e, i) => {
    if (!e || typeof e !== "object") {
      errors.push(`interfaces[${i}] must be an object`);
      return;
    }
    if (typeof e.ifName !== "string" || !IFNAME_RE.test(e.ifName)) {
      errors.push(`interfaces[${i}].ifName is not a valid interface name`);
      return;
    }
    if (seen.has(e.ifName)) errors.push(`interfaces[${i}].ifName ${e.ifName} is listed twice`);
    seen.add(e.ifName);
    if (!ACTIONS.has(e.action)) errors.push(`interfaces[${i}].action must be enable or disable`);
    const speed = e.speedMbps ?? null;
    if (e.action === "enable" && !ALLOWED_SPEEDS_MBPS.includes(speed)) {
      errors.push(`interfaces[${i}].speedMbps must be one of ${ALLOWED_SPEEDS_MBPS.join(", ")} when enabling`);
    }
    if (e.action === "disable" && speed !== null) errors.push(`interfaces[${i}].speedMbps must be null when disabling`);
    out.push({ ifName: e.ifName, action: e.action, speedMbps: speed });
  });
  return errors.length ? { ok: false, errors } : { ok: true, entries: out };
}

/**
 * The exact host commands a plan maps to. Intentionally empty: we do not
 * guess at link-config commands without a verified path (see header).
 * @param {Array<{ifName: string, action: string, speedMbps: number|null}>} _entries
 * @returns {string[]}
 */
export function planCommands(_entries) {
  return [];
}

/**
 * Apply (or dry-run) one host's link plan.
 * @param {{ interfaces?: unknown, dryRun?: unknown }} body
 * @returns {{ status: number, body: object }}
 */
export function applyLinkPlan(body) {
  const req = body && typeof body === "object" ? body : {};
  // Dry run is the default: only an explicit `dryRun: false` asks for a real apply.
  const dryRun = req.dryRun !== false;
  const v = validateLinkPlan(req.interfaces ?? []);
  if (!v.ok) return { status: 400, body: { ok: false, error: v.errors.join("; ") } };
  const commands = planCommands(v.entries);
  if (dryRun) {
    return {
      status: 200,
      body: {
        ok: true,
        dryRun: true,
        implemented: ROCE_APPLY_IMPLEMENTED,
        interfaces: v.entries,
        commands,
        message: ROCE_APPLY_IMPLEMENTED
          ? "dry run: these commands would run"
          : "dry run: no commands would run — " + NOT_IMPLEMENTED_MESSAGE,
      },
    };
  }
  return { status: 501, body: { ok: false, dryRun: false, implemented: false, error: NOT_IMPLEMENTED_MESSAGE } };
}
