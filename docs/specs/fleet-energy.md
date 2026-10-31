# Spec: Fleet energy across Sparks and agent nodes (issue #33)

Replaces IMPLEMENTATION_PLAN F4 ("extend `/api/fleet-energy` onto node agents").
Overlaps MGPU1 (#30): energy sums power over every GPU on a host; the rest of
#30 (per-GPU cards, VRAM per GPU) is out of scope here.

## What is measured, what is modelled

Every value is **estimated, not wall-metered**. Per host, each sample (2 s) is:

| Hardware | GPU term | CPU term | Base term |
|---|---|---|---|
| GB10 (SSH Spark, or agent node with one NVIDIA GPU and unified memory) | nvidia-smi board draw | 5.2–65 W from CPU utilisation | 23 W; total clamped to 240 W |
| x86 / ARM + discrete NVIDIA | Σ nvidia-smi `power.draw` over every GPU | RAPL package power (Δ`energy_uj`/Δt), else a power sensor, else TDP model | idle baseline |
| AMD GPU | Σ hwmon `power1_average` (else `power1_input`), µW → W | as above | idle baseline |
| No GPU | — | as above | idle baseline (only if the CPU term exists) |

* Idle baseline: `energyIdleBaselineW` (default 40 W), overridable per host with
  `energyHostBaselines[<spark or node id>]`, 0–2000 W.
* A host with no GPU reading and no CPU reading is *not reporting* and is not
  estimated.
* Sources travel with the value: `gpuSource` ∈ {`nvidia-smi`, `amd-hwmon`},
  `cpuSource` ∈ {`rapl`, `hwmon`, `thermal`, `estimated`}. "Measured" watts are
  the terms from a sensor; the rest is model + baseline.
* Plausibility: one host ≤ 20 kW; no floor.

## Scope and freshness

* Scope = every registered Spark id + every registered agent-node id whose LAN
  IP is not a Spark's. A node on a Spark's IP is shown as `duplicateOf` that
  Spark and counted once.
* Spark freshness: the monitor's GPU and CPU collections succeeded within the
  freshness window (unchanged).
* Node freshness: online and a new `polledAt` seen by the server within 10 s.
* Registering or removing a Spark or node re-scopes the tracker live: new ids
  start with zero energy, removed ids keep their minutes until they age out of
  the 31-day window. No restart is needed. A file written for a different scope
  is still retired into monthly history on start-up.

## Aggregates

* `currentWatts30s`: mean over the last 30 s of the summed watts of reporting
  hosts, using only samples with the same reporting set as the latest one.
* `hourlyWatts24h[h]`: Σ over hosts of the host's mean watts over the time it
  reported in that hour; `null` if none reported.
* `energy24hKwh` / `energy31dKwh`: Σ of per-host minute energy (1-minute buckets,
  31 days).
* `whPerOutputToken24h`: Δ output tokens of the single `head` host paired with
  full-fleet energy only; `null` (and hidden in the UI) otherwise.

## API: `GET /api/fleet-energy`

The tracker snapshot (unchanged fields; `membershipChanged` and
`restartRequired` are now always `false`) plus:

```
label: "estimated, not wall-metered"
hosts: [{ id, name, kind: "spark"|"host"|"node", online, reporting, duplicateOf,
          model: "gb10"|"measured"|null, watts, measuredWatts, gpuWatts, cpuWatts,
          baselineWatts, gpuSource, cpuSource, gpuCount }]
coverage: { reportingHosts, hostsInScope, percent, measuredSharePct, coverage24hPct }
cost: null | { currency, pricePerKwh, cost24h, cost31d, costPerDayAtCurrent }
```

`cost` is `null` when `electricityPricePerKwh` is 0.

## Settings

| Key | Default | Notes |
|---|---|---|
| `showFleetEnergy` | `true` | Settings files from before #33 (`settingsRevision` < 2) are switched on once. |
| `electricityPricePerKwh` | `0.17` | 0–100; invalid → default; 0 hides cost. |
| `electricityCurrency` | `"USD"` | three letters, upper-cased; invalid → default. |
| `energyIdleBaselineW` | `40` | 0–2000. |
| `energyHostBaselines` | `{}` | `{ id: W }`; invalid entries dropped. |

## UI

The Fleet energy card sits on the Fleet tab under the node cards (and above
Recent activity), with the monthly table inside it. It shows the label with
coverage, current W, 24 h and 31 d kWh, cost when priced, Wh/token only when
tokens were counted, 24 hourly bars (gaps empty) and one table of every Spark
and agent node with its watts and power sources.
