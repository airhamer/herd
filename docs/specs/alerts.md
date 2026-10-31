# Spec: alert notifications, browser alerts and the delivery event log

Status: behavioural spec for the clean-room re-implementation (LIC1).
Sources: herd's existing tests, the HTTP/WS contract and TypeScript API types
herd already ships (`src/api/types.ts` `Alert*`), black-box observation of
herd's running behaviour (outputs only), and the upstream sparkDash
README/CHANGELOG feature descriptions. No upstream source code was used to
write this spec.

## 1. What it does

Opt-in (`settings.alertsEnabled`, default `false`). While on, the server
watches two existing signals and notifies external channels when a problem
has held for a while and again when it clears:

- **Health findings** from `HealthEvaluator` (each unit's `health[]`).
- **Overview exceptions**, the same list the Overview strip shows
  (`src/shared/fleetExceptions.js`, shared by server and UI).

There are no thresholds of its own: severities and texts come from those
sources. While off nothing is evaluated, resolved, sent or written, and the
config/test routes answer 409 with
`"Alerts are off. Turn them on in Settings → Alerts first."`.

## 2. Overview exceptions (`fleetExceptions(spark, unit = "celsius")`)

Returns `[{ id, label, severity, detail? }]` in this order:

| id | when | label | severity | detail |
|---|---|---|---|---|
| `offline` | `!online` | `Host unreachable` | critical | — |
| `throttle` | GPU throttle flags `thermal` or `hwSlowdown` (the SW power cap alone never counts) | `is thermal throttling` (thermal) / `has a hardware slowdown` | critical | parts joined by ` · `: throttle `detail` text if any; `GPU at N°C/°F` if temperature known; `SM clock X.X GHz` plus ` (P% of max)` when known |
| `disk` | any storage entry `percentage >= 90` | `storage is at or above 90%` | warning | — |
| `llm` | LLM monitoring not off, ≥1 port, every port unavailable | `LLM is unavailable` | warning | — |
| `tailnet` | tailnet monitoring on, tailscale data present, not available or `online === false` | `tailnet is unavailable` | warning | — |

An offline unit yields only `offline`. Missing GPU data yields no throttle.

## 3. Conditions (`server/alerts/conditions.js`)

- `RULES`: the catalogue; each `{ id, source: "strip"|"health", name,
  description, defaults: { enabled, forSec } }`.
  - strip: offline "Unit offline" 60 s; throttle "GPU throttling" 60 s; disk
    "Storage" 300 s; llm "LLM unavailable" 120 s; tailnet "Tailnet
    unavailable" 120 s.
  - health: thermal "GPU temperature" 60 s; memory "Unified memory low"
    60 s; low-power "GPU stuck in low power" 0 s; xid "NVIDIA Xid error" 0 s;
    oom "Out-of-memory kill" 0 s; roce-link "RoCE link down" 60 s; roce-loss
    "RoCE packet loss" 120 s; link-speed "Slow network link" 300 s;
    concurrency "Several models loaded" 300 s, **off by default**.
  - None of the retired ids (`gpu_throttle`, `memory_headroom`, …) exist.
- `MAX_FOR_SEC = 86400`.
- `effectiveRuleConfig(id, overrides?)` → `{ enabled, forSec }`; an unknown
  id (a new Health finding) defaults to enabled.
- `collectConditions(unit)` → `{ conditions, judged(ruleId) }`.
  Condition: `{ ruleId, ruleName, severity: "warning"|"critical", label,
  summary }`. Finding `warn` → `warning`; finding title → label, detail →
  summary; strip label → label; summary = strip detail, or for offline
  `Unreachable: <offlineReason>`, else the label. Order: strip exceptions
  first (same ids/severities/order as `fleetExceptions`), then findings.
- Online unit: every rule is judged. Offline with a reason: only `offline`
  is judged; other rules' alerts are held (not resolved). Offline with no
  reason yet (before the first liveness check): nothing is judged.
- Remote text is flattened and capped (`text.js`): `capText(value, max =
  MAX_SUMMARY_CHARS=120)` turns control characters/whitespace runs into
  single spaces, trims, cuts to `max` characters ending in `…`, `null` → "".
  `MAX_NAME_CHARS = 60` for unit and channel names.

## 4. Engine (`server/alerts/engine.js`)

`new AlertEngine({ now, getConfig, notifier, persistState, log })`;
exports `MIN_CLEAR_MS = 30000`, `STATE_MAX_AGE_MS = 900000`, `HISTORY_LIMIT = 200`.

- `evaluate(units)`: for each enabled rule and judged unit, key
  `${unitId}:${ruleId}`.
  - New condition → **pending** (`startsAt` = now). Fires once it has held
    `forSec` (with `forSec` 0 it fires at once). A pending alert whose
    condition clears is dropped silently.
  - Firing alert clears only after the condition stays false for
    `max(forSec, MIN_CLEAR_MS)`; `endsAt` = when it first went false. Any
    true reading in between cancels the clear (no flapping).
  - Severity escalation must hold `forSec` before a new notification; a
    de-escalation is silent. `peakSeverity` keeps the highest.
  - Rule turned off → its alerts resolve with summary mentioning
    "rule turned off"; unit gone → "unit removed".
  - Reminders: with `repeatIntervalMin > 0`, still-firing alerts are re-sent
    every interval as a group with `reminder: true`.
  - Everything that becomes firing/resolved in one evaluation goes out as one
    group `{ firing, resolved, reminder }` via `notifier.dispatch(channels,
    group)`.
  - Unit names capped to 60, summaries to 120.
- `active()`, `pending()` → `AlertInstance`
  `{ key, ruleId, ruleName, unitId, unitName, severity, peakSeverity,
  state, label, summary, startsAt, firingAt, endsAt, status }`.
- `recent()` → newest first `AlertEvent` `{ id, at, status, key, ruleId,
  ruleName, unitId, unitName, severity, label, summary, startsAt, endsAt }`,
  at most `HISTORY_LIMIT`.
- Persistence: after changes `persistState({ savedAt, firing: [...] })`;
  `restore(saved)` re-adopts the firing set (no re-notification,
  `startsAt` kept) and returns how many; a state older than
  `STATE_MAX_AGE_MS` is ignored (returns 0). `reset()` clears everything.

## 5. Channels, messages and delivery (`notifier.js`, `outbound.js`)

- Channel: `{ id, name, type: ntfy|discord|slack|webhook, url, enabled,
  minSeverity: warning|critical }`.
- `filterGroupForChannel(channel, group)`: keep firing alerts at or above the
  minimum by `severity`, resolved ones by `peakSeverity ?? severity`; `null`
  when nothing is left.
- `describeGroup(group, now)` → `{ tone, title, lines, firing, resolved }`:
  - one alert: `[CRITICAL] <unit>: <label>` (or `[WARNING]`, `[RESOLVED]`);
    several: `sparkDash: N firing`, or `sparkDash: N still firing, M resolved`
    (reminder) / `sparkDash: N firing, M resolved`.
  - lines: `CRITICAL <unit> · <ruleName>: <summary> (for 5m)`, resolved
    `RESOLVED <unit> · <ruleName>: <summary> (lasted 5m)`; at most 20, then
    `+N more`.
  - tone: `critical` if any firing critical, `warning` if any firing,
    else `resolved`.
- `formatAge(ms)`: `0s`…`59s`, `1m`…, `1h 1m`, `1d 1h`.
- `buildRequest(channel, group, now)` → `{ url, init }`, POST:
  - ntfy: `text/plain`, headers `Title`, `Priority` 5 critical / 4 warning /
    3 resolved, `Tags` (`rotating_light`, `warning`, `white_check_mark`);
    body = lines joined by newline.
  - discord: `{ username: "sparkDash", content: title, embeds: [one per
    alert, ≤10: { title: "<Critical|Warning|Resolved> · <unit>: <label>",
    description: summary, color, timestamp }], allowed_mentions: { parse:
    [] } }`.
  - slack: `{ text: "*<title>*\n• line\n• line" }`.
  - webhook: `{ source: "sparkDash", status: "firing"|"resolved", severity
    (null if only resolved), title, reminder, sentAt, alerts: [{ status,
    severity, rule, ruleName, unit, unitId, label, summary, startsAt,
    endsAt }] }` with ISO times.
- Outbound policy (same as `validate.js` targets): http(s) only; loopback,
  LAN, CGNAT/Tailscale OK; link-local/metadata, multicast, unspecified
  (also as IPv4-mapped IPv6) refused. Checked on save and **re-resolved on
  every send**; the connection is pinned to the checked address (one DNS
  lookup per send).
  - `POLICY_BLOCKED` = "blocked: the host resolves to an address the
    outbound policy does not allow" (names no address);
    `POLICY_UNRESOLVED` = "could not resolve the channel host".
- `new Notifier({ fetchImpl, lookup, timeoutMs = 10000, log, onResult })`:
  - `send(channel, group)` → `{ ok: true, status }` or `{ ok: false, error }`.
    `redirect: "manual"`; any 3xx → `redirect not followed (HTTP 302)`;
    non-2xx → `HTTP 500`; timeout → `timed out after 10s`; socket error →
    `connection failed (CODE)`; anything else → `request failed`. Response
    bodies and error texts never reach results, status, logs or events.
  - `status: Map<channelId, { lastSentAt, lastError, lastErrorAt }>`.
  - `dispatch(channels, group)` → `[{ channelId, ok, status|error }]` for
    enabled channels whose filtered group is non-empty.

## 6. Configuration store (`store.js`)

- `config/alerts.json` (env `ALERTS_JSON_PATH`), mode 0600, gitignored:
  `{ version: 2, repeatIntervalMin, rules: { id: { enabled?, forSec? } },
  channels: [{ id, name, type, enabled, minSeverity }], state }`. **Never a
  URL.** Unreadable file → defaults. Earlier-build files (version 1 with
  plaintext `url`s, unknown rule ids) load: unknown rules dropped, URLs that
  pass the policy returned as `legacyUrls` (Map id → url).
- Exports: `CHANNEL_TYPES`, `MAX_CHANNELS = 20`, `REPEAT_MIN_MINUTES = 5`,
  `REPEAT_MAX_MINUTES = 10080`, `ValidationError` (status 400),
  `defaultConfig()`, `loadAlertsFile(file, log)` → `{ config, legacyUrls,
  state }`, `saveAlertsFile(file, config, state)`, `maskUrl(url)` →
  `<origin>…<last 4 chars>`, `publicConfig(config)`, `validateChannelUrl`,
  `validateChannel`, `validateConfig(input, previous?)`.
- Validation messages (400): rules must be an object; `Unknown alert rule`;
  `unknown setting <key>` (only `enabled`/`forSec`); `<Rule name>: enabled
  must be true or false`; `<Rule name>: duration must be between 0 and
  86400`; repeat interval a number, 0 or 5…10080; channels an array, ≤20;
  `Channel name is required`; type one of the four; `minSeverity must be
  warning or critical`; URL: `required`, `not a valid URL`, `must start with
  http:// or https://`, `... host is not allowed ...`. Saving a channel's
  masked URL unchanged keeps the stored one; a masked URL for a new channel
  is refused (`masked`). New channels get `ch_<12 hex>` ids.

## 7. Secrets

Channel URLs live encrypted in the existing secrets store
(`config/sparks-secrets.json`, section `alertChannels: { id: blob }`):
`loadAlertChannelUrls()` → Map, `saveAlertChannelUrls(map)`. SSH-password
and API-key saves keep the alert section and vice versa; the file is
removed only when every section is empty. A plaintext URL found in
alerts.json is moved into the store at startup and alerts.json rewritten.

## 8. Runtime and routes (`runtime.js`)

`createAlertsRuntime({ filePath, isEnabled, now, fetchImpl, lookup, log,
secrets = {load, save}, recordEvent })` →
`{ engine, notifier, start, tick, snapshotBlock, status, publicConfig,
updateConfig, test }`.

- `tick(units)` evaluates only while enabled; turning alerts off resets the
  engine. `snapshotBlock()` → `{ active }` while enabled, else `null` (the WS
  snapshot carries `alerts` only then).
- `updateConfig(update)` (409 when off): validates, checks each channel host
  against the policy (a host that resolves to a forbidden address →
  400 `<name>: <POLICY_BLOCKED>`; unresolvable is allowed and checked at
  send), stores URLs in secrets (removed channels lose their URL), writes
  alerts.json, returns `publicConfig()`.
- `test({ channelId, channel })` (409 when off): sends a one-line test to a
  saved channel or a draft (a masked draft URL resolves against
  `channelId`); unknown channel → 404 `{ ok: false, error: "Unknown channel" }`.
- Test sends use the group `{ test: true }`: title "sparkDash test
  notification", one line "If you can read this, the channel works. Sent from
  the sparkDash Alerts dialog." (ntfy priority 3, tag `test_tube`; Discord
  embed colour 0x6366F1; webhook `status: "test"`, `severity: null`,
  `alerts: []`). A second test to the same channel within 5 s returns
  `{ ok: false, error: "Wait a moment before sending another test",
  rateLimited: true }` (HTTP 429). Test results update the channel status.
