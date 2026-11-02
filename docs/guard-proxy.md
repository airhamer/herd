# Guard proxy

H.E.R.D. can watch a **guard / keepalive proxy** that fronts an LLM engine on
another node. The proxy keeps the engine warm and holds/replays requests while
the engine restarts; the dashboards care whether it answers, not what it holds.

Fleet example (issue #95): the keepalive proxy on **gx10-1c2c port 8081**.
The proxy listens on `:8081`; the engine (vLLM) lives behind it on the same
box at `127.0.0.1:8080`. OpenAI-compatible traffic goes to
`http://<host>:8081/v1/chat/completions`, Anthropic-shaped traffic to
`http://<host>:8081/v1/messages`. H.E.R.D. itself only ever hits the proxy's
`/health` (fallback `/`).

## Pointing H.E.R.D. at a guard proxy

Settings → **Guard proxy URL** (persisted as `guardProxy.baseURL` in
`config/settings.json`, editable through `PUT /api/settings`):

```json
{
  "guardProxy": {
    "baseURL": "http://192.168.50.226:8081",
    "apiKeyRef": "env:GUARD_PROXY_KEY"
  }
}
```

Validation rules (`server/settings.js`):

- `baseURL` must parse as an `http(s)` URL with a host; trailing slashes are
  trimmed. Anything else clears to `""` (= not configured) — a malformed edit
  never half-probes.
- `apiKeyRef` must be a **secret ref**, never a raw key: `env:VAR`,
  `file:/path`, or a bare `VAR` (env var). Raw keys (`sk-…`) and URL-shaped
  values are rejected. An invalid ref clears to `""`.

Clearing the URL removes the proxy row from the panel and returns
`proxy: null` from `GET /api/guard`.

## What the probe does (`server/health/guardProbe.js`)

`probeKeepaliveProxy` GETs `<baseURL>/health`, falling back to `<baseURL>/`.
Following the SRV1 (#93) probe-truth convention:

- **2xx → alive.** A JSON body is mined for metrics; a non-JSON 2xx body is
  still liveness.
- **401/403 → alive via auth gate.** The gate rejecting an unauthenticated
  probe still proves the process behind it answers. Metrics are simply
  unknown in that case.
- anything else → the fallback URL is scored the same way; if both fail the
  row shows `down` with the reason (`unreachable` / `timeout` / `http-<code>`).

If the proxy exposes them, the panel shows **uptime** (`uptime` /
`uptimeSeconds` / `uptime_seconds`, seconds) and a **recent/total request
count** (`recentRequests`, `requestCount`, `requests`, `requestsTotal`, …).
If it exposes neither, the panel says **"no metrics endpoint"** rather than
showing blanks.

## Engine behind the proxy

The panel also names the engine the proxy fronts — without probing anything
new. `findEngineBehindProxy` scans the fleet's existing SRV1 service-truth
snapshots: a monitored Spark whose service declares `proxyPort` equal to the
guard-proxy port is the engine behind it, and its `engine` / `model` /
`enginePort` ride along as `proxy.engine`. Snapshots whose `lanIp` matches
the proxy host win; a port-only match is the fallback. When the fleet knows
nothing (proxy not enrolled as a Spark, or the model hidden behind an auth
gate), the panel shows `engine behind proxy: unknown`.

## Key handling

- `apiKeyRef` names where the key lives; the value is resolved at probe time
  by the same resolver the SRV1 proxy probes use (`resolveServiceApiKeyRef`).
  Resolved keys are sent as `Authorization: Bearer <key>` and never
  persisted, echoed to the client, or logged.
- `GET /api/guard` returns probe results only — never the resolved key.

## API shape

`GET /api/guard` →

```json
{
  "guards": [ …legacy S4.1a guard list… ],
  "proxy": { "alive": true, "authGate": false, "uptimeSeconds": 3725,
             "requestCount": 41, "hasMetrics": true, "engine": { … },
             "checkedAt": "…", "reason": null }
}
```

`proxy` is `null` when nothing is configured; the Guard panel's empty state
names that reason ("not configured — add the URL in Settings") instead of
rendering a silent blank.
