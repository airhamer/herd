# Batch 8 — DGX package list: fetch `/api/v1/updates/list` (real shapes, captured 2026-10-14)

## Why
The stock DGX OS dashboard (verified by packet capture on gx10-1c2c, live login as `sparkdash-ota`) splits updates across TWO endpoints:

- `GET /api/v1/updates/available` → `{"available":true,"otaAvailable":false,"firmwareAvailable":true}` (64 B) — summary booleans only. This is all Batch 5 knew about.
- `GET /api/v1/updates/list` → 43 KB: `{"packageUpdates":[…],"firmwareUpdates":[…]}` — the actual pending package rows (234 on 1c2c today). This is what the fleet/updates table needs and why every box reads `0 pkgs` today.

Verified real shapes (fetched live from `http://127.0.0.1:11000` on gx10-1c2c, 2026-10-14 16:5x EDT):

```jsonc
// GET /api/v1/updates/list
{
  "packageUpdates": [
    { "name": "apache2-bin", "description": "Apache HTTP Server (modules and other binary files)",
      "size": "1.3 MB", "currentVersion": "2.4.58-1ubuntu8.15", "availableVersion": "2.4.58-1ubuntu8.17" }
    // …234 total
  ],
  "firmwareUpdates": [
    { "name": "Embedded Controller", "currentVersion": "0x02000006", "availableVersion": "0x02000007" },
    { "name": "UEFI Device Firmware", "currentVersion": "0x03000007", "availableVersion": "0x03000008" }
  ]
}
// GET /api/v1/ota/status          → {"isTorn": <bool>}
// GET /api/v1/update_reboot/status → {"isInProgress": <bool>}
```

Real captured fixtures are ALREADY COMMITTED at `agent/updates/__tests__/fixtures/*.real.json` (truncated to 4 pkg entries + 2 fw entries; field-for-field verbatim). Use them; do not invent shapes.

## Scope — files you may touch (nothing else)
1. `agent/updates/dgx.js`
2. `agent/updates/__tests__/dgx.test.js`

