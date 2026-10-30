/**
 * library.js — on-disk library state for LLM Components (adopted from Hasso cockpit Library).
 *
 * Reports:
 * - Engine images (docker images matching sglang/vllm/qwen/flash)
 * - Checkpoints on disk (from HF cache or model dirs, with size, pinned vs stray)
 * - Pins (from recipe imageDigest)
 *
 * Used for the Library view to show "Checkpoints on disk", "Engine Images", "Pins against upstream".
 */

import fs from "fs";
import path from "path";
import { runShell } from "./util.js";

/**
 * @typedef {object} CheckpointEntry
 * @property {string} model
 * @property {string} revision
 * @property {number} sizeGB
 * @property {boolean} onDisk
 * @property {string} status  // "pinned" | "stray" | "DRAFT_REV"
 */

/**
 * @typedef {object} EngineImage
 * @property {string} image
 * @property {string} size
 * @property {string} id
 */

/**
 * @typedef {object} LibraryState
 * @property {EngineImage[]} engineImages
 * @property {CheckpointEntry[]} checkpoints
 * @property {Array<{pinned: string, upstream: string, status: string}>} pins
 */

export async function collectLibrary({ exec = runShell } = {}) {
  const state = {
    engineImages: [],
    checkpoints: [],
    pins: [],
  };

  try {
    // Engine images via docker (mounted in agent)
    const imagesOut = await exec(
      'docker images --format "{{.Repository}}:{{.Tag}} {{.Size}} {{.ID}}" 2>/dev/null | grep -E "sglang|vllm|qwen|flash|llm" | head -10 || true'
    );
    if (imagesOut) {
      for (const line of imagesOut.split("\n").filter(Boolean)) {
        const [img, size, id] = line.split(" ");
        if (img) state.engineImages.push({ image: img, size: size || "?", id: id || "?" });
      }
    }

    // Checkpoints: scan common HF cache or /models (best effort, /host mounted)
    const hfCache = "/host/root/.cache/huggingface/hub";
    const modelDirs = ["/host/models", hfCache];
    for (const base of modelDirs) {
      try {
        if (!fs.existsSync(base)) continue;
        const entries = fs.readdirSync(base, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isDirectory()) continue;
          const full = path.join(base, ent.name);
          // HF models--org--name or direct
          let model = ent.name;
          if (model.startsWith("models--")) {
            model = model.replace("models--", "").replace(/--/g, "/");
          }
          let size = 0;
          try {
            // rough size via du if available, else skip
            const du = await exec(`du -sb "${full}" 2>/dev/null | cut -f1 || echo 0`);
            size = parseInt(du, 10) || 0;
          } catch {}
          const sizeGB = +(size / 1e9).toFixed(1);
          // Heuristic status
          let status = "on disk";
          if (/DRAFT|stray/i.test(ent.name)) status = "stray";
          if (/pinned|STOCK_REV/i.test(ent.name)) status = "pinned";
          state.checkpoints.push({
            model,
            revision: ent.name.includes("snapshots") ? "latest" : ent.name,
            sizeGB,
            onDisk: true,
            status,
          });
        }
      } catch {}
    }

    // Pins from recipes if available (imageDigest)
    // For now placeholder; real integration later via recipes
    // state.pins.push({ pinned: "sha256:...", upstream: "hf/...", status: "ok" });

  } catch (e) {
    // best effort
  }

  return state;
}

export default { collectLibrary };