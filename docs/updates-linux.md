# Standard Linux updates (UPD2)

Spark nodes keep the DGX OTA columns (Applied OTA / Available OTA) and the
existing `GET /updates` agent path.

SSH `protocol:"ssh"` Linux nodes (for example Narthex) do **not** use that
backend. The dashboard runs a read-only probe over the existing SSH transport:

- tool discovery (`apt-get` or `dnf`)
- `apt-get -s upgrade` (simulate only) or `dnf -q check-update`

A missing tool, empty transcript, or SSH failure is **stale**, never
**current** and never a package count of `0`. A successful probe with nothing
to install is **current** with count `0`.

`POST /api/fleet/nodes/:id/updates/now` on an SSH node returns **501** and a
dry-run command plan. It never runs `apt-get -y` or `dnf -y`. Applying
packages stays an operator action through a privileged executor that is not
wired yet, and only after an explicit confirm.

This probe is not executed by the unit tests against live hosts; tests feed
canned transcripts into `parseLinuxUpdateProbe` / `linuxProbe`.
