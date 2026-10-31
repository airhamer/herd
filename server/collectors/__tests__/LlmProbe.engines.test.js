/**
 * STAT1 (#34): per-engine fixture tests for detection, labels, totals, source
 * tiers and nulls. Payloads are synthetic but use each engine's documented
 * metric / field names (see fixtures/llmEngineFixtures.js).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { LlmProbe } from "../LlmProbe.js";
import { LEGACY_ENGINES, NEW_ENGINES, runFixture, fixtureFetch } from "./fixtures/llmEngineFixtures.js";

const GOLDEN = JSON.parse(
  readFileSync(new URL("./fixtures/llm-legacy-golden.json", import.meta.url), "utf8")
);

/**
 * Legacy fields that STAT1 may fill where main left them null, because the
 * engine publishes them. Every other legacy field must match main exactly.
 */
const LEGACY_NULL_FILLS = { sglang: new Set(["kvCacheUsage"]) };

// ─── Existing six engines: output unchanged ────────────────────────────────

for (const [name, polls] of Object.entries(LEGACY_ENGINES)) {
  test(`legacy ${name}: every field main emitted is unchanged`, async () => {
    const snaps = await runFixture(LlmProbe, polls);
    const golden = GOLDEN[name];
    assert.equal(snaps.length, golden.length);
    const fills = LEGACY_NULL_FILLS[name] ?? new Set();
    snaps.forEach((snap, i) => {
      for (const [key, want] of Object.entries(golden[i])) {
        if (want === null && fills.has(key)) continue;
        assert.deepEqual(snap[key], want, `${name} poll ${i} field ${key}`);
      }
    });
  });
}

test("legacy sglang: KV usage is filled from sglang:token_usage", async () => {
  const snaps = await runFixture(LlmProbe, LEGACY_ENGINES.sglang);
  assert.deepEqual(snaps.map((s) => s.kvCacheUsage), [0.2, 0.3, 0.4]);
});

// ─── Prompt / cached totals on the legacy engines ──────────────────────────

test("vLLM: prompt/cached totals and computed prefill = Δprompt − Δcached", async () => {
  const snaps = await runFixture(LlmProbe, LEGACY_ENGINES.vllm);
  assert.deepEqual(snaps.map((s) => s.totalPromptTokens), [1000, 5000, 9000]);
  assert.deepEqual(snaps.map((s) => s.totalCachedTokens), [200, 3200, 6200]);
  // Δprompt 4000 − Δcached 3000 = 1000 tokens over 2 s.
  assert.deepEqual(snaps.map((s) => s.computedPrefillTps), [null, 500, 500]);
});

test("vLLM: Hasso decode, prefill, queue and accept length", async () => {
  const [first, second] = await runFixture(LlmProbe, LEGACY_ENGINES.vllm);
  for (const k of ["engineDecodeTps", "enginePrefillTps", "queueTimeSeconds", "specAcceptLength"]) {
    assert.equal(first[k], null, `${k} is null before a delta exists`);
  }
  // (Δgeneration 120 − Δfirst-token 1) / Δitl_sum (119 × 0.02 s) = 50 tok/s
  assert.equal(second.engineDecodeTps, 50);
  // Δprefill_kv_computed 1000 / Δprefill_time 0.5 s
  assert.equal(second.enginePrefillTps, 2000);
  assert.equal(second.queueTimeSeconds, 0.05);
  // 1 + Δaccepted 20 / Δdrafts 10
  assert.equal(second.specAcceptLength, 3);
});

test("SGLang: Hasso decode uses ITL count / sum, prefill uses prefill_forward only", async () => {
  const [, second] = await runFixture(LlmProbe, LEGACY_ENGINES.sglang);
  assert.equal(second.engineDecodeTps, 40); // 150 / 3.75 s
  // Δprefill_compute 1000 / Δprefill_forward (1000/1500 s); chunked_prefill not added.
  assert.equal(second.enginePrefillTps, 1500);
  assert.equal(second.queueTimeSeconds, 0.01);
  assert.equal(second.specAcceptLength, 3); // Δgenerated 150 / Δverify 50
  assert.equal(second.totalPromptTokens, 7000);
  assert.equal(second.totalCachedTokens, 4500);
});

