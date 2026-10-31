// Issue #33 / MGPU1 (#30): energy must count every GPU on a host.
import test from "node:test";
import assert from "node:assert/strict";
import { SystemCollector } from "../SystemCollector.js";

const line = (draw) => `55, 40, ${draw}, 350, 0x0000000000000000`;

test("_parseGpuLine sums power draw across every GPU line", () => {
  const collector = new SystemCollector({ id: "host-test", kind: "host" });
  const gpu = collector._parseGpuLine([line(100.5), line(200), line(50.25), line(10)].join("\n"));
  assert.equal(gpu.powerDraw, 100.5, "the headline GPU stays GPU 0");
  assert.equal(gpu.powerDrawTotal, 360.75);
  assert.equal(gpu.gpuCount, 4);
});

test("_parseGpuLine on one GPU: total equals the single draw", () => {
  const collector = new SystemCollector({ id: "spark-test", kind: "spark" });
  const gpu = collector._parseGpuLine(line(31.4));
  assert.equal(gpu.powerDrawTotal, 31.4);
  assert.equal(gpu.gpuCount, 1);
  const missing = collector._parseGpuLine(`55, 40, [N/A], 350, 0x0\n${line(20)}`);
  assert.equal(missing.powerDrawTotal, 20, "unreadable lines add nothing");
});
