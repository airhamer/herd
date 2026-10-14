/**
 * updates/dgx.js — client for the DGX dashboard backend (http://<host>:<port>,
 * live-verified loopback service on 127.0.0.1:11000 — docs/SPEC-UPDATES.md §2.5).
 *
 * Live-verified contract (Batch-1 spike, 2026-10-09, read-only):
 *   POST /api/login                     {username,password} (PAM) → JWT
 *   GET  /api/v1/updates/available      401 unauth — summary booleans (2026-10-14 capture)
 *   GET  /api/v1/updates/list           401 unauth — packageUpdates[]/firmwareUpdates[] rows (Batch 8, live capture)
 *   GET  /api/v1/update_reboot/status   401 unauth
 *   POST /api/v1/update_reboot          the trigger (NEVER call from tests)
 *   GET  /api/v1/update_reboot/stream   401 unauth — SSE vs WS TBD (auto-detect)
 *   GET  /api/v1/updates/enabled        PUBLIC {"updatesEnabled":boolean}
 * Unknown paths 302-redirect to the SPA fallback (treated as route missing).
 *
 * Response BODY shapes are unverified — probe() parses defensively, keeps the
 * original JSON under snapshot.raw, and maps nothing it does not recognize.
 *
 * Doctrine: no config / bad credentials / backend down → every snapshot entry
 * point returns the degraded shape with dgxConfigured:false and NEVER throws.
 * The event ring survives reboots (persisted, atomic tmp+rename), so the last
 * streamed outcome can be reported once the box is back.
 *
 * Between prober ticks NOTHING polls (spec §3). The status endpoint is read
 * on demand only; the stream is a push consumer; the prober is one unref'd
 * hourly interval and it probes only when credentials are configured.
 *
 * Zero dependencies: Node built-ins + global fetch/WebSocket.
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 8_000;
const STREAM_TIMEOUT_MS = 10 * 60_000; // long-lived stream; reboot ends it anyway
const EVENT_RING_MAX = 200;
const PROBE_INTERVAL_MS = 60 * 60_000; // hourly cadence (spec §5.1)

/** Login token field discovery order (spec §2.5: success token key TBD). */
const TOKEN_KEYS = ["token", "jwt", "access_token", "accessToken", "authorization"];

/** agent/config — overridable via opts.configDir (tests use tmp dirs). */
const CONFIG_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "config");

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Atomic JSON write: tmp file + rename (readers never see a half-written file). */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function bootId() {
  const t = readTextSafe("/proc/sys/kernel/random/boot_id") || readTextSafe("/proc/sys/kernel/random/boot_id");
  return t && t.trim() !== "" ? t.trim() : null;
}

/** /etc/dgx-release DGX_SWBUILD_VERSION (tolerant — absent → null). */
function readSwBuild() {
  const t = readTextSafe("/etc/dgx-release");
  if (!t) return null;
  const m = t.match(/^DGX_SWBUILD_VERSION="?([^"\r\n]+)"?/m);
  return m ? m[1] : null;
}

/** Last applied OTA: last DGX_OTA_VERSION/DGX_OTA_DATE pair (tolerant). */
function readLatestOta() {
  const t = readTextSafe("/etc/dgx-release");
  if (!t) return null;
  let version = null;
  let date = "";
  for (const m of t.matchAll(/^DGX_OTA_VERSION="?([^"\r\n]+)"?/gm)) version = m[1];
  for (const m of t.matchAll(/^DGX_OTA_DATE="?([^"\r\n]+)"?/gm)) date = m[1];
  return version ? { version, date } : null;
}

/** Tolerant login-token discovery across the five candidate field names. */
export function pickToken(body) {
  if (!body || typeof body !== "object") return null;
  for (const k of TOKEN_KEYS) {
    const v = body[k];
    if (typeof v === "string" && v !== "") return v;
  }
  return null;
}

/**
 * Defensive mapping of GET /updates/available (shape unverified). Recognized
 * fields are mapped into the DgxUpdateSnapshot sub-shapes; everything else
 * stays in snapshot.raw. Unknown → empty arrays, never a guess.
 */
