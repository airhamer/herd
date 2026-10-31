// Alert state machine: turns per-unit conditions (conditions.js) into
// pending → firing → resolved alerts and hands each evaluation's changes to
// the notifier as one group. docs/specs/alerts.md §4.
// Clean-room implementation (LIC1).
import { collectConditions, effectiveRuleConfig } from "./conditions.js";
import { MAX_NAME_CHARS, MAX_SUMMARY_CHARS, capText } from "./text.js";

/** A firing alert must stay clear at least this long before it resolves. */
export const MIN_CLEAR_MS = 30_000;
/** A saved firing set older than this is not trusted after a restart. */
export const STATE_MAX_AGE_MS = 15 * 60_000;
/** Firing/resolved transitions kept for GET /api/alerts. */
export const HISTORY_LIMIT = 200;

const SEVERITY_RANK = { warning: 1, critical: 2 };
const rank = (severity) => SEVERITY_RANK[severity] ?? 0;
const higher = (a, b) => (rank(b) > rank(a) ? b : a);
const isSeverity = (s) => s === "warning" || s === "critical";

/** The public view of one tracked alert. */
function view(alert, status = alert.state, endsAt = null) {
  return {
    key: alert.key,
    ruleId: alert.ruleId,
    ruleName: alert.ruleName,
    unitId: alert.unitId,
    unitName: alert.unitName,
    severity: alert.severity,
    peakSeverity: alert.peakSeverity,
    state: alert.state,
    label: alert.label,
    summary: alert.summary,
    startsAt: alert.startsAt,
    firingAt: alert.firingAt,
    endsAt,
    status,
  };
}

export class AlertEngine {
  constructor({ now = () => Date.now(), getConfig, notifier, persistState = () => {}, log = console, onTransition = null } = {}) {
    this._now = now;
    /** Told about every alert that starts firing or resolves (activity feed, #32). */
    this._onTransition = typeof onTransition === "function" ? onTransition : null;
    this._config = typeof getConfig === "function" ? getConfig : () => ({});
    this._notifier = notifier;
    this._persist = persistState;
    this._log = log;
    /** @type {Map<string, object>} key → tracked alert (pending or firing) */
    this._tracked = new Map();
    this._history = [];
    this._eventSeq = 0;
  }

  active() {
    return [...this._tracked.values()].filter((a) => a.state === "firing").map((a) => view(a));
  }

  pending() {
    return [...this._tracked.values()].filter((a) => a.state === "pending").map((a) => view(a));
  }

  recent() {
    return this._history.map((entry) => ({ ...entry }));
  }

  /** Forget every pending and firing alert (alerts were turned off). History stays. */
  reset() {
    this._tracked.clear();
  }

