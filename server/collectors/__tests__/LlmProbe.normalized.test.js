/**
 * STAT2 (#35): LlmProbe feeds every poll into the 60 s / 300 s engine windows
 * and returns the normalized record on each live snapshot.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { LlmProbe } from "../LlmProbe.js";
import { LEGACY_ENGINES, NEW_ENGINES, runFixture } from "./fixtures/llmEngineFixtures.js";
import { NORMALIZED_FIELDS } from "../../metrics/EngineWindow.js";

const ALL = { ...LEGACY_ENGINES, ...NEW_ENGINES };
const TIERS = new Set(["counter", "native", "proxy", "client"]);

/** value of one normalized field in the 300 s window of the last snapshot */
const last300 = (snaps) => snaps.at(-1).normalized["300"].values;
const pick = (values) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.value]));

for (const [name, polls] of Object.entries(ALL)) {
  test(`${name}: normalized record is well formed in both windows`, async () => {
    const snaps = await runFixture(LlmProbe, polls);
    for (const snap of snaps) {
      assert.deepEqual(Object.keys(snap.normalized), ["60", "300"]);
      for (const [span, rec] of Object.entries(snap.normalized)) {
        assert.equal(rec.spanS, Number(span));
        assert.deepEqual(Object.keys(rec.values), [...NORMALIZED_FIELDS]);
        for (const [field, v] of Object.entries(rec.values)) {
          const where = `${name} ${span}s ${field}`;
          assert.equal(v.valid, v.value !== null, `${where}: valid ⇔ non-null`);
          if (v.valid) {
            assert.ok(Number.isFinite(v.value), `${where}: finite`);
            assert.ok(TIERS.has(v.source), `${where}: tier ${v.source}`);
            assert.ok(v.samples > 0, `${where}: samples`);
            assert.ok(v.windowS != null && v.windowS <= rec.spanS, `${where}: window`);
          } else {
            assert.equal(v.approximate, false, `${where}: unmeasured is not approximate`);
            assert.equal(v.samples, 0, `${where}: unmeasured has no samples`);
          }
        }
      }
    }
  });
}

test("vLLM: Hasso values over the window", async () => {
  const v = last300(await runFixture(LlmProbe, LEGACY_ENGINES.vllm));
  assert.deepEqual(pick(v), {
    decode_tps: 50,
    prefill_tps: 2000,
    ttft_s: 0.2,
    queue_s: 0.05,
    running: 0,
    waiting: 2,
    kv_pct: 20,
    cache_reuse: 0.75,
    acc_len: 3,
    idle_share: null,
    throughput_tps: 60,
  });
  assert.equal(v.decode_tps.source, "counter");
  assert.equal(v.decode_tps.approximate, false);
  assert.equal(v.decode_tps.windowS, 4);
  assert.equal(v.decode_tps.samples, 3);
});

test("SGLang: Hasso values over the window", async () => {
  const v = last300(await runFixture(LlmProbe, LEGACY_ENGINES.sglang));
  assert.equal(v.decode_tps.value, 40);
  assert.equal(v.prefill_tps.value, 1500);
  assert.equal(v.ttft_s.value, 0.3);
  assert.equal(v.queue_s.value, 0.01);
  assert.equal(v.cache_reuse.value, 0.8);
  assert.equal(v.acc_len.value, 3);
  assert.equal(v.kv_pct.value, 40);
});

test("engines without Hasso counters: per-poll rates, flagged approximate", async () => {
  for (const name of ["llama.cpp", "ds4", "exl3", "q27", "freetoken", "strata", "locals", "splash"]) {
    const v = last300(await runFixture(LlmProbe, ALL[name]));
    assert.equal(v.decode_tps.valid, true, name);
    assert.equal(v.decode_tps.approximate, true, name);
    assert.equal(v.queue_s.valid, false, `${name}: no queue histogram`);
  }
});

test("llama.cpp: per-task slot totals never feed throughput or cache reuse", async () => {
  const v = last300(await runFixture(LlmProbe, LEGACY_ENGINES["llama.cpp"]));
  assert.equal(v.throughput_tps.value, null);
  assert.equal(v.cache_reuse.value, null);
});

test("LM Studio and Ollama: every rate is null, not 0", async () => {
  for (const name of ["lmstudio", "ollama"]) {
    const v = last300(await runFixture(LlmProbe, NEW_ENGINES[name]));
    for (const f of ["decode_tps", "prefill_tps", "ttft_s", "throughput_tps"]) {
      assert.equal(v[f].value, null, `${name} ${f}`);
      assert.equal(v[f].valid, false, `${name} ${f}`);
    }
  }
});

test("engine restart: counters going back start the window again", async () => {
  const polls = LEGACY_ENGINES.vllm;
  const snaps = await runFixture(LlmProbe, [...polls, ...polls]);
  const rec = snaps.at(-1).normalized["300"];
  assert.equal(rec.resets, 1);
  assert.equal(rec.reads, polls.length);
  assert.equal(rec.values.decode_tps.value, 50);
  // Nothing negative anywhere.
  for (const s of snaps) {
    for (const v of Object.values(s.normalized["300"].values)) assert.ok(v.value == null || v.value >= 0);
  }
});

test("unreachable probe: normalized is null", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888, { now: () => 1 });
  probe._fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const s = await probe.probe();
  assert.equal(s.available, false);
  assert.equal(s.normalized, null);
});

test("deterministic: the same polls give the same records", async () => {
  const a = await runFixture(LlmProbe, LEGACY_ENGINES.sglang);
  const b = await runFixture(LlmProbe, LEGACY_ENGINES.sglang);
  assert.deepEqual(a.map((s) => s.normalized), b.map((s) => s.normalized));
});
