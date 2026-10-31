// Outbound policy for alert channel URLs: the same address rules herd applies
// to unit and LLM targets (server/validate.js isForbiddenAddress), checked when
// a channel is saved and again, against fresh DNS, on every send.
// docs/specs/alerts.md §5. Clean-room implementation (LIC1).
import dns from "node:dns";
import net from "node:net";
import { isForbiddenAddress } from "../validate.js";

/** Fixed failure texts: they never name the address or echo resolver output. */
export const POLICY_BLOCKED = "blocked: the host resolves to an address the outbound policy does not allow";
export const POLICY_UNRESOLVED = "could not resolve the channel host";

export class OutboundPolicyError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "OutboundPolicyError";
    this.reason = reason;
  }
}

const defaultLookup = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/** Host part of a channel URL without IPv6 brackets, or null when it does not parse. */
export function channelHost(url) {
  try {
    const host = new URL(url).hostname;
    return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  } catch {
    return null;
  }
}

/**
 * Why a URL can never be a channel target, before any DNS: "required",
 * "invalid", "scheme" or "forbidden" (a literal address the policy refuses).
 * null when the URL is acceptable so far.
 */
export function channelUrlProblem(url) {
  if (typeof url !== "string" || url.trim() === "") return "required";
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return "invalid";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "scheme";
  const host = channelHost(parsed.href);
  if (!host) return "invalid";
  if (net.isIP(host) && isForbiddenAddress(host)) return "forbidden";
  return null;
}

/**
 * Resolve a channel URL's host once and check every answer.
 * @returns {Promise<{ host: string, addresses: Array<{ address: string, family: number }> }>}
 * @throws {OutboundPolicyError} with POLICY_BLOCKED or POLICY_UNRESOLVED
 */
export async function resolveChannelTarget(url, { lookup = defaultLookup } = {}) {
  const host = channelHost(url);
  if (!host) throw new OutboundPolicyError(POLICY_UNRESOLVED);
  let answers;
  if (net.isIP(host)) {
    answers = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      answers = await lookup(host);
    } catch {
      throw new OutboundPolicyError(POLICY_UNRESOLVED);
    }
  }
  const list = (Array.isArray(answers) ? answers : [answers])
    .filter((a) => a && typeof a.address === "string")
    .map((a) => ({ address: a.address, family: a.family === 6 || net.isIPv6(a.address) ? 6 : 4 }));
  if (list.length === 0) throw new OutboundPolicyError(POLICY_UNRESOLVED);
  if (list.some((a) => isForbiddenAddress(a.address))) throw new OutboundPolicyError(POLICY_BLOCKED);
  return { host, addresses: list };
}

/**
 * A `lookup` for net/tls connect options that only ever answers with the
 * addresses already checked, so the socket cannot reach anything else.
 */
export function pinnedLookup(addresses) {
  const first = addresses[0];
  return (_hostname, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    const wantsAll = typeof options === "object" && options?.all;
    if (wantsAll) done(null, addresses.map((a) => ({ address: a.address, family: a.family })));
    else done(null, first.address, first.family);
  };
}
