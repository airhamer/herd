/**
 * history.test.js — tests for the SC4 proven-history store
 * (agent/catalog/history.js): entry/file validation, append-only storage
 * with rolling cap, fail-soft load, queries by stack / recent proven, and
 * the enrichSnapshot seam that attaches history to the snapshot.
 *
 * Pure functions (validateHistoryEntry / validateHistoryFile) take objects,
 * touch no fs. HistoryStore is exercised against a temp file in os.tmpdir
 * (cleaned up in the same test), like stacks-catalog.test.js.
 *
 * Run: node --test agent/catalog/__tests__/history.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  validateHistoryEntry,
  validateHistoryFile,
  createHistoryStore,
  HISTORY_FILE_VERSION,
} from "../history.js";
import { enrichSnapshot } from "../../main.js";

// ── fixtures ────────────────────────────────────────────────

const entry = (over = {}) => ({
  stackId: "hasso-27b-stock",
  componentNames: ["qwen38-27b-stock-sglang-tp1-gx10"],
  tpSize: 1,
  actualBootMs: 210000,
  etaMs: 180000,
  success: true,
  timestamp: 1760000000000,
  ...over,
});

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-history-test-"));
  return path.join(dir, name);
}

function cleanup(file) {
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

// ── validateHistoryEntry ────────────────────────────────────

test("validateHistoryEntry: accepts a minimal valid entry and one with notes", () => {
  assert.deepEqual(validateHistoryEntry(entry()), []);
  assert.deepEqual(validateHistoryEntry(entry({ notes: "no OOM, 27B loaded" })), []);
  assert.deepEqual(validateHistoryEntry(entry({ actualBootMs: null, etaMs: null, success: false })), []);
});

test("validateHistoryEntry: rejects bad stackId/components/tpSize/boot/success/timestamp", () => {
  assert.ok(validateHistoryEntry(null).length === 1);
  assert.ok(validateHistoryEntry([]).length === 1);
  assert.ok(validateHistoryEntry(entry({ stackId: "" })).some((e) => e.includes("stackId")));
  assert.ok(validateHistoryEntry(entry({ componentNames: [] })).some((e) => e.includes("componentNames")));
  assert.ok(validateHistoryEntry(entry({ componentNames: ["ok", 7] })).some((e) => e.includes("componentNames")));
  assert.ok(validateHistoryEntry(entry({ tpSize: 0 })).some((e) => e.includes("tpSize")));
  assert.ok(validateHistoryEntry(entry({ tpSize: 1.5 })).some((e) => e.includes("tpSize")));
  assert.ok(validateHistoryEntry(entry({ actualBootMs: "fast" })).some((e) => e.includes("actualBootMs")));
  assert.ok(validateHistoryEntry(entry({ etaMs: -1 })).some((e) => e.includes("etaMs")));
  assert.ok(validateHistoryEntry(entry({ success: "yes" })).some((e) => e.includes("success")));
  assert.ok(validateHistoryEntry(entry({ notes: 3 })).some((e) => e.includes("notes")));
  assert.ok(validateHistoryEntry(entry({ timestamp: 1.5 })).some((e) => e.includes("timestamp")));
});

// ── validateHistoryFile ─────────────────────────────────────

test("validateHistoryFile: version, array, per-entry errors, dup keys", () => {
  assert.deepEqual(validateHistoryFile({ version: HISTORY_FILE_VERSION, entries: [entry()] }), []);
  assert.ok(validateHistoryFile({ version: 2, entries: [] })[0].includes("version"));
  assert.ok(validateHistoryFile({ version: 1, entries: "nope" })[0].includes("array"));
  const badEntry = validateHistoryFile({ version: 1, entries: [entry({ tpSize: 0 })] });
  assert.ok(badEntry.some((e) => e.startsWith("entries[0]") && e.includes("tpSize")));
  const dup = validateHistoryFile({ version: 1, entries: [entry(), entry()] });
  assert.ok(dup.some((e) => e.includes("duplicate (stackId, timestamp)")));
});

// ── HistoryStore: append + persistence ──────────────────────

test("HistoryStore: absent file loads empty (no bootstrap), append persists and reloads", () => {
  const f = tmpFile("stack-history.json");
  try {
    const a = createHistoryStore(f).load();
    assert.deepEqual(a.entries, []);
    assert.deepEqual(a.errors, []);
    assert.ok(!fs.existsSync(f), "load of an absent file writes nothing");

    a.append(entry());
    a.append(entry({ stackId: "hasso-flash-next", timestamp: 1760000000500, success: false }));
    assert.ok(fs.existsSync(f));

    const b = createHistoryStore(f).load();
    assert.deepEqual(b.errors, []);
    assert.equal(b.entries.length, 2);
    assert.equal(b.entries[0].stackId, "hasso-27b-stock");
    assert.equal(b.entries[1].stackId, "hasso-flash-next");
  } finally {
    cleanup(f);
  }
});

test("HistoryStore: append rejects invalid entries and duplicate (stackId, timestamp)", () => {
  const f = tmpFile("stack-history.json");
  try {
    const s = createHistoryStore(f).load();
    assert.throws(() => s.append(entry({ tpSize: 0 })), /tpSize/);
    assert.equal(s.entries.length, 0);
    s.append(entry());
    assert.throws(() => s.append(entry()), /duplicate/);
    assert.equal(s.entries.length, 1);
  } finally {
    cleanup(f);
  }
});

test("HistoryStore: rolling cap keeps the newest maxEntries (oldest dropped)", () => {
  const f = tmpFile("stack-history.json");
  try {
    const s = createHistoryStore(f, { maxEntries: 3 }).load();
    for (let i = 0; i < 5; i++) {
      s.append(entry({ timestamp: 1760000000000 + i }));
    }
    assert.deepEqual(
      s.entries.map((e) => e.timestamp),
      [1760000000002, 1760000000003, 1760000000004]
    );
  } finally {
    cleanup(f);
  }
});

// ── HistoryStore: fail-soft load ────────────────────────────

test("HistoryStore: corrupt file degrades to empty with an error, never overwrites", () => {
  const f = tmpFile("stack-history.json");
  try {
    fs.writeFileSync(f, "{not json");
    const s = createHistoryStore(f).load();
    assert.deepEqual(s.entries, []);
    assert.ok(s.errors.some((e) => e.includes("unreadable")));
    assert.ok(fs.readFileSync(f, "utf8").includes("not json"), "corrupt file untouched");
  } finally {
    cleanup(f);
  }
});

test("HistoryStore: invalid entries dropped on load, good ones survive (fail-soft)", () => {
  const f = tmpFile("stack-history.json");
  try {
    fs.writeFileSync(
      f,
      JSON.stringify({
        version: 1,
        entries: [entry(), entry({ stackId: "bad", tpSize: 0, timestamp: 1760000000500 }), entry({ timestamp: 1760000001000 })],
      })
    );
    const s = createHistoryStore(f).load();
    assert.equal(s.entries.length, 2);
    assert.ok(s.errors.some((e) => e.includes("dropped entry")));
  } finally {
    cleanup(f);
  }
});

// ── queries ─────────────────────────────────────────────────

test("queries: historyFor / allHistories / hasProven / recentProven", () => {
  const f = tmpFile("stack-history.json");
  try {
    const s = createHistoryStore(f).load();
    s.append(entry({ timestamp: 1760000000000, success: true }));
    s.append(entry({ timestamp: 1760000000100, success: false, notes: "OOM" }));
    s.append(entry({ stackId: "hasso-flash-next", timestamp: 1760000000200, success: true }));

    const h = s.historyFor("hasso-27b-stock");
    assert.equal(h.stackId, "hasso-27b-stock");
    assert.deepEqual(h.entries.map((e) => e.timestamp), [1760000000000, 1760000000100]);

    const all = s.allHistories();
    assert.deepEqual(Object.keys(all), ["hasso-27b-stock", "hasso-flash-next"]);
    assert.equal(all["hasso-flash-next"].entries.length, 1);

    assert.ok(s.hasProven("hasso-27b-stock"));
    assert.ok(s.hasProven("hasso-flash-next"));
    assert.ok(!s.hasProven("never-run"));
    const onlyFailed = createHistoryStore(tmpFile("x.json")).load();
    onlyFailed.append(entry({ success: false }));
    assert.ok(!onlyFailed.hasProven("hasso-27b-stock"));

    const recent = s.recentProven();
    assert.deepEqual(
      recent.map((e) => e.timestamp),
      [1760000000200, 1760000000000]
    ); // successes only, newest first
    assert.equal(s.recentProven(1).length, 1);

    // copies, not live references
    recent[0].stackId = "mutated";
    assert.equal(s.entries[2].stackId, "hasso-flash-next");
  } finally {
    cleanup(f);
  }
});

// ── snapshot seam (enrichSnapshot) ──────────────────────────

test("enrichSnapshot: attaches stackHistory keyed by stackId; store absent/empty → null", () => {
  const base = { nodeId: "n1", nodeName: "n1", lanIp: "", polledAt: 1 };
  const withHistory = createHistoryStore(tmpFile("snap.json")).load();
  withHistory.append(entry());
  const snap = enrichSnapshot({ ...base }, { stackHistory: withHistory });
  assert.ok(snap.stackHistory);
  assert.equal(snap.stackHistory["hasso-27b-stock"].entries.length, 1);

  const emptyStore = createHistoryStore(tmpFile("empty.json")).load();
  assert.equal(enrichSnapshot({ ...base }, { stackHistory: emptyStore }).stackHistory, null);
  assert.equal(enrichSnapshot({ ...base }, {}).stackHistory, null);

  const throwing = { allHistories: () => { throw new Error("boom"); } };
  assert.equal(enrichSnapshot({ ...base }, { stackHistory: throwing }).stackHistory, null);
  cleanup(withHistory.historyPath);
  cleanup(emptyStore.historyPath);
});
