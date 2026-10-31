import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchAlerts, fetchAlertsConfig, testAlertChannel, updateAlertsConfig, updateSettings } from "../api/client";
import type { AlertChannel, AlertChannelType, AlertEvent, AlertInstance, AlertRule, AlertsConfig, AlertSeverity, Settings } from "../api/types";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useModalPresence } from "../hooks/useModalPresence";
import { formatSince } from "../shared/formatSince";
import { PlusIcon, XIcon } from "./ui/icons";
import { SettingRow, Switch, ToggleRow } from "./SettingRows";
import "../styles/dialogs.css";

/*
 * Settings → Alert notifications → Configure…
 *
 * The master switch is a server setting (`alertsEnabled`) and is saved the
 * moment it is clicked. Everything else (rules, channels, reminders) is a
 * draft until Save, and can only be edited while the switch is on.
 */

const TYPE_INFO: Record<AlertChannelType, { label: string; example: string }> = {
  ntfy: { label: "ntfy", example: "https://ntfy.sh/my-topic (or a LAN ntfy, e.g. http://10.0.0.5/alerts)" },
  discord: { label: "Discord", example: "https://discord.com/api/webhooks/…" },
  slack: { label: "Slack", example: "https://hooks.slack.com/services/…" },
  webhook: { label: "Webhook (JSON)", example: "https://example.org/hooks/herd" },
};
const TYPE_ORDER: AlertChannelType[] = ["ntfy", "discord", "slack", "webhook"];

const REMINDERS: Array<[minutes: number, label: string]> = [
  [0, "Off"],
  [60, "Every hour"],
  [240, "Every 4 hours"],
  [720, "Every 12 hours"],
  [1440, "Every day"],
];

const GROUPS: Array<{ source: AlertRule["source"]; title: string; note: string }> = [
  { source: "strip", title: "Overview exceptions", note: "Same conditions as the exceptions strip on the Overview page." },
  { source: "health", title: "Health findings", note: "Findings from the unit cards, using the thresholds set in the Health rules." },
];

const STATUS_POLL_MS = 10_000;

/** A rule as edited: the wait stays text so partial input survives re-renders. */
interface RuleEdit {
  enabled: boolean;
  wait: string;
}
interface TestOutcome {
  busy: boolean;
  ok?: boolean;
  text?: string;
}
type Draft = { rules: Record<string, RuleEdit>; channels: AlertChannel[]; repeat: number };

const effective = (rule: AlertRule): RuleEdit => ({
  enabled: rule.overrides.enabled ?? rule.defaults.enabled,
  wait: String(rule.overrides.forSec ?? rule.defaults.forSec),
});

function draftOf(config: AlertsConfig): Draft {
  const rules: Record<string, RuleEdit> = {};
  for (const rule of config.rules) rules[rule.id] = effective(rule);
  return { rules, channels: config.channels.map((c) => ({ ...c })), repeat: config.repeatIntervalMin };
}

/** Rule values to PUT: only what now differs from the defaults. Throws on a non-numeric wait. */
function ruleChanges(rules: AlertRule[], edits: Record<string, RuleEdit>): Record<string, { enabled?: boolean; forSec?: number }> {
  const out: Record<string, { enabled?: boolean; forSec?: number }> = {};
  for (const rule of rules) {
    const edit = edits[rule.id] ?? effective(rule);
    const text = edit.wait.trim();
    const forSec = text === "" ? NaN : Number(text);
    if (!Number.isFinite(forSec)) throw new Error(`${rule.name}: enter the wait in seconds`);
    const change: { enabled?: boolean; forSec?: number } = {};
    if (edit.enabled !== rule.defaults.enabled) change.enabled = edit.enabled;
    if (forSec !== rule.defaults.forSec) change.forSec = forSec;
    if (change.enabled !== undefined || change.forSec !== undefined) out[rule.id] = change;
  }
  return out;
}