  /** One evaluation over the current unit snapshots. */
  evaluate(units) {
    const at = this._now();
    const config = this._config() ?? {};
    const overrides = config.rules ?? {};
    const ruleOn = (ruleId) => effectiveRuleConfig(ruleId, overrides).enabled;
    const waitMs = (ruleId) => Math.max(0, effectiveRuleConfig(ruleId, overrides).forSec) * 1000;

    const newlyFiring = [];
    const resolved = [];
    let changed = false;
    const present = new Set();

    for (const unit of units ?? []) {
      if (!unit || unit.id == null) continue;
      present.add(unit.id);
      const { conditions, judged } = collectConditions(unit);

      // Strongest condition per rule among enabled rules.
      const now = new Map();
      for (const c of conditions) {
        if (!ruleOn(c.ruleId)) continue;
        const prior = now.get(c.ruleId);
        if (!prior || rank(c.severity) > rank(prior.severity)) now.set(c.ruleId, c);
      }

      // Tracked alerts of this unit whose condition is absent this round.
      for (const alert of this._tracked.values()) {
        if (alert.unitId !== unit.id || now.has(alert.ruleId)) continue;
        if (!ruleOn(alert.ruleId)) {
          changed = this._end(alert, "rule turned off", at, resolved) || changed;
          continue;
        }
        if (!judged(alert.ruleId)) continue; // stale reading: hold as is
        if (alert.state === "pending") {
          this._tracked.delete(alert.key);
          continue;
        }
        alert.escalatingSince = null;
        alert.clearSince ??= at;
        if (at - alert.clearSince >= Math.max(waitMs(alert.ruleId), MIN_CLEAR_MS)) {
          this._resolve(alert, alert.clearSince, resolved);
          changed = true;
        }
      }

      for (const [ruleId, c] of now) {
        const key = `${unit.id}:${ruleId}`;
        let alert = this._tracked.get(key);
        if (!alert) {
          alert = {
            key,
            ruleId,
            unitId: unit.id,
            state: "pending",
            severity: c.severity,
            peakSeverity: c.severity,
            notifiedSeverity: null,
            startsAt: at,
            firingAt: null,
            lastNotifiedAt: null,
            clearSince: null,
            escalatingSince: null,
          };
          this._tracked.set(key, alert);
        }
        alert.ruleName = c.ruleName;
        alert.unitName = capText(unit.name ?? unit.id, MAX_NAME_CHARS);
        alert.label = c.label;
        alert.summary = capText(c.summary, MAX_SUMMARY_CHARS);
        alert.clearSince = null;
        const hold = waitMs(ruleId);

        if (alert.state === "pending") {
          alert.severity = c.severity;
          alert.peakSeverity = higher(alert.peakSeverity, c.severity);
          if (at - alert.startsAt >= hold) {
            alert.state = "firing";
            alert.firingAt = at;
            alert.notifiedSeverity = alert.severity;
            this._remember("firing", alert, at, null);
            newlyFiring.push(alert);
            changed = true;
          }
          continue;
        }

        if (rank(c.severity) > rank(alert.notifiedSeverity)) {
          // Worse than what was announced: announce only once it has held.
          alert.escalatingSince ??= at;
          if (at - alert.escalatingSince >= hold) {
            alert.escalatingSince = null;
            alert.severity = c.severity;
            alert.peakSeverity = higher(alert.peakSeverity, c.severity);
            alert.notifiedSeverity = c.severity;
            this._remember("firing", alert, at, null);
            newlyFiring.push(alert);
            changed = true;
          }
        } else {
          // Same or milder than announced: follow it quietly.
          alert.escalatingSince = null;
          alert.severity = c.severity;
        }
      }
    }

    for (const alert of [...this._tracked.values()]) {
      if (!present.has(alert.unitId)) changed = this._end(alert, "unit removed", at, resolved) || changed;
    }

    const reminders = this._dueReminders(config, at, newlyFiring);
    for (const alert of newlyFiring) alert.lastNotifiedAt = at;

    if (this._onTransition && (newlyFiring.length > 0 || resolved.length > 0)) {
      try {
        this._onTransition({ firing: newlyFiring.map((a) => view(a, "firing")), resolved });
      } catch {
        // the feed is best effort
      }
    }

    const channels = Array.isArray(config.channels) ? config.channels : [];
    if (newlyFiring.length > 0 || resolved.length > 0) {
      this._send(channels, {
        firing: newlyFiring.map((a) => view(a, "firing")),
        resolved,
        reminder: false,
      });
    }
    if (reminders.length > 0) {
      this._send(channels, { firing: reminders.map((a) => view(a, "firing")), resolved: [], reminder: true });
      changed = true;
    }
    if (changed) this._save();
  }

  _dueReminders(config, at, skip) {
    const everyMs = Number(config.repeatIntervalMin) * 60_000;
    if (!(everyMs > 0)) return [];
    const due = [];
    for (const alert of this._tracked.values()) {
      if (alert.state !== "firing" || skip.includes(alert)) continue;
      if (alert.lastNotifiedAt !== null && at - alert.lastNotifiedAt >= everyMs) {
        alert.lastNotifiedAt = at;
        due.push(alert);
      }
    }
    return due;
  }