## Contract
1. **`probe()`**: after the existing `GET /api/v1/updates/available` succeeds, issue `GET /api/v1/updates/list` with the same token/base. **FAIL-SOFT**: if `/list` returns non-2xx, times out, or its body is unparseable, keep the probe result from `/available` (today's behavior) and record `listError: "<short reason>"` on the snapshot. A `/list` failure must NEVER fail the probe.
2. **New exported pure function `normalizeList(raw)`** (mirror `normalizeAvailable`'s defensive style):
   - `packageUpdates[]` → `packages[]`, each `{ name, installed, candidate, size, description }`.
   - `firmwareUpdates[]` → `firmware[]`, each `{ name, installed, candidate }`.
   - Read the existing snapshot `packages`/`firmware` element shape produced by `normalizeAvailable` (around dgx.js:130) and emit EXACTLY that shape plus `description` where the source has it. Field mapping: `currentVersion → installed`, `availableVersion → candidate`, `size` verbatim string ("1.3 MB"), `description` → string or null.
   - Defensive: non-object input, missing/non-array `packageUpdates`/`firmwareUpdates` → empty arrays; items without a `name` are skipped; never throws.
3. **Merge rule** in the snapshot: `packages`/`firmware` come from `normalizeList` when `/list` succeeded; otherwise from the legacy `normalizeAvailable` guess path (unchanged). Summary booleans (`available/otaAvailable/firmwareAvailable`) keep coming from `/available` verbatim. `snapshot.raw` keeps BOTH upstream bodies verbatim (`{ available, list }`) — fail-closed design: unverified upstream preserved untouched.
4. **Zero server/dashboard changes expected** — the snapshot contract is backward-compatible. If you believe a fleet-side change is unavoidable, STOP and flag in the report; do not touch `server/`.

## Hard forbidden
- No calls to `POST /api/v1/update_reboot`; no crontab mutation; no trigger-now; no model-container touches; no destructive git (no reset/checkout-of-others' files/rebase); no push.
- No new npm deps (Node built-ins + global fetch only, ESM).
- Do not change `PROBE_INTERVAL_MS` or prober structure.
- Do not edit fixture files.

## Verification gate (run 3×, identical)
```
node --test agent/updates/__tests__/*.test.js
node --test server/fleet/__tests__/*.test.js
npx tsc --noEmit
```
Record baseline counts BEFORE your edits; every pre-existing test must still pass with zero assertion edits to other files.

## Tests to add (in dgx.test.js, using the committed fixtures)
- `normalizeList` on `updates-list.real.json`: 4 packages mapped (installed/candidate/size/description verbatim), 2 firmware entries mapped (hex versions verbatim).
- Merge precedence: `/list` OK → list data wins over `/available` guess data.
- Fail-soft: `/list` 500 → probe still OK, snapshot has legacy packages + `listError`; `/list` malformed JSON → same.
- `packageUpdates: []` → `packages: []` (legit zero ≠ error, `listError` stays absent).
- Junk tolerance: string input, null input, items missing `name`.

## ORCHESTRATOR RULING (2026-10-14 17:1x EDT — supersedes the Passage A/B conflict in §Contract 2; RESOLVES the BLOCKED return)

The worker's `spec-conflict:` return is valid. Ruling = reading **C**:

1. `normalizeList` emits the **existing committed snapshot shape plus additive fields only**:
   - packages: `{ name, currentVersion, availableVersion, sizeBytes: null, size: <verbatim string>, description: <string|null> }`
   - firmware: `{ component: <source name>, currentVersion, availableVersion }`
   Passage A's `installed/candidate` key names are WITHDRAWN. "size verbatim" now means the additive `size` field; `sizeBytes` stays `null` for list-sourced rows (source has no numeric size — do not parse one).
2. **Fleet-side change is now IN SCOPE (minimal, additive) — the §Contract-4 STOP is lifted for exactly these two files, added to the owned-files list:**
   - `shared/types.ts`: `DgxPackageUpdate` gains optional `size?: string | null` and `description?: string | null`.
   - `src/components/Updates/UpdateRow.tsx`: Size cell renders `p.size ?? bytes(p.sizeBytes)`; description shown only if present (tooltip or subtext — keep it minimal, no layout redesign).
   No other `server/` or `src/` changes.
3. In-scope adaptation authorized: `dgx.test.js` happy-path `deepEqual(snap.raw, AVAILABLE_BODY)` updates to the new `{available, list}` raw shape.
4. Commit message per brief stays verbatim.

Gate now includes dashboard build path: same three commands, 3×, identical.

## ORCHESTRATOR RULING-2 (2026-10-14 17:45 EDT — RESOLVES `ruling-needed:` one-line scope extension)

The second `ruling-needed:` return is ACCEPTED as correctly raised; the analysis is verified sound (fullView.integration.test.js drives the REAL probe; its happyBackend has no `/list` route → 302 fall-through → fail-soft → `raw.list` null → line-75 old-shape assertion breaks). Ruling:

1. **Granted.** `agent/updates/__tests__/fullView.integration.test.js` joins the owned-files list **for the line-75 `raw` assertion ONLY**, updated to exactly:
   `assert.deepEqual(view.snapshot.raw, { available: AVAILABLE_BODY, list: null }); // Batch 8: {available, list} verbatim; /list fail-soft (302) → list null`
   Nothing else in that file changes (line-74 packages assertion passes via fail-soft as-is).
2. Rejected alternatives (a) conditional/morphic `raw` and (b) silent out-of-scope edit: both concurred — never ratified, never silent.
3. Ship the already-designed implementation verbatim per the parked report's "Ready to ship" list.

## Commit (one, message verbatim)
`Batch 8 (updates): agent probe fetches /api/v1/updates/list — real package/firmware rows (gx10-1c2c captured fixtures)`
On top of `f9bafaa`. Tree clean after. Report: commit hash, gate table ×3, test delta, deviations (flagged, never silent).
