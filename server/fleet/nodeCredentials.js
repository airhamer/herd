// ─── Node SSH credentials (S1.3 credential store) ──────────────────────
//
// SSH passwords for fleet nodes live ONLY in the encrypted secrets store
// (server/secretsStore.js — AES-256-GCM at rest, key from SPARKDASH_SECRETS_KEY
// or config/.secrets-key). They are NEVER written to nodes.json and NEVER
// served by the API. This mirrors the Spark-side precedent (Edit Spark
// password → secretsStore, never sparks.json).
//
// The store is shared with Spark SSH passwords, so fleet entries are namespaced
// with a `node:` key prefix: a Spark and a fleet node that happen to share an
// id can never clobber each other's credential.
//
// Seam for server/fleet/sshTransport.js: getNodeSshPassword(nodeId) resolves
// the password when a record selects auth:"pass" (key auth needs no secret).
//
// Zero runtime deps beyond the repo's secretsStore.

import { loadSecrets, saveSecrets } from "../secretsStore.js";

/** Store-key namespacing (see header). */
const NODE_KEY_PREFIX = "node:";

/** @param {string} nodeId @returns {string} */
function storeKey(nodeId) {
  return NODE_KEY_PREFIX + nodeId;
}

/**
 * Resolve a node's SSH password from the encrypted store.
 * @param {string} nodeId
 * @returns {string | null}
 */
export function getNodeSshPassword(nodeId) {
  if (typeof nodeId !== "string" || !nodeId.trim()) return null;
  const pw = loadSecrets().passwords.get(storeKey(nodeId.trim()));
  return typeof pw === "string" && pw ? pw : null;
}

/**
 * Whether a password is stored for this node (API-safe: reveals nothing).
 * @param {string} nodeId
 * @returns {boolean}
 */
export function hasNodeSshPassword(nodeId) {
  return getNodeSshPassword(nodeId) !== null;
}

/**
 * Store (or replace) a node's SSH password. The encrypted store is shared
 * with Spark secrets and LLM API keys, so the write is a load-merge-save:
 * every unrelated entry round-trips untouched.
 * @param {string} nodeId
 * @param {string} password non-empty
 */
export function setNodeSshPassword(nodeId, password) {
  if (typeof nodeId !== "string" || !nodeId.trim()) {
    throw new Error("setNodeSshPassword: nodeId required");
  }
  if (typeof password !== "string" || !password) {
    throw new Error("setNodeSshPassword: password must be a non-empty string");
  }
  const { passwords, llmApiKeys } = loadSecrets();
  passwords.set(storeKey(nodeId.trim()), password);
  saveSecrets(passwords, llmApiKeys);
}

/**
 * Forget a node's stored SSH password (unrelated entries preserved).
 * @param {string} nodeId
 * @returns {boolean} true when an entry was removed
 */
export function deleteNodeSshPassword(nodeId) {
  if (typeof nodeId !== "string" || !nodeId.trim()) return false;
  const { passwords, llmApiKeys } = loadSecrets();
  const key = storeKey(nodeId.trim());
  if (!passwords.has(key)) return false;
  passwords.delete(key);
  saveSecrets(passwords, llmApiKeys);
  return true;
}