export function normalizeAvailable(raw) {
  const out = { otaAvailable: null, packages: [], firmware: [] };
  if (!raw || typeof raw !== "object") return out;

  const ota = raw.ota ?? raw.otaAvailable ?? raw.latest_ota ?? raw.available ?? null;
  if (typeof ota === "string" && ota !== "") {
    out.otaAvailable = { version: ota, date: null, priority: null, releaseNotesUrl: null };
  } else if (ota && typeof ota === "object") {
    const version = ota.version ?? ota.versionString ?? ota.latest_ota_version ?? null;
    if (version != null && String(version) !== "") {
      const p = ota.priority ?? null;
      out.otaAvailable = {
        version: String(version),
        date: ota.date ?? ota.release_date ?? ota.releaseDate ?? null,
        priority:
          typeof p === "string" && /^critical$/i.test(p)
            ? "Critical"
            : typeof p === "string" && p !== ""
              ? "Normal"
              : null,
        releaseNotesUrl: ota.releaseNotesUrl ?? ota.release_notes_url ?? ota.url ?? null,
      };
    }
  }

  const pkgs = raw.packages ?? raw.packageUpdates ?? raw.apt_updates ?? [];
  if (Array.isArray(pkgs)) {
    for (const p of pkgs) {
      if (!p || typeof p !== "object") continue;
      const name = p.name ?? p.package ?? p.packageName;
      if (typeof name !== "string" || name === "") continue;
      out.packages.push({
        name,
        currentVersion: String(p.currentVersion ?? p.current_version ?? p.installed ?? ""),
        availableVersion: String(p.availableVersion ?? p.available_version ?? p.candidate ?? ""),
        sizeBytes: Number.isFinite?.(p.sizeBytes ?? p.size) ? Number(p.sizeBytes ?? p.size) : null,
      });
    }
  }

  const fw = raw.firmware ?? raw.firmwareUpdates ?? raw.firmware_updates ?? [];
  if (Array.isArray(fw)) {
    for (const f of fw) {
      if (!f || typeof f !== "object") continue;
      const component = f.component ?? f.name;
      if (typeof component !== "string" || component === "") continue;
      const avail = f.availableVersion ?? f.available_version ?? f.new_version ?? null;
      out.firmware.push({
        component,
        currentVersion: String(f.currentVersion ?? f.current_version ?? f.installed ?? ""),
        availableVersion: avail == null ? null : String(avail),
      });
    }
  }
  return out;
}

/**
 * Defensive mapping of GET /api/v1/updates/list — REAL captured shapes
 * (gx10-1c2c, 2026-10-14): { packageUpdates:[{name,description,size,
 * currentVersion,availableVersion}], firmwareUpdates:[{name,currentVersion,
 * availableVersion}] }. Orchestrator ruling eeb3696 (reading C): emit the
 * committed snapshot element shape (DgxPackageUpdate / DgxFirmwareUpdate)
 * plus additive fields ONLY — packages carry the DGX human size string
 * VERBATIM under `size` (sizeBytes stays null; the source has no numeric
 * size — never parse one) and `description`; firmware rows rename source
 * `name` to `component`. Same defensive style as normalizeAvailable:
 * non-object input or missing/non-array fields → empty arrays; items
 * without a string `name` are skipped; never throws.
 */
export function normalizeList(raw) {
  const out = { packages: [], firmware: [] };
  if (!raw || typeof raw !== "object") return out;

  if (Array.isArray(raw.packageUpdates)) {
    for (const p of raw.packageUpdates) {
      if (!p || typeof p !== "object") continue;
      if (typeof p.name !== "string" || p.name === "") continue;
      out.packages.push({
        name: p.name,
        currentVersion: String(p.currentVersion ?? ""),
        availableVersion: String(p.availableVersion ?? ""),
        sizeBytes: null, // /list has no numeric size (ruling: do not invent one)
        size: typeof p.size === "string" ? p.size : null,
        description: typeof p.description === "string" ? p.description : null,
      });
    }
  }

  if (Array.isArray(raw.firmwareUpdates)) {
    for (const f of raw.firmwareUpdates) {
      if (!f || typeof f !== "object") continue;
      if (typeof f.name !== "string" || f.name === "") continue;
      const avail = f.availableVersion;
      out.firmware.push({
        component: f.name,
        currentVersion: String(f.currentVersion ?? ""),
        availableVersion: avail == null ? null : String(avail),
      });
    }
  }
  return out;
}

