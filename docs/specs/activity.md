# Activity log (issue #32)

Herd keeps a persistent, capped activity log (`server/events/EventLog.js`,
`config/events.json`, overridable with `EVENTS_JSON_PATH`). Every entry is
`{ id, ts, type, severity: "info"|"warn"|"error", sparkId, sparkName, message, data? }`.

## Sources

| Source | Types |
|---|---|
| Activity watcher (5 s ticks over Spark snapshots and fleet nodes; first sighting is a silent baseline; 30 s boot warm-up) | `spark.online/offline`, `node.online/offline`, `node.claimed`, `container.started/stopped`, `service.started/stopped/wedged`, `gpu.throttle.start/end` and `health.raised/cleared` (settled over 2 ticks), `gpu.clock.capped/released` |
| Registry routes | `spark.added/removed`, `node.added/removed` |
| Operator actions | `service.action(.failed)`, `component.<action>`/`component.failed`, `update.started/failed/scheduled`, `power.shutdown(.failed)`, `power.wake(.failed)` |
| Alerts engine (`onTransition`) | `alert.fired`, `alert.resolved` (delivery outcomes stay `alert.notify.*`) |
| Bench managers | `bench.decode.*`, `bench.prefill.*`, `showcase.*` with `started/completed/cancelled/failed` |

## API

- `GET /api/events?limit=50&sparkId=&sinceId=&beforeId=&type=gpu.,alert.fired&severity=warn,error`
  returns `{ events, oldestId, newestId, total }`, newest first. A `type` entry
  ending in `.` matches as a prefix. Bad parameters answer 400.
- `DELETE /api/events[?olderThanMs=N]` returns `{ removed }`.
- Live push: every recorded event is broadcast on `/ws` as `{ type: "event", event }`.
  The UI also polls with `sinceId` every 30 s to cover reconnect gaps.

## UI

- Fleet tab: **Recent activity** card (latest 8, live, empty state, "View all").
- `/activity`: full log with unit and category filters, paging, and clear actions.
