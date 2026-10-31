import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { atomicWrite } from "./util/atomicWrite.js";
import {
  DEFAULT_ELECTRICITY_PRICE_PER_KWH,
  DEFAULT_ELECTRICITY_CURRENCY,
  normalizePrice,
  normalizeCurrency,
} from "./energy/pricing.js";
import { DEFAULT_IDLE_BASELINE_W, normalizeBaseline } from "./energy/powerModel.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const SETTINGS_PATH =
  process.env.SETTINGS_JSON_PATH || path.join(ROOT, "config", "settings.json");

const DEFAULTS = Object.freeze({
  pollIntervalMs: 2000,
  defaultLlmPort: 8888,
  autoHideOffline: false,
  /** Hide worker-role Sparks from Overview and the tab bar. */
  hideWorkers: false,
  temperatureUnit: "celsius",
  /** Persist prompts / HTTP traces / GPU samples on decode benchmark runs. */
  benchDebugTraces: false,
  /** Layout density — compact (default) or comfortable. */
  density: "compact",
  /** Fleet energy card on the Fleet tab (and Overview). On by default since #33. */
  showFleetEnergy: true,
  /** Electricity price per kWh for the energy cost estimate; 0 hides cost. */
  electricityPricePerKwh: DEFAULT_ELECTRICITY_PRICE_PER_KWH,
  /** ISO 4217 currency code for the cost estimate. */
  electricityCurrency: DEFAULT_ELECTRICITY_CURRENCY,
  /** Idle baseline (W) added to non-GB10 hosts: board, RAM, disks, fans, PSU loss. */
  energyIdleBaselineW: DEFAULT_IDLE_BASELINE_W,
  /** Per-host idle baseline overrides, keyed by Spark or node id. */
  energyHostBaselines: {},
  /**
   * Settings-file revision. Files below 2 were written when Fleet energy
   * defaulted off (and saved that default), so loading one turns it on once.
   */
  settingsRevision: 2,
  /** Overview active fleet exceptions strip. Off by default. */
  showFleetExceptions: false,
  /** Overview search + status filter row. Off by default. */
  showOverviewSearch: false,
  /**
   * Master switch for alert notifications. Default off; when off no rule runs,
   * nothing is delivered, and the alert write/test endpoints return 409.
   */
  alertsEnabled: false,
  /**
   * Benchmark dialogs offer the share-card format. On by default: the extra
   * control is one caret next to a button that already copies, and anyone who
   * does not want it can turn it off here (see the README's settings table).
   */
  benchShareImage: true,
  /**
   * Record the bucketed per-unit history the unit page charts (1-minute
   * buckets for two days, quarter-hour buckets for a month). Default off;
   * while off no buckets are kept and the history file is left alone.
   */
  metricsHistory: false,
});

/** @type {typeof DEFAULTS} */
let _settings = { ...DEFAULTS };

function _clampSettings(settings) {
  const s = { ...settings };
  // Clamp poll interval to 1000ms minimum
  if (typeof s.pollIntervalMs !== "number" || s.pollIntervalMs < 1000) {
    s.pollIntervalMs = 1000;
  }
  // Clamp LLM port to 1–65535
  if (typeof s.defaultLlmPort !== "number" || s.defaultLlmPort < 1 || s.defaultLlmPort > 65535) {
    s.defaultLlmPort = DEFAULTS.defaultLlmPort;
  }
  // Ensure autoHideOffline is boolean
  s.autoHideOffline = Boolean(s.autoHideOffline);
  s.hideWorkers = Boolean(s.hideWorkers);
  s.metricsHistory = Boolean(s.metricsHistory);
  // Ensure benchDebugTraces is boolean
  s.benchDebugTraces = Boolean(s.benchDebugTraces);
  s.showFleetEnergy = Boolean(s.showFleetEnergy);
  s.showFleetExceptions = Boolean(s.showFleetExceptions);
  s.showOverviewSearch = Boolean(s.showOverviewSearch);
  s.alertsEnabled = Boolean(s.alertsEnabled);
  s.electricityPricePerKwh = normalizePrice(s.electricityPricePerKwh);
  s.electricityCurrency = normalizeCurrency(s.electricityCurrency);
  s.energyIdleBaselineW = normalizeBaseline(s.energyIdleBaselineW, DEFAULT_IDLE_BASELINE_W);
  s.energyHostBaselines = normalizeHostBaselines(s.energyHostBaselines);
  s.settingsRevision = DEFAULTS.settingsRevision;
  // Ensure temperatureUnit is valid
  if (s.temperatureUnit !== "celsius" && s.temperatureUnit !== "fahrenheit") {
    s.temperatureUnit = DEFAULTS.temperatureUnit;
  }
  // Ensure density is valid
  if (s.density !== "comfortable" && s.density !== "compact") {
    s.density = DEFAULTS.density;
  }
  return s;
}

/** Per-host baselines: `{ [unitId]: watts }`, invalid entries dropped. */
function normalizeHostBaselines(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [id, watts] of Object.entries(value)) {
    if (typeof id !== "string" || id.trim() === "" || id.length > 128) continue;
    if (!Number.isFinite(watts) || watts < 0) continue;
    out[id] = normalizeBaseline(watts);
  }
  return out;
}

/** Load settings from disk, falling back to defaults. */
export function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    // Issue #33: Fleet energy became default-on. A file from before that
    // (settingsRevision < 2) is shown with it on; the file itself is only
    // rewritten on the next save, which records revision 2 and from then on
    // keeps whatever the user chose. Loading never writes.
    const migrate = !(Number(parsed?.settingsRevision) >= 2);
    if (migrate && parsed && typeof parsed === "object") parsed.showFleetEnergy = true;
    _settings = _clampSettings({ ...DEFAULTS, ...parsed });
  } catch (err) {
    if (err.code === "ENOENT") {
      _settings = { ...DEFAULTS };
      saveSettings();
    } else {
      console.error("[settings] Failed to load settings.json:", err.message);
      _settings = { ...DEFAULTS };
    }
  }
  return { ..._settings };
}

/** Persist current settings to disk. */
export function saveSettings() {
  try {
    // Atomic write (tmp + rename) — a SIGKILL/power loss mid-write must not
    // truncate settings.json. atomicWrite ensures the dir is created.
    atomicWrite(SETTINGS_PATH, JSON.stringify(_settings, null, 2) + "\n", 0o644);
  } catch (err) {
    console.error("[settings] Failed to save settings.json:", err.message);
  }
}

/** Get current settings (clamped). */
export function getSettings() {
  return { ..._settings };
}

/**
 * Apply a partial patch, persist, and return the new settings.
 * @param {Partial<typeof DEFAULTS>} patch
 * @returns {typeof DEFAULTS}
 */
export function updateSettings(patch) {
  const merged = _clampSettings({ ..._settings, ...patch });
  _settings = merged;
  saveSettings();
  return { ..._settings };
}
