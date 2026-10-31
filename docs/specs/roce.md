# RoCE / RDMA monitoring — behaviour spec (LIC2)

Written for the LIC2 clean-room rewrite (issue #52). It describes what herd's
RoCE feature must do, in herd's own terms: the observable contract (snapshot
fields, health findings, UI text, test ids). How the code achieves it is
left to the implementation.

## 1. Data sources (no root, no switch access)

Per unit, read as an ordinary user:

- **sysfs RDMA tree** `/sys/class/infiniband/<dev>`: port 1 `state`
  (e.g. `4: ACTIVE`), `phys_state` (`5: LinkUp`), `rate`
  (`200 Gb/sec (2X NDR)`), `link_layer`, every file under `hw_counters/`, and
  the attached netdev (first entry of `<dev>/device/net`).
- **netdev** `/sys/class/net/<if>`: `operstate`, `mtu`, `speed` (Mb/s;
  ≤ 0 or unreadable = unknown), `statistics/{rx,tx}_{bytes,errors,dropped}`.
- **slow facts** for each netdev: `ethtool -S` (only `rx_discards_phy`,
  `tx_discards_phy`, `rx_crc_errors_phy`, `rx_symbol_err_phy`,
  `rx_pause_ctrl_phy`, `tx_pause_ctrl_phy`, `rx_prioN_pause`,
  `tx_prioN_pause`, `rx_prioN_discards`, `rx_out_of_buffer`),
  `ethtool -a` (global pause RX/TX on|off) and `mlnx_qos -i` (trust mode,
  PFC-enabled priorities, cable length, DSCP→priority map).

Interface names only reach a shell command after matching
`^[A-Za-z0-9._-]{1,15}$`; duplicates are dropped. Scripts are POSIX sh and
only read. State strings lose their leading `N: ` code. The line protocol
between the scripts and the parsers is private to the module.

## 2. Module `server/collectors/roce.js`

Exports (names other code and tests rely on):

- `ROCE_FAST_SCRIPT` (string), `roceSlowScript(netdevs)` → string or `null`
  when no valid name remains.
- `parseRoceFast(text)` → `{ devices: [{ name, state, physState, rateGbps,
  linkLayer, netdev, counters }], netdevs: Map<name, { name, operstate, mtu,
  speedMbps, rxBytes, txBytes, rxErrors, txErrors, rxDropped, txDropped }> }`.
  Garbage or empty input gives empty results.
- `parseMlnxQos(text)` → `{ trust (lower case) | null, pfcPriorities:
  number[] | null, cableLen | null, dscpMap: { [prio]: number[] } | null }`.
  `pfcPriorities` lists the priorities whose PFC "enabled" flag is 1 (`[]`
  = PFC off) and is null when no PFC table was seen.
- `parseRoceSlow(text)` → `Map<netdev, { eth: {counter: number},
  flowControl: { rx, tx } (booleans or null), qos }>`.
- `LOSS_COUNTERS`: out_of_buffer, packet_seq_err, local_ack_timeout_err,
  rnr_nak_retry_err, implied_nak_seq_err, req_transport_retries_exceeded,
  rx_icrc_encapsulated. `ETH_LOSS_COUNTERS`: rx_discards_phy,
  tx_discards_phy, rx_crc_errors_phy, rx_out_of_buffer.
- Constants: `FAST_INTERVAL_MS` 4500, `SLOW_INTERVAL_MS` 30000,
  `NO_RDMA_RECHECK_MS` 10 min, `LOSS_STREAK_FOR_FINDING` 3,
  `ETH_LOSS_STREAK_FOR_FINDING` 2, `STALE_AFTER_FAILURES` 4,
  `RETRY_AFTER_FAILURE_MS` 15000.
- `class RoceSampler({ run(script) → Promise<stdout>, now = Date.now })`
  with `sample()`.

### Sampler behaviour

- At most one read in flight: concurrent `sample()` calls share it.
- Within `FAST_INTERVAL_MS` of the last good result, return it unchanged.
- A unit whose first successful read lists no RDMA device returns `null`
  and is not asked again for `NO_RDMA_RECHECK_MS`.
- A failed read (run rejects), or an empty read after devices were seen
  before, counts a failure: until `STALE_AFTER_FAILURES` in a row the last
  good result is returned; on reaching it the last result is dropped and the
  call returns `null` (empty read) or rejects with the error (failed read).
  After a failure the script is not run again for `RETRY_AFTER_FAILURE_MS`
  (meanwhile: the last result, or `null` once stale). A good read resets
  the count.
- Slow facts are refreshed at most every `SLOW_INTERVAL_MS`, for the
  netdevs of the current fast read; a failing slow read keeps the previous
  facts (and still waits a full slow interval).
