/**
 * library.js — SC6: on-disk library state for LLM Components (Hasso-style Library).
 *
 * The Library tab's three surfaces, collected on the node that owns the
 * disk (docs/PHASES.md Phase 3: "Full library collector: docker images,
 * HF cache scans (size/status pinned/stray), pins from recipes"):
 *
 * - engineImages: every local docker image with its repo digest; an image
 *   whose digest matches a recipe pin is `pinned: true` even when its tag
 *   moved (a moving tag is never a pin, per Hasso's rule). `inferenceEngine`
 *   flags the engine-relevant ones for the Library grouping.
 * - checkpoints: the HuggingFace cache layout (`models--org--name` with
 *   `refs/` + `snapshots/`), plus a fallback for plain model directories.
 *   Statuses: "pinned" | "unpinned" | "stray" | "missing".
 * - pins: what the node's recipe store CLAIMS (imageDigest / modelRevision),
 *   resolved against disk — an unmet claim surfaces as a finding.
 *
 * Pin verdicts (one method, no directory-name heuristics):
 * - A revision on disk matching a recipe's modelRevision pin ⇒ "pinned".
 * - A revision on disk inside a model that HAS pins but matching none ⇒
 *   "stray" (drift next to the pin). A model with NO pins at all is all
 *   "unpinned" — ungoverned cache is not drift.
 * - A pin whose revision is NOT on disk ⇒ a "missing" checkpoint entry
 *   (pull finding). "missing" NEVER appears on models without pins.
 * - Engine pin: the pinned digest present in `docker images` ⇒ that image
 *   is `pinned: true`; a pin with no local image ⇒ pins row + errors line.
 *
 * Honesty rule (collector style, mirrors collectors/docker.js): a raw
 * docker/du failure leaves fields null (unknown) with a reported `error` —
 * never a fabricated 0 and never a silent drop. The collect never throws.
 *
 * Seam contract: `library: LibraryReport` on the snapshot (shared/types.ts,
 * NodeAgentSnapshot.library — SC6 additive field; api.schema.json permits
 * extras). The recipe-pin source is the node's validated recipe store
 * (agent/catalog/recipes.js, loadRecipes) — fail-soft: an unreadable or
 * invalid recipes file degrades to an empty pin index with a reported
 * error, exactly like the agent's own loadCatalog degradation.
 */

import fs from "fs";
import path from "path";
import { runShell } from "./util.js";
import { loadRecipes } from "../catalog/recipes.js";

/** Substrings marking an inference-engine image (Hasso-class engines). */
export const INFERENCE_ENGINE_MATCHES = ["sglang", "vllm", "flash", "llm", "comfy", "qwen"];

/** Default refs in an HF cache refs/ file. */
export const DEFAULT_REFS = new Set(["main", "master"]);

/** 40-hex commit or 64-hex content-addressed snapshot hash. */
const HEX_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** sha256:... (prefix) or raw 64-hex (docker RepoDigests carry bare hex). */
export function normalizeDigest(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(?:sha256:)?([0-9a-f]{64})$/);
  return m ? `sha256:${m[1]}` : null;
}

