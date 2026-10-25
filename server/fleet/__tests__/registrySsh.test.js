// S1.3 tests — SSH transport fields on NodeRecord (EVAL §4.4 item 3).
// protocol:"ssh" + ssh connection params, credential material NEVER persisted
// on the record. Same fixture convention as registry.test.js: real files in a
// fresh temp dir, registry pointed at them via loadNodes(path).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { loadNodes, saveNodes, addNode, updateNode, getNode, registryPath } from "../registry.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-sshtest-"));

function freshNodesPath(name = "ssh") {
  const dir = fs.mkdtempSync(path.join(tmpRoot, name + "-"));
  const p = path.join(dir, "nodes.json");
  loadNodes(p);
  return p;
}

function base(over = {}) {
  return {
    id: "narthex-ssh",
    name: "Narthex (agentless)",
    endpoint: "",
    lanIp: "127.0.0.1",
    ...over,
  };
}

// ─── protocol field normalization ──────────────────────────────────────────

test('protocol:"ssh" is stored explicitly (trimmed + lowercased)', () => {
  freshNodesPath();
  const rec = addNode(base({ protocol: " SSH ", ssh: { user: "steve" } }));
  assert.equal(rec.protocol, "ssh");
  assert.equal(getNode("narthex-ssh").protocol, "ssh");
});

test("protocol-less records round-trip key-free (legacy byte-shape)", () => {
  freshNodesPath();
  const p = registryPath();
  const rec = addNode(base());
  assert.equal("protocol" in rec, false);
  assert.equal("ssh" in rec, false);
  saveNodes([rec], p);
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  assert.equal("protocol" in raw.nodes[0], false);
  assert.equal("ssh" in raw.nodes[0], false);
});

test('protocol:"http" and junk normalize to the default (key omitted)', () => {
  freshNodesPath();
  for (const v of ["http", "https", "serial", ""]) {
    const rec = addNode(base({ id: `n-${v || "empty"}`, protocol: v }));
    assert.equal("protocol" in rec, false, `protocol ${JSON.stringify(v)} must not persist`);
  }
});

// ─── ssh sub-record ─────────────────────────────────────────────────────────

test("ssh params persist: user, auth, trimmed host; host omitted when blank", () => {
  freshNodesPath();
  const rec = addNode(
    base({ protocol: "ssh", ssh: { user: " steve ", auth: "pass", host: " 192.168.50.150 " } })
  );
  assert.deepEqual(rec.ssh, { user: "steve", auth: "pass", host: "192.168.50.150" });

  const rec2 = addNode(base({ id: "n2", protocol: "ssh", ssh: { user: "steve" } }));
  assert.deepEqual(rec2.ssh, { user: "steve", auth: "key" });
});

test("ssh auth defaults to key; any non-pass value (incl. junk) is key", () => {
  freshNodesPath();
  const rec = addNode(base({ protocol: "ssh", ssh: { user: "steve", auth: "publickey" } }));
  assert.equal(rec.ssh.auth, "key");
});

test("ssh block is dropped for non-ssh protocols", () => {
  freshNodesPath();
  const rec = addNode(base({ ssh: { user: "steve", auth: "pass" } }));
  assert.equal("ssh" in rec, false);
});

test("strict writes require a valid ssh.user for protocol ssh", () => {
  freshNodesPath();
  for (const bad of [undefined, "", "  ", "bad user;rm", "a".repeat(65), "user$()", {}]) {
    assert.throws(
      () => addNode(base({ id: `x-${Math.random()}`, protocol: "ssh", ssh: { user: bad } })),
      /ssh\.user/,
      `user ${JSON.stringify(bad)} must be rejected`
    );
  }
  // Load path: record kept, ssh dropped (SSH transport unavailable), no crash.
  const p = registryPath();
  fs.writeFileSync(
    p,
    JSON.stringify({ nodes: [base({ id: "loadme", protocol: "ssh", ssh: { user: "no peaches" } })] })
  );
  loadNodes(p);
  const rec = getNode("loadme");
  assert.ok(rec, "record itself survives");
  assert.equal("ssh" in rec, false);
});

// ─── credential material is never persisted ────────────────────────────────

test("strict writes reject credential material on the record", () => {
  freshNodesPath();
  for (const key of ["password", "passphrase", "privateKey", "identity", "identityFile"]) {
    assert.throws(
      () =>
        addNode(
          base({ id: `c-${key.toLowerCase()}`, protocol: "ssh", ssh: { user: "steve", [key]: "s3cret" } })
        ),
      (err) => /never stored/.test(err.message) && /ssh-password/.test(err.message),
      `${key} must be refused with the ssh-password pointer`
    );
  }
});

test("load path strips credential keys but keeps the record + params", () => {
  const p = freshNodesPath();
  fs.writeFileSync(
    p,
    JSON.stringify({
      nodes: [base({ id: "sneaky", protocol: "ssh", ssh: { user: "steve", auth: "pass", password: "hunter2" } })],
    })
  );
  loadNodes(p);
  const rec = getNode("sneaky");
  assert.equal(rec.ssh.user, "steve");
  assert.equal(rec.ssh.auth, "pass");
  assert.equal("password" in rec.ssh, false);
});

test("non-22 ssh.port is refused on writes, ignored on load", () => {
  freshNodesPath();
  assert.throws(
    () => addNode(base({ protocol: "ssh", ssh: { user: "steve", port: 2222 } })),
    /port 22 only/
  );
  // 22 is the only port the transport dials — recording it is a no-op.
  const rec = addNode(base({ id: "okport", protocol: "ssh", ssh: { user: "steve", port: 22 } }));
  assert.equal("port" in rec.ssh, false);
  const p = registryPath();
  fs.writeFileSync(p, JSON.stringify({ nodes: [base({ id: "okport", protocol: "ssh", ssh: { user: "steve", port: 22 } })] }));
  loadNodes(p);
  assert.equal("port" in getNode("okport").ssh, false);
});

test("updateNode can set protocol+ssh on an existing record", () => {
  freshNodesPath();
  addNode(base());
  const rec = updateNode("narthex-ssh", { protocol: "ssh", ssh: { user: "steve", auth: "pass" } });
  assert.equal(rec.protocol, "ssh");
  assert.deepEqual(rec.ssh, { user: "steve", auth: "pass" });
  // And switching back to HTTP drops both keys (default transport).
  const back = updateNode("narthex-ssh", { protocol: "", ssh: null });
  assert.equal("protocol" in back, false);
  assert.equal("ssh" in back, false);
});
