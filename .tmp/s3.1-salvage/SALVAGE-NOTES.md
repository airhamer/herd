# S3.1 salvage bundle — attempt 1 (run 5faf7359), 2026-10-27

## Incident (worker report)
Attempt-1 work ran against a tree matching the S3.1 baseline exactly:
gate a fleet 202/0 pre-change, gate b server 478/0, gate c agent 247/0, gate d vitest
229/229 (x2), gate e tsc 0 (x2) — all measured in-session before the loss.
M1 (schema + laneNameOf + snapshot merge + 5 tests → fleet 207/0) and M2 (4 fleet lane
methods + 4 routes + agent laneCreate/Start/Stop/Remove + 9+7 tests → fleet 211/0,
agent 247/0) were applied and green in that tree. Mid-session the checkout at
projects/sparkDash was replaced by an older fork shape (src/ layout; no server/fleet/
fleet.ts, no agent/nodeAgent.js, no web/; loop-launch commit 497f659 on top). Attempt-1
commits are absent from the object DB; a root-wide filesystem sweep finds no copy of the
base files. Gates x5 x3 could not be completed; the final tree is the wrong tree.
This is an environment/worktree-swap loss, not a code failure.

## Contents (apply onto a correct S3.1-base checkout; re-verify all anchors from git)
- nodeAgent-laneCreate.snippet.js — agent-side lane lifecycle methods (private-field
  names and router wiring MUST be re-derived from the real nodeAgent.js).
- fleet-lane-methods.snippet.ts — server constants/sanitizer/snapshot-merge hunk/4
  methods/4 routes + error→status mapping (400/409/400/404 contract).
- test-plan.md — the 16 tests with exact assertions (deliberately not reconstructed
  source: byte-exact rebuild from worker context after the loss began corrupting —
  rebuild tests fresh against the real files using this plan).

## Contract decisions (validated by the pre-loss green runs)
- lane envelope {name, container_id, status, updated_at}; server map key lane:<sanitized-name>
  (snapshot lanes already name-keyed; legacy docker_lane/docker_container_name precedence
  retained, lanes map added beside it).
- sanitizer (both sides, identical): lower → [^a-z0-9._-]+ → "-" → slice 64; empty→null.
- LANES_MAX 8; create: 400 not connected / 409 full (existing name replaceable) /
  400 invalid name; name==sanitized enforced agent-side; idempotent no-op when running.
- remove: server also deletes snapshot.lanes[name] on accepted dispatch (dropped-event
  strand guard).
- Deviations from spec: none material; row is agent/server-only, vitest stayed 229.
