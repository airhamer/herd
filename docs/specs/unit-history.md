# Spec: per-unit history (GPU raw series + 48 h / 30 d bucketed tiers)

Status: behavioural spec for the clean-room re-implementation (LIC2, #52).
Sources: herd's existing tests, the HTTP routes and file formats herd already
serves and writes, the TypeScript API types (`MetricsHistory*`,
`GpuHistoryResponse`), the observed UI, and the upstream sparkDash
README/CHANGELOG feature description. No upstream source code was used to
write this spec.

## 1. What it is

The server keeps a short memory of every unit so a freshly opened unit page
can draw the last hours immediately. Two independent kinds of history are
kept in one store:

1. **GPU raw series** — always on. Utilization %, temperature (°C) and power
   as % of the board limit, one reading per sample, as parallel arrays.
   Two retention depths fed by the same readings:
   - *dense*: min gap 1.5 s, kept 8 h, persisted to `gpu-history.json`;
   - *long* (optional, only when a long file is configured): min gap 60 s,
     kept 7 days, persisted to `gpu-history-long.json`.
   On a host with ≥ 2 GPUs each card also gets its own series, aligned with
   the aggregate timestamps.
2. **Bucketed tiers** — opt-in (`settings.metricsHistory`, default `false`).
   1-minute buckets kept 48 h and 15-minute buckets kept 30 days, both fed
   directly from samples (never rolled up from one another), persisted to
   `metrics-history.json`.

## 2. Sample extraction (`server/metrics/historySample.js`)

`extractSample(snapshot, isFresh = () => true)` → `null` for a unit that is
not `online === true`; otherwise an object `{ seriesKey: number }` holding
only values the unit really reported. Nothing is ever recorded as a stand-in
zero.

| key | source | skipped when |
|---|---|---|
| `gpuUtil` | `metrics.gpu.usage` | gpu domain not fresh; gpu is the all-zero default (temperature, usage, power.draw, vram.total all 0); `metricAvailability.usage === false` |
| `gpuTemp` | `metrics.gpu.temperature` | as above, or `metricAvailability.temperature === false`, or value ≤ 0 (no sensor) |
| `gpuPower` | `metrics.gpu.power.draw` (W) | as above, or `metricAvailability.powerDraw === false` |
| `memUsedMB`, `memFreeMB` | `memoryReading()` below | reading is null |
| `cpuUtil` | `metrics.cpu.usage` | cpu not fresh, or cpu is the all-zero default (usage, temperature, draw, tdp all 0) |
| `cpuTemp` | `metrics.cpu.temperature` | as cpuUtil, or ≤ 0 |
| `ramUsedMB` | `metrics.ram.used` | only for `kind === "host"`, ram fresh and `ram.total > 0` |
| `netRx`, `netTx` | `networkRates()` below | network not fresh or no rates |
| `llm:<port>:genTps` / `prefillTps` / `kvUsage` | `metrics.llm[i]` zipped with `snapshot.llmPorts[i]` | llm not fresh; port not an integer; entry not `available === true`. `kvUsage` = `kvCacheUsage` clamped to 0–1 |

Non-finite values are always dropped.

`memoryReading(snapshot, isFresh)` → `{ usedMB, freeMB }` or `null`:
- *unified* units (any `kind` other than `"host"`) with a fresh `memory`
  domain and `unifiedMemory.total > 0`: used = max(0, gpuUsed) + max(0,
  cpuUsed) (non-finite parts count as 0); free = max(0, available) when
  finite, else max(0, total − used).
- otherwise the GPU view: requires a fresh gpu domain, a non-default gpu
  and `vram.total > 0`; used = max(0, vram.used); free = max(0,
  vram.available) on unified units when finite, else max(0, total − used)
  (a discrete host's `available` is system RAM and is ignored).

`networkRates(network)` → `{ rx, tx }` or `null`: interfaces that are not
`disabled` and not `lo`; if `primaryInterface` names one of them use only
that one, else sum all of them; null when none has a finite rate.

## 3. Series, keys and buckets (`server/metrics/historyTiers.js`)

- Unit series: `gpuUtil gpuTemp gpuPower memUsedMB memFreeMB cpuUtil cpuTemp
  ramUsedMB netRx netTx`.
- LLM series per port: `genTps prefillTps kvUsage`; key form
  `llm:<port>:<name>` (port 1–5 digits). Any other key is ignored.
- A bucket per series holds avg, max and sample count n; `memFreeMB` (and
  only it) also keeps min. Merges are weighted by n (keep sum, not avg).
  n saturates at 65 535.
- Tiers: `{ name: "1m", stepMs: 60 000, retentionMs: 48 h }`,
  `{ name: "15m", stepMs: 900 000, retentionMs: 30 d }` (`BUCKET_TIERS`).
  Bucket start = floor(t / step) × step (epoch-aligned).
- Ranges (`HISTORY_RANGES`): `1h` (tier 1m, step 1 min), `6h` (1m, 1 min),
  `24h` (1m, 3 min), `7d` (15m, 30 min), `30d` (15m, 90 min). Each range is
  answered from its tier, re-gridded onto the range step (weighted merge),
  ≤ 500 points per series.
- Wire / storage rounding: |v| ≥ 100 → integer; ≥ 1 → 2 decimals; else 4
  decimals.
- Memory per series is bounded by the retention (rows older than it are cut).
- Exports other modules rely on: `BUCKET_TIERS` (array of `{ name, stepMs,
  retentionMs }`), `HISTORY_RANGES` (object `range → { spanMs, tier, stepMs }`),
  `UNIT_SERIES`, `LLM_SERIES`, `llmKey(port, name)`, `parseLlmKey(key)`,
  `isKnownKey(key)`. Internal helpers are free-form.

## 4. Store (`server/metrics/UnitHistory.js`)

`new UnitHistory({ file, tiersFile, maxAgeMs = 8 h, minGapMs = 1500,
longFile (omitted = no long series; null = long series in memory only),
longMaxAgeMs = 7 d, longMinGapMs = 60 s, tiersEnabled = () => true,
now = Date.now, writeSync, writeAsync, readFileSync, yieldFn, logError })`.

### 4.1 GPU raw series

- `record(id, at, usage, temperature, powerPct, devices = [])` → true when
  the dense or long series took it. A series rejects a non-finite `at`, a
  reading with no finite value at all (aggregate and devices), a reading
  closer than its min gap to its last one, and a reading going back in
  time. Values are rounded to 1 decimal; non-finite → `null`.
- `deviceReadings(gpus)` → `[]` unless ≥ 2 cards; at most 16 cards; each
  `{ index, name|null, usage|null, temperature|null, powerPct|null }`
  honouring `metricAvailability` (usage/temperature/powerDraw/powerLimit
  false → null); powerPct = min(100, draw / limit × 100) only for a finite
  positive limit. Entries without a non-negative integer index are skipped.
- Per-card series: a card seen for the first time is back-filled with
  nulls; a known card missing from a reading gets nulls; at most 16 cards
  per unit; a card whose `u` is all null after trimming is dropped.
- Trimming: when a series is longer than 64 readings and its oldest is more
  than a minute past the cutoff, cut everything older than the cutoff (so
  the cut is chunked, not per sample). `_prune(now)` (also run before every
  save) cuts exactly and drops units left empty.
- `get(id, sinceMs = 0)` → `{ t, u, c, p, gpus }` from the dense series;
  `gpus` = `[{ index, name, u, c, p }]` sorted by index, only cards with a
  non-null `u` in the window; unknown unit → all arrays empty.
- `maxWindowMs` → long max age if a long series exists, else dense max age.
- `window(id, windowMs, atMs = now())` → same shape; long series when it
  exists and `windowMs` > dense max age, else dense.
- `remove(id)` forgets the unit in every series and the tiers.
- File format (both GPU files, unchanged):
  `{"version":1,"sparks":{"<id>":{"t":[…],"u":[…],"c":[…],"p":[…],"g":{"<index>":{"n":name|null,"u":[…],"c":[…],"p":[…]}}}}}`.
  Load drops readings older than the max age, non-increasing timestamps
  and malformed entries; files without `g` load fine. Invalid JSON →
  quarantined (moved to `<file>.corrupt-<ms>`), store starts empty; missing
  file → empty.

### 4.2 Bucketed tiers

- The tiers file is read lazily — only on the first `recordSample()` or
  `query()` — so an install that never enables the setting never reads or
  writes it.
- `recordSample(units, atMs = now())`; `units = [{ id, llmPorts?, values }]`
  is the whole fleet in order. For each unit: remember its LLM ports when
  given; add every known, finite value to the bucket of both tiers that
  contains `atMs` (a sample from a clock that stepped back merges into the
  bucket for its own time). `values` null/empty = a gap.
  Units absent from the list, and series of LLM ports a unit no longer
  lists, are dropped at the next save; a membership change alone makes the
  file dirty.
- `query(id, range, atMs = now())` → `{ range, stepMs, from: atMs − span,
  to: atMs, points: [{ t, <series>: { avg, max, min? } }], llm: [{ port,
  points: [{ t, genTps?, prefillTps?, kvUsage? }] }] }` built from the tier's
  buckets starting at or after `from`. The bucket still filling is included. Unknown range (including prototype names) → throws
  `unknown range: <range>`. Unknown unit → empty `points`/`llm`. LLM
  entries sorted by port; LLM ports the unit no longer lists are hidden.
- `serializeTiers(atMs)` → the parsed file object (tests).
- Tiers file format:
  `{"version":1,"savedAt":ms,"units":{"<id>":{"1m":{"t":[…],"series":{"<key>":{"avg":[…],"max":[…],"min":[…]?,"n":[…]}}},"15m":{…}}}}`.
  Rows ascending by t and limited to the retention window, open bucket
  merged in; series keys sorted; `null` avg/max/min and `n: 0` where a
  series has no samples in a row; a series with no samples at all, a tier
  with no series and a unit with no tiers are omitted. File mode 0600.
  Loading skips rows outside retention or not aligned to the tier step,
  unknown keys and cells without a positive integer n and finite avg/max.
  A file that is not valid JSON or has another version / no `units` object
  is quarantined. Worst case (every bucket of both tiers full, 10 unit
  series + 3 LLM series) stays under 1.4 MB per unit on disk.
- Unit ids are only used as Map keys and object text keys, so ids such as
  `__proto__`, `constructor` and `toString` round-trip.

### 4.3 Persistence

- `start()` → periodic async `save()` every 5 minutes (unref'd), only if
  some file is configured.
- `save()` → async; one GPU file then the tiers file; yields (`yieldFn`)
  once per unit while serializing the tiers; writes via `writeAsync(file,
  text, 0o600, { shouldCommit })`. Coalesced: while a save is in flight,
  `save()` returns the same promise. A file is written only when its change
  revision moved since the last successful write; changes made while a save
  is in flight are written next time.
- `flush()` → synchronous write of whatever is dirty; returns true when a
  file was written. It supersedes any async save in flight: that save's
  `shouldCommit` then answers false, so it discards its temp file and never
  renames older data over the newer file.
- `stop()` → clear the timer, then `flush()`.
- The tiers file is written only while `tiersEnabled()` is true; buckets
  pending when the setting goes off are written if it is turned on again
  before a restart.
- Write errors are logged via `logError` and never thrown to callers.

## 5. Runtime and routes (`server/metrics/UnitHistoryRuntime.js`)

- `HISTORY_SAMPLE_INTERVAL_MS = 2000`, `MIN_STALE_WINDOW_MS = 15 000`.
- `staleWindowMs(monitor, domain)` = max(15 s, 3 × `monitor.pollIntervalMs(domain)`)
  (just 15 s when the monitor or interval is missing).
- `monitorFreshness(monitor, atMs)` → `(domain) => boolean`: false without a
  monitor, when `monitor.collectionOk(domain)` is false, when
  `lastCollectedAt(domain)` is null or older than the stale window.
- `recordGpuSample(store, snap, atMs)`: only for an online snapshot whose
  gpu result carries the collector's success tag; power % = min(100, draw /
  limit × 100) with a finite positive limit; honours `metricAvailability`;
  passes `deviceReadings(gpu.gpus)`.
- `createUnitHistoryRuntime({ store, orderedSnapshots, monitors, isEnabled,
  now, setIntervalFn, clearIntervalFn, logError })` → `{ sample, start,
  stop }`. Each tick: GPU raw sample for every snapshot (errors swallowed);
  then, only if `isEnabled()` (read every tick), one `recordSample()` with
  `extractSample(snap, monitorFreshness(monitors.get(id), atMs))` per unit.
  `start()` → interval at 2 s (unref'd) + `store.start()`; idempotent;
  false once stopped. `stop()` → clear the interval, `store.stop()`; after
  stop, a tick does nothing. Errors go to `logError`, never thrown.
- Routes (`registerUnitHistoryRoutes(app, { store, hasUnit, isEnabled, now })`):
  - `GET /api/sparks/:id/gpu-history?windowMs=` → 404 `{ error: "Spark not
    found" }` for an unknown unit; else `store.window(id, w)` where
    w = clamp(Number(windowMs) || 8 h, 60 s, store.maxWindowMs).
  - `GET /api/sparks/:id/history?range=` → 404 as above; range defaults to
    `1h`; a non-string or unknown range (including `__proto__`, repeated
    `range=`) → 400 `{ error: "range must be one of: 1h, 6h, 24h, 7d, 30d" }`;
    setting off → `{ enabled: false }`; else `{ enabled: true, …query }`.

## 6. Monitor accessors (`server/sparks/SparkMonitor.js`)

- `lastCollectedAt(domain)` → epoch ms of the last poll of that domain that
  returned real data, or null.
- `collectionOk(domain)` → gpu/cpu: the collector's success flag for the
  latest poll; other domains: the latest completed poll returned real data.
- `pollIntervalMs(domain)` → this fork's fixed cadence for the domain
  (gpu, cpu, ram, network, storage, memory, llm, comfy, tailscale, hermes),
  null otherwise.
- "Real data": gpu/cpu carry the success tag; ram/memory `total > 0`;
  network has ≥ 1 interface; storage is a non-empty array; llm is an array.
  A RoCE sample's `sampledAt` is recorded as the `roce` domain's time.

## 7. Settings and config

- `settings.metricsHistory` boolean, default false, coerced with Boolean().
- `METRICS_HISTORY_JSON_PATH` = env or `config/metrics-history.json`;
  GPU files from `GPU_HISTORY_JSON_PATH` / `GPU_HISTORY_LONG_JSON_PATH` or
  `config/gpu-history(-long).json`.
- index.js: unit removal calls `store.remove(id)`; shutdown calls the
  runtime's `stop()` and logs a failure.

## 8. Atomic writes (`server/util/atomicWrite.js`)

- `atomicWrite(file, text, mode = 0o600)` (sync): create the directory;
  write a temp file named `<file>.<pid>.tmp` (stable per target and
  process, so a crashed write is overwritten next time); chmod it; rename
  onto the target. If the rename fails (e.g. a root-owned target), make the
  target writable, unlink it and rename again. Never write the target in
  place. Remove the temp file on every failure and throw
  `Failed to write <file>: <reason>` (plus a `sudo chown` hint when the
  fallback also failed). Finally chmod the target (best effort).
- `atomicWriteAsync(file, text, mode = 0o600, { shouldCommit, fsp })` →
  `Promise<boolean>`: same steps on `fs.promises` with temp name
  `<file>.<pid>.async.tmp` (never shared with a concurrent sync write);
  `shouldCommit()` is asked after the data is on disk and before the
  rename — false → delete the temp file, leave the target, resolve false.
- `quarantineCorrupt(file, label, err)` — unchanged from LIC1.

## 9. Client and types

- `getUnitHistory(id, range)` → `GET /api/sparks/<encodeURIComponent(id)>/history?range=<range>`.
- `getGpuHistory(id, windowMs?)` → `GET /api/sparks/<id>/gpu-history`
  (`?windowMs=<n>` only when given).
- Types `MetricsHistoryRange`, `HistoryStat`, `HistoryUnitSeries`,
  `HistoryLlmSeries`, `HistoryPoint`, `HistoryLlmPoint`,
  `MetricsHistoryData`, `MetricsHistoryResponse`, `GpuHistoryDevice`,
  `GpuHistoryResponse` keep their shapes.

## 10. History panel UI (`src/components/SparkPage/HistoryPanel.tsx`, `HistoryChart.tsx`)

Placement: the last block of the unit page, after the `.spark-page` grid,
full width.

Panel:
- Title `History · <last hour | last 6 hours | last 24 hours | last 7 days |
  last 30 days>`; range chips `1h 6h 24h 7d 30d` in a group labelled
  `History range`, `aria-pressed` on the active chip. Default `1h`; the
  choice is stored in `localStorage["sparkdash.ui.history.range"]` and read
  back on mount. Changing range clears the crosshair and refetches.
- Polls `getUnitHistory(id, range)` immediately and every 30 s
  (`HISTORY_POLL_MS`), only while the panel is on screen
  (IntersectionObserver; counts as on screen when unavailable) and the tab
  is visible; becoming visible again fetches at once. The last answer stays
  on screen while paused. A new unit or range starts from loading.
- States: `Loading history…`; `Could not load history: <msg>` (no data
  yet); `Metrics history is off on the server. Turn it on in Settings →
  Metrics history.`; `No history in this range yet. The server records
  every unit while it is online.`; otherwise a caption `Average per <n>
  min|s · shaded: peak (low point for free memory) · gaps: offline or not
  reported` and a two-column grid of charts. After a failed refresh with
  data on screen: `Stale: could not refresh (<msg>). Showing data from
  <HH:MM>.` with `role="status"`; it disappears after a successful refresh.
- Charts (id → title, series, format):
  `gpuUtil` "GPU utilization" (0–100 %, band max); `gpuTemp` "GPU
  temperature" (°C/°F per the temperature unit, y rounded to 5, band max);
  `gpuPower` "GPU power" (W, from 0, band max); `memFree` "Memory free
  (unified)" or, for `kind === "host"`, "VRAM free" (MB→GB, from 0, y
  rounded to 1024, band **min**, threshold lines `low` / `critical` at 8 /
  4 GB unified or 2 / 1 GB discrete, labelled `low 8.0 GB` etc.);
  `cpuUtil` "CPU utilization"; `cpuTemp` "CPU temperature"; `ramUsed` "RAM
  used" only for hosts with data; `network` "Network" with series `↓ rx`
  and `↑ tx` (bytes/s, no band); per LLM port `llm-<port>-gen` "Decode
  tok/s · :<port>", `llm-<port>-prefill` "Prefill tok/s · :<port>",
  `llm-<port>-kv` "KV cache · :<port>" (0–100 %, only when reported).
  Percent format: one decimal below 10, else integer (`0.0%`, `60%`).
  tok/s: ≥ 1000 → `k` suffix; ≥ 100 → integer; else one decimal (`40.0`).
- The shared timeline is the sorted union of all bucket times (unit and
  LLM); every series is aligned to it with null where absent.

Chart (`data-chart="<id>"`):
- Header: title and one readout per series (`data-readout="<key>"`, label
  shown only when there is more than one series) — the value at the
  crosshair, else the latest bucket with data, else `—`.
- Y labels `data-axis="ymax"` / `"ymin"`, x labels `data-axis="xstart"` /
  `"xend"` (from / to).
- Inline SVG plot that stretches to its box. Lines: a run of consecutive
  non-null buckets no more than 1.5 steps apart is one
  `polyline[data-series=<key>]`, with a `polygon[data-band=<key>]` between
  avg and max (or min) when the series has a band; a lone bucket is a short
  `line[data-series]`. Thresholds are dashed lines (`data-threshold`) with
  HTML labels. A bucket is drawn at its middle.
- Y domain: covers avg, the drawn band edge and thresholds; fixed
  `yMin`/`yMax` are extended if data exceeds them; without `yMax` and with
  thresholds, leave ≥ 25 % room above the highest threshold; auto bounds
  are rounded (lower to a unit, upper to a 1-1.2-1.5-2-2.5-3-4-5-6-8 ×
  10^k multiple of the unit). No data → `No data in this range`, no
  domain, not focusable.
- Crosshair: one timestamp shared by every chart in the panel
  (`line[data-crosshair]` on every chart with data). The plot is a
  focusable `role="group"`; focus puts the crosshair on the newest bucket;
  ArrowLeft / ArrowRight / Home / End move it; Escape and blur clear it;
  pointer move/down snaps to the nearest bucket middle; pointer leave
  clears it unless focused. Only the chart under the pointer/focus shows a
  tooltip (`data-tooltip`, `role="status"`): time, one row per series
  (label + value), and a footer with `max <v>` / `min <v>` for banded
  series.
- Exported helpers: `segmentRuns(timeline, values, stepMs)` → index runs;
  `nearestIndex(timeline, t)` → nearest index (ties go to the earlier one,
  −1 when empty); `yDomain(series, yMin?, yMax?, thresholds?, yUnit?)` →
  `{ lo, hi }` or null.
