// Wires alerts into the server: one runtime owning the config, the engine and
// the notifier, gated by Settings → alertsEnabled, plus the /api/alerts routes.
// docs/specs/alerts.md §8. Clean-room implementation (LIC1).
import { loadAlertChannelUrls, saveAlertChannelUrls } from "../secretsStore.js";
import { activity } from "../events/activity.js";
import { AlertEngine } from "./engine.js";
import { Notifier } from "./notifier.js";
import { OutboundPolicyError, POLICY_BLOCKED, resolveChannelTarget } from "./outbound.js";
import { loadAlertsFile, publicConfig, saveAlertsFile, validateChannel, validateConfig } from "./store.js";
import { MAX_NAME_CHARS, capText } from "./text.js";

export const ALERTS_OFF_MESSAGE = "Alerts are off. Turn them on in Settings → Alerts first.";

/** Seconds between two test sends to the same channel. */
const TEST_SPACING_MS = 5_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function countText(firing, resolved) {
  const parts = [];
  if (firing > 0) parts.push(`${firing} firing`);
  if (resolved > 0) parts.push(`${resolved} resolved`);
  return parts.join(", ");
}

/**
 * The Activity event for one delivery attempt. It names the channel and the
 * alerts, never a URL or anything the receiver answered.
 */
export function notificationEvent({ channel, group, ok, status, reason, test = false }) {
  const firing = group?.firing ?? [];
  const resolved = group?.resolved ?? [];
  const isTest = Boolean(test || group?.test);
  const reminder = Boolean(group?.reminder);
  const all = [...firing, ...resolved];
  const units = new Set(all.map((a) => a.unitId));
  const unit = units.size === 1 ? all[0] : null;

  const who = `"${capText(channel?.name ?? "", MAX_NAME_CHARS)}" (${channel?.type})`;
  let message;
  if (isTest) {
    message = ok ? `Test notification sent to ${who}` : `Test notification to ${who} failed: ${reason}`;
  } else {
    const kind = reminder ? "Alert reminder" : "Alert notification";
    let what;
    if (all.length === 1) {
      const sev = firing.length === 1 ? firing[0].severity : "resolved";
      what = `${sev} · ${all[0].unitName} ${all[0].label}`;
    } else {
      what = countText(firing.length, resolved.length);
    }
    message = ok ? `${kind} sent to ${who}: ${what}` : `${kind} to ${who} failed: ${reason}: ${what}`;
  }

  const data = {
    channelId: channel?.id,
    channelType: channel?.type,
    test: isTest,
    reminder,
    firing: firing.length,
    resolved: resolved.length,
  };
  if (ok) {
    if (status !== undefined) data.status = status;
  } else {
    data.reason = reason;
  }
  return {
    type: ok ? "alert.notify.sent" : "alert.notify.failed",
    severity: ok ? "info" : "error",
    sparkId: unit ? unit.unitId : null,
    sparkName: unit ? unit.unitName : null,
    message,
    data,
  };
}

const noSecrets = { load: loadAlertChannelUrls, save: saveAlertChannelUrls };

