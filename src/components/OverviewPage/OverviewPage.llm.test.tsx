import { describe, expect, it } from "vitest";
import { render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import type { LlmMetrics, SparkSnapshot } from "../../api/types";
import { OverviewPage } from "./OverviewPage";

// STAT1 (#34): engine labels and unmeasured rates on the Sparks card.
function withLlm(over: Partial<LlmMetrics>): SparkSnapshot {
  const s = makeSpark("s1");
  s.metrics.llm = [{ ...s.metrics.llm[0], ...over } as LlmMetrics];
  return s;
}

describe("OverviewPage LLM tile (#34)", () => {
  it("keeps the existing vLLM label and rates", () => {
    const { container } = render(<OverviewPage sparks={[withLlm({})]} />);
    expect(container.textContent).toContain("vLLM");
    expect(container.textContent).toContain("20 tok/s");
    expect(container.textContent).toContain("200 prefill");
  });

  it("labels a new engine and shows a dash for rates it does not measure", () => {
    const { container } = render(
      <OverviewPage sparks={[withLlm({ backend: "ollama", generationTps: null, prefillTps: null })]} />
    );
    expect(container.textContent).toContain("Ollama");
    expect(container.textContent).toContain("— tok/s");
    expect(container.textContent).toContain("— prefill");
    expect(container.textContent).not.toContain("0 tok/s");
  });

  it("labels LM Studio", () => {
    const { container } = render(<OverviewPage sparks={[withLlm({ backend: "lmstudio" })]} />);
    expect(container.textContent).toContain("LM Studio");
  });
});
