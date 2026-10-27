import test from "node:test";
import assert from "node:assert/strict";
import { SystemCollector, parseClockCap } from "../SystemCollector.js";

const BOOT = "0f1e2d3c-4b5a-6978-8877-665544332211";
const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("parseClockCap: marker with matching boot_id", () => {
  assert.equal(parseClockCap(`1800 ${BOOT}\n${BOOT}`), 1800);
});

test("parseClockCap: marker without boot_id is trusted", () => {
  assert.equal(parseClockCap(`2200\n${BOOT}`), 2200);
});

test("parseClockCap: stale marker from a previous boot is ignored", () => {
  assert.equal(parseClockCap(`1800 ${OTHER}\n${BOOT}`), null);
});

test("parseClockCap: no marker / junk → null", () => {
  assert.equal(parseClockCap(BOOT), null);
  assert.equal(parseClockCap(""), null);
  assert.equal(parseClockCap("cap\n"), null);
  assert.equal(parseClockCap(`0 ${BOOT}\n${BOOT}`), null);
});

test("parseClockCap: a bare boot_id that starts with digits is not a cap", () => {
  assert.equal(parseClockCap("139dcc9e-1111-2222-3333-444455556666"), null);
  assert.equal(parseClockCap("12345678-1111-2222-3333-444455556666\n"), null);
  assert.equal(parseClockCap(`1800 139dcc9e-1111-2222-3333-444455556666\n139dcc9e-1111-2222-3333-444455556666`), 1800);
});

// Shaped like OUR remote probe: `---`-separated sections (GPU, VRAM, apps,
// meminfo, clock-cap). Fork has no __SECTION__ named-section parser.
function probeOutput(smLine, clockCap) {
  return [
    smLine,
    "---",
    "[N/A], [N/A]",
    "---",
    "",
    "---",
    "MemTotal:       125000000 kB\nMemAvailable:   60000000 kB",
    "---",
    clockCap,
  ].join("\n");
}

test("_getRemoteGpu: clock cap marker lands on throttle.clockCapMHz", async () => {
  const c = new SystemCollector({ id: "spark1", host: "spark1", lanIp: "10.0.0.1" });
  c._nvErrNoMemory = async () => 0;
  c._kernelErrors = async () => null;
  const output = probeOutput(
    "52, 96, 60.1, 140, 1794, 3003, Not Active, Not Active, Not Active, Not Active",
    `1800 ${BOOT}\n${BOOT}`,
  );
  const gpu = await c._getRemoteGpu(async () => output);
  assert.equal(gpu.throttle.clockCapMHz, 1800);
  assert.match(gpu.throttle.detail, /Clock locked ≤ 1800 MHz/);
});

test("_getRemoteGpu: no marker → clockCapMHz null", async () => {
  const c = new SystemCollector({ id: "spark1", host: "spark1", lanIp: "10.0.0.1" });
  c._nvErrNoMemory = async () => 0;
  c._kernelErrors = async () => null;
  const output = probeOutput(
    "52, 96, 60.1, 140, 2418, 3003, Not Active, Not Active, Not Active, Not Active",
    BOOT,
  );
  const gpu = await c._getRemoteGpu(async () => output);
  assert.equal(gpu.throttle.clockCapMHz, null);
  assert.equal(gpu.throttle.detail, "Clocks not limited");
});
