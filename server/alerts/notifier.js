// Turns an alert group into one request per channel type and delivers it.
// Delivery re-checks the outbound policy on every send, pins the socket to the
// checked address, never follows redirects and never keeps a response body.
// docs/specs/alerts.md §5. Clean-room implementation (LIC1).
import { Agent, fetch as undiciFetch } from "undici";
import { OutboundPolicyError, pinnedLookup, resolveChannelTarget } from "./outbound.js";

const MAX_LINES = 20;
const MAX_EMBEDS = 10;
const SOURCE = "sparkDash";

const RANK = { warning: 1, critical: 2 };
const TONE_STYLE = {
  critical: { word: "Critical", priority: "5", tag: "rotating_light", color: 0xdc2626 },
  warning: { word: "Warning", priority: "4", tag: "warning", color: 0xf59e0b },
  resolved: { word: "Resolved", priority: "3", tag: "white_check_mark", color: 0x16a34a },
  test: { word: "Test", priority: "3", tag: "test_tube", color: 0x6366f1 },
};

export const TEST_TITLE = `${SOURCE} test notification`;
export const TEST_TEXT = `If you can read this, the channel works. Sent from the ${SOURCE} Alerts dialog.`;

/** Compact duration: "45s", "12m", "3h 4m", "2d 5h". */
export function formatAge(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

function lineFor(alert, resolved, now) {
  if (resolved) {
    const lasted = formatAge((alert.endsAt ?? now) - alert.startsAt);
    return `RESOLVED ${alert.unitName} · ${alert.ruleName}: ${alert.summary} (lasted ${lasted})`;
  }
  return `${alert.severity.toUpperCase()} ${alert.unitName} · ${alert.ruleName}: ${alert.summary} (for ${formatAge(now - alert.startsAt)})`;
}

/** Title, tone and text lines shared by every channel type. */
export function describeGroup(group, now = Date.now()) {
  if (group?.test) return { tone: "test", title: TEST_TITLE, lines: [TEST_TEXT], firing: [], resolved: [] };
  const firing = group?.firing ?? [];
  const resolved = group?.resolved ?? [];
  let tone = "resolved";
  if (firing.length > 0) tone = firing.some((a) => a.severity === "critical") ? "critical" : "warning";

  let title;
  if (firing.length + resolved.length === 1) {
    const only = firing[0] ?? resolved[0];
    let tag;
    if (firing.length === 0) tag = "RESOLVED";
    else if (group.reminder) tag = "Still firing";
    else tag = only.severity.toUpperCase();
    title = `[${tag}] ${only.unitName}: ${only.label}`;
  } else {
    const parts = [];
    if (firing.length > 0) parts.push(`${firing.length} ${group.reminder ? "still firing" : "firing"}`);
    if (resolved.length > 0) parts.push(`${resolved.length} resolved`);
    title = `${SOURCE}: ${parts.join(", ")}`;
  }

  const all = [...firing.map((a) => lineFor(a, false, now)), ...resolved.map((a) => lineFor(a, true, now))];
  const lines = all.length > MAX_LINES ? [...all.slice(0, MAX_LINES), `+${all.length - MAX_LINES} more`] : all;
  return { tone, title, lines, firing, resolved };
}

function discordBody(d) {
  if (d.tone === "test") {
    const embeds = [{ title: d.title, description: d.lines[0], color: TONE_STYLE.test.color }];
    return { username: SOURCE, content: d.title, embeds, allowed_mentions: { parse: [] } };
  }
  const embeds = [
    ...d.firing.map((a) => ({ a, style: TONE_STYLE[a.severity] ?? TONE_STYLE.warning, at: a.startsAt })),
    ...d.resolved.map((a) => ({ a, style: TONE_STYLE.resolved, at: a.endsAt ?? a.startsAt })),
  ]
    .slice(0, MAX_EMBEDS)
    .map(({ a, style, at }) => ({
      title: `${style.word} · ${a.unitName}: ${a.label}`,
      description: a.summary,
      color: style.color,
      timestamp: iso(at),
    }));
  return { username: SOURCE, content: d.title, embeds, allowed_mentions: { parse: [] } };
}

function webhookBody(d, group, now) {
  const entry = (a, status) => ({
    status,
    severity: a.severity,
    rule: a.ruleId,
    ruleName: a.ruleName,
    unit: a.unitName,
    unitId: a.unitId,
    label: a.label,
    summary: a.summary,
    startsAt: iso(a.startsAt),
    endsAt: status === "resolved" ? iso(a.endsAt) : null,
  });
  return {
    source: SOURCE,
    status: d.tone === "test" ? "test" : d.firing.length > 0 ? "firing" : "resolved",
    severity: d.tone === "critical" || d.tone === "warning" ? d.tone : null,
    title: d.title,
    reminder: Boolean(group?.reminder),
    sentAt: iso(now),
    alerts: [...d.firing.map((a) => entry(a, "firing")), ...d.resolved.map((a) => entry(a, "resolved"))],
  };
}

/** The HTTP request a channel type expects for this group. */
export function buildRequest(channel, group, now = Date.now()) {
  const d = describeGroup(group, now);
  const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let init;
  switch (channel.type) {
    case "ntfy": {
      const style = TONE_STYLE[d.tone];
      init = {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8", Title: d.title, Priority: style.priority, Tags: style.tag },
        body: d.lines.join("\n"),
      };
      break;
    }
    case "discord":
      init = json(discordBody(d));
      break;
    case "slack":
      init = json({ text: [`*${d.title}*`, ...d.lines.map((line) => `• ${line}`)].join("\n") });
      break;
    default:
      init = json(webhookBody(d, group, now));
  }
  return { url: channel.url, init };
}

/**
 * The part of a group this channel wants: firing alerts at or above its
 * minimum, resolved ones by the highest severity they reached. null if empty.
 */
export function filterGroupForChannel(channel, group) {
  const floor = RANK[channel?.minSeverity] ?? RANK.warning;
  const firing = (group?.firing ?? []).filter((a) => (RANK[a.severity] ?? 0) >= floor);
  const resolved = (group?.resolved ?? []).filter((a) => (RANK[a.peakSeverity ?? a.severity] ?? 0) >= floor);
  if (firing.length === 0 && resolved.length === 0) return null;
  return { ...group, firing, resolved };
}

/** A fixed, body-free reason for a failed request. */
function failureReason(err, timeoutMs) {
  if (err instanceof OutboundPolicyError) return err.reason;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return `timed out after ${Math.round(timeoutMs / 1000)}s`;
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return `connection failed (${code})`;
  return "request failed";
}

export class Notifier {
  constructor({ fetchImpl = null, lookup, timeoutMs = 10_000, log = console, onResult = null, now = () => Date.now() } = {}) {
    this._now = now;
    this._fetch = fetchImpl;
    this._lookup = lookup;
    this._timeoutMs = timeoutMs;
    this._log = log;
    this._onResult = onResult;
    /** @type {Map<string, { lastSentAt: number|null, lastError: string|null, lastErrorAt: number|null }>} */
    this.status = new Map();
  }

  async _post(channel, group) {
    const target = await resolveChannelTarget(channel.url, this._lookup ? { lookup: this._lookup } : {});
    const { url, init } = buildRequest(channel, group, this._now());
    const request = { ...init, redirect: "manual", signal: AbortSignal.timeout(this._timeoutMs) };
    if (this._fetch) return this._fetch(url, request);
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup(target.addresses) } });
    try {
      const response = await undiciFetch(url, { ...request, dispatcher });
      await response.body?.cancel().catch(() => {});
      return response;
    } finally {
      dispatcher.close().catch(() => {});
    }
  }

  /** Deliver one group to one channel. Never throws. */
  async send(channel, group) {
    let result;
    try {
      const response = await this._post(channel, group);
      const code = response.status;
      if (code >= 300 && code < 400) result = { ok: false, error: `redirect not followed (HTTP ${code})` };
      else if (code < 200 || code >= 300) result = { ok: false, error: `HTTP ${code}` };
      else result = { ok: true, status: code };
    } catch (err) {
      result = { ok: false, error: failureReason(err, this._timeoutMs) };
    }

    const at = this._now();
    const previous = this.status.get(channel.id) ?? { lastSentAt: null, lastError: null, lastErrorAt: null };
    this.status.set(
      channel.id,
      result.ok
        ? { lastSentAt: at, lastError: null, lastErrorAt: previous.lastErrorAt }
        : { lastSentAt: previous.lastSentAt, lastError: result.error, lastErrorAt: at }
    );
    if (!result.ok) this._log?.warn?.(`[alerts] "${channel.name}" (${channel.type}): ${result.error}`);
    try {
      this._onResult?.({ channel, group, ok: result.ok, status: result.status, reason: result.error });
    } catch {
      // a reporting hook must not break delivery
    }
    return result;
  }

  /** Send to every enabled channel that wants part of the group, in parallel. */
  async dispatch(channels, group) {
    const jobs = [];
    for (const channel of channels ?? []) {
      if (!channel?.enabled) continue;
      const part = filterGroupForChannel(channel, group);
      if (!part) continue;
      jobs.push(this.send(channel, part).then((r) => ({ channelId: channel.id, ...r })));
    }
    return Promise.all(jobs);
  }
}