export function parseSizeBytes(raw) {
  const n = parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function isEngineImage(reference) {
  const s = String(reference ?? "").toLowerCase();
  return INFERENCE_ENGINE_MATCHES.some((m) => s.includes(m));
}

/**
 * Pin claims from one validated recipe (shared/recipe.schema.json shape).
 * A malformed claim (bad digest/revision) is dropped, never guessed.
 * @param {{name?: string, image?: string, imageDigest?: string|null,
 *   modelPath?: string|null, modelRevision?: string|null}} recipe
 * @returns {{image: {digest: string}|null, model: {model: string, revision: string}|null}}
 */
/**
 * Git commit ids are 40 or 64 hex (recipe.schema.json: "git sha").
 * Char class written as explicit ranges: a−z is NOT hex — a lookalike
 * dash in `[0-9a−f]` once silently killed every 64-char revision claim.
 */
const HEX40_RE = new RegExp("^[0-9a-f]{40}$");
const HEX64_RE = new RegExp("^[0-9a-f]{64}$");

export function hex40Or64(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  return HEX40_RE.test(s) || HEX64_RE.test(s);
}

export function extractPins(recipe) {
  const out = { image: null, model: null };
  if (!recipe || typeof recipe !== "object") return out;
  const digest = normalizeDigest(recipe.imageDigest);
  if (digest) out.image = { digest };
  if (
    typeof recipe.modelPath === "string" &&
    recipe.modelPath &&
    typeof recipe.modelRevision === "string" &&
    hex40Or64(recipe.modelRevision)
  ) {
    out.model = { model: recipe.modelPath, revision: recipe.modelRevision.trim().toLowerCase() };
  }
  return out;
}

/**
 * Index pin claims by what they pin; duplicate claims accumulate recipe names.
 * @param {object[]} recipes
 * @returns {{byDigest: Map<string, string[]>, byModel: Map<string, Map<string, string[]>>}}
 */
export function buildPinsIndex(recipes) {
  const byDigest = new Map();
  const byModel = new Map();
  const list = Array.isArray(recipes) ? recipes : [];
  for (const r of list) {
    if (!r || typeof r !== "object" || typeof r.name !== "string") continue;
    const pins = extractPins(r);
    if (pins.image) {
      const names = byDigest.get(pins.image.digest) || [];
      if (!names.includes(r.name)) names.push(r.name);
      byDigest.set(pins.image.digest, names);
    }
    if (pins.model) {
      if (!byModel.has(pins.model.model)) byModel.set(pins.model.model, new Map());
      const revs = byModel.get(pins.model.model);
      const names = revs.get(pins.model.revision) || [];
      if (!names.includes(r.name)) names.push(r.name);
      revs.set(pins.model.revision, names);
    }
  }
  return { byDigest, byModel };
}

/**
 * Checkpoint verdict for one disk revision (pure, known-answer tested).
 * @param {string} revision on-disk revision
 * @param {{revision: string}[]} pinRevisions pin claims for the SAME model
 * @returns {"pinned"|"unpinned"|"stray"}
 */
export function checkpointPinStatus(revision, pinRevisions) {
  const rev = String(revision ?? "").toLowerCase();
  const claims = Array.isArray(pinRevisions) ? pinRevisions : [];
  if (claims.some((p) => p && String(p.revision ?? "").toLowerCase() === rev)) return "pinned";
  return claims.length > 0 ? "stray" : "unpinned";
}

/**
 * Engine-image verdict (pure): digest match against a pin claim.
 * @param {string|null} imageDigest
 * @param {string[]} pinDigests
 * @returns {boolean}
 */
export function engineImagePinned(imageDigest, pinDigests) {
  const d = normalizeDigest(imageDigest);
  if (!d) return false;
  const list = Array.isArray(pinDigests) ? pinDigests : [];
  return list.some((p) => normalizeDigest(p) === d);
}

/**
 * Ref-entry verdict (pure). A ref names a revision the fetcher resolved; the
 * snapshots are what is materialized. A ref entry therefore answers against
 * the model's pin claims: its target IS the pinned revision ⇒ "pinned"; a
 * pin exists for the model and this ref is not it ⇒ "stray" (drift next to
 * the pin). Ungoverned models keep their ref noise dropped, so "unpinned"
 * stays reachable only for completeness.
 * @param {boolean} pinned this ref's target matches a pin claim
 * @param {boolean} governed the model has at least one pin claim
 * @returns {"pinned"|"stray"|"unpinned"}
 */
export function refEntryStatus(pinned, governed) {
  if (pinned) return "pinned";
  return governed ? "stray" : "unpinned";
}

/**
 * @typedef {object} EngineImageEntry
 * @property {string} reference repo (docker Repository)
 * @property {string} tag "<none>" when dangling
 * @property {string|null} repoDigest normalized repo digest
 * @property {number|null} sizeBytes null when docker could not answer
 * @property {string} imageId docker image id, sha256: stripped, 19 chars
 * @property {boolean} inferenceEngine engine-relevant by reference match
 * @property {boolean} pinned some recipe pin's digest matches this image
 * @property {string[]} pinnedBy recipe names claiming that pin
 */

/**
 * @typedef {object} CheckpointEntry
 * @property {string} model org/name
 * @property {string} revision snapshot hash / commit, or "<dir>" for plain dirs
 * @property {string|null} refName default-ref name when surfaced ("main")
 * @property {number|null} sizeBytes null when du could not answer
 * @property {"pinned"|"unpinned"|"stray"|"missing"} status
 * @property {string[]} pinnedBy recipes pinning this exact revision
 */

/**
 * @typedef {object} PinClaim
 * @property {"image"|"model"} kind
 * @property {string} recipe
 * @property {string} ref digest or `model@revision`
 * @property {boolean} present on disk locally
 * @property {"pinned"|"missing"} status
 */

/**
 * @typedef {object} LibraryReport
 * @property {number} version 1
 * @property {EngineImageEntry[]} engineImages
 * @property {CheckpointEntry[]} checkpoints
 * @property {PinClaim[]} pins
 * @property {string[]} errors raw-source failures, never swallowed silently
 */

export const LIBRARY_REPORT_VERSION = 1;

/** du -sb with failure → null + reported error (never 0, never silence). */
async function duSize(dir, exec, errors) {
  try {
    const out = await exec(`du -sb "${dir}" 2>/dev/null | cut -f1`);
    const n = parseSizeBytes(out);
    if (n == null) errors.push(`du unparseable for ${dir}`);
    return n;
  } catch (e) {
    errors.push(`du ${dir}: ${e.message}`);
    return null;
  }
}

/**
 * Scan one root for model dirs. HF cache layout (`models--org--name` with
 * refs/ + snapshots/) is parsed exactly; other dirs get the plain shape
 * (revision "<dir>"). du failure → null size + error.
 * @param {string} root
 * @param {(cmd: string) => Promise<string>} exec
 * @param {string[]} errors
 * @param {Map<string, Map<string, string[]>>} byModel
 * @returns {Promise<CheckpointEntry[]>}
 */
async function scanModelDirs(root, exec, errors, byModel) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    if (e && e.code !== "ENOENT") errors.push(`readdir ${root}: ${e.message}`);
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const isHf = ent.name.startsWith("models--");
    const model = isHf ? ent.name.replace(/^models--/, "").replace(/--+/g, "/") : ent.name;
    const full = path.join(root, ent.name);
    const pinMap = byModel.get(model) || null;

    if (isHf) {
      const refs = {};
      try {
        for (const name of fs.readdirSync(path.join(full, "refs"))) {
          if (name.includes("/") || name.includes("\0")) continue;
          const raw = fs.readFileSync(path.join(full, "refs", name), "utf-8");
          refs[name] = raw.trim().toLowerCase();
        }
      } catch {
        /* no refs dir — snapshots still tell the truth */
      }
      let snapDirs = [];
      try {
        snapDirs = fs
          .readdirSync(path.join(full, "snapshots"), { withFileTypes: true })
          .filter((d) => d.isDirectory() && HEX_RE.test(d.name))
          .map((d) => d.name.toLowerCase());
      } catch {
        /* nothing materialized */
      }
      const snapSet = new Set(snapDirs);

      for (const hash of snapDirs) {
        out.push({
          model,
          revision: hash,
          refName: null,
          sizeBytes: await duSize(path.join(full, "snapshots", hash), exec, errors),
          status: checkpointPinStatus(hash, pinMap ? [...pinMap.keys()].map((revision) => ({ revision })) : []),
          pinnedBy: pinMap && pinMap.has(hash) ? [...pinMap.get(hash)] : [],
        });
      }
      // A named ref whose target is NOT a materialized snapshot is disk
      // drift worth surfacing: it names a revision the operator believes is
      // live. Governance (a recipe pin) decides the verdict.
      for (const [refName, rev] of Object.entries(refs)) {
        if (snapSet.has(rev)) continue;
        const pinned = Boolean(pinMap && pinMap.has(rev));
        const isDefault = DEFAULT_REFS.has(refName);
        if (!isDefault && !pinned) continue; // ungoverned named ref — noise, not a finding
        out.push({
          model,
          revision: rev,
          refName,
          sizeBytes: null, // not a materialized snapshot — size unknown
          status: refEntryStatus(pinned, Boolean(pinMap)),
          pinnedBy: pinned ? [...pinMap.get(rev)] : [],
        });
      }
      // Pin claims for this model absent from disk ⇒ missing findings.
      // A ref naming the pin does NOT make it present: only a materialized
      // snapshot does (the Library answers what is ON DISK).
      if (pinMap) {
        for (const [rev, names] of pinMap) {
          if (snapSet.has(rev)) continue;
          out.push({
            model,
            revision: rev,
            refName: null,
            sizeBytes: null,
            status: "missing",
            pinnedBy: [...names],
          });
        }
      }
    } else {
      // Plain model dir (e.g. /host/models/<name>): one implicit revision.
      // Pins keying this model name cannot match a "<dir>" revision — the
      // model's real cache entry, when present, carries the verdict.
      out.push({
        model,
        revision: "<dir>",
        refName: null,
        sizeBytes: await duSize(full, exec, errors),
        status: pinMap ? "stray" : "unpinned",
        pinnedBy: [],
      });
    }
  }
  return out;
}