export function createAlertsRuntime({
  filePath,
  isEnabled = () => false,
  now = () => Date.now(),
  fetchImpl = null,
  lookup = null,
  log = console,
  secrets = noSecrets,
  recordEvent = () => {},
} = {}) {
  const enabled = () => Boolean(isEnabled());
  const lookupOpts = lookup ? { lookup } : {};
  const lastTestAt = new Map();

  // Load the file, then put each channel's URL back from the secrets store,
  // moving any plaintext URL an earlier build left in alerts.json.
  const loaded = loadAlertsFile(filePath, log);
  let config = loaded.config;
  const urls = (() => {
    try {
      return secrets.load() ?? new Map();
    } catch (err) {
      log?.error?.(`[alerts] could not read channel URLs: ${err?.message ?? err}`);
      return new Map();
    }
  })();
  if (loaded.legacyUrls.size > 0) {
    for (const [id, url] of loaded.legacyUrls) if (!urls.has(id)) urls.set(id, url);
    try {
      secrets.save(urls);
      saveAlertsFile(filePath, config, loaded.state);
      log?.log?.(`[alerts] moved ${loaded.legacyUrls.size} channel URL(s) into the encrypted secrets store`);
    } catch (err) {
      log?.error?.(`[alerts] could not migrate channel URLs: ${err?.message ?? err}`);
    }
  }
  config = { ...config, channels: config.channels.map((c) => ({ ...c, url: urls.get(c.id) ?? "" })) };

  const report = (event) => {
    try {
      recordEvent(event);
    } catch {
      // Activity is best effort
    }
  };

  const notifier = new Notifier({
    fetchImpl,
    lookup: lookup ?? undefined,
    log,
    now,
    onResult: ({ channel, group, ok, status, reason }) => report(notificationEvent({ channel, group, ok, status, reason })),
  });

  // The firing set saved by the last process; adopted once, the first time alerts are on.
  let pendingState = loaded.state;
  const engine = new AlertEngine({
    now,
    log,
    notifier,
    getConfig: () => config,
    persistState: (state) => saveAlertsFile(filePath, config, state),
    onTransition: ({ firing, resolved }) => {
      for (const a of firing) report(activity.alertFired(a));
      for (const a of resolved) report(activity.alertResolved(a));
    },
  });

  let wasOn = false;
  function syncOnOff() {
    const on = enabled();
    if (on && !wasOn && pendingState) {
      engine.restore(pendingState);
      pendingState = null;
    }
    if (!on && wasOn) engine.reset();
    wasOn = on;
    return on;
  }

  function requireOn() {
    if (!enabled()) throw new HttpError(409, ALERTS_OFF_MESSAGE);
  }

  /** Refuse a channel whose host currently resolves somewhere the policy forbids. */
  async function checkResolvedHost(channel) {
    try {
      await resolveChannelTarget(channel.url, lookupOpts);
    } catch (err) {
      if (err instanceof OutboundPolicyError && err.reason === POLICY_BLOCKED) {
        throw new HttpError(400, `${channel.name}: ${POLICY_BLOCKED}`);
      }
      // Unresolvable now is fine; every send resolves again.
    }
  }

  return {
    engine,
    notifier,

    start() {
      syncOnOff();
    },

    tick(units) {
      if (!syncOnOff()) return;
      engine.evaluate(Array.isArray(units) ? units : []);
    },

    snapshotBlock() {
      return enabled() ? { active: engine.active() } : null;
    },

    status() {
      const on = enabled();
      return { enabled: on, active: on ? engine.active() : [], pending: on ? engine.pending() : [], recent: engine.recent() };
    },

    publicConfig() {
      return { enabled: enabled(), ...publicConfig(config, notifier.status) };
    },

    async updateConfig(update) {
      requireOn();
      const next = validateConfig(update, config);
      for (const channel of next.channels) await checkResolvedHost(channel);
      secrets.save(new Map(next.channels.filter((c) => c.url).map((c) => [c.id, c.url])));
      config = next;
      saveAlertsFile(filePath, config, engine.stateForSave());
      for (const id of [...notifier.status.keys()]) {
        if (!config.channels.some((c) => c.id === id)) notifier.status.delete(id);
      }
      return this.publicConfig();
    },

    /** Send a one-line test to a saved channel or to a draft from the dialog. */
    async test(body) {
      requireOn();
      const channelId = typeof body?.channelId === "string" ? body.channelId : null;
      const saved = channelId ? config.channels.find((c) => c.id === channelId) : null;
      let channel;
      if (body?.channel && typeof body.channel === "object") {
        const draft = validateChannel({ ...body.channel, id: saved?.id }, saved);
        channel = { ...draft, id: saved ? saved.id : "draft" };
      } else if (saved) {
        channel = saved;
      } else {
        throw new HttpError(404, "Unknown channel");
      }
      if (!channel.url) throw new HttpError(404, "Unknown channel");

      const at = now();
      const previous = lastTestAt.get(channel.id);
      if (previous !== undefined && at - previous < TEST_SPACING_MS) {
        return { ok: false, error: "Wait a moment before sending another test", rateLimited: true };
      }
      lastTestAt.set(channel.id, at);

      const result = await notifier.send(channel, { test: true, firing: [], resolved: [], reminder: false });
      return result.ok ? { ok: true, status: result.status } : { ok: false, error: result.error };
    },
  };
}

/** GET /api/alerts, GET|PUT /api/alerts/config, POST /api/alerts/test. */
export function registerAlertRoutes(app, runtime) {
  const failWith = (res, err, fallback, extra = {}) => {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({ ...extra, error: status === 500 ? fallback : err.message });
  };

  app.get("/api/alerts", (_req, res) => res.json(runtime.status()));
  app.get("/api/alerts/config", (_req, res) => res.json(runtime.publicConfig()));

  app.put("/api/alerts/config", async (req, res) => {
    try {
      res.json(await runtime.updateConfig(req.body));
    } catch (err) {
      failWith(res, err, "Could not save the alert settings");
    }
  });

  app.post("/api/alerts/test", async (req, res) => {
    try {
      const result = await runtime.test(req.body);
      res.status(result.rateLimited ? 429 : 200).json(result);
    } catch (err) {
      failWith(res, err, "Test failed", { ok: false });
    }
  });
}
