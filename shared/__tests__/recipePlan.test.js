import test from "node:test";
import assert from "node:assert/strict";
import { validateArgv, buildRecipePlan, executePlanStep } from "../recipePlan.js";

const def = {
  id: "qwen38-27b-stock-sglang-tp1-gx10",
  source: { origin: "hasso5703/alzeo", upstreamCommit: "01902c67709c4164c30ccf036422bfed6f172158", license: "MIT" },
  lifecycle: {
    workdir: "~/dgx-spark-qwen38",
    exclusivePorts: [8080, 8081],
    exclusiveWith: ["qwen38-flash-next-sglang-tp1-gx10"],
    loadingDeadlineMs: 540000,
    install: {
      argv: ["./install.sh", "--plan"],
      executeArgv: ["./install.sh"],
      env: { MODEL_CHOICE: "stock" },
      requiresSudo: true,
      estDiskGB: 101,
      estBootMs: 540000,
      notes: ["clone alzeo at the pinned commit; never curl|sh"],
    },
    switch: {
      argv: ["./switch-model.sh", "stock"],
      requiresSudo: false,
      startsEngine: false,
    },
  },
};

test("rejects shell injection and unknown scripts", () => {
  assert.equal(validateArgv(["./install.sh", "--plan"]).ok, true);
  assert.equal(validateArgv(["./install.sh; rm -rf /"]).ok, false);
  assert.equal(validateArgv(["curl", "-fsSL", "https://get.alzeo.ai"]).ok, false);
  assert.equal(validateArgv(["./not-allowed.sh"]).ok, false);
});

test("install preview lists sudo/disk/downtime and pinned source", () => {
  const p = buildRecipePlan(def, "install");
  assert.equal(p.ok, true);
  assert.deepEqual(p.plan.steps[0].argv, ["./install.sh", "--plan"]);
  assert.equal(p.plan.requiresSudo, true);
  assert.equal(p.plan.estDiskGB, 101);
  assert.equal(p.plan.pinned.commit, "01902c67709c4164c30ccf036422bfed6f172158");
  assert.match(p.plan.notes[0], /never curl\|sh/);
});

test("exclusive port occupancy blocks without killing the other lane", () => {
  const p = buildRecipePlan(def, "install", {
    portOccupier: { 8080: "qwen38-flash-next-sglang-tp1-gx10" },
  });
  assert.equal(p.ok, false);
  assert.match(p.error, /8080/);
});

test("missing checkout is a preview blocker, not a silent clone", () => {
  const p = buildRecipePlan(def, "install", { requireWorkdir: true, workdirExists: false });
  assert.equal(p.ok, false);
  assert.match(p.error, /never curl\|sh/);
});

test("execute uses argv array via injected exec; confirm path can use executeArgv", async () => {
  const preview = buildRecipePlan(def, "install");
  assert.equal(preview.plan.steps[0].argv[1], "--plan");
  const run = buildRecipePlan(def, "install", { execute: true });
  assert.deepEqual(run.plan.steps[0].argv, ["./install.sh"]);
  const seen = [];
  const out = await executePlanStep(run.plan.steps[0], async (file, args, opts) => {
    seen.push({ file, args, opts });
    return { ok: true, stdout: "planned" };
  });
  assert.equal(out.ok, true);
  assert.deepEqual(seen[0].file, "./install.sh");
  assert.deepEqual(seen[0].args, []);
  assert.equal(seen[0].opts.env.MODEL_CHOICE, "stock");
});
