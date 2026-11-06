import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  emptyStore,
  loadInstanceStore,
  saveInstanceStore,
  writeInstance,
  readInstance,
  defaultInstancePath,
} from "../componentInstance.js";

test("instance store round-trips variant and recording across restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-inst-"));
  const file = defaultInstancePath(dir);
  let store = writeInstance(emptyStore(), "n1", "comp-a", {
    variantId: "stock",
    recording: { content: "metadata", retentionHours: 24 },
    segments: [],
  });
  saveInstanceStore(file, store);
  store = loadInstanceStore(file);
  const rec = readInstance(store, "n1", "comp-a");
  assert.equal(rec.variantId, "stock");
  assert.equal(rec.recording.content, "metadata");
  store = writeInstance(store, "n1", "comp-a", { ...rec, variantId: "uncensored" });
  saveInstanceStore(file, store);
  const again = readInstance(loadInstanceStore(file), "n1", "comp-a");
  assert.equal(again.variantId, "uncensored");
  assert.equal(again.recording.content, "metadata");
});
