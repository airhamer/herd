# Batch 1 — DGX Dashboard Backend (11000) Spike

**Date:** 2026-10-09
**Method:** Read-only live probe on all three sparks (1c2c, 102c, 25ed).
No triggers fired (the spike is non-mutating by design).
**Status:** Contract mapped and live-verified. Authenticated payload shape
pending Steve's DGX dashboard password (read-only, non-mutating).

---

## 1. Service

| Property | Value |
|---|---|
| Unit | `dgx-dashboard.service` (systemd, root) |
| Binary | `/opt/nvidia/dgx-dashboard-service/dashboard-service` (Go) |
| Bind | `127.0.0.1:11000` (loopback only) |
| RSS | ~30 MB (no GNOME dependency) |
| State | enabled + active on all three sparks |
| Auth | JWT bearer (PAM username/password → token) |

Companion unit `dgx-dashboard-admin.service` (root, D-Bus) is a dead end:
`com.nvidia.dgx.dashboard.admin1` is policy-restricted to uid=0 and even
root's `gdbus introspect` gets `AccessDenied` (2 matched rules). The HTTP
+ JWT path (this doc) is the one to use.

## 2. Login Endpoint

- **Path:** `POST /api/login`
- **Content-Type:** `application/json`
- **Payload:** `{ "username": "<pam-user>", "password": "<pam-pass>" }`
- **Auth:** PAM (unix user/pass)
- **Response (success):** JWT — token field name pending (see §6)
- **Response (wrong password):** `500` `{"error":"Failed to run authenticate operation"}`
  (PAM layer reached — confirms path + payload shape)

## 3. API Surface (all under `/api/v1/`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/updates/available` | 401 (JWT) | Package/firmware/OTA list |
| GET | `/api/v1/updates/list` | 401 (JWT) | Update list |
| GET | `/api/v1/update_reboot/status` | 401 (JWT) | Reboot/update status |
| GET | `/api/v1/update_reboot/stream` | 401 (JWT) | SSE or WS stream (TBD) |
| POST | `/api/v1/update_reboot` |  (JWT) | **Trigger** (read-only — not called in spike) |
| GET | `/api/v1/updates/enabled` | public | `{"updatesEnabled":true}` |

**Note:** The trigger is `POST /api/v1/update_reboot` (no path suffix).
The spike is read-only — no triggers fired.

## 4. Auth Behavior

- **401** = route exists, JWT required
- **302** = SPA fallback (unknown route)
- **200** = public route (e.g. `/api/v1/updates/enabled`)

## 5. Sample Responses (verified)

### GET /api/v1/updates/enabled (public)
```json
{"updatesEnabled":true}
```

### POST /api/login (wrong password)
```json
{"error":"Failed to run authenticate operation"}
```

### GET /api/v1/updates/available (unauth)
```json
{"error":"missing or invalid Authorization header"}
```

## 6. Pending (needs Steve's DGX password)

- Token field name in login success response
- Authenticated payload shape for `GET /api/v1/updates/available`
- Authenticated payload shape for `GET /api/v1/update_reboot/status`
- Stream transport (SES vs WS) for `GET /api/v1/update_reboot/stream`

These are read-only, non-mutating. Once the password is available, the
spike is complete.

---

## 7. Conclusions for Batch 2+

1. **Login:** `POST /api/login` with JSON `{username, password}` → JWT
2. **API base:** `/api/v1/`
3. **Auth:** `Authorization: Bearer <jwt>` on all routes except `/updates/enabled`
4. **Trigger:** `POST /api/v1/update_reboot` (read-only — not called in spike)
5. **Stream:** `GET /api/v1/update_reboot/stream` (SSE vs WS TBD)
6. **Status:** `GET /api/v1/update_reboot/status`
7. **Available:** `GET /api/v1/updates/available`
8. **List:** `GET /api/v1/updates/list`
9. **Enabled:** `GET /api/v1/updates/enabled` (public)
10. **D-Bus:** dead end (uid=0, policy-restricted)
