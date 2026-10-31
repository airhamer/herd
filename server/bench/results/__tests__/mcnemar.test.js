import { test } from "node:test";
import assert from "node:assert/strict";
import { mcnemarCompare, mcnemarExactP, NOISE_P } from "../mcnemar.js";

test("exact McNemar p: known values", () => {
  assert.equal(NOISE_P, 0.05);
  assert.equal(mcnemarExactP(0, 0), 1);
  assert.equal(mcnemarExactP(1, 0), 1);
  assert.equal(mcnemarExactP(10, 0), 0.001953125); // 2 × 0.5^10
  assert.equal(mcnemarExactP(0, 10), 0.001953125);
  // 2 × P(X ≤ 5 | n = 20, ½) = 2 × 21700 / 2^20
  assert.ok(Math.abs(mcnemarExactP(5, 15) - 0.04138946533203125) < 1e-12);
  assert.ok(Math.abs(mcnemarExactP(15, 5) - mcnemarExactP(5, 15)) < 1e-15);
  assert.equal(mcnemarExactP(7, 7), 1);
  // Large n: log-space terms, no overflow or NaN.
  const p = mcnemarExactP(0, 400);
  assert.ok(p > 0 && p < 1e-100);
  assert.equal(mcnemarExactP(200, 200), 1);
  assert.throws(() => mcnemarExactP(-1, 2), TypeError);
});

test("mcnemarCompare pairs by id and skips unscored items", () => {
  const a = [
    { id: "x1", pass: true },
    { id: "x2", pass: true },
    { id: "x3", pass: false },
    { id: "x4", pass: false },
    { id: "x5", pass: null },
    { id: "x6", pass: true },
  ];
  const b = [
    { id: "x1", pass: true },
    { id: "x2", pass: false },
    { id: "x3", pass: true },
    { id: "x4", pass: false },
    { id: "x5", pass: true },
    { id: "x7", pass: true },
  ];
  assert.deepEqual(mcnemarCompare(a, b), {
    paired: 4,
    both_pass: 1,
    both_fail: 1,
    baseline_only: 1,
    candidate_only: 1,
    p: 1,
    within_noise: true,
  });
});

test("ten one-way flips are significant", () => {
  const a = Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, pass: i >= 10 }));
  const b = Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, pass: true }));
  const out = mcnemarCompare(a, b);
  assert.equal(out.candidate_only, 10);
  assert.equal(out.p, 0.001953);
  assert.equal(out.within_noise, false);
});
