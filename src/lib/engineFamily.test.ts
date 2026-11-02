/**
 * CONT1 (#96) — engine-family labeling of raw containers. Covers the image
 * → family table, the unique-family case, and the family-collision case
 * (two sglang containers must get distinguishable labels).
 */
import { describe, expect, it } from "vitest";
import { containerLabels, engineFamilyFromImage, imageBasename } from "./engineFamily";
import type { ContainerInfo, ServiceInstance } from "../../shared/types";

function container(overrides: Partial<ContainerInfo> & { name: string; image: string }): ContainerInfo {
  return {
    imageDigest: null,
    status: "running",
    uptimeSeconds: 100,
    ports: [],
    memUsedMB: 512,
    memLimitMB: null,
    cpuPercent: 10,
    ...overrides,
  };
}

function service(overrides: Partial<ServiceInstance> & { name: string; port: number }): ServiceInstance {
  return {
    kind: "llm",
    engine: "sglang",
    status: "running",
    modelId: null,
    engineVersion: null,
    footprintMB: 0,
    active: false,
    polledAt: 1,
    ...overrides,
  };
}

describe("engineFamilyFromImage", () => {
  it("maps the real catalog images to their engine family", () => {
    expect(engineFamilyFromImage("lmsysorg/sglang:v1.2.0")).toBe("sglang");
    expect(engineFamilyFromImage("lmsysorg/sglang@sha256:3e79541d1e2a6818979c4aa9ca1fa63d6961d7bc50120867953ea6baaf1d8f62")).toBe("sglang");
    expect(engineFamilyFromImage("vllm/vllm-openai:v0.29.0")).toBe("vllm");
    expect(engineFamilyFromImage("ghcr.io/ai-dock/comfyui:latest")).toBe("comfyui");
    expect(engineFamilyFromImage("docker.io/lightllm/lightllm:latest")).toBe("lightllm");
  });

  it("falls back to the image basename for unknown engines", () => {
    expect(engineFamilyFromImage("qdrant/qdrant:1.11")).toBe("qdrant");
    expect(engineFamilyFromImage("sparkdash/node-agent:2.3")).toBe("node-agent");
    expect(engineFamilyFromImage("registry.local:5000/team/flash-serve:latest")).toBe("flash-serve");
  });

  it("never throws on empty/garbage input", () => {
    expect(engineFamilyFromImage("")).toBe("container");
    expect(engineFamilyFromImage(null)).toBe("container");
    expect(engineFamilyFromImage(undefined)).toBe("container");
  });

  it("imageBasename strips registry, path, tag and digest", () => {
    expect(imageBasename("docker.io/library/redis:7")).toBe("redis");
    expect(imageBasename("lmsysorg/sglang@sha256:aa")).toBe("sglang");
    expect(imageBasename("registry.local:5000/foo/bar")).toBe("bar");
  });
});

describe("containerLabels", () => {
  it("unique family per node renders as the bare family name", () => {
    const labels = containerLabels([
      container({ name: "qwen38-flash", image: "lmsysorg/sglang:v1.2.0", ports: ["8080:8080"] }),
      container({ name: "qdrant", image: "qdrant/qdrant:1.11" }),
    ]);
    expect(labels.map((l) => l.label)).toEqual(["sglang", "qdrant"]);
    // The real name always survives for the tooltip.
    expect(labels.map((l) => l.name)).toEqual(["qwen38-flash", "qdrant"]);
  });

  it("collision case: two sglang containers get distinguishable labels via served model", () => {
    const labels = containerLabels(
      [
        container({ name: "qwen38-flash", image: "lmsysorg/sglang:v1.2.0", ports: ["8080:8080"] }),
        container({ name: "aeon-tp2-262k", image: "lmsysorg/sglang:v1.2.0", ports: ["8081:8081"] }),
      ],
      [
        service({ name: "llm-tp1", port: 8080, modelId: "qwen3.8-27b" }),
        service({ name: "aeon-worker", port: 8081, modelId: "aeon-27b" }),
      ],
    );
    expect(labels[0]!.label).toBe("sglang qwen3.8-27b");
    expect(labels[1]!.label).toBe("sglang aeon-27b");
    expect(labels[0]!.label).not.toBe(labels[1]!.label);
  });

  it("collision without served model falls back to the host port", () => {
    const labels = containerLabels([
      container({ name: "flash-a", image: "lmsysorg/sglang:v1.2.0", ports: ["8080:8080"] }),
      container({ name: "flash-b", image: "lmsysorg/sglang:v1.2.0", ports: ["8084:11235"] }),
    ]);
    expect(labels[0]!.label).toBe("sglang :8080");
    // Host side of "8084:11235" is 8084, not the container port.
    expect(labels[1]!.label).toBe("sglang :8084");
  });

  it("collision with no ports and no service falls back to the container name", () => {
    const labels = containerLabels([
      container({ name: "flash-a", image: "vllm/vllm-openai:v0.29.0", ports: [] }),
      container({ name: "flash-b", image: "vllm/vllm-openai:v0.29.1", ports: [] }),
    ]);
    expect(labels[0]!.label).toBe("vllm flash-a");
    expect(labels[1]!.label).toBe("vllm flash-b");
  });

  it("a service without modelId still distinguishes by service name", () => {
    const labels = containerLabels(
      [
        container({ name: "ex-a", image: "vllm/vllm-openai:v0.29.0", ports: ["8000:8000"], status: "exited" }),
        container({ name: "ex-b", image: "vllm/vllm-openai:v0.29.0", ports: ["8001:8000"], status: "running" }),
      ],
      [service({ name: "llm-offline", port: 8000, modelId: null, status: "stopped" })],
    );
    expect(labels[0]!.label).toBe("vllm llm-offline");
    expect(labels[1]!.label).toBe("vllm :8001");
    expect(labels[0]!.status).toBe("exited");
    expect(labels[1]!.status).toBe("running");
  });
});