/** Model roots to scan: env override first, then the known fleet locations. */
export function defaultModelRoots(env) {
  const roots = [];
  const push = (v) => {
    const s = String(v ?? "").trim();
    if (s && !roots.includes(s)) roots.push(s);
  };
  push(env.HERD_MODEL_ROOTS);
  push(env.HF_HUB_CACHE);
  push(env.HF_HOME ? path.join(String(env.HF_HOME), "hub") : "");
  push("/host/root/.cache/huggingface/hub"); // agent container host mount
  push("/host/models");
  return roots;
}

/**
 * Collect the library report. Never throws; raw-source failures land in
 * report.errors. deps: {exec?, recipes? | recipePath?, env?}.
 *
 * @param {{exec?: (cmd: string) => Promise<string>, recipes?: object[],
 *   recipePath?: string, env?: object}} [deps]
 * @returns {Promise<LibraryReport>}
 */
export async function collectLibrary(deps = {}) {
  const exec = deps.exec || runShell;
  const env = deps.env && typeof deps.env === "object" ? deps.env : {};
  const errors = [];

  // Recipe pin claims — through the validated loader (fail-soft like main.js).
  let recipes = Array.isArray(deps.recipes) ? deps.recipes : null;
  if (!recipes) {
    const defaultPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "config",
      "recipes.json"
    );
    const p = deps.recipePath || defaultPath;
    try {
      recipes = loadRecipes(p).recipes;
    } catch (e) {
      errors.push(`recipes unavailable (${p}): ${e.message} — reporting disk truth with no pins`);
      recipes = [];
    }
  }
  const { byDigest, byModel } = buildPinsIndex(recipes);

  // An explicit empty pin set from an unreadable store is a finding, not
  // silence (deps.pinsNote from the caller's fail-soft recipe load).
  if (typeof deps.pinsNote === "string" && deps.pinsNote) errors.push(deps.pinsNote);

  // ── Engine images (all local images; engine-relevant flagged) ───────
  /** @type {EngineImageEntry[]} */
  const engineImages = [];
  try {
    const out = await exec(
      'docker images --format "{{.Repository}} {{.Tag}} {{.Digest}} {{.Size}} {{.ID}}" 2>/dev/null'
    );
    for (const line of String(out || "").split("\n").filter(Boolean)) {
      const [reference, tag, digest, size, imageId] = line.split(" ");
      const d = normalizeDigest(digest);
      const pinners = d ? byDigest.get(d) || [] : [];
      engineImages.push({
        reference: String(reference || "").trim(),
        tag: String(tag || "").trim() || "<none>",
        repoDigest: d,
        sizeBytes: parseSizeBytes(size),
        imageId: String(imageId || "").replace(/^sha256:/, "").slice(0, 19),
        inferenceEngine: isEngineImage(reference),
        pinned: pinners.length > 0,
        pinnedBy: [...pinners],
      });
    }
  } catch (e) {
    errors.push(`docker images: ${e.message}`);
  }

  // Pins: image claims resolved against local digests.
  const localDigests = new Set(engineImages.map((i) => i.repoDigest).filter(Boolean));
  /** @type {PinClaim[]} */
  const pins = [];
  for (const [digest, names] of byDigest) {
    const present = localDigests.has(digest);
    if (!present) errors.push(`image pin ${digest} (${names.join(",")}) not present locally`);
    for (const recipe of names) {
      pins.push({ kind: "image", recipe, ref: digest, present, status: present ? "pinned" : "missing" });
    }
  }

  // ── Checkpoints on disk ──────────────────────────────────────────────
  /** @type {CheckpointEntry[]} */
  const checkpoints = [];
  for (const root of defaultModelRoots(env)) {
    const found = await scanModelDirs(root, exec, errors, byModel);
    checkpoints.push(...found);
  }

  // Model claims resolved against disk. A pin is PRESENT only when the
  // revision is a materialized snapshot — a ref naming it is drift, not
  // bytes on disk.
  for (const [model, revMap] of byModel) {
    for (const [rev, names] of revMap) {
      const entry = checkpoints.find(
        (c) => c.model === model && c.revision === rev && c.status !== "missing" && c.refName === null
      );
      const present = Boolean(entry);
      for (const recipe of names) {
        pins.push({
          kind: "model",
          recipe,
          ref: `${model}@${rev}`,
          present,
          status: present ? "pinned" : "missing",
        });
      }
    }
  }

  return {
    version: LIBRARY_REPORT_VERSION,
    engineImages,
    checkpoints,
    pins,
    errors,
  };
}

export default { collectLibrary };
