/**
 * CONT1 (#96): the node detail Containers panel labels rows by engine
 * family (with a distinguisher on family collisions) instead of raw docker
 * names; the real container name stays as the tooltip.
 */
import { describe, expect, it } from "vitest";
import { render } from "../../testing/render";
import { NodeDetail, type NodeDetailProps } from "./NodeDetail";
import type { ContainerInfo, ServiceInstance } from "../../../shared/types";

function ctr(overrides: Partial<ContainerInfo> & { name: string; image: string }): ContainerInfo {
  return {
    imageDigest: null,
    status: "running",
    uptimeSeconds: 120,
    ports: [],
    memUsedMB: 512,
    memLimitMB: null,
    cpuPercent: 10,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<NodeDetailProps> = {}): NodeDetailProps {
  return {
    nodeId: "gx10-1c2c",
    nodeName: "gx10-1c2c",
    lanIp: "192.168.50.226",
    role: "standalone",
    rank: null,
    groupId: null,
    online: true,
    gpu: null,
    cpu: null,
    mem: null,
    disk: [],
    net: [],
    containers: [],
    services: [],
    versions: [],
    requests: null,
    topology: null,
    memory: null,
    polledAt: Date.now(),
    ...overrides,
  };
}

describe("NodeDetail containers (CONT1 #96)", () => {
  it("labels a unique-family container by family and keeps the raw name in the tooltip", () => {
    const { container } = render(
      <NodeDetail
        {...makeDetail({
          containers: [
            ctr({ name: "qwen38-flash", image: "lmsysorg/sglang:v1.2.0", ports: ["8080:8080"] }),
            ctr({ name: "qdrant", image: "qdrant/qdrant:1.11", status: "exited" }),
          ],
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("sglang");
    expect(text).toContain("qdrant");
    // Raw names are no longer the row label…
    const labels = [...container.querySelectorAll("span[title]")].filter((el) =>
      ["qwen38-flash", "qdrant"].includes(el.getAttribute("title") ?? ""),
    );
    expect(labels.length).toBe(2);
    // …but survive as tooltips; the image subtitle carries name + image.
    expect(text).toContain("lmsysorg/sglang:v1.2.0");
    expect(text).toContain("exited");
  });

  it("two sglang containers on one node render distinguishable labels", () => {
    const services: ServiceInstance[] = [
      {
        name: "llm-tp1",
        kind: "llm",
        engine: "sglang",
        port: 8080,
        status: "running",
        modelId: "qwen3.8-27b",
        engineVersion: null,
        footprintMB: 0,
        active: true,
        polledAt: 1,
      },
    ];
    const { container } = render(
      <NodeDetail
        {...makeDetail({
          containers: [
            ctr({ name: "qwen38-flash", image: "lmsysorg/sglang:v1.2.0", ports: ["8080:8080"] }),
            ctr({ name: "aeon-tp2-262k", image: "lmsysorg/sglang:v1.2.0", ports: ["8081:8081"] }),
          ],
          services,
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("sglang qwen3.8-27b");
    expect(text).toContain("sglang :8081");
  });
});
