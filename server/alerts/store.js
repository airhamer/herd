// Alert configuration: validation of what the dialog sends, the masked public
// view, and config/alerts.json (which never holds a channel URL; those live in
// the encrypted secrets store). docs/specs/alerts.md §6.
// Clean-room implementation (LIC1).
import crypto from "node:crypto";
import fs from "node:fs";
import { atomicWrite } from "../util/atomicWrite.js";
import { MAX_FOR_SEC, RULES, ruleById } from "./conditions.js";
import { channelUrlProblem } from "./outbound.js";
import { MAX_NAME_CHARS } from "./text.js";

export const CHANNEL_TYPES = Object.freeze(["ntfy", "discord", "slack", "webhook"]);
export const MAX_CHANNELS = 20;
export const REPEAT_MIN_MINUTES = 5;
export const REPEAT_MAX_MINUTES = 7 * 24 * 60;

const FILE_VERSION = 2;
const SEVERITIES = ["warning", "critical"];
const ELLIPSIS = "…";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A user-correctable problem; routes answer it as 400 { error }. */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
  }
}

const fail = (message) => {
  throw new ValidationError(message);
};
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function defaultConfig() {
  return { version: FILE_VERSION, repeatIntervalMin: 0, rules: {}, channels: [] };
}

/**
 * Enough of a URL to recognise it, never enough to use it:
 * "https://ntfy.sh/topic-1234" → "https://ntfy.sh…1234". Credentials, path
 * and query are dropped except for the last four characters.
 */
