/**
 * Allowlisted Hasso switch-model lifecycle (COMP2 / #118).
 *
 * The dashboard may only invoke `./switch-model.sh <allowlisted-target>`.
 * No shell strings, no extra flags, no arbitrary paths.
 *
 * Verified against the pinned alzeo `switch-model.sh` case at
 * https://github.com/hasso5703/alzeo/blob/01902c67709c4164c30ccf036422bfed6f172158/switch-model.sh
 * (parser `case "$MODEL" in` around line 60). Unsupported invented names
 * fail compatibility instead of executing a guessed command.
 */
export const PINNED_ALZEO_SWITCH_TARGETS = Object.freeze([
  "stock",
  "uncensored",
  "fp8",
  "uncensored-fp8",
  "flash",
  "flash-nvda",
  "flash-uncensored",
  "image",
  "image-turbo",
  "video",
  "kolibri",
  "kolibri-nvfp4",
  "nemotron",
  "nemotron-super",
  "flash-local",
  "ornith-122b",
]);

/** Targets bound to current herd recipe variants (subset of the pin). */
export const ALLOWED_SWITCH_TARGETS = Object.freeze([
  "stock",
  "uncensored",
  "flash",
  "flash-uncensored",
]);

export const SWITCH_SCRIPT = "./switch-model.sh";

const TARGET_SET = new Set(ALLOWED_SWITCH_TARGETS);

/**
 * @param {string|null|undefined} target
 * @returns {{ok: true, target: string, argv: string[]} | {ok: false, error: string, code: string}}
 */
export function validateSwitchTarget(target) {
  if (target == null || target === "") {
    return { ok: false, error: "no switchTarget on variant (metadata-only swap)", code: "no-switch-target" };
  }
  if (typeof target !== "string" || !TARGET_SET.has(target)) {
    const pinned = PINNED_ALZEO_SWITCH_TARGETS.includes(target);
    return {
      ok: false,
      error: pinned
        ? `switch target '${target}' exists upstream but no current herd recipe variant binds it`
        : `switch target '${String(target)}' is not a pinned switch-model.sh target (expected ${ALLOWED_SWITCH_TARGETS.join("|")})`,
      code: pinned ? "target-unbound-in-herd" : "target-not-allowlisted",
    };
  }
  return { ok: true, target, argv: [SWITCH_SCRIPT, target] };
}

/**
 * Reject argv that is not exactly the reviewed switch-model invocation.
 * @param {unknown} argv
 */
export function validateSwitchArgv(argv) {
  if (!Array.isArray(argv) || argv.length !== 2) {
    return { ok: false, error: "switch argv must be ['./switch-model.sh', <target>]", code: "bad-argv" };
  }
  if (argv[0] !== SWITCH_SCRIPT) {
    return { ok: false, error: "only ./switch-model.sh is an allowed switch entrypoint", code: "bad-script" };
  }
  return validateSwitchTarget(argv[1]);
}

/**
 * Preview steps for a variant that has a hardware switchTarget.
 * @param {{switchTarget?: string|null, id?: string}} variant
 * @param {{confirmedDowntime?: boolean}} [opts]
 */
export function planHardwareSwitch(variant, opts = {}) {
  const checked = validateSwitchTarget(variant?.switchTarget);
  if (!checked.ok) return checked;
  if (opts.confirmedDowntime === false) {
    return { ok: false, error: "hardware switch requires confirmed downtime", code: "downtime-unconfirmed" };
  }
  return {
    ok: true,
    target: checked.target,
    argv: checked.argv,
    willDo: ["switch-model", "canary"],
    confirmedDowntime: true,
    // Matches Hasso load: long model load is expected, not a failure.
    estDowntimeMs: 20 * 60 * 1000,
  };
}
