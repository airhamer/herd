// GPU clock cap marker (docs/specs/gpu-clock-cap.md).
import test from "node:test";
import assert from "node:assert/strict";
import { CLOCK_CAP_FILES, SystemCollector, parseClockCap } from "../SystemCollector.js";

const BOOT_A = "7d2c9a10-5e4f-4b3a-9c8d-112233445566";
const BOOT_B = "90ab12cd-0000-4000-8000-ffffffffffff";

test("marker paths", () => {
  assert.deepEqual(CLOCK_CAP_FILES, ["/run/sparkdash/gpu-clock-cap", "$HOME/.config/sparkdash/gpu-clock-cap"]);
});

test("a marker counts unless it was stamped in another boot", () => {
  const cases = [
    [`1650 ${BOOT_A}\n${BOOT_A}`, 1650],
    [`1650 ${BOOT_A.toUpperCase()}\n${BOOT_A}`, 1650],
    [`2100\n${BOOT_A}`, 2100],
    [`2100`, 2100],
    [`1650 ${BOOT_A}`, 1650],
    [`1650 ${BOOT_A}\n${BOOT_B}`, null],
    [`\n  \n1700 ${BOOT_B}\n${BOOT_B}\n`, 1700],
  ];
  for (const [text, want] of cases) assert.equal(parseClockCap(text), want, JSON.stringify(text));
});

test("junk, zero and boot ids are not caps", () => {
  for (const text of [undefined, null, "", "locked", "0", `0 ${BOOT_A}`, "-5", "12.5", BOOT_B, "12345678-aaaa-bbbb-cccc-1234567890ab"]) {
    assert.equal(parseClockCap(text), null, String(text));
  }
});

/** The remote GPU probe's "---"-separated sections, clock cap last. */
const probe = (capSection) =>
  [
    "61, 88, 45.2, 140, 1650, 3003, Not Active, Not Active, Not Active, Not Active",
    "[N/A], [N/A]",
    "",
    "MemTotal:       130000000 kB\nMemAvailable:   70000000 kB",
    capSection,
  ].join("\n---\n");

function remoteCollector() {
  const c = new SystemCollector({ id: "u1", host: "u1", lanIp: "192.0.2.9" });
  c._nvErrNoMemory = async () => 0;
  c._kernelErrors = async () => null;
  return c;
}

test("remote probe: the marker section sets clockCapMHz and the detail", async () => {
  let sent = "";
  const gpu = await remoteCollector()._getRemoteGpu(async (_spark, cmd) => {
    sent = cmd;
    return probe(`1650 ${BOOT_A}\n${BOOT_A}`);
  });
  assert.match(sent, /gpu-clock-cap/);
  assert.match(sent, /boot_id/);
  assert.equal(gpu.throttle.clockCapMHz, 1650);
  assert.equal(gpu.throttle.detail, "Clock locked ≤ 1650 MHz");
});

test("remote probe: no marker leaves the throttle alone", async () => {
  const gpu = await remoteCollector()._getRemoteGpu(async () => probe(BOOT_A));
  assert.equal(gpu.throttle.clockCapMHz, null);
  assert.equal(gpu.throttle.detail, "Clocks not limited");
});

test("the cap note is appended to existing throttle reasons", () => {
  const c = remoteCollector();
  const throttle = { clockCapMHz: null, detail: "Power cap" };
  c._applyClockCap(throttle, 1400);
  assert.deepEqual(throttle, { clockCapMHz: 1400, detail: "Power cap · Clock locked ≤ 1400 MHz" });
  c._applyClockCap(throttle, null);
  assert.equal(throttle.clockCapMHz, 1400);
});