test("ds4 / q27: prompt total = computed + cached", async () => {
  const ds4 = await runFixture(LlmProbe, LEGACY_ENGINES.ds4);
  assert.equal(ds4[0].totalPromptTokens, 5000);
  assert.equal(ds4[0].totalCachedTokens, 4000);
  const q27 = await runFixture(LlmProbe, LEGACY_ENGINES.q27);
  assert.equal(q27[1].totalPromptTokens, 5100);
  assert.equal(q27[1].totalCachedTokens, 4000);
});

test("EXL3: prompt total from /health, no cache split → cached null", async () => {
  const [s] = await runFixture(LlmProbe, LEGACY_ENGINES.exl3);
  assert.equal(s.totalPromptTokens, 300);
  assert.equal(s.totalCachedTokens, null);
  assert.equal(s.valueSources.totalPromptTokens.source, "native");
});

test("llama.cpp: /slots counters are per task, so lifetime totals are null", async () => {
  const snaps = await runFixture(LlmProbe, LEGACY_ENGINES["llama.cpp"]);
  for (const s of snaps) {
    assert.equal(s.totalPromptTokens, null);
    assert.equal(s.totalCachedTokens, null);
  }
});

// ─── New engines: detection and label ──────────────────────────────────────

const EXPECTED_BACKEND = {
  tensorfoldHealth: "tensorfold",
  tensorfoldMetricsOnly: "tensorfold",
  freetoken: "freetoken",
  strata: "strata",
  locals: "locals",
  splash: "splash",
  lmstudio: "lmstudio",
  ollama: "ollama",
};

for (const [name, polls] of Object.entries(NEW_ENGINES)) {
  test(`detect ${name} → ${EXPECTED_BACKEND[name]}`, async () => {
    const snaps = await runFixture(LlmProbe, polls);
    for (const s of snaps) {
      assert.equal(s.backend, EXPECTED_BACKEND[name]);
      assert.equal(s.available, true);
      assert.equal(s.error, null);
    }
  });
}

for (const [name, polls] of Object.entries(LEGACY_ENGINES)) {
  test(`detect legacy ${name} unchanged`, async () => {
    const snaps = await runFixture(LlmProbe, polls);
    assert.ok(snaps.every((s) => s.backend === name));
  });
}

test("exact owned_by only: a partial match does not classify", async () => {
  const polls = [
    {
      "/v1/models": { json: { data: [{ id: "m", owned_by: "splashai" }] } },
      "/metrics": { text: 'vllm:generation_tokens_total{model_name="m"} 1\nvllm:prompt_tokens_total{model_name="m"} 1\n' },
    },
  ];
  const [s] = await runFixture(LlmProbe, polls);
  assert.equal(s.backend, "vllm");
});

test("Strata is read before /slots even though it serves /slots", async () => {
  const ref = { i: 0 };
  const calls = [];
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888, { now: () => 1 });
  const inner = fixtureFetch(NEW_ENGINES.strata, ref);
  probe._fetch = async (url) => {
    calls.push(new URL(url).pathname);
    return inner(url);
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "strata");
  assert.equal(calls[0], "/health");
  assert.ok(!calls.includes("/slots"));
});

test("LM Studio is ruled out before the SGLang / vLLM heuristics", async () => {
  const ref = { i: 0 };
  const calls = [];
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888, { now: () => 1 });
  const inner = fixtureFetch(NEW_ENGINES.lmstudio, ref);
  probe._fetch = async (url) => {
    calls.push(new URL(url).pathname);
    return inner(url);
  };
  await probe._detectServerType();
  assert.equal(probe.backendType, "lmstudio");
  assert.ok(!calls.includes("/server_info"), "SGLang probe must not run");
});

test("TabbyAPI: label from owned_by, every rate null", async () => {
  const polls = [0, 1].map(() => ({
    "/v1/models": { json: { data: [{ id: "Qwen3-32B-exl2", owned_by: "tabbyAPI" }] } },
  }));
  const snaps = await runFixture(LlmProbe, polls);
  for (const s of snaps) {
    assert.equal(s.backend, "tabbyapi");
    assert.equal(s.generationTps, null);
    assert.equal(s.prefillTps, null);
    assert.equal(s.totalOutputTokens, null);
    assert.deepEqual(s.valueSources, {});
  }
});

// ─── New engines: values, sources and nulls ────────────────────────────────

