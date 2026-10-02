import test from "node:test";
import assert from "node:assert/strict";
import { collectTailscale, parseTailscaleStatus } from "../tailscale.js";

const TAILSCALE_JSON = {
  AuthURL: null,
  BackendState: "Running",
  CertDomains: [],
  ClientVersion: "1.102.4",
  CurrentTailnet: "elcid92@ts.net",
  ExtraRecords: [],
  HaveNodeKey: true,
  Health: ["health:100.72.165.103:41641/tcp:0.0.0.0:41641/tcp:ok"],
  MagicDNSSuffix: "ts.net",
  Peer: {},
  Self: {
    ID: "n4WPMY1Rz711CNTRL",
    NodeID: 895147591268925,
    PublicKey: "nodekey:cadf43dc5dcf7a8a172df3dbc1fa4aff6402df894bcd62707d7278913fc8a567",
    HostName: "gx10-1c2c",
    DNSName: "gx10-1c2c.tailda7857.ts.net.",
    OS: "linux",
    UserID: 4183428287296061,
    TailscaleIPs: ["100.72.165.103", "fd7a:115c:a1e0::3f32:a568"],
    AllowedIPs: ["100.72.165.103/32", "fd7a:115c:a1e0::3f32:a568/128"],
    Addrs: ["174.106.119.103:26958", "192.168.50.226:41641"],
    CurAddr: "",
    Relay: "nyc",
    PeerRelay: "",
    RxBytes: 0,
    TxBytes: 0,
    Created: "2026-06-08T03:33:02.09679202Z",
    Online: true,
    KeyExpiry: "2027-06-08T03:33:02Z",
    ExitNode: null,
    ExitNodeOption: null,
  },
  TUN: {
    TUNName: "tailscale0",
    MTU: 65520,
    User: "steve",
    Group: "steve",
  },
  User: {
    ID: 4183428287296061,
    Name: "elcid92",
    Email: "elcid92@example.com",
  },
  Version: "1.102.4",
};

/**
 * Mock exec: `tailscale status --json` → fixture; `systemctl cat tailscaled`
 * → unit file; anything else → throw.
 */
function makeExec({ statusOut = JSON.stringify(TAILSCALE_JSON) } = {}) {
  return async (cmd) => {
    if (cmd.startsWith("tailscale status --json")) return statusOut;
    if (cmd.startsWith("systemctl cat tailscaled")) {
      return [
        "# /usr/lib/systemd/system/tailscaled.service",
        "[Unit]",
        "Description=Tailscale node agent",
        "[Service]",
        "EnvironmentFile=/etc/default/tailscaled",
        "ExecStart=/usr/sbin/tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/run/tailscale/tailscaled.sock --port=${PORT} $FLAGS",
        "ExecStopPost=/usr/sbin/tailscaled --cleanup",
        "Restart=on-failure",
        "RuntimeDirectory=tailscale",
        "StateDirectory=tailscale",
        "CacheDirectory=tailscale",
      ].join("\n");
    }
    throw new Error(`ENOENT: ${cmd}`);
  };
}

function makeReadFile(files = {}) {
  return async (p) => {
    if (p in files) return files[p];
    throw new Error(`ENOENT: ${p}`);
  };
}

test("tailscale: parseTailscaleStatus normalizes Self + config", () => {
  const parsed = parseTailscaleStatus(TAILSCALE_JSON);
  assert.equal(parsed.available, true);
  assert.equal(parsed.hostname, "gx10-1c2c");
  assert.equal(parsed.dnsName, "gx10-1c2c.tailda7857.ts.net.");
  assert.equal(parsed.tailscaleIp, "100.72.165.103");
  assert.deepEqual(parsed.tailscaleIps, ["100.72.165.103", "fd7a:115c:a1e0::3f32:a568"]);
  assert.equal(parsed.backendState, "Running");
  assert.equal(parsed.os, "linux");
  assert.equal(parsed.version, "1.102.4");
  assert.equal(parsed.relay, "nyc");
  assert.equal(parsed.currentTailnet, "elcid92@ts.net");
  assert.equal(parsed.magicDNSSuffix, "ts.net");
  assert.equal(parsed.keyExpiry, "2027-06-08T03:33:02Z");
  assert.equal(parsed.keyExpired, false);
  assert.equal(parsed.online, true);
  assert.equal(parsed.exitNode, null);
  assert.deepEqual(parsed.tun, TAILSCALE_JSON.TUN);
  assert.deepEqual(parsed.health, [
    "health:100.72.165.103:41641/tcp:0.0.0.0:41641/tcp:ok",
  ]);
});

test("tailscale: parseTailscaleStatus handles null/missing Self", () => {
  const parsed = parseTailscaleStatus({ Self: null, Version: "1.0.0" });
  assert.equal(parsed.available, false);
  assert.equal(parsed.hostname, null);
  assert.equal(parsed.tailscaleIp, null);
  assert.deepEqual(parsed.tailscaleIps, []);
  assert.equal(parsed.version, "1.0.0");
});

test("tailscale: collectTailscale full path (status + unit + conf + env)", async () => {
  const readFile = makeReadFile({
    "/etc/tailscale/tailscale.conf": "state_file = /var/lib/tailscale/tailscaled.state",
    "/etc/tailscale/tailscale.env": "TAILSCALE_SOCKET=/run/tailscale/tailscaled.sock",
  });
  const result = await collectTailscale({ exec: makeExec(), readFile });
  assert.equal(result.available, true);
  assert.equal(result.hostname, "gx10-1c2c");
  assert.equal(result.tailscaleIp, "100.72.165.103");
  assert.equal(result.error, null);
  // Config parsed from the unit file.
  assert.equal(result.config.stateFile, "/var/lib/tailscale/tailscaled.state");
  assert.equal(result.config.socket, "/run/tailscale/tailscaled.sock");
  assert.equal(result.config.port, "${PORT}");
  assert.equal(result.config.flags, "$FLAGS");
  // Config files.
  assert.equal(result.config.conf, "state_file = /var/lib/tailscale/tailscaled.state");
  assert.equal(result.config.env, "TAILSCALE_SOCKET=/run/tailscale/tailscaled.sock");
});

test("tailscale: collectTailscale degrades gracefully (no tailscaled)", async () => {
  const readFile = makeReadFile({});
  const result = await collectTailscale({ exec: makeExec(), readFile });
  assert.equal(result.available, true);
  assert.equal(result.error, null);
  // No /etc/tailscale files → conf/env null.
  assert.equal(result.config.conf, null);
  assert.equal(result.config.env, null);
});

test("tailscale: collectTailscale handles missing CLI (graceful degradation)", async () => {
  const exec = async (cmd) => {
    if (cmd.startsWith("tailscale status")) throw new Error("tailscale: not found");
    return "";
  };
  const result = await collectTailscale({ exec, readFile: makeReadFile({}) });
  assert.equal(result.available, false);
  assert.equal(result.hostname, null);
  assert.equal(result.tailscaleIp, null);
  assert.deepEqual(result.tailscaleIps, []);
  assert.equal(result.error, "tailscale: not found");
  assert.equal(result.keyExpired, false);
  assert.deepEqual(result.health, []);
});

test("tailscale: collectTailscale handles unparseable JSON", async () => {
  const exec = async (cmd) => {
    if (cmd.startsWith("tailscale status")) return "not-json";
    return "";
  };
  const result = await collectTailscale({ exec, readFile: makeReadFile({}) });
  assert.equal(result.available, false);
  assert.equal(result.hostname, null);
  assert.ok(result.error);
});
