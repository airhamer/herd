/**
 * Standard-Linux update probe (UPD2, issue #103).
 *
 * Sparks keep the DGX OTA backend. SSH / generic Linux nodes (Narthex)
 * need a package probe that is not the Spark OTA path. This module is
 * read-only parsing plus a plan shape for an operator-confirmed apply.
 * It never runs apt-get -y by itself.
 */

export const LINUX_APT_PROBE_CMD = `
echo '===OS==='
. /etc/os-release 2>/dev/null; echo "\${ID:-unknown}"
echo '===TOOL==='
if command -v apt-get >/dev/null 2>&1; then echo apt
elif command -v dnf >/dev/null 2>&1; then echo dnf
else echo none
fi
echo '===SIM==='
if command -v apt-get >/dev/null 2>&1; then
  apt-get -s upgrade 2>/dev/null || true
elif command -v dnf >/dev/null 2>&1; then
  dnf -q check-update 2>/dev/null || true
fi
echo '===LIST==='
if command -v apt-get >/dev/null 2>&1; then
  apt list --upgradable 2>/dev/null || true
fi
echo '===END==='
`;

function section(text, name) {
  const re = new RegExp(`===${name}===([\\s\\S]*?)(?====[A-Z]+===|$)`);
  const m = String(text ?? "").replace(/\r/g, "").match(re);
  return m ? m[1] : "";
}

/**
 * Parse a probe transcript. Missing/unknown tools are an error, not "0 upgrades".
 * @param {string} text
 * @returns {{ ok: true, tool: string, distro: string, upgradable: number, security: number } | { ok: false, error: string }}
 */
export function parseLinuxUpdateProbe(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "empty probe output" };
  }
  const distro = section(text, "OS").trim().split(/\s+/)[0] || "unknown";
  const tool = section(text, "TOOL").trim().split(/\s+/)[0] || "none";
  if (tool === "none" || tool === "") {
    return { ok: false, error: "no apt or dnf on this host" };
  }
  const sim = section(text, "SIM");
  const list = section(text, "LIST");
  let upgradable = 0;
  if (tool === "apt") {
    upgradable = (sim.match(/^Inst /gm) || []).length;
  } else if (tool === "dnf") {
    upgradable = list
      ? list.split("\n").filter((l) => l.trim() && !/^Last metadata/.test(l) && !/^===/.test(l)).length
      : sim.split("\n").filter((l) => l.trim() && !/^Last metadata/.test(l)).length;
  }
  const security = (list || sim).split("\n").filter((l) => /security/i.test(l)).length;
  return { ok: true, tool, distro, upgradable, security };
}

/**
 * Dashboard snapshot for a Linux node. packages is omitted (null) when the
 * probe failed so the UI can show "—" rather than 0 / current.
 */
export function linuxUpdatesSnapshot(probe, now = Date.now()) {
  if (!probe || probe.ok !== true) {
    return {
      backend: "linux",
      probedAt: now,
      probeError: probe && probe.error ? probe.error : "probe failed",
      upgradableCount: null,
      securityCount: null,
      packages: null,
      firmware: null,
      latestOtaApplied: null,
      otaAvailable: null,
    };
  }
  return {
    backend: "linux",
    probedAt: now,
    probeError: null,
    upgradableCount: probe.upgradable,
    securityCount: probe.security,
    packages: null,
    firmware: null,
    latestOtaApplied: null,
    otaAvailable: null,
  };
}

/** Apply is never automatic. Dry-run is the default. */
export function linuxUpgradePlan({ confirm = false, tool = "apt" } = {}) {
  if (tool === "dnf") {
    return {
      dryRun: !confirm,
      command: confirm ? "sudo dnf -y upgrade" : "dnf -q check-update",
      requiresConfirm: true,
    };
  }
  return {
    dryRun: !confirm,
    command: confirm
      ? "sudo DEBIAN_FRONTEND=noninteractive apt-get -y upgrade"
      : "apt-get -s upgrade",
    requiresConfirm: true,
  };
}

export function linuxDisplay(snapshot) {
  if (!snapshot || snapshot.upgradableCount == null) return "stale";
  if (snapshot.upgradableCount > 0) return "available";
  return "current";
}

export default {
  LINUX_APT_PROBE_CMD,
  parseLinuxUpdateProbe,
  linuxUpdatesSnapshot,
  linuxUpgradePlan,
  linuxDisplay,
};
