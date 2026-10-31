/**
 * Streaming OpenAI-compatible fixture for decode-bench tests and demos:
 * every /v1/chat/completions request streams `tokens` content chunks
 * `tokenMs` apart after `ttftMs`, then a usage chunk; a request without
 * `stream: true` gets one JSON reply after the same time. Request bodies are
 * recorded so tests can assert exactly what was sent.
 */
import http from "http";

/**
 * @param {{ tokens?: number, tokenMs?: number, ttftMs?: number, model?: string, failEvery?: number }} [opts]
 * @returns {Promise<{ port: number, requests: any[], close: () => Promise<void> }>}
 */
export function startSseFixture(opts = {}) {
  const { tokens = 8, tokenMs = 2, ttftMs = 2, model = "fixture-model", failEvery = 0 } = opts;
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: model }] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* recorded as null */
      }
      requests.push(body);
      if (failEvery > 0 && requests.length % failEvery === 0) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "fixture failure" } }));
        return;
      }
      if (body && body.stream !== true) {
        // Non-streamed completion (Hasso bench-matrix.sh): same timing, one JSON reply.
        const n = Math.min(tokens, body.max_tokens ?? tokens);
        await new Promise((r) => setTimeout(r, ttftMs + Math.max(0, n - 1) * tokenMs));
        const prompt = String(body.messages?.[0]?.content ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "x",
            model,
            choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "t ".repeat(n) } }],
            usage: { prompt_tokens: Math.max(1, Math.round(prompt.length / 4)), completion_tokens: n },
          })
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await sleep(ttftMs);
      const n = Math.min(tokens, body?.max_tokens ?? tokens);
      for (let i = 0; i < n; i++) {
        if (i > 0) await sleep(tokenMs);
        send({ id: "x", model, choices: [{ index: 0, delta: { content: ` t${i}` } }] });
      }
      const prompt = String(body?.messages?.[0]?.content ?? "");
      send({
        id: "x",
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "length" }],
        usage: { prompt_tokens: Math.max(1, Math.round(prompt.length / 4)), completion_tokens: n },
      });
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = /** @type {import("net").AddressInfo} */ (server.address());
      resolve({
        port: addr.port,
        requests,
        close: () => new Promise((r) => server.close(() => r(undefined))),
      });
    });
  });
}