- Result: `{ available: true, sampledAt, devices }`, devices sorted by
  netdev name (device name when none), independent of read order. Device:
  `name, netdev, state, physState, active (state === "ACTIVE"), everActive
  (ACTIVE in any read since the sampler started), rateGbps, linkLayer,
  operstate, mtu, speedMbps, rxBps, txBps (bytes/s since the previous read
  of that device, ≥ 0, null on the first read), rxErrors, txErrors,
  rxDropped, txDropped, counters (raw totals), deltas (per counter, ≥ 0,
  empty on the first read), loss: { rising, streak, ethStreak }, eth,
  flowControl, qos` (the last three null when no slow facts exist).
- `loss.rising`: loss counters with a positive delta this read, plus
  `"port discards"` while `ethStreak > 0`. `loss.streak`: consecutive reads
  with at least one rising loss counter (0 when none rose).
  `loss.ethStreak`: consecutive *slow* refreshes in which any
  `ETH_LOSS_COUNTERS` value rose; it changes only when slow facts are
  refreshed, so a single rise lasts one slow period, not many fast reads.

## 3. Collection and monitor hook

- `SystemCollector.collectRoce()`: `null` on Windows and macOS units;
  otherwise one sampler per collector whose `run` executes on the host
  (local unit, host namespace when available) or over SSH with an 8000 ms
  timeout; a rejected sample is logged and returns `undefined`.
- `SparkMonitor`'s network poll asks for RoCE, waiting at most 3 s;
  `undefined` (failure or no answer) keeps the previous `metrics.roce`.
  `metrics.roce` starts as null and is part of the snapshot and of
  `/api/sparks/:id/metrics`. Health is evaluated with the RoCE data.

## 4. Health findings (`HealthEvaluator`)

- `roce-link`, critical: devices with `everActive && !active`. Title
  "A RoCE link went down" (one) or "N RoCE links went down". Detail:
  `<netdev or name>: <state or "unknown">[ (<physState>)]`, joined by
  ", ", ending in ".". A hint about checking cable, transceiver and switch
  port. Never-active (uncabled) ports produce nothing.
- `roce-loss`, warn: active devices with `loss.streak ≥ 3` or
  `loss.ethStreak ≥ 2`. Title "RoCE is dropping packets". Detail:
  `<netdev or name>: <rising joined by ", " or "counters rising">`, joined
  by "; ", ending in ".". A hint about congestion / PFC / ECN / trust
  configuration.

## 5. UI: `RocePanel` (unit page)

- Rendered (in both unit page layouts, after the network panel) only when
  `metrics.roce` has at least one device; otherwise nothing.
- Panel title "RoCE / RDMA", network icon, accent, class `panel-roce`; an
  action tag "{up}/{total} up" (good tone when all are up).
- Ports that are active or were ever active get a row
  (`data-testid="roce-<name>"`, dimmed with `opacity-70` when not active).
  Others are summarised in one line: "N port(s) not connected: a, b".
- Row: the netdev (or name) with the device name as tooltip; state tag
  (good when active, bad when it was up, neutral otherwise; phys state as
  tooltip; "unknown" when missing); speed tag "X Gb/s" (from speedMbps / 1000,
  else rateGbps); "MTU N"; ↓ / ↑ rates formatted B/s, KB/s, MB/s, GB/s
  (1024 based, one decimal; "—" when null); "N err · N drop"; tags
  "PFC on: 3, 4" (good) / "PFC off" (neutral), "trust <mode>", "pause
  rx/tx" when either is on, "loss rising" (warn, rising list as tooltip);
  a DSCP line "prio P: DSCP a,b · …" when mapped; a collapsible "RDMA
  counters" table.
- Exported `ROCE_COUNTER_ROWS` (ordered `{ key, label, loss? }`):
  Out of buffer, Packet sequence errors, Local ACK timeouts, RNR NAK retries,
  Implied NAK errors, Transport retries exceeded, ICRC errors (all loss),
  ECN-marked packets (`np_ecn_marked_roce_packets`), CNPs sent
  (`np_cnp_sent`), CNPs handled (`rp_cnp_handled`), Adaptive retransmits
  (`roce_adp_retrans`), Duplicate requests (`duplicate_request`). Only
  counters present are listed, with "+delta" when it rose (loss rows that
  rose are highlighted). Then port counters when present: RX discards,
  TX discards, CRC errors, Pause frames received, Pause frames sent.
- Exported `pfcLabel(device)` → `{ text, tone }` as above, or null when PFC
  is unknown.
- Types `RoceQos`, `RoceDevice`, `RoceMetrics` in `src/api/types.ts`
  describe §2's result; `SparkMetrics.roce?: RoceMetrics | null`; health ids
  include `roce-link` and `roce-loss`.