test("TensorFold CUDA /health: JSON totals, computed-only prefill, KV from pool", async () => {
  const snaps = await runFixture(LlmProbe, NEW_ENGINES.tensorfoldHealth);
  const [a, b] = snaps;
  assert.equal(a.generationTps, null, "first poll seeds");
  assert.equal(a.prefillTps, null, "no finished prefill in the window yet");
  assert.equal(b.generationTps, 150);
  // (Δprompt 20000 − Δcached 19000) / Δprefill_seconds 1
  assert.equal(b.prefillTps, 1000);
  assert.equal(b.totalPromptTokens, 30_000);
  assert.equal(b.totalCachedTokens, 27_000);
  assert.equal(b.kvCacheUsage, 0.25);
  assert.equal(b.slotsTotal, 4);
  assert.equal(b.valueSources.totalPromptTokens.source, "native");
  assert.equal(b.valueSources.generationTps.approximate, true);
});

test("TensorFold native /metrics: decode = Δ(finished + running), cached from prompt_tokens_cached_total", async () => {
  const snaps = await runFixture(LlmProbe, NEW_ENGINES.tensorfoldMetricsOnly);
  assert.deepEqual(snaps.map((s) => s.generationTps), [null, 100, 25]);
  assert.deepEqual(snaps.map((s) => s.prefillTps), [null, 1000, 1000]);
  assert.equal(snaps[1].totalCachedTokens, 13_500);
  assert.equal(snaps[1].kvCacheUsage, 0.4, "max across pools");
  assert.equal(snaps[1].requestsWaiting, 1);
  assert.equal(snaps[1].ttftSeconds, 0.6);
  assert.equal(snaps[1].slotsTotal, 0, "no invented slot total");
  assert.equal(snaps[1].valueSources.generationTps.source, "counter");
});

test("FreeToken /v1/stats: engine window rates, totals, KV pages, E2E p95 not TTFT", async () => {
  const [a, , c] = await runFixture(LlmProbe, NEW_ENGINES.freetoken);
  assert.equal(a.generationTps, 38.5);
  assert.equal(a.prefillTps, 1520.4);
  assert.deepEqual(a.valueSources.generationTps, { source: "native", windowS: 5, approximate: false });
  assert.equal(a.totalPromptTokens, 50_000);
  assert.equal(a.totalCachedTokens, 30_000);
  assert.equal(a.totalOutputTokens, 4000);
  assert.equal(a.kvCacheUsage, 0.1);
  assert.equal(a.e2eP95Seconds, 9.8);
  assert.equal(a.ttftP95Seconds, null);
  assert.equal(a.requestsWaiting, null, "FreeToken has no queue gauge");
  assert.equal(c.generationTps, 0, "engine reports a measured idle 0");
});

test("Strata: live tok/s, active-slot fallback is approximate, idle clears rates", async () => {
  const [a, b, c] = await runFixture(LlmProbe, NEW_ENGINES.strata);
  assert.equal(a.generationTps, 31.2);
  assert.deepEqual(a.valueSources.generationTps, { source: "native", windowS: 2, approximate: false });
  assert.equal(b.generationTps, 30.4);
  assert.equal(b.valueSources.generationTps.approximate, true);
  assert.equal(b.prefillTps, 1840);
  assert.equal(b.valueSources.prefillTps.approximate, true);
  assert.equal(c.generationTps, 0);
  assert.equal(c.prefillTps, 0);
  assert.equal(a.totalPromptTokens, 20_000);
  assert.equal(a.totalCachedTokens, 15_000);
  assert.equal(a.slotsTotal, 2);
  assert.equal(a.contextLength, 131072);
});

test("Strata: a decoding slot without a rate leaves decode unknown", async () => {
  const polls = [
    {
      ...NEW_ENGINES.strata[0],
      "/metrics": {
        json: {
          live: {
            state: "generating",
            tok_s: null,
            outside_slots: 0,
            slots: [
              { slot: 0, state: "decoding", tok_s: 20 },
              { slot: 1, state: "decoding", tok_s: null },
            ],
          },
          totals: {},
        },
      },
    },
  ];
  const [s] = await runFixture(LlmProbe, polls);
  assert.equal(s.generationTps, null);
});

test("Locals /stats: per-engine counters summed; a restart gives null, not a negative rate", async () => {
  const snaps = await runFixture(LlmProbe, NEW_ENGINES.locals);
  assert.deepEqual(snaps.map((s) => s.generationTps), [null, 40, 40]);
  assert.deepEqual(snaps.map((s) => s.prefillTps), [null, 2000, 2000]);
  assert.equal(snaps[0].totalPromptTokens, 8000);
  assert.equal(snaps[0].totalCachedTokens, 5000);

  const restarted = structuredClone(NEW_ENGINES.locals[0]);
  restarted["/stats"].json.locals = { ...restarted["/stats"].json.locals, tokens_out: 5, completion_tokens: 5, prefill_tokens: 0, prefill_s: 0 };
  const after = await runFixture(LlmProbe, [NEW_ENGINES.locals[1], restarted]);
  assert.equal(after[1].generationTps, null);
  assert.equal(after[1].prefillTps, null);
});