  /** Stop tracking an alert for a reason other than its condition clearing. */
  _end(alert, reason, at, resolved) {
    this._tracked.delete(alert.key);
    if (alert.state !== "firing") return false;
    alert.summary = capText(`Ended: ${reason}`, MAX_SUMMARY_CHARS);
    this._resolve(alert, at, resolved);
    return true;
  }

  _resolve(alert, endsAt, resolved) {
    this._tracked.delete(alert.key);
    this._remember("resolved", alert, this._now(), endsAt);
    resolved.push(view(alert, "resolved", endsAt));
  }

  _remember(status, alert, at, endsAt) {
    this._eventSeq += 1;
    this._history.unshift({
      id: this._eventSeq,
      at,
      status,
      key: alert.key,
      ruleId: alert.ruleId,
      ruleName: alert.ruleName,
      unitId: alert.unitId,
      unitName: alert.unitName,
      severity: alert.severity,
      label: alert.label,
      summary: alert.summary,
      startsAt: alert.startsAt,
      endsAt,
    });
    if (this._history.length > HISTORY_LIMIT) this._history.length = HISTORY_LIMIT;
  }

  _send(channels, group) {
    if (!this._notifier) return;
    try {
      Promise.resolve(this._notifier.dispatch(channels, group)).catch((err) =>
        this._log?.error?.(`[alerts] dispatch failed: ${err?.message ?? err}`)
      );
    } catch (err) {
      this._log?.error?.(`[alerts] dispatch failed: ${err?.message ?? err}`);
    }
  }

  _save() {
    try {
      this._persist(this.stateForSave());
    } catch (err) {
      this._log?.error?.(`[alerts] could not save alert state: ${err?.message ?? err}`);
    }
  }

  /** What survives a restart: the firing set only. */
  stateForSave() {
    const firing = [];
    for (const a of this._tracked.values()) {
      if (a.state !== "firing") continue;
      firing.push({
        ruleId: a.ruleId,
        ruleName: a.ruleName,
        unitId: a.unitId,
        unitName: a.unitName,
        severity: a.severity,
        peakSeverity: a.peakSeverity,
        notifiedSeverity: a.notifiedSeverity,
        label: a.label,
        summary: a.summary,
        startsAt: a.startsAt,
        firingAt: a.firingAt,
        lastNotifiedAt: a.lastNotifiedAt,
      });
    }
    return { savedAt: this._now(), firing };
  }

  /** Re-adopt a saved firing set without notifying again. Returns how many were restored. */
  restore(saved) {
    if (!saved || !Array.isArray(saved.firing) || !Number.isFinite(saved.savedAt)) return 0;
    const age = this._now() - saved.savedAt;
    if (age < 0 || age > STATE_MAX_AGE_MS) return 0;
    let count = 0;
    for (const item of saved.firing) {
      if (!item || typeof item.ruleId !== "string" || typeof item.unitId !== "string") continue;
      if (!isSeverity(item.severity) || !Number.isFinite(item.startsAt)) continue;
      const key = `${item.unitId}:${item.ruleId}`;
      this._tracked.set(key, {
        key,
        ruleId: item.ruleId,
        ruleName: capText(item.ruleName ?? item.ruleId, MAX_SUMMARY_CHARS),
        unitId: item.unitId,
        unitName: capText(item.unitName ?? item.unitId, MAX_NAME_CHARS),
        state: "firing",
        severity: item.severity,
        peakSeverity: isSeverity(item.peakSeverity) ? higher(item.peakSeverity, item.severity) : item.severity,
        notifiedSeverity: isSeverity(item.notifiedSeverity) ? item.notifiedSeverity : item.severity,
        label: capText(item.label, MAX_SUMMARY_CHARS),
        summary: capText(item.summary, MAX_SUMMARY_CHARS),
        startsAt: item.startsAt,
        firingAt: Number.isFinite(item.firingAt) ? item.firingAt : item.startsAt,
        lastNotifiedAt: Number.isFinite(item.lastNotifiedAt) ? item.lastNotifiedAt : null,
        clearSince: null,
        escalatingSince: null,
      });
      count += 1;
    }
    return count;
  }
}