/** A channel as the server accepts it: no read-only fields, trimmed text. */
function channelForSave(channel: AlertChannel): AlertChannel {
  const { status: _s, hasUrl: _h, ...rest } = channel;
  return { ...rest, name: rest.name.trim(), url: rest.url.trim() };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const toneOf = (severity: AlertSeverity) => (severity === "critical" ? "critical" : "warning");

export function AlertsDialog({
  open,
  onClose,
  onSettingsSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after the master switch is saved, so Settings can reflect it without becoming dirty. */
  onSettingsSaved: (settings: Settings) => void;
}) {
  const headingId = useId();
  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);

  const [config, setConfig] = useState<AlertsConfig | null>(null);
  const [draft, setDraft] = useState<Draft>({ rules: {}, channels: [], repeat: 0 });
  const [enabled, setEnabled] = useState(false);
  const [feeds, setFeeds] = useState<{ active: AlertInstance[]; recent: AlertEvent[]; at: number }>({ active: [], recent: [], at: Date.now() });
  const [tests, setTests] = useState<Map<AlertChannel, TestOutcome>>(new Map());
  const [busy, setBusy] = useState<"load" | "save" | "switch" | null>(null);
  const [changed, setChanged] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback((c: AlertsConfig) => {
    setConfig(c);
    setEnabled(c.enabled);
    setDraft(draftOf(c));
    setTests(new Map());
    setChanged(false);
  }, []);

  const refreshFeeds = useCallback(() => {
    fetchAlerts().then(
      (r) => setFeeds({ active: r.active, recent: r.recent, at: Date.now() }),
      () => {
        /* optional extras; config errors are what we report */
      }
    );
  }, []);

  // Load when opened, reset when closed.
  useEffect(() => {
    if (!open) {
      setConfig(null);
      setError(null);
      setJustSaved(false);
      setTests(new Map());
      return;
    }
    let live = true;
    setBusy("load");
    fetchAlertsConfig()
      .then((c) => live && adopt(c))
      .catch((err) => live && setError(message(err)))
      .finally(() => live && setBusy(null));
    refreshFeeds();
    const poll = window.setInterval(refreshFeeds, STATUS_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(poll);
    };
  }, [open, adopt, refreshFeeds]);

  // Escape closes this dialog only: handled in the capture phase and stopped
  // there, so the Settings dialog below never sees it.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const edit = (update: (d: Draft) => Draft) => {
    setDraft(update);
    setChanged(true);
    setJustSaved(false);
  };
  const editRule = (id: string, patch: Partial<RuleEdit>) => edit((d) => ({ ...d, rules: { ...d.rules, [id]: { ...d.rules[id], ...patch } } }));
  const editChannel = (target: AlertChannel, patch: Partial<AlertChannel>) =>
    edit((d) => ({ ...d, channels: d.channels.map((c) => (c === target ? { ...c, ...patch } : c)) }));

  const flipMaster = async () => {
    setBusy("switch");
    setError(null);
    try {
      const saved = await updateSettings({ alertsEnabled: !enabled });
      setEnabled(saved.alertsEnabled === true);
      onSettingsSaved(saved);
      refreshFeeds();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  };

  const runTest = async (channel: AlertChannel) => {
    const mark = (outcome: TestOutcome) => setTests((prev) => new Map(prev).set(channel, outcome));
    mark({ busy: true });
    try {
      const result = await testAlertChannel(channel.id, {
        name: channel.name.trim() || "Test",
        type: channel.type,
        url: channel.url,
        enabled: true,
        minSeverity: channel.minSeverity,
      });
      mark({ busy: false, ok: result.ok, text: result.ok ? "Sent" : (result.error ?? "Failed") });
    } catch (err) {
      mark({ busy: false, ok: false, text: message(err) });
    }
    refreshFeeds();
  };

  const save = async () => {
    if (!config) return;
    setBusy("save");
    setError(null);
    try {
      const next = await updateAlertsConfig({
        rules: ruleChanges(config.rules, draft.rules),
        channels: draft.channels.map(channelForSave),
        repeatIntervalMin: draft.repeat,
      });
      adopt(next);
      setJustSaved(true);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  };

  if (!mounted) return null;

  const reminderChoices = REMINDERS.some(([m]) => m === draft.repeat) ? REMINDERS : [...REMINDERS, [draft.repeat, `Every ${draft.repeat} min`] as [number, string]];

  return createPortal(
    <div className={visible ? "modal-overlay is-open" : "modal-overlay"} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={trapRef} role="dialog" aria-modal="true" aria-labelledby={headingId} className="modal-sheet modal-sheet--wide">
        <div className="modal-sheet__header">
          <h2 id={headingId} className="modal-sheet__title">
            Alert notifications
          </h2>
          <button type="button" aria-label="Close" className="modal-sheet__close" onClick={onClose}>
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="modal-sheet__body">
          {busy === "load" ? <p className="bench-sheet__hint">Loading…</p> : null}
          {config && busy !== "load" ? (
            <>
              <ToggleRow
                title="Send notifications"
                help="When on, the server evaluates Health findings and Overview exceptions and messages the channels below once a condition has lasted its wait time, and again when it clears. Off by default; while off nothing is checked or sent. This switch saves immediately."
                checked={enabled}
                disabled={busy === "switch"}
                onChange={() => void flipMaster()}
              />

              {enabled && feeds.active.length > 0 ? (
                <section className="al-group" aria-label="Firing now">
                  <h3>Firing now · {feeds.active.length}</h3>
                  <ul className="al-feed">
                    {feeds.active.map((a) => (
                      <li key={a.key} data-tone={toneOf(a.severity)}>
                        <b>{a.unitName}</b> {a.label} · {formatSince(a.startsAt, feeds.at) ?? "now"}
                        <small>{a.summary}</small>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {enabled ? null : <p className="modal-sheet__lead al-hint">Switch notifications on to edit rules, channels and reminders.</p>}

              <fieldset className="al-locked" disabled={!enabled}>
                {GROUPS.map((group) => (
                  <section key={group.source} className="al-group" aria-label={group.title}>
                    <h3>{group.title}</h3>
                    <p className="al-group__note">{group.note}</p>
                    {config.rules
                      .filter((rule) => rule.source === group.source)
                      .map((rule) => (
                        <RuleRow key={rule.id} rule={rule} value={draft.rules[rule.id] ?? effective(rule)} onChange={(patch) => editRule(rule.id, patch)} />
                      ))}
                  </section>
                ))}

                <section className="al-group" aria-label="Channels">
                  <header>
                    <h3>Channels</h3>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => edit((d) => ({ ...d, channels: [...d.channels, { name: "", type: "ntfy", url: "", enabled: true, minSeverity: "warning" }] }))}
                    >
                      <PlusIcon className="h-3.5 w-3.5" />
                      Add channel
                    </button>
                  </header>
                  <p className="al-group__note">
                    Channel URLs are kept encrypted alongside the unit passwords and only shown masked. LAN targets (such as a self-hosted ntfy) and internet targets are allowed under the same address rules as units and LLM endpoints. Redirects are never followed.
                  </p>
                  {draft.channels.length === 0 ? <p className="al-group__note">No channels configured; alerts still appear in the Overview strip.</p> : null}
                  {draft.channels.map((channel, index) => (
                    <ChannelCard
                      key={channel.id ?? `draft-${index}`}
                      channel={channel}
                      index={index}
                      test={tests.get(channel)}
                      onChange={(patch) => editChannel(channel, patch)}
                      onTest={() => void runTest(channel)}
                      onRemove={() => edit((d) => ({ ...d, channels: d.channels.filter((c) => c !== channel) }))}
                    />
                  ))}
                </section>

                <SettingRow title="Remind while still firing" help="Send the alert again at this interval for as long as it has not cleared." htmlFor="alerts-repeat">
                  <select id="alerts-repeat" value={draft.repeat} onChange={(e) => edit((d) => ({ ...d, repeat: Number(e.target.value) }))}>
                    {reminderChoices.map(([minutes, label]) => (
                      <option key={minutes} value={minutes}>
                        {label}
                      </option>
                    ))}
                  </select>
                </SettingRow>
              </fieldset>

              <RecentFeed events={feeds.recent} now={feeds.at} />
            </>
          ) : null}
        </div>

        {error ? (
          <div role="alert" className="modal-sheet__error al-error">
            {error}
          </div>
        ) : null}

        <div className="modal-sheet__footer">
          <span role="status" className="field-hint">
            {justSaved ? "Saved" : changed ? "Unsaved changes" : ""}
          </span>
          <div className="modal-sheet__footer-actions">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Close
            </button>
            <button type="button" className="btn btn--primary" disabled={!config || !enabled || !changed || busy === "save"} onClick={() => void save()}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function RuleRow({ rule, value, onChange }: { rule: AlertRule; value: RuleEdit; onChange: (patch: Partial<RuleEdit>) => void }) {
  return (
    <div data-rule={rule.id}>
      <ToggleRow title={rule.name} help={rule.description} label={`${rule.name} notifications`} checked={value.enabled} onChange={(on) => onChange({ enabled: on })}>
        <label className="al-wait">
          after
          <input
            type="number"
            className="field-input"
            min={0}
            step={1}
            aria-label={`${rule.name} wait (seconds)`}
            value={value.wait}
            onChange={(e) => onChange({ wait: e.target.value })}
          />
          s
        </label>
      </ToggleRow>
    </div>
  );
}

function ChannelCard({
  channel,
  index,
  test,
  onChange,
  onTest,
  onRemove,
}: {
  channel: AlertChannel;
  index: number;
  test: TestOutcome | undefined;
  onChange: (patch: Partial<AlertChannel>) => void;
  onTest: () => void;
  onRemove: () => void;
}) {
  const stored = channel.id !== undefined;
  const lastError = channel.status?.lastError;
  const showResult = test !== undefined && !test.busy && test.text;
  return (
    <div className="al-channel" data-channel={index}>
      <div className="al-channel__line">
        <input
          type="text"
          className="field-input al-grow"
          aria-label="Channel name"
          placeholder="Name"
          maxLength={60}
          value={channel.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <select aria-label="Channel type" value={channel.type} onChange={(e) => onChange({ type: e.target.value as AlertChannelType })}>
          {TYPE_ORDER.map((type) => (
            <option key={type} value={type}>
              {TYPE_INFO[type].label}
            </option>
          ))}
        </select>
        <select aria-label="Minimum severity" value={channel.minSeverity} onChange={(e) => onChange({ minSeverity: e.target.value as AlertSeverity })}>
          <option value="warning">Warning and up</option>
          <option value="critical">Critical only</option>
        </select>
        <Switch label={`Channel ${channel.name || index + 1} enabled`} checked={channel.enabled} onChange={(on) => onChange({ enabled: on })} />
      </div>
      <input
        type="text"
        className="field-input field-input--mono"
        aria-label="Channel URL"
        placeholder={(TYPE_INFO[channel.type] ?? TYPE_INFO.ntfy).example}
        spellCheck={false}
        autoComplete="off"
        value={channel.url}
        onChange={(e) => onChange({ url: e.target.value })}
      />
      {stored && channel.url.includes("…") ? <p className="field-hint">The saved URL is hidden. Keep it as is, or paste a replacement.</p> : null}
      {stored && channel.url === "" && channel.hasUrl === false ? <p className="field-hint is-warn">This channel has no saved URL; please enter it again.</p> : null}
      <div className="al-channel__line">
        <button type="button" className="btn btn--sm" disabled={channel.url.trim() === "" || test?.busy === true} onClick={onTest}>
          {test?.busy ? "Sending…" : "Send test"}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onRemove}>
          Remove
        </button>
        {showResult ? (
          <span role="status" className={test.ok ? "field-hint is-ok" : "field-hint is-warn"}>
            {test.text}
          </span>
        ) : lastError ? (
          <span className="field-hint is-warn" title={channel.status?.lastErrorAt ? new Date(channel.status.lastErrorAt).toLocaleString() : undefined}>
            Last send failed: {lastError}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function RecentFeed({ events, now }: { events: AlertEvent[]; now: number }) {
  return (
    <section className="al-group" aria-label="Recent">
      <h3>Recent</h3>
      <p className="al-group__note">Alerts that fired or cleared since the server started. Each notification attempt, sent or failed, is also listed on the Activity page.</p>
      {events.length === 0 ? (
        <p className="al-group__note">No alerts so far.</p>
      ) : (
        <ul className="al-feed">
          {events.slice(0, 50).map((event) => {
            const resolved = event.status === "resolved";
            return (
              <li key={event.id} data-tone={resolved ? "ok" : toneOf(event.severity)}>
                {resolved ? "Resolved" : event.severity === "critical" ? "Critical" : "Warning"} · <b>{event.unitName}</b> {event.label} · {formatSince(event.at, now) ?? "—"} ago
                <small>{event.summary}</small>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