test("Splash: counter deltas, prompt total = computed + reused, lifetime tok/s gauges ignored", async () => {
  const snaps = await runFixture(LlmProbe, NEW_ENGINES.splash);
  assert.deepEqual(snaps.map((s) => s.generationTps), [null, 35, 35]);
  assert.deepEqual(snaps.map((s) => s.prefillTps), [null, 600, 600]);
  assert.equal(snaps[1].cachedPrefillTps, 3000);
  assert.equal(snaps[0].totalPromptTokens, 14_000);
  assert.equal(snaps[0].totalCachedTokens, 10_000);
  assert.equal(snaps[1].requestsRunning, 2);
  assert.equal(snaps[1].requestsWaiting, 2);
  assert.equal(snaps[1].ttftP95Seconds, 0.42);
  assert.equal(snaps[1].valueSources.ttftP95Seconds.source, "native");
  assert.ok(!snaps.some((s) => s.generationTps === 45.1), "lifetime gauge never shown");
});

for (const name of ["lmstudio", "ollama"]) {
  test(`${name}: passive tok/s and totals are null, not 0`, async () => {
    const snaps = await runFixture(LlmProbe, NEW_ENGINES[name]);
    for (const s of snaps) {
      for (const k of [
        "generationTps",
        "prefillTps",
        "totalOutputTokens",
        "totalPromptTokens",
        "totalCachedTokens",
        "engineDecodeTps",
        "kvCacheUsage",
      ]) {
        assert.equal(s[k], null, `${name} ${k}`);
      }
      assert.deepEqual(s.valueSources, {});
    }
  });
}

test("LM Studio: loaded model and its loaded context; embeddings skipped", async () => {
  const [s] = await runFixture(LlmProbe, NEW_ENGINES.lmstudio);
  assert.equal(s.modelId, "qwen3-8b");
  assert.equal(s.contextLength, 16384);
  assert.deepEqual(s.installedModels, ["text-embedding-nomic", "qwen3-8b"]);
});

test("Ollama: installed + loaded model from /api/tags and /api/ps", async () => {
  const [s] = await runFixture(LlmProbe, NEW_ENGINES.ollama);
  assert.equal(s.modelId, "llama3.2:3b");
  assert.equal(s.contextLength, 4096);
  assert.deepEqual(s.installedModels, ["llama3.2:3b", "qwen3:8b"]);
});

// ─── Source tiers: every non-null value carries one; nulls carry none ──────

for (const [name, polls] of Object.entries({ ...LEGACY_ENGINES, ...NEW_ENGINES })) {
  test(`${name}: valueSources covers exactly the non-null sourced values`, async () => {
    const snaps = await runFixture(LlmProbe, polls);
    for (const s of snaps) {
      for (const [field, src] of Object.entries(s.valueSources)) {
        assert.notEqual(s[field], null, `${field} has a source but no value`);
        assert.ok(["counter", "native", "proxy", "client"].includes(src.source));
        assert.equal(typeof src.approximate, "boolean");
        assert.ok(src.windowS === null || src.windowS > 0);
      }
      for (const field of ["generationTps", "prefillTps", "totalPromptTokens", "totalCachedTokens", "totalOutputTokens"]) {
        if (s[field] != null) assert.ok(s.valueSources[field], `${name} ${field} lacks a source`);
      }
    }
  });
}

test("cached never exceeds prompt", async () => {
  for (const polls of Object.values({ ...LEGACY_ENGINES, ...NEW_ENGINES })) {
    for (const s of await runFixture(LlmProbe, polls)) {
      if (s.totalCachedTokens != null && s.totalPromptTokens != null) {
        assert.ok(s.totalCachedTokens <= s.totalPromptTokens);
      }
    }
  }
});

test("unreachable probe: STAT1 fields are null", async () => {
  const probe = new LlmProbe({ lanIp: "127.0.0.1" }, 8888, { now: () => 1 });
  probe._fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  const s = await probe.probe();
  assert.equal(s.available, false);
  assert.equal(s.totalPromptTokens, null);
  assert.equal(s.totalCachedTokens, null);
  assert.deepEqual(s.valueSources, {});
});
