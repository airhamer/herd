/**
 * Tiny OpenAI-compatible SSE server for the fleet Showcase tests.
 *   usage: true   → final usage chunk (completion/prompt tokens)
 *   metrics: true → vLLM-style Prometheus counter that grows as tokens stream
 *   rejectFillFields → HTTP 400 for any request carrying ignore_eos (fill-to-max retry path)
 */
import http from "node:http";

export async function startFakeLlm({ chunks = 20, delayMs = 4, usage = true, metrics = true, rejectFillFields = false, model = "fake-model", hang = false } = {}) {
  let generated = 0;
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/metrics") {
      if (!metrics) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(`# TYPE vllm:generation_tokens_total counter\nvllm:generation_tokens_total{model_name="${model}"} ${generated}\n`);
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      return res.end();
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = JSON.parse(raw || "{}");
      requests.push(body);
      if (rejectFillFields && body.ignore_eos !== undefined) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end('{"error":"unknown field ignore_eos"}');
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let closed = false;
      res.on("close", () => (closed = true));
      if (hang) return; // never sends a token (cancel tests)
      for (let i = 0; i < chunks && !closed; i += 1) {
        res.write(`data: ${JSON.stringify({ id: "x", model, choices: [{ index: 0, delta: { content: "word " } }] })}\n\n`);
        generated += 1;
        await new Promise((r) => setTimeout(r, delayMs));
      }
      if (closed) return;
      if (usage) {
        res.write(
          `data: ${JSON.stringify({ model, usage: { prompt_tokens: 40, completion_tokens: chunks, total_tokens: 40 + chunks }, choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}\n\n`
        );
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = /** @type {any} */ (server.address()).port;
  return {
    port,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
