# GPU clock cap display — behaviour spec (LIC2)

Written for the LIC2 clean-room rewrite (issue #52). Display only: herd
never sets or clears a clock lock.

## 1. The marker

`nvidia-smi -lgc` locks cannot be read back through nvidia-smi or NVML, so
whatever applies the lock records it in a marker file. herd reads the first
of these that has content:

1. `/run/sparkdash/gpu-clock-cap`
2. `$HOME/.config/sparkdash/gpu-clock-cap`

Its first line is `<MHz>` or `<MHz> <boot_id>`. The current boot id is
`/proc/sys/kernel/random/boot_id`.

## 2. Parsing (`parseClockCap(text)`, exported from SystemCollector.js)

Input: the marker line(s) followed by the current boot id (either may be
missing). Result: the capped MHz, or `null`.

- The cap line is the first non-blank line whose first whitespace-separated
  token is all digits. A boot id that happens to start with digits
  (`139dcc9e-…`) is not a cap line.
- MHz must be a positive integer, else `null`.
- If the cap line carries a boot id and the input also contains a current
  boot id (the last UUID-shaped line), they must match case-insensitively;
  a mismatch means the box rebooted and the lock is gone → `null`.
- No cap line → `null`.

`CLOCK_CAP_FILES` (exported) lists the two paths above, the second spelled
with a literal `$HOME`.

## 3. Collection

- Local units read the marker and boot id from disk (with `$HOME` expanded);
  remote units get it as one more `---`-separated section (the fifth,
  index 4) of the existing remote GPU probe. `_getRemoteGpu(executor)`
  accepts the ssh executor as a parameter (tests inject one).
- Every throttle object has `clockCapMHz` (null by default). When a cap is
  found it is set, and the throttle `detail` gains "Clock locked ≤ N MHz":
  replacing "Clocks not limited" when that was the whole detail, otherwise
  appended with " · ".
- A read failure is treated as "no cap".

## 4. UI

- `GpuThrottle.clockCapMHz?: number | null` in `src/api/types.ts`.
- GPU panel (unit page): under the SM clock row, a muted line
  "cap N MHz" (tooltip "Locked with nvidia-smi -lgc") when the cap is set.
- Overview unit card header: while online and capped, a tag
  "Cap X.X GHz" (MHz / 1000, one decimal; tooltip "GPU clock locked with
  nvidia-smi -lgc"), before the online/offline label.
