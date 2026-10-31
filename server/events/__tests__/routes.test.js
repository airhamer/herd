// GET/DELETE /api/events (issue #32) against a real Express app.
import { after, before, describe, test } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import { EventLog } from "../EventLog.js";
import { MAX_EVENTS_LIMIT, parseEventsQuery, registerEventRoutes } from "../routes.js";

let clock = 1_000_000;
const log = new EventLog({ max: 2000, now: () => clock });
let server;
let base;

function seed() {
  log.clear();
  const add = (type, sparkId, severity = "info") => {
    clock += 10_000;
    return log.record({ type, sparkId, sparkName: sparkId, severity, message: `${type} on ${sparkId}` });
  };
  add("spark.online", "s1", "success");
  add("gpu.throttle.start", "s1", "warn");
  add("gpu.clock.capped", "s2", "warn");
  add("service.started", "n1", "success");
  add("alert.fired", "s2", "error");
  add("bench.decode.completed", "s1", "success");
}

before(async () => {
  const app = express();
  app.use(express.json());
  registerEventRoutes(app, { eventLog: log });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = async (qs = "") => {
  const r = await fetch(`${base}/api/events${qs}`);
  return { status: r.status, body: await r.json() };
};

describe("GET /api/events", () => {
  test("newest first with ids for paging and totals", async () => {
    seed();
    const { status, body } = await get();
    assert.equal(status, 200);
    assert.equal(body.events.length, 6);
    assert.equal(body.events[0].type, "bench.decode.completed");
    assert.equal(body.total, 6);
    assert.equal(body.oldestId, body.events[5].id);
    assert.equal(body.newestId, body.events[0].id);
  });

  test("limit, sparkId, sinceId and beforeId", async () => {
    seed();
    const all = (await get()).body.events;
    assert.equal((await get("?limit=2")).body.events.length, 2);
    const s1 = (await get("?sparkId=s1")).body.events;
    assert.deepEqual(s1.map((e) => e.sparkId), ["s1", "s1", "s1"]);
    const newer = (await get(`?sinceId=${all[2].id}`)).body.events;
    assert.deepEqual(newer.map((e) => e.id), [all[0].id, all[1].id]);
    const older = (await get(`?beforeId=${all[3].id}&limit=2`)).body.events;
    assert.deepEqual(older.map((e) => e.id), [all[4].id, all[5].id]);
  });

  test("type (exact or prefix) and severity filters", async () => {
    seed();
    const gpu = (await get("?type=gpu.")).body.events;
    assert.deepEqual(gpu.map((e) => e.type).sort(), ["gpu.clock.capped", "gpu.throttle.start"]);
    const mixed = (await get("?type=alert.fired,service.")).body.events;
    assert.deepEqual(mixed.map((e) => e.type), ["alert.fired", "service.started"]);
    const warnings = (await get("?severity=warn,error")).body.events;
    assert.deepEqual(warnings.map((e) => e.severity), ["error", "warn", "warn"]);
    const both = (await get("?type=gpu.&sparkId=s2")).body.events;
    assert.deepEqual(both.map((e) => e.type), ["gpu.clock.capped"]);
  });

  test("bad parameters answer 400", async () => {
    for (const qs of ["?limit=0", `?limit=${MAX_EVENTS_LIMIT + 1}`, "?limit=abc", "?sinceId=-1", "?type=Bad Type", "?severity=fatal", "?sparkId=a%20b"]) {
      const { status, body } = await get(qs);
      assert.equal(status, 400, qs);
      assert.ok(body.error, qs);
    }
  });
});

describe("DELETE /api/events", () => {
  test("olderThanMs prunes only old events", async () => {
    seed();
    const r = await fetch(`${base}/api/events?olderThanMs=25000`, { method: "DELETE" });
    assert.equal(r.status, 200);
    // Seeded 10 s apart ending at `clock`: events at ≥ clock-25 s survive (3).
    assert.deepEqual(await r.json(), { removed: 3 });
    assert.equal((await get()).body.total, 3);
  });

  test("no parameter clears everything; bad values answer 400", async () => {
    seed();
    const bad = await fetch(`${base}/api/events?olderThanMs=soon`, { method: "DELETE" });
    assert.equal(bad.status, 400);
    const r = await fetch(`${base}/api/events`, { method: "DELETE" });
    assert.deepEqual(await r.json(), { removed: 6 });
    assert.deepEqual((await get()).body.events, []);
  });
});

describe("parseEventsQuery", () => {
  test("defaults and arrays", () => {
    const p = parseEventsQuery({});
    assert.deepEqual(p, {
      ok: true,
      filter: { limit: 50, sparkId: undefined, sinceId: undefined, beforeId: undefined, types: [], severities: [] },
    });
    assert.equal(parseEventsQuery({ limit: ["5", "7"] }).filter.limit, 7, "last repeated value wins");
  });
});
