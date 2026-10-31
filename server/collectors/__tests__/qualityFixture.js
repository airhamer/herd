/**
 * Fixture "model" for Quality bench tests and demos: an OpenAI-compatible
 * /v1/chat/completions server that answers each bench item correctly with a
 * fixed, per-item probability (hash of item id + skill seed). Fully
 * deterministic, so two runs against the same fixture give identical vectors.
 */
import http from "http";
import { buildQualityItems } from "../quality/items.js";
import { expectedText } from "../quality/scoring.js";
import { QUALITY_CATEGORY_KEYS } from "../../../src/shared/qualityBench.js";

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 1000;
}

const BY_PROMPT = new Map(buildQualityItems(QUALITY_CATEGORY_KEYS).map((it) => [it.prompt, it]));

/** Reply text for one prompt under a given skill (0–1000 ‰ of items right). */
export function fixtureReply(prompt, { skill = 700, salt = "" } = {}) {
  const item = BY_PROMPT.get(prompt);
  if (!item) return "Answer: unknown";
  const right = hash(`${salt}${item.id}`) < skill;
  if (item.score.kind === "instruction") return "ok"; // the fixture never follows format instructions
  if (!right) return "Let me think.\nAnswer: none of these";
  return `Working through it.\nAnswer: ${expectedText(item)}`;
}

/**
 * Start a fixture server on 127.0.0.1.
 * @param {{ skill?: number, salt?: string, failIds?: Set<string>, delayMs?: number }} [opts]
 * @returns {Promise<{ port: number, requests: any[], close: () => Promise<void> }>}
 */
export function startQualityFixture(opts = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      const json = JSON.parse(body || "{}");
      requests.push(json);
      const prompt = json.messages?.[0]?.content ?? "";
      const item = BY_PROMPT.get(prompt);
      if (item && opts.failIds?.has(item.id)) {
        res.writeHead(500, { "Content-Type": "text/plain" }).end("fixture failure");
        return;
      }
      const send = () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "fixture",
            model: "fixture-model",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: fixtureReply(prompt, opts) } }],
          })
        );
      };
      if (opts.delayMs) setTimeout(send, opts.delayMs);
      else send();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