- `notificationEvent({ channel, group, ok, status, reason, test })` →
  `{ type: alert.notify.sent|alert.notify.failed, severity: info|error,
  sparkId, sparkName, message, data: { channelId, channelType, test,
  reminder, firing, resolved, status|reason } }`. Messages:
  `Alert notification sent to "<name>" (<type>): <severity> · <unit> <label>`,
  `Alert notification to "<name>" (<type>) failed: <reason>: …`,
  `Alert reminder to …`, `Test notification to "<name>" (<type>) failed:
  <reason>`; several alerts → `N firing, M resolved`; channel name capped at
  60. `sparkId` only when the group is about one unit. Never a URL or body.
- Routes (behind herd's auth): `GET /api/alerts` → `{ enabled, active,
  pending, recent }`; `GET /api/alerts/config`; `PUT /api/alerts/config`;
  `POST /api/alerts/test` → `{ ok, status? , error? }`.

## 9. Event log (`server/events/EventLog.js`)

`new EventLog({ file?, max = 200, now })` (max: floor, at least 1; 0/NaN →
200). `record({ type, severity = "info", sparkId, sparkName, message, data })`
→ stored event `{ id, ts, type, severity, sparkId, sparkName, message, data? }`
(ids ascending, never reused; unknown severity → "info"), or `null` without a
string `type`/`message`, or when it repeats the same unit's latest event
(same type + message) within 5 s. Subscriber errors are swallowed; `record`
never throws. `list({ limit = 50, sparkId, sinceId, beforeId })` newest first,
limit clamped to 1…max. `clear({ olderThanMs? })` → removed count.
`oldestId()`, `subscribe(fn)` → unsubscribe, `flush()`. File
`{ nextId, events }`, written debounced (1.5 s), atomic, 0644 (events carry no
secrets) when `file` is set; malformed entries are skipped on load and an
unparseable file is quarantined (`<file>.corrupt-<ts>`).
(`server/events/eventFormat.js`, an unused helper ported with the log, is removed.)

## 10. UI

- **Settings → Alert notifications**: state "On"/"Off"
  (`data-testid="alerts-state"`) and a "Configure…" button opening the
  Alerts dialog; Escape closes only the topmost dialog.
- **AlertsDialog** (`open`, `onClose`, `onSettingsSaved`): a master switch
  `aria-label="Send notifications"` saves `{ alertsEnabled }` immediately
  via `PUT /api/settings` and reports it; while off the rules/channels
  `fieldset` is disabled and Save is disabled. Rules are setting rows
  (`.set-row`) grouped into sections `aria-label="Overview exceptions"` and
  `"Health findings"`; each has a switch `"<name> notifications"` and a
  number input `"<name> wait (seconds)"`, no thresholds. Channels: name,
  type, URL (masked), minimum severity, enabled; "Send test" posts
  `{ channelId, channel }` and shows the result text in a
  `[role="status"].field-hint`; a stored failure reads `Last send failed:
  <reason>`. Save PUTs only changed rule values and the channels without
  `status`/`hasUrl`.
- **FleetAlertStrip** exports `deriveAlerts(sparks, unit)` and
  `stripAlerts({ sparks, alertsEnabled, serverAlerts, showExceptions,
  temperatureUnit })` returning `FleetAlert { key, unitId, unitName, label,
  severity, detail?, startsAt }`. Notifications off (or no server set yet):
  derived from `fleetExceptions`; on: the server's set, with text for strip
  rules taken from the live snapshot (so °F applies) and real `startsAt`.
  `showExceptions=false` keeps only throttle rows. Rows `.ov-alert` (critical
  `ov-alert--bad`), text `.ov-alert__text` = `<unit> <label>.` + `<detail> · `
  + `<N>m active`; clicking selects the unit.
- **Browser alerts** (per browser, localStorage `sparkdash.browserAlerts`
  `{ tabBadge, desktop }`, both off): `useFleetAlerts(...)` → `{ rows, ready,
  source: "server"|"browser" }` built from `stripAlerts`;
  `useBrowserAlerts(rows, ready, source)`: tab title `(N) <title>` and a
  favicon dot (`BADGE_COLORS.critical` red / `.warning` amber, restored when
  clear, stale draws discarded); desktop notifications only for rows that
  appear after the first ready state (`"<Critical|Warning> · <unit>"`, body
  label, tag key), re-baselined when the source changes, only with
  permission granted and a secure context. Browser-derived rows go through
  `stepDebounce` (`alertDebounce.ts`: `BROWSER_ALERT_HOLD_MS = 30000`,
  `emptyDebounce()`, `stepDebounce(state, rows, now, holdMs)` →
  `{ visible, nextCheckAt }`); rows present at page open count at once.
  `BrowserAlertsSettings`: switches "Tab badge" and "Desktop
  notifications" as `.set-row`s; permission requested on click only; denied
  → "Notifications are blocked for this site"; insecure context → switch
  disabled and a `role="note"` mentioning "HTTPS or localhost".

### 10.1 UI details (behaviour the rewrite keeps)

- Alerts dialog: title "Alert notifications"; loads `GET /api/alerts/config`
  and polls `GET /api/alerts` every 10 s while open ("Firing now · N" list
  when on; "Recent" list of the latest 50 transitions, "Resolved" /
  "Critical" / "Warning" · unit label · age). Channel rows: "Channel name",
  "Channel type" (ntfy, Discord, Slack, Webhook (JSON)), "Minimum severity"
  ("Warning and up" / "Critical only"), switch "Channel <name|n> enabled",
  "Channel URL"; "Add channel", "Remove". A test sends the draft with
  `enabled: true` and `name` defaulting to "Test"; success reads "Sent".
  Reminder select "Remind while still firing" (Off, 1 h, 4 h, 12 h, 1 day,
  or the stored custom value). Footer status "Unsaved changes" / "Saved";
  errors in `role="alert"`; a non-numeric wait blocks Save with an error.
  Escape is captured and stopped so only this dialog closes.
- `SettingRows.tsx`: `SettingRow`, `ToggleRow` (switch name = `label` or
  title; children before the switch) and `Switch`.
- Tab badge: the base title is the current title without a leading "(N) ";
  the favicon (first `link[rel~=icon]`) is redrawn as a PNG with the dot and
  restored (href and type) when the badge goes away or the app unmounts.
- Desktop notification body: `label`, or `label — detail`; `tag` = row key;
  clicking focuses the window.
