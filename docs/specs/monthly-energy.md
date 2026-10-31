# Spec: permanent monthly fleet-energy history

Status: behavioural spec for the clean-room re-implementation (LIC1).
Sources: herd's existing tests and API types (`src/api/types.ts`
`MonthlyEnergy*`), the HTTP contract herd already serves, and the upstream
sparkDash README/CHANGELOG feature description. No upstream source code was
used to write this spec.

## Purpose

The fleet-energy tracker keeps a rolling 31-day window of per-minute buckets
(`config/fleet-energy.json`). That window is lossy by design: it is pruned
and it is set aside when fleet membership changes. The monthly history is a
permanent, compact roll-up of those minutes, one record per **UTC calendar
month**, so long-run energy figures survive pruning, restarts and fleet
changes. All figures are estimates (not wall-metered).

## Inputs

Minute buckets as the tracker already produces them:

| field | meaning |
|---|---|
| `minuteStartMs` | start of the minute, a multiple of 60 000 |
| `nodeWh` | `{ [nodeId]: Wh }` for that minute |
| `nodeCoverageMs` | `{ [nodeId]: ms of the minute that node was measured }` |
| `fleetWattMs` | fleet watt·ms for the minute (fleet Wh = `fleetWattMs / 3.6e6`) |
| `fleetCoverageMs` | ms of the minute the whole fleet was measured |
| `outputTokens` | LLM output tokens counted in the minute |
| `coveredOutputTokens` | output tokens counted while the fleet was measured |

## Module contract (`server/energy/FleetEnergyMonthly.js`)

- `monthKey(ms)` → `"YYYY-MM"` of the UTC month containing `ms`.
- `monthRange("YYYY-MM")` → `[startMs, endMs)` of that UTC month, or `null`
  for anything that is not a well-formed month (`"2026-13"`, `"26-1"`, …).
- `class MonthlyEnergyArchive({ filePath = null, now = Date.now, fileSystem })`
  - In memory only when `filePath` is null.
  - `foldedThroughMs` — the watermark: every minute that starts before it has
    already been counted.
  - `foldBuckets(buckets, { nowMs, trackedSinceMs })` → number of minutes
    added. A minute is folded only once it is finished **plus a 10 s grace**
    (`minuteStart + 60 s + 10 s <= nowMs`), only if it starts at or after the
    watermark, and never if it ends later than the archive clock (`now()`)
    plus one day (clock-jump guard). Folding the same buckets again adds
    nothing. Minutes are folded in time order and the watermark moves to the
    end of the last folded minute. A bucket with no per-node readings adds
    nothing (not even coverage or tokens).
  - `snapshot(atMs = now())` → the API document below.
  - `clear({ month })` / `clear({ all: true })` → number of months removed.
    The watermark is kept so cleared minutes are not re-added from the
    31-day window.
  - `flush()` → persist if anything changed.
- Per-month accumulation: per node `wh` and `coverageMs`; `fleetWh`,
  `fleetCoverageMs`, `outputTokens`, `coveredOutputTokens`, and
  `tokenFleetWh` (fleet Wh of minutes from `trackedSinceMs` on, i.e. while
  tokens were being counted) used for the Wh-per-token figure.

## Persistence

`config/fleet-energy-monthly.json` (env `FLEET_ENERGY_MONTHLY_JSON_PATH`),
gitignored, written atomically at mode `0600`:

```json
{ "version": 1, "savedAt": 0, "foldedThroughMs": 0,
  "months": { "2026-09": { "nodes": { "a": { "wh": 7, "coverageMs": 60000 } },
    "fleetWh": 7, "fleetCoverageMs": 60000, "outputTokens": 0,
    "coveredOutputTokens": 0, "tokenFleetWh": 0 } } }
```

- Existing files in this shape must keep loading (format is unchanged).
- An unreadable file is renamed to `<name>.unreadable-<now>.json` and the
  archive starts empty; it is never overwritten in place and nothing new is
  written until there is something to save.
- A stored watermark more than one day ahead of the clock is clamped back to
  the current time on load; month totals are kept.

## Tracker integration (`FleetEnergyTracker`)

- Options `monthlyFilePath` (or an injected `monthly` archive).
- `monthlySnapshot(atMs)` folds what has closed, then returns the snapshot.
- `clearMonthly({ month } | { all: true })`.
- Recording samples folds finished minutes as they close; `flush()`/`close()`
  persist both files. On first start with an existing 31-day file the
  archive is back-filled from it; the watermark prevents double counting
  when the same file is reloaded after a restart.
- The tracker remembers since when it has counted tokens
  (`tokensTrackedSinceMs`, persisted in the 31-day file).
- **Fleet change**: when the 31-day file belongs to a different node set,
  its minutes are validated against **that file's own node set** with the
  same plausibility rules as a normal load (per-node Wh within 4 Wh/min and
  28.2–240 W, coverage ≤ 1 min, fleet watts within node bounds, non-negative
  safe-integer token counts, aligned and unique minutes, exact node keys),
  the plausible ones are folded, and the file is renamed
  `<name>.scope-<savedAt>.json`. A file with no usable node list adds nothing.

## HTTP API

- `GET /api/fleet-energy/monthly` → `MonthlyEnergy`:
  `{ estimated: true, generatedAt, foldedThroughMs, months: Month[] }`,
  oldest month first. `Month` = `{ month, startMs, endMs, closed, nodeIds
  (sorted), nodes: {id:{wh,coverageMs}}, totalWh (sum of node Wh), fleetWh,
  fleetCoverageMs, outputTokens, coveredOutputTokens, whPerOutputToken }`;
  `closed` is true once `endMs <= at`; `whPerOutputToken` is
  `tokenFleetWh / coveredOutputTokens`, or `null` when no covered tokens.
- `DELETE /api/fleet-energy/monthly?month=YYYY-MM` → `{ removed }`.
- `DELETE /api/fleet-energy/monthly?all=true&confirm=delete-all-history` →
  `{ removed }`. `all=true` without that exact confirmation → 400 with an
  error that names `confirm=delete-all-history`. Anything else (no
  parameters, a bad month, `all=1`, both) → 400. Refusals delete nothing.
- The 31-day window endpoint stays read-only in herd (no DELETE).

## UI (`MonthlyEnergy`, under the Fleet Energy card)

- Fetches once on mount (no polling). States: loading text, error
  "Energy history unavailable: <message>", empty "No closed months yet".
- Table, one row per month, labelled like "Aug 2026" (UTC), kWh with one
  decimal from `fleetWh`; the open month is marked "current"; a footer
  "total N kWh"; the note "estimated, not wall-metered".
