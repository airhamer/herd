/**
 * disk.js — disk metrics via df (local, no SSH).
 *
 * Seam type: DiskMetrics[] (shared/types.ts). Real filesystems only: pseudo
 * types (tmpfs, overlay, ...) and loop/SRAM devices are filtered out, same
 * exclusion set as sparkDash SystemCollector._getDiskUsage.
 */
import { runShell } from "./util.js";

const PSEUDO_TYPES = new Set([
  "tmpfs", "devtmpfs", "proc", "sysfs", "efivarfs", "squashfs",
  "overlay", "devpts", "cgroup", "cgroup2", "iso9660", "zram",
]);

const MB = 1024 * 1024;

/**
 * Collect disk usage per mounted real filesystem.
 * @param {{ exec?: (cmd: string) => Promise<string> }} [deps]
 * @returns {Promise<Array<{device:string, mount:string, usedMB:number, totalMB:number, availableMB:number, percentage:number}>>}
 */
export async function collectDisk({ exec = runShell } = {}) {
  try {
    // -P: POSIX columns; -T: filesystem type; -B1: bytes (header still says
    // "1024-blocks" with -P, values are bytes).
    const out = await exec("df -B1 -T -P 2>/dev/null");
    const disks = [];
    for (const line of out.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 7) continue;
      const [device, type, sizeS, usedS, availS, , mount] = parts;
      if (PSEUDO_TYPES.has(String(type || "").toLowerCase())) continue;
      if (/^\/dev\/(loop|sr|zram|ram|dm-)/.test(device)) continue;
      if (device === "none" || device === "tmpfs" || !device) continue;
      if (!mount || mount === "/boot/efi" || mount.includes("/snap/")) continue;
      if (mount.startsWith("/host")) continue;  // ignore the host root bind mount itself (we surface real / via /host logic)

      const total = parseInt(sizeS, 10);
      const used = parseInt(usedS, 10);
      const avail = parseInt(availS, 10);
      if (!Number.isFinite(total) || total <= 0) continue;

      const usedMB = Math.round((Number.isFinite(used) ? used : 0) / MB);
      const availableMB = Math.round((Number.isFinite(avail) ? avail : 0) / MB);
      const denom = (Number.isFinite(used) ? used : 0) + (Number.isFinite(avail) ? avail : 0);
      const percentage =
        denom > 0
          ? Math.min(100, Math.max(0, Math.round(((Number.isFinite(used) ? used : 0) / denom) * 100)))
          : 0;

      disks.push({
        device,
        mount,
        usedMB,
        totalMB: Math.round(total / MB),
        availableMB,
        percentage,
      });
    }

    // Host root visibility: the container often sees an overlay for / and a bind
    // mount (e.g. /opt/rocm or /etc/hosts) carrying the real root device. If /host
    // is mounted (see deploy/install-node-agent.sh), use df /host for the true root.
    try {
      const hOut = await exec("df -B1 -T -P /host 2>/dev/null || true");
      for (const line of hOut.split("\n").slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 7) continue;
        const [device, type, sizeS, usedS, availS, , mount] = parts;
        if (mount !== "/host") continue;
        if (PSEUDO_TYPES.has(String(type || "").toLowerCase())) continue;
        if (/^\/dev\/(loop|sr|zram|ram|dm-)/.test(device)) continue;
        const total = parseInt(sizeS, 10);
        if (!Number.isFinite(total) || total <= 0) continue;
        const used = parseInt(usedS, 10) || 0;
        const avail = parseInt(availS, 10) || 0;
        const usedMB = Math.round(used / MB);
        const availableMB = Math.round(avail / MB);
        const denom = used + avail;
        const percentage = denom > 0 ? Math.min(100, Math.max(0, Math.round((used / denom) * 100))) : 0;
        // Replace any prior entry for this device (the /opt/rocm bind etc) with true root.
        const idx = disks.findIndex((d) => d.device === device);
        const rootEntry = { device, mount: "/", usedMB, totalMB: Math.round(total / MB), availableMB, percentage };
        if (idx !== -1) {
          disks[idx] = rootEntry;
        } else {
          disks.push(rootEntry);
        }
        break;
      }
    } catch { /* /host not mounted or df failed; fall back to container view */ }

    // Dedupe by device; prefer the entry mounted at / (real host root) over bind mounts.
    const byDevice = new Map();
    for (const d of disks) {
      const prev = byDevice.get(d.device);
      if (!prev || (d.mount === "/" && prev.mount !== "/")) {
        byDevice.set(d.device, d);
      }
    }
    // Return with root first if present.
    return Array.from(byDevice.values()).sort((a, b) => (a.mount === "/" ? -1 : 0) - (b.mount === "/" ? -1 : 0) || a.mount.localeCompare(b.mount));
  } catch {
    return [];
  }
}
