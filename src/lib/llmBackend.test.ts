import { describe, expect, it } from "vitest";
import { formatTps, llmBackendLabel } from "./llmBackend";

describe("llmBackendLabel", () => {
  it("keeps the six existing labels", () => {
    expect(llmBackendLabel("vllm")).toBe("vLLM");
    expect(llmBackendLabel("llama.cpp")).toBe("llama.cpp");
    expect(llmBackendLabel("sglang")).toBe("sgLang");
    expect(llmBackendLabel("ds4")).toBe("ds4");
    expect(llmBackendLabel("exl3")).toBe("EXL3");
    expect(llmBackendLabel("q27")).toBe("q27");
  });

  it("labels the STAT1 engines", () => {
    expect(llmBackendLabel("tensorfold")).toBe("TensorFold");
    expect(llmBackendLabel("freetoken")).toBe("FreeToken");
    expect(llmBackendLabel("strata")).toBe("Strata");
    expect(llmBackendLabel("locals")).toBe("Locals");
    expect(llmBackendLabel("splash")).toBe("Splash");
    expect(llmBackendLabel("lmstudio")).toBe("LM Studio");
    expect(llmBackendLabel("ollama")).toBe("Ollama");
    expect(llmBackendLabel("tabbyapi")).toBe("TabbyAPI");
  });

  it("passes unknown ids through and falls back on null", () => {
    expect(llmBackendLabel("mystery")).toBe("mystery");
    expect(llmBackendLabel(null)).toBe("LLM");
    expect(llmBackendLabel(null, "No backend")).toBe("No backend");
  });
});

describe("formatTps", () => {
  it("shows a dash for unmeasured rates, never 0", () => {
    expect(formatTps(null, 1)).toBe("—");
    expect(formatTps(undefined, 0)).toBe("—");
    expect(formatTps(0, 1)).toBe("0.0");
    expect(formatTps(38.46, 1)).toBe("38.5");
  });
});