export function maskUrl(url) {
  if (typeof url !== "string" || url === "") return "";
  const tail = url.slice(-4);
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${ELLIPSIS}${tail}`;
  } catch {
    return `${ELLIPSIS}${tail}`;
  }
}

const URL_MESSAGES = {
  required: "Channel URL is required",
  invalid: "Channel URL is not a valid URL",
  scheme: "Channel URL must start with http:// or https://",
  forbidden: "Channel URL host is not allowed (same outbound policy as unit and LLM targets)",
};

/** Trimmed URL, or a ValidationError naming what is wrong with it. */
export function validateChannelUrl(url) {
  const problem = channelUrlProblem(url);
  if (problem) fail(URL_MESSAGES[problem]);
  return url.trim();
}

function cleanName(raw) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) fail("Channel name is required");
  if ([...name].length > MAX_NAME_CHARS) fail(`Channel name must be at most ${MAX_NAME_CHARS} characters`);
  return name;
}

/**
 * One channel from the dialog. A URL that is still the masked form of the
 * stored one keeps the stored URL; a masked URL with nothing behind it is
 * refused, since it cannot be delivered to.
 */
export function validateChannel(input, previous = null) {
  if (!isPlainObject(input)) fail("Each channel must be an object");
  const name = cleanName(input.name);
  if (!CHANNEL_TYPES.includes(input.type)) fail(`Channel type must be one of ${CHANNEL_TYPES.join(", ")}`);
  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== "boolean") fail("Channel enabled must be true or false");
  const minSeverity = input.minSeverity === undefined ? "warning" : input.minSeverity;
  if (!SEVERITIES.includes(minSeverity)) fail("minSeverity must be warning or critical");

  let url;
  const sent = typeof input.url === "string" ? input.url.trim() : input.url;
  if (typeof sent === "string" && sent.includes(ELLIPSIS)) {
    if (!previous?.url || sent !== maskUrl(previous.url)) fail(`${name}: the URL is masked — enter the full URL again`);
    url = previous.url;
  } else {
    url = validateChannelUrl(sent);
  }

  const id = typeof input.id === "string" && ID_PATTERN.test(input.id) ? input.id : `ch_${crypto.randomBytes(6).toString("hex")}`;
  return { id, name, type: input.type, url, enabled, minSeverity };
}

function validateRules(input) {
  if (input === null || input === undefined) return {};
  if (!isPlainObject(input)) fail("rules must be an object");
  const out = {};
  for (const [id, value] of Object.entries(input)) {
    const rule = ruleById(id);
    if (!rule) fail(`Unknown alert rule ${id}`);
    if (value === null || value === undefined) continue;
    if (!isPlainObject(value)) fail(`${rule.name}: settings must be an object`);
    const entry = {};
    for (const [key, setting] of Object.entries(value)) {
      if (key === "enabled") {
        if (typeof setting !== "boolean") fail(`${rule.name}: enabled must be true or false`);
        entry.enabled = setting;
      } else if (key === "forSec") {
        const seconds = typeof setting === "string" && setting.trim() !== "" ? Number(setting) : setting;
        if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > MAX_FOR_SEC) {
          fail(`${rule.name}: duration must be between 0 and ${MAX_FOR_SEC}`);
        }
        entry.forSec = Math.round(seconds);
      } else {
        fail(`${rule.name}: unknown setting ${key}`);
      }
    }
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  return out;
}

function validateRepeat(value) {
  const minutes = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof minutes !== "number" || Number.isNaN(minutes)) fail("Repeat interval must be a number");
  if (minutes < 0 || minutes > REPEAT_MAX_MINUTES) fail(`Repeat interval must be between 0 and ${REPEAT_MAX_MINUTES}`);
  if (minutes !== 0 && (minutes < REPEAT_MIN_MINUTES || !Number.isInteger(minutes))) {
    fail(`Repeat interval must be 0 (off) or at least ${REPEAT_MIN_MINUTES} minutes`);
  }
  return minutes;
}

/**
 * The next configuration from a (partial) update. Sections that are left out
 * keep their previous value; unknown top-level keys are ignored.
 */
export function validateConfig(input, previous = defaultConfig()) {
  const base = previous ?? defaultConfig();
  const update = isPlainObject(input) ? input : {};
  const next = {
    version: FILE_VERSION,
    repeatIntervalMin: base.repeatIntervalMin ?? 0,
    rules: { ...(base.rules ?? {}) },
    channels: [...(base.channels ?? [])],
  };
  if ("repeatIntervalMin" in update) next.repeatIntervalMin = validateRepeat(update.repeatIntervalMin);
  if ("rules" in update) next.rules = validateRules(update.rules);
  if ("channels" in update) {
    if (!Array.isArray(update.channels)) fail("channels must be an array");
    if (update.channels.length > MAX_CHANNELS) fail(`At most ${MAX_CHANNELS} channels`);
    const known = new Map((base.channels ?? []).map((c) => [c.id, c]));
    const seen = new Set();
    next.channels = update.channels.map((raw) => {
      const channel = validateChannel(raw, isPlainObject(raw) ? known.get(raw.id) : null);
      if (seen.has(channel.id)) fail(`Duplicate channel id ${channel.id}`);
      seen.add(channel.id);
      return channel;
    });
  }
  return next;
}

const NO_STATUS = Object.freeze({ lastSentAt: null, lastError: null, lastErrorAt: null });

/** What GET /api/alerts/config shows: rule catalogue with overrides, masked channels. */
export function publicConfig(config, status = new Map()) {
  const overrides = config?.rules ?? {};
  return {
    repeatIntervalMin: config?.repeatIntervalMin ?? 0,
    rules: RULES.map((rule) => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      source: rule.source,
      defaults: { ...rule.defaults },
      overrides: { ...(overrides[rule.id] ?? {}) },
    })),
    channels: (config?.channels ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      url: maskUrl(c.url),
      hasUrl: Boolean(c.url),
      enabled: c.enabled,
      minSeverity: c.minSeverity,
      status: { ...(status.get(c.id) ?? NO_STATUS) },
    })),
  };
}

/** Rebuild a stored channel; null when it is not usable. */
function storedChannel(raw) {
  if (!isPlainObject(raw) || typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) return null;
  if (typeof raw.name !== "string" || !raw.name.trim() || !CHANNEL_TYPES.includes(raw.type)) return null;
  return {
    id: raw.id,
    name: raw.name.trim().slice(0, 200),
    type: raw.type,
    url: "",
    enabled: raw.enabled !== false,
    minSeverity: SEVERITIES.includes(raw.minSeverity) ? raw.minSeverity : "warning",
  };
}

/** Keep only overrides for rules that still exist and values that still validate. */
function storedRules(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!ruleById(id) || !isPlainObject(value)) continue;
    const entry = {};
    if (typeof value.enabled === "boolean") entry.enabled = value.enabled;
    if (Number.isFinite(value.forSec) && value.forSec >= 0 && value.forSec <= MAX_FOR_SEC) entry.forSec = Math.round(value.forSec);
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  return out;
}

/**
 * Read alerts.json. Missing or unreadable → defaults. A plaintext `url` left
 * by an earlier build is returned in `legacyUrls` (if the policy allows it) so
 * the caller can move it into the secrets store.
 * @returns {{ config: object, legacyUrls: Map<string, string>, state: object|null }}
 */
export function loadAlertsFile(file, log = console) {
  const legacyUrls = new Map();
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err?.code !== "ENOENT") log?.warn?.(`[alerts] ${file} is unreadable; starting from defaults`);
    return { config: defaultConfig(), legacyUrls, state: null };
  }
  if (!isPlainObject(doc)) return { config: defaultConfig(), legacyUrls, state: null };

  const config = defaultConfig();
  const repeat = doc.repeatIntervalMin;
  if (repeat === 0 || (Number.isInteger(repeat) && repeat >= REPEAT_MIN_MINUTES && repeat <= REPEAT_MAX_MINUTES)) {
    config.repeatIntervalMin = repeat;
  }
  config.rules = storedRules(doc.rules);
  const seen = new Set();
  for (const raw of Array.isArray(doc.channels) ? doc.channels.slice(0, MAX_CHANNELS) : []) {
    const channel = storedChannel(raw);
    if (!channel || seen.has(channel.id)) continue;
    seen.add(channel.id);
    config.channels.push(channel);
    if (typeof raw.url === "string" && raw.url && channelUrlProblem(raw.url) === null) {
      legacyUrls.set(channel.id, raw.url.trim());
    }
  }
  return { config, legacyUrls, state: isPlainObject(doc.state) ? doc.state : null };
}

/** Write alerts.json (0600). Channel URLs are left out on purpose. */
export function saveAlertsFile(file, config, state) {
  const doc = {
    version: FILE_VERSION,
    repeatIntervalMin: config.repeatIntervalMin ?? 0,
    rules: config.rules ?? {},
    channels: (config.channels ?? []).map(({ id, name, type, enabled, minSeverity }) => ({ id, name, type, enabled, minSeverity })),
    state: state ?? null,
  };
  atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`, 0o600);
}
