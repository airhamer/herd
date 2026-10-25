// S1.3 credential-store tests — server/fleet/nodeCredentials.js
//
// Real encrypted store (AES-256-GCM via server/secretsStore.js), pointed at a
// fresh temp dir BEFORE the first config.js import (paths captured as consts;
// each node --test file runs in its own process — same convention as
// server/sparks/__tests__/SparkRegistry.llmApiKeys.test.js).
//
// Proves: ciphertext at rest (never plaintext), load-merge-save preserves
// unrelated Spark secrets and LLM keys, `node:` namespacing isolates a Spark
// and a fleet node that share an id, and the negative cases.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-nodecred-"));
process.env.SPARKS_SECRETS_PATH = path.join(TMP, "secrets.json");
process.env.SECRETS_KEY_PATH = path.join(TMP, ".secrets-key");
process.env.SPARKDASH_SECRETS_KEY = "test-key-not-for-prod-0123456789abcdef";

const { loadSecrets, saveSecrets } = await import("../../secretsStore.js");
const {
  getNodeSshPassword,
  hasNodeSshPassword,
  setNodeSshPassword,
  deleteNodeSshPassword,
} = await import("../nodeCredentials.js");

test("set → get round-trips through the encrypted store", () => {
  setNodeSshPassword("gx10-1c2c", "hunter2 \u00e9\u4e16");
  // Re-read through a fresh loadSecrets (file → decrypt), not module memory.
  assert.equal(getNodeSshPassword("gx10-1c2c"), "hunter2 \u00e9\u4e16");
  assert.equal(hasNodeSshPassword("gx10-1c2c"), true);
});

test("password is ciphertext at rest — plaintext bytes never touch the file", () => {
  const raw = fs.readFileSync(process.env.SPARKS_SECRETS_PATH, "utf-8");
  assert.equal(raw.includes("hunter2"), false, "plaintext leaked into the store file");
  assert.equal(raw.includes("68756e74"), false); // hex form too
  const data = JSON.parse(raw);
  assert.equal(typeof data.secrets["node:gx10-1c2c"], "string");
});

test("replace (not append): second set wins, single entry", () => {
  setNodeSshPassword("gx10-1c2c", "second");
  assert.equal(getNodeSshPassword("gx10-1c2c"), "second");
  const data = JSON.parse(fs.readFileSync(process.env.SPARKS_SECRETS_PATH, "utf-8"));
  const nodeKeys = Object.keys(data.secrets).filter((k) => k === "node:gx10-1c2c");
  assert.equal(nodeKeys.length, 1);
});

test("load-merge-save never clobbers Spark secrets or LLM API keys", () => {
  // Pre-seed the store with Spark-side entries (the pre-existing tenants).
  const sparkPw = new Map([["spark-alpha", "spark-pw-1"]]);
  const llmKeys = new Map([["spark-beta", { "8000": "sk-abcdef" }]]);
  saveSecrets(sparkPw, llmKeys);

  setNodeSshPassword("gx10-27c1", "node-pw");
  const after = loadSecrets();
  assert.equal(after.passwords.get("spark-alpha"), "spark-pw-1", "Spark password survived set");
  assert.equal(after.llmApiKeys.get("spark-beta")["8000"], "sk-abcdef", "LLM key survived set");
  assert.equal(after.passwords.get("node:gx10-27c1"), "node-pw");

  assert.equal(deleteNodeSshPassword("gx10-27c1"), true);
  const gone = loadSecrets();
  assert.equal(gone.passwords.has("node:gx10-27c1"), false, "node entry removed");
  assert.equal(gone.passwords.get("spark-alpha"), "spark-pw-1", "Spark password survived delete");
  assert.equal(gone.llmApiKeys.get("spark-beta")["8000"], "sk-abcdef", "LLM key survived delete");

  // Idempotent delete: second call reports nothing removed, store unchanged.
  assert.equal(deleteNodeSshPassword("gx10-27c1"), false);
  assert.equal(loadSecrets().passwords.get("spark-alpha"), "spark-pw-1");
});

test("node:/spark id namespacing — same id, separate credentials", () => {
  const sparkPw = new Map([["dupe", "spark-side"]]);
  saveSecrets(sparkPw, new Map());
  setNodeSshPassword("dupe", "node-side");
  const after = loadSecrets();
  assert.equal(after.passwords.get("dupe"), "spark-side", "Spark credential untouched");
  assert.equal(after.passwords.get("node:dupe"), "node-side", "node-prefixed entry written");
  assert.equal(getNodeSshPassword("dupe"), "node-side", "resolver reads the node entry");

  deleteNodeSshPassword("dupe");
  assert.equal(loadSecrets().passwords.get("dupe"), "spark-side", "delete stays in its lane");
});

test("negatives: unknown ids, blank input, empty password", () => {
  assert.equal(getNodeSshPassword("never-set"), null);
  assert.equal(hasNodeSshPassword("never-set"), false);
  assert.equal(getNodeSshPassword(""), null);
  assert.equal(getNodeSshPassword(null), null);
  assert.equal(deleteNodeSshPassword(""), false);
  assert.throws(() => setNodeSshPassword("", "x"), /nodeId required/);
  assert.throws(() => setNodeSshPassword("ok-id", ""), /non-empty string/);
  assert.throws(() => setNodeSshPassword("ok-id", null), /non-empty string/);
});
