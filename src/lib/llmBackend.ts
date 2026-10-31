/**
 * Display labels for LLM backends (STAT1, #34). One table shared by the
 * Spark page badge and the Overview tile so the two never disagree.
 */
import type { LlmMetrics } from "../api/types";

export type LlmBackend = NonNullable<LlmMetrics["backend"]>;

const LABELS: Record<LlmBackend, string> = {
  vllm: "vLLM",
  "llama.cpp": "llama.cpp",
  sglang: "sgLang",
  ds4: "ds4",
  exl3: "EXL3",
  q27: "q27",
  tensorfold: "TensorFold",
  freetoken: "FreeToken",
  strata: "Strata",
  locals: "Locals",
  splash: "Splash",
  lmstudio: "LM Studio",
  ollama: "Ollama",
  tabbyapi: "TabbyAPI",
};

/** Label for a backend id; unknown ids pass through, null gives `fallback`. */
export function llmBackendLabel(backend: string | null | undefined, fallback = "LLM"): string {
  if (!backend) return fallback;
  return (LABELS as Record<string, string>)[backend] ?? backend;
}

/** Rate for display: "—" when the engine does not measure it. */
export function formatTps(value: number | null | undefined, digits: number): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}
