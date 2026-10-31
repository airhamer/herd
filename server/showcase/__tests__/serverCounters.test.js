import { test } from "node:test";
import assert from "node:assert/strict";
import { hasServerCounters, pollGenerationRate, readGeneratedTokens, SERVER_POLL_INTERVAL_MS } from "../serverCounters.js";

const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  json: async () => (typeof body === "string" ? JSON.parse(body) : body),
});

function fetchFrom(routes, seen = []) {
  return async (url, init) => {
    seen.push({ url, auth: init?.headers?.Authorization ?? null });
    const path = new URL(url).pathname;
    if (path in routes) return res(200, routes[path]);
    return res(404, "");
  };
}

test("server polling is every 400 ms; Ollama and LM Studio are client only", () => {
  assert.equal(SERVER_POLL_INTERVAL_MS, 400);
  assert.equal(hasServerCounters("ollama"), false);
  assert.equal(hasServerCounters("LMStudio"), false);
  assert.equal(hasServerCounters("lm-studio"), false);
  assert.equal(hasServerCounters("vllm"), true);
  assert.equal(hasServerCounters("llama.cpp"), true);
  assert.equal(hasServerCounters(null), true);
});

test("readGeneratedTokens: Prometheus engines through the shared counter adapter", async () => {
  const seen = [];
  const vllm = await readGeneratedTokens("http://h:1", {
    apiKey: " k ",
    fetchImpl: fetchFrom({ "/metrics": 'vllm:generation_tokens_total{model_name="m"} 1234\n' }, seen),
  });
  assert.deepEqual(vllm, { generated: 1234, engine: "vllm" });
  assert.equal(seen[0].auth, "Bearer k");
  const llama = await readGeneratedTokens("http://h:1", {
    fetchImpl: fetchFrom({ "/metrics": "llamacpp:tokens_predicted_total 77\nllamacpp:prompt_tokens_total 5\n" }),
  });
  assert.deepEqual(llama, { generated: 77, engine: "llama.cpp" });
});

test("readGeneratedTokens: EXL3 /health and SGLang server_info fallbacks", async () => {
  const exl3 = await readGeneratedTokens("http://h:1", {
    fetchImpl: fetchFrom({ "/health": { ok: true, busy: false, completion_tokens_total: 50, prompt_tokens_total: 9 } }),
  });
  assert.deepEqual(exl3, { generated: 50, engine: "exl3" });
  const sg = await readGeneratedTokens("http://h:1", { fetchImpl: fetchFrom({ "/get_server_info": { total_output_tokens: 9 } }) });
  assert.deepEqual(sg, { generated: 9, engine: "sglang" });
});

test("readGeneratedTokens: nothing answers → null (never throws)", async () => {
  assert.equal(await readGeneratedTokens("http://h:1", { fetchImpl: fetchFrom({ "/metrics": "# nothing\n" }) }), null);
  assert.equal(
    await readGeneratedTokens("http://h:1", {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    }),
    null
  );
});

test("pollGenerationRate: Δtokens / Δt, ignoring idle, resets and stale gaps", async () => {
  const values = [100, 140, 140, 220, 10, 50, null, 90];
  const times = [0, 400, 800, 1200, 1600, 2000, 2400, 20_000];
  let i = 0;
  const ctrl = new AbortController();
  const samples = [];
  const out = await pollGenerationRate({
    read: async () => {
      const v = values[i];
      if (i >= values.length - 1) ctrl.abort();
      return v == null ? null : { generated: v };
    },
    now: () => times[i++],
    wait: async () => {},
    signal: ctrl.signal,
    onSample: (s) => samples.push(s.rate),
  });
  // 100→140 in 0.4 s = 100; 140→220 = 200; reset 220→10 skipped; 10→50 = 100; 90 after a 17.6 s gap skipped.
  assert.deepEqual(samples, [100, 200, 100]);
  assert.deepEqual(out, { median: 100, max: 200, samples: 3, available: true });
});

test("pollGenerationRate: no counter → unavailable", async () => {
  const ctrl = new AbortController();
  let n = 0;
  const out = await pollGenerationRate({
    read: async () => {
      if (++n > 3) ctrl.abort();
      return null;
    },
    wait: async () => {},
    signal: ctrl.signal,
  });
  assert.deepEqual(out, { median: null, max: null, samples: 0, available: false });
});