/** Map a streamed stage token onto the DgxUpdateStage union (null = keep). */
function mapStage(stage) {
  const s = String(stage).toLowerCase();
  if (s.includes("cache")) return "update_cache";
  if (s.includes("firm")) return "upgrade_firmware";
  if (s.includes("pack")) return "upgrade_packages";
  if (s.includes("reboot")) return "reboot";
  return null;
}

/**
 * @param {{
 *   configDir?: string,                                  // tests: tmp dir
 *   fetch?: (url: string, init?: object) => Promise<any>, // test seam
 *   WebSocket?: typeof globalThis.WebSocket,              // test seam
 *   now?: () => number,
 * }} [opts]
 */
export function createDgxUpdates(opts = {}) {
  const configDir = opts.configDir || CONFIG_DIR;
  const doFetch = opts.fetch || ((u, i) => globalThis.fetch(u, i));
  const WebSocketCtor = opts.WebSocket !== undefined ? opts.WebSocket : globalThis.WebSocket;
  const now = opts.now || (() => Date.now());

  const configPath = path.join(configDir, "dgx.json");
  const eventsPath = path.join(configDir, "update-events.json");

  /** Persisted together in update-events.json so outcomes survive the reboot. */
  const persisted = readJsonSafe(eventsPath);
  /** @type {import("../../shared/types.ts").DgxUpdateState} */
  const state = {
    inProgress: Boolean(persisted?.state?.inProgress),
    stage: persisted?.state?.stage ?? null,
    startedAt: persisted?.state?.startedAt ?? null,
    finishedAt: persisted?.state?.finishedAt ?? null,
    bootId: persisted?.state?.bootId ?? null,
    lastOutcome: persisted?.state?.lastOutcome ?? null,
    lastOutcomeDetail: persisted?.state?.lastOutcomeDetail ?? null,
  };
  const startedBootId = persisted?.state?.startedBootId ?? null;
  /** @type {Array<{at:number,stage:string,message:string}>} */
  let events = Array.isArray(persisted?.events) ? persisted.events.slice(-EVENT_RING_MAX) : [];

  /** @type {object | null} cached probe snapshot (memory-only; the dashboard caches per poll) */
  let snapshot = null;
  let token = null;
  let prober = null;
  let wsActive = null;

  function save() {
    try {
      writeJsonAtomic(eventsPath, { state: { ...state, startedBootId }, events });
    } catch {
      /* persistence is best-effort; never break the caller */
    }
  }

  /** Credentials present? null when dgx.json missing or username/password empty. */
  function loadConfig() {
    const c = readJsonSafe(configPath);
    if (!c || typeof c !== "object") return null;
    if (typeof c.username !== "string" || c.username === "") return null;
    if (typeof c.password !== "string" || c.password === "") return null;
    return {
      host: typeof c.host === "string" && c.host !== "" ? c.host : "127.0.0.1",
      port: Number.isInteger(c.port) ? c.port : 11000,
      username: c.username,
      password: c.password,
    };
  }

  const base = (c) => `http://${c.host}:${c.port}`;

  /** The degraded snapshot (dgxConfigured:false) — what every entry point returns without credentials. */
  function degraded() {
    return {
      probedAt: snapshot?.probedAt ?? 0,
      agentReachable: true, // the agent itself answers; the DGX backend is simply not configured
      dgxConfigured: false,
      swBuild: readSwBuild(),
      latestOtaApplied: readLatestOta(),
      otaAvailable: null,
      packages: [],
      firmware: [],
      updatesDisabled: false,
    };
  }

  /** POST /api/login → JWT (field name discovered, cached in memory). */
  async function login(c) {
    const res = await doFetch(`${base(c)}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: c.username, password: c.password }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw Object.assign(
        new Error(`dgx login failed (${res.status}): ${body.slice(0, 200)}`),
        { httpStatus: res.status === 401 || res.status === 403 ? res.status : 502 }
      );
    }
    const t = pickToken(await res.json().catch(() => null));
    if (!t) throw Object.assign(new Error("dgx login succeeded but no token field in response"), { httpStatus: 502 });
    token = t;
    return t;
  }

  /**
   * Authed call with the cached bearer token; on any 401 exactly ONE re-login
   * and retry per call (spec §2.5).
   */
  async function api(c, pathname, init = {}, retry401 = true, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!token) await login(c);
    const res = await doFetch(`${base(c)}${pathname}`, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 && retry401) {
      token = null;
      await login(c);
      return api(c, pathname, init, false, timeoutMs);
    }
    return res;
  }

  /**
   * Probe the backend: /updates/available + /updates/list (fail-soft, Batch 8)
   * + enabled flag + local release info.
   * force=false serves the cached snapshot when fresh (<60 s). Never throws:
   * failures return the degraded shape (or last snapshot) with dgxError set.
   */
  async function probe(force = false) {
    reconcileBoot();
    const c = loadConfig();
    if (!c) return degraded();
    if (!force && snapshot && now() - snapshot.probedAt < 60_000) return snapshot;
    try {
      const availRes = await api(c, "/api/v1/updates/available");
      if (!availRes.ok) {
        throw Object.assign(new Error(`GET /updates/available → ${availRes.status}`), { httpStatus: availRes.status });
      }
      const raw = await availRes.json().catch(() => null);
      const norm = normalizeAvailable(raw);
      // Batch 8: GET /api/v1/updates/list — the real pending package/firmware
      // rows. FAIL-SOFT by contract: non-2xx / timeout / unparseable body must
      // NEVER fail the probe; the /available snapshot stands and the snapshot
      // records a short listError reason instead.
      let listBody = null;
      let listNorm = null;
      let listError = null;
      try {
        const listRes = await api(c, "/api/v1/updates/list");
        if (!listRes.ok) {
          listError = `GET /api/v1/updates/list → ${listRes.status}`;
        } else {
          listBody = await listRes.json().catch(() => null);
          if (!listBody || typeof listBody !== "object") {
            listError = "GET /api/v1/updates/list: unparseable JSON body";
            listBody = null;
          } else {
            listNorm = normalizeList(listBody);
          }
        }
      } catch (err) {
        listError = `GET /api/v1/updates/list failed: ${String(err?.message || err)}`.slice(0, 200);
      }
      let updatesDisabled = false;
      try {
        // PUBLIC endpoint — no bearer needed (spec §2.5).
        const en = await doFetch(`${base(c)}/api/v1/updates/enabled`, { signal: AbortSignal.timeout(3_000) });
        if (en.ok) updatesDisabled = (await en.json().catch(() => null))?.updatesEnabled === false;
      } catch {
        /* enabled flag unknown — stay false (fail-open, display hint only) */
      }
      snapshot = {
        probedAt: now(),
        agentReachable: true,
        dgxConfigured: true,
        swBuild: readSwBuild(),
        latestOtaApplied: readLatestOta(),
        otaAvailable: norm.otaAvailable,
        // Merge precedence (ruling): successful /list rows win — even when
        // legitimately empty; the legacy /available guess is kept ONLY when
        // /list failed (listNorm null).
        packages: listNorm ? listNorm.packages : norm.packages,
        firmware: listNorm ? listNorm.firmware : norm.firmware,
        updatesDisabled,
        ...(listError ? { listError } : {}),
        // Batch 8: BOTH upstream bodies kept verbatim; failed/unparseable /list → null.
        raw: { available: raw, list: listBody },
      };
      const b = bootId();
      if (b) state.bootId = b;
      return snapshot;
    } catch (err) {
      // Last snapshot is truth from a moment ago; better than fabricating empty.
      return {
        ...(snapshot || degraded()),
        agentReachable: true,
        dgxConfigured: true,
        dgxError: String(err?.message || err),
      };
    }
  }

  /** GET /update_reboot/status — raw merged over the known flags (demand read, no loop). */
  async function status() {
    const c = loadConfig();
    if (!c) return { ok: false, dgxConfigured: false };
    const res = await api(c, "/api/v1/update_reboot/status");
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, ...(body && typeof body === "object" ? { raw: body } : {}) };
  }

  /** Normalize one streamed payload (JSON or plain line) into the ring + state machine. */
  function handleStreamData(data) {
    const text = String(data ?? "").trim();
    if (text === "" || text === "[DONE]") return;
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch {
      obj = null;
    }
    if (!obj || typeof obj !== "object") {
      pushEvent("log", text);
      return;
    }
    const stageGuess = obj.stage ?? obj.state ?? obj.phase ?? null;
    const message = String(obj.message ?? obj.status ?? obj.detail ?? JSON.stringify(obj)).slice(0, 300);
    pushEvent(typeof stageGuess === "string" ? stageGuess : "log", message);

    if (typeof stageGuess === "string") {
      const mapped = mapStage(stageGuess);
      if (mapped && state.inProgress) state.stage = mapped;
    }
    const isError = Boolean(obj.error) || obj.success === false || (typeof stageGuess === "string" && /error|failed/i.test(stageGuess));
    const isDone = obj.done === true || obj.finished === true || obj.success === true || (typeof stageGuess === "string" && /reboot|complete/i.test(stageGuess));
    if (isError || isDone) {
      if (state.inProgress) {
        state.inProgress = false;
        state.finishedAt = now();
        state.stage = null;
        state.lastOutcome = isError ? "error" : "success";
        state.lastOutcomeDetail = message;
      }
    }
    save();
  }

  function pushEvent(stage, message) {
    events.push({ at: now(), stage, message: String(message).slice(0, 400) });
    if (events.length > EVENT_RING_MAX) events = events.slice(events.length - EVENT_RING_MAX);
    save();
  }

  /**
   * Stream consumer (spec §2.5): GET the stream endpoint. If the response is
   * text/event-stream, parse SSE `data:` lines; otherwise (JSON body, upgrade,
   * 4xx) fall back to a global WebSocket against ws://host:port. Every event
   * normalizes into the ring buffer. No status polling.
   */
  async function consumeStream(c) {
    try {
      const res = await api(
        c,
        "/api/v1/update_reboot/stream",
        { headers: { Accept: "text/event-stream, application/json" } },
        true,
        STREAM_TIMEOUT_MS
      );
      const ct = String(res.headers?.get?.("content-type") || "");
      if (res.ok && ct.includes("text/event-stream") && res.body) {
        const dec = new TextDecoder();
        let buf = "";
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of block.split("\n")) {
              if (line.startsWith("data:")) handleStreamData(line.slice(5));
            }
          }
        }
        return;
      }
    } catch {
      /* not SSE (or unreachable) → WebSocket fallback */
    }
    try {
      if (typeof WebSocketCtor !== "function") {
        pushEvent("stream", "no SSE and no WebSocket support; outcome resolves via boot-id reconciliation");
        return;
      }
      const ws = new WebSocketCtor(`ws://${c.host}:${c.port}/api/v1/update_reboot/stream`, [`bearer.${token || ""}`]);
      wsActive = ws;
      ws.onmessage = (ev) => handleStreamData(ev?.data ?? ev);
      ws.onerror = () => {
        pushEvent("stream", "WebSocket stream error");
      };
      ws.onclose = () => {
        if (wsActive === ws) wsActive = null;
      };
    } catch (err) {
      pushEvent("stream", `WebSocket stream unavailable: ${String(err?.message || err)}`);
    }
  }

  /**
   * POST /api/v1/update_reboot with {}. Throws on failure with the backend's
   * status/error body propagated. NEVER call this from tests (the HTTP layer
   * is stubbed).
   */
  async function trigger(c) {
    const res = await api(c, "/api/v1/update_reboot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const bodyText = await res.text().catch(() => "");
    if (!res.ok) {
      throw Object.assign(
        new Error(`dgx update_reboot failed (${res.status}): ${bodyText.slice(0, 300)}`),
        { httpStatus: res.status }
      );
    }
    return { ok: true, body: bodyText };
  }

  /**
   * Trigger + start stream consumption. inProgress is true from here until a
   * terminal stream event (or boot-id reconciliation after the reboot).
   * @throws {httpStatus:409} while an update is already in progress
   * @throws {httpStatus:400} when the DGX backend is not configured
   */
  async function triggerNow() {
    reconcileBoot();
    if (state.inProgress) {
      throw Object.assign(new Error("an update is already in progress on this node"), { httpStatus: 409 });
    }
    const c = loadConfig();
    if (!c) {
      throw Object.assign(new Error("DGX backend not configured (agent/config/dgx.json missing or empty credentials)"), { httpStatus: 400 });
    }
    const r = await trigger(c);
    state.inProgress = true;
    state.startedAt = now();
    state.startedBootId = bootId();
    state.finishedAt = null;
    state.stage = "update_cache";
    state.lastOutcome = null;
    state.lastOutcomeDetail = null;
    save();
    pushEvent("trigger", "update_reboot accepted by DGX backend");
    void consumeStream(c).catch(() => {
      /* stream is fire-and-forget; reboot ends it */
    });
    return { ok: true, status: r };
  }

  /**
   * Post-boot confirmation (spec §4): an update was inProgress when this boot
   * started and the boot id changed → resolve to the last streamed outcome.
   */
  function reconcileBoot() {
    if (!state.inProgress || !startedBootId) return;
    const b = bootId();
    if (!b || b === startedBootId) return; // boot id unavailable or still the same boot
    state.inProgress = false;
    state.finishedAt = now();
    state.bootId = b;
    state.stage = null;
    const errored = events.some((e) => /error|fail/i.test(e.stage + e.message) && e.at >= (state.startedAt ?? 0));
    state.lastOutcome = errored ? "error" : "success";
    state.lastOutcomeDetail = errored ? "update stream reported an error before reboot" : "back online after reboot";
    save();
  }

  /** Cached snapshot (degraded when unconfigured). Never throws, never probes. */
  function getSnapshot() {
    reconcileBoot();
    if (!loadConfig()) return degraded();
    return snapshot ?? { ...degraded(), dgxConfigured: true, swBuild: readSwBuild(), latestOtaApplied: readLatestOta() };
  }

  /** Current DgxUpdateState + the persisted event ring (copy). */
  function getState() {
    reconcileBoot();
    return { ...state, events: events.slice() };
  }

  /**
   * GET /updates producer — consumed by scheduler.fullView(), which awaits
   * this and adds its own `schedules` key; http.js serves the merged
   * { snapshot, state, schedules } body. Cache-only composition on purpose:
   * getSnapshot/getState never probe and never throw, and the dashboard may
   * poll /updates far faster than the hourly prober cadence — spec §3
   * forbids backend polling between prober ticks. Degraded-safe: with no
   * credentials the snapshot carries dgxConfigured:false.
   */
  async function fullView() {
    return { snapshot: getSnapshot(), state: getState() };
  }

  /** Hourly unref'd prober; probes only when configured, nothing between ticks. */
  function startProber() {
    if (prober) return prober;
    prober = setInterval(() => {
      if (!loadConfig()) return; // not configured → no traffic at all
      void probe(true).catch(() => {});
    }, PROBE_INTERVAL_MS);
    prober.unref?.();
    return prober;
  }

  function stopProber() {
    if (prober) {
      clearInterval(prober);
      prober = null;
    }
    if (wsActive) {
      try {
        wsActive.close?.();
      } catch {
        /* best-effort */
      }
      wsActive = null;
    }
  }

  return {
    configured: () => loadConfig() !== null,
    getSnapshot,
    getState,
    fullView,
    probe,
    probeForce: () => probe(true),
    status,
    triggerNow,
    startProber,
    stopProber,
    /** test seam */
    _events: () => events.slice(),
  };
}
