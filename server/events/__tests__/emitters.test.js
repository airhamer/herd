// Job managers announce their runs to the activity feed (issue #32).
// No LLM is needed: targets that refuse connections make runs fail fast.
import { after, describe, test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import net from "net";
import { DecodeBenchManager } from "../../collectors/DecodeBench.js";
import { PrefillBenchManager } from "../../collectors/PrefillBench.js";
import { ShowcaseManager } from "../../collectors/ShowcaseManager.js";
import { activity } from "../activity.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herd-emitters-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A port nothing listens on. */
async function closedPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

const waitFor = async (check) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};
const refuse = async () => {
  throw new Error("target unreachable");
};

describe("bench managers", () => {
  test("decode: started then failed, mapped to bench.decode.* events", async () => {
    const mgr = new DecodeBenchManager(path.join(dir, "dh.json"), path.join(dir, "da.json"));
    const seen = [];
    mgr.setEventSink((job) => seen.push(activity.bench("decode", job)));
    mgr.start({ sparkId: "s-dec", lanIp: "127.0.0.1", port: await closedPort(), modelId: "m", concurrencies: [1], resolveTarget: refuse });
    await waitFor(() => seen.length >= 2);
    assert.deepEqual(seen.map((e) => e.type), ["bench.decode.started", "bench.decode.failed"]);
    assert.equal(seen[0].sparkId, "s-dec");
    assert.equal(seen[0].data.benchId, seen[1].data.benchId);
    assert.equal(seen[1].severity, "error");
  });

  test("prefill: started then failed; a throwing sink does not break the run", async () => {
    const mgr = new PrefillBenchManager(path.join(dir, "ph.json"), path.join(dir, "pa.json"));
    const seen = [];
    mgr.setEventSink((job) => {
      seen.push(job.status);
      throw new Error("sink down");
    });
    const job = mgr.start({ sparkId: "s-pre", lanIp: "127.0.0.1", port: await closedPort(), modelId: "m", contextSizes: [1024], resolveTarget: refuse });
    await waitFor(() => seen.length >= 2);
    assert.deepEqual(seen, ["running", "failed"]);
    assert.equal(mgr.getJob(job.benchId).status, "failed");
    assert.equal(mgr.activeCount(), 0);
  });

  test("detaching the sink stops notices", async () => {
    const mgr = new DecodeBenchManager(path.join(dir, "dh2.json"), path.join(dir, "da2.json"));
    const seen = [];
    mgr.setEventSink((job) => seen.push(job));
    mgr.setEventSink(null);
    const job = mgr.start({ sparkId: "s-x", lanIp: "127.0.0.1", port: await closedPort(), modelId: "m", concurrencies: [1], resolveTarget: refuse });
    await waitFor(() => mgr.getJob(job.benchId).status !== "running");
    assert.deepEqual(seen, []);
  });
});

describe("showcase manager", () => {
  test("started, then settled exactly once", async () => {
    const mgr = new ShowcaseManager(path.join(dir, "sh.json"));
    const seen = [];
    mgr.setEventSink((s) => seen.push(activity.showcase(s)));
    const { sessionId } = mgr.start({ sparkId: "s-show", lanIp: "127.0.0.1", port: await closedPort(), prompts: ["hello", "world"] });
    await waitFor(() => seen.length >= 2);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(seen.length, 2);
    assert.equal(seen[0].type, "showcase.started");
    assert.equal(seen[0].message, "Showcase started: 2 streams");
    assert.equal(seen[1].type, "showcase.failed");
    assert.equal(seen[1].data.sessionId, sessionId);
  });

  test("a cancel is announced once even though the run also settles", async () => {
    const mgr = new ShowcaseManager(path.join(dir, "sh2.json"));
    const seen = [];
    mgr.setEventSink((s) => seen.push(s.status));
    const { sessionId } = mgr.start({ sparkId: "s-c", lanIp: "127.0.0.1", port: await closedPort(), prompts: ["one"] });
    mgr.cancel("s-c", sessionId);
    await waitFor(() => mgr.activeBySpark.size === 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(seen, ["running", "cancelled"]);
  });
});
