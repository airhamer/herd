import { authenticate, configuredToken } from "../auth.js";

/** Content GET and all mutations require a configured dashboard token when one is set. */
export function requireRecordingAccess(req, { content = false } = {}) {
  if (content || (req.method && req.method !== "GET" && req.method !== "HEAD")) {
    if (configuredToken()) {
      const result = authenticate(req);
      if (!result.ok) return result;
    }
  }
  return { ok: true };
}

export async function proxyAgentJson(rec, pathname, opts = {}) {
  const doFetch = typeof opts.fetchImpl === "function" ? opts.fetchImpl : fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const endpoint = (rec.endpoint || `${rec.lanIp}:${rec.agentPort}`).replace(/\/+$/, "");
  const method = opts.method || "GET";
  try {
    const upstream = await doFetch(`http://${endpoint}${pathname}`, {
      method,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await upstream.json().catch(() => null);
    if (upstream.status === 401) return { status: 401, body: body || { error: "unauthorized" } };
    if (upstream.status === 404) return { status: 404, body: body || { error: "not found" } };
    if (!upstream.ok) {
      return { status: 502, body: { error: body?.error || `Node agent responded ${upstream.status}` } };
    }
    return { status: 200, body: body ?? { ok: true } };
  } catch (err) {
    return { status: 502, body: { error: `Node agent unreachable: ${err.message}` } };
  }
}
