/**
 * Content-recording capture helpers (COMP2 / #118).
 *
 * Metadata is the default. Prompt/response bodies are captured only when the
 * effective policy (stricter-wins across component/node/group/route) opts in,
 * an observer is actually present, and no auth/header/key material is stored.
 */
import { resolveRecordingPolicy } from "./runtimeProfile.js";

const AUTH_HEADER_RE = /^(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)$/i;
const SECRET_KEY_RE = /(?:api[_-]?key|password|secret|token|authorization|bearer|private[_-]?key)$/i;

/** SSE comment / keepalive lines that must never become captured content. */
export function isKeepaliveLine(line) {
  const s = String(line ?? "").trim();
  if (!s) return true;
  if (s === ":") return true;
  if (s.startsWith(": ping") || s.startsWith(":ping") || s.startsWith(": keepalive") || s.startsWith(":keepalive")) {
    return true;
  }
  return false;
}

/**
 * Strip hop-by-hop and credential headers. The result must never be persisted.
 * @param {Record<string, unknown>|null|undefined} headers
 */
export function stripAuthHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (AUTH_HEADER_RE.test(k)) continue;
    if (SECRET_KEY_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * True when this header map (or any leftover object) would leak credentials.
 * Used as a persist-time assertion: captured records must not contain these.
 */
export function containsCapturedSecrets(obj, path = "") {
  if (obj == null) return null;
  if (typeof obj === "string") {
    if (/^(?:sk-|hf_|ghp_|gho_|Bearer\s)/i.test(obj.trim())) return path || "<root>";
    return null;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const hit = containsCapturedSecrets(obj[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (AUTH_HEADER_RE.test(k) || SECRET_KEY_RE.test(k)) return path ? `${path}.${k}` : k;
      const hit = containsCapturedSecrets(v, path ? `${path}.${k}` : k);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Assemble streamed SSE / NDJSON into a bounded text payload.
 * Keepalive pings are dropped. Overflow marks truncated; client/upstream
 * abort marks aborted; either implies incomplete.
 *
 * @param {Array<string|Buffer>} chunks
 * @param {{maxBytes?: number, aborted?: boolean}} [opts]
 */
export function assembleStream(chunks, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : 64 * 1024;
  const parts = [];
  let bytes = 0;
  let truncated = false;
  const raw = Array.isArray(chunks) ? chunks : [];
  for (const chunk of raw) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    for (const line of text.split(/\r?\n/)) {
      if (isKeepaliveLine(line)) continue;
      const piece = line.startsWith("data:") ? line.slice(5).trimStart() : line;
      if (!piece) continue;
      const extra = Buffer.byteLength(piece, "utf8");
      if (bytes + extra > maxBytes) {
        const remain = Math.max(0, maxBytes - bytes);
        if (remain > 0) parts.push(Buffer.from(piece, "utf8").subarray(0, remain).toString("utf8"));
        bytes = maxBytes;
        truncated = true;
        break;
      }
      parts.push(piece);
      bytes += extra;
    }
    if (truncated) break;
  }
  const aborted = Boolean(opts.aborted);
  return {
    text: parts.join("\n"),
    bytes,
    aborted,
    truncated,
    incomplete: aborted || truncated,
    keepaliveExcluded: true,
  };
}

export function extractPromptText(body, maxBytes = 64 * 1024) {
  if (body == null) return { text: null, truncated: false };
  let parsed = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return clip(body, maxBytes);
    }
  }
  if (typeof parsed === "string") return clip(parsed, maxBytes);
  if (parsed && typeof parsed === "object") {
    if (typeof parsed.prompt === "string") return clip(parsed.prompt, maxBytes);
    if (typeof parsed.input === "string") return clip(parsed.input, maxBytes);
    if (Array.isArray(parsed.messages)) {
      const joined = parsed.messages
        .map((m) => (m && typeof m.content === "string" ? m.content : ""))
        .filter(Boolean)
        .join("\n");
      return clip(joined, maxBytes);
    }
  }
  return { text: null, truncated: false };
}

export function extractResponseText(body, maxBytes = 64 * 1024) {
  if (body == null) return { text: null, truncated: false };
  if (typeof body === "string") {
    const assembled = assembleStream([body], { maxBytes });
    if (assembled.text.includes('"choices"') || assembled.text.startsWith("{")) {
      try {
        const parsed = JSON.parse(body);
        const content = parsed?.choices?.[0]?.message?.content ?? parsed?.choices?.[0]?.text ?? parsed?.output ?? null;
        if (typeof content === "string") return clip(content, maxBytes);
      } catch {
        /* streamed SSE assembled below */
      }
    }
    return { text: assembled.text || null, truncated: assembled.truncated };
  }
  if (body && typeof body === "object") {
    const content = body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.text ?? body?.output ?? null;
    if (typeof content === "string") return clip(content, maxBytes);
  }
  return { text: null, truncated: false };
}

function clip(text, maxBytes) {
  const buf = Buffer.from(String(text), "utf8");
  if (buf.length <= maxBytes) return { text: buf.toString("utf8"), truncated: false };
  return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

/**
 * Observer + policy → what the UI should show and whether bodies may be stored.
 * Policy true + no observer ⇒ "not recording / unavailable", never silent capture.
 */
export function recordingAvailability({ policy, observerPresent, levels = [] }) {
  const effective = resolveRecordingPolicy([policy, ...levels].filter(Boolean));
  const content = effective.content;
  if (!observerPresent) {
    return {
      recording: false,
      available: false,
      content: content ?? "metadata",
      effective,
      ui: "not recording / unavailable",
      reason: "observer-unavailable",
    };
  }
  if (content === "off") {
    return { recording: false, available: true, content, effective, ui: "off", reason: null };
  }
  if (content === "metadata") {
    return { recording: false, available: true, content, effective, ui: "metadata only", reason: null };
  }
  return { recording: true, available: true, content, effective, ui: "content opt-in on", reason: null };
}

export function shouldStorePrompt(content) {
  return content === "prompts" || content === "prompts+responses";
}

export function shouldStoreResponse(content) {
  return content === "prompts+responses";
}

/**
 * Stable logical request / attempt ids plus a component-variant segment.
 * @param {{componentId: string, variantId?: string|null, requestId?: string, attempt?: number}} parts
 */
export function captureIds(parts) {
  const requestId = typeof parts.requestId === "string" && parts.requestId ? parts.requestId : newId();
  const attempt = Number.isFinite(parts.attempt) && parts.attempt > 0 ? parts.attempt : 1;
  const variantId = parts.variantId || "default";
  return {
    requestId,
    attemptId: `${requestId}:${attempt}`,
    segment: `${parts.componentId}:${variantId}`,
  };
}

function newId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
