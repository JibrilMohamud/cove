import assert from "node:assert/strict";
import test from "node:test";
import { summarizeOwnedPhase } from "./check-owned-ssr-capacity.mjs";
const row = (ttfbMs = 100, extra = {}) => ({
  ttfbMs,
  launchDelayMs: 0,
  valid: true,
  colo: "IAD",
  ...extra,
});
test("both full 100-RPS phases require exactly 2000 actual valid responses", () => {
  const rows = Array.from({ length: 2000 }, () => row());
  assert.equal(summarizeOwnedPhase("100-rps-20s-phase-1", 2000, rows, 0, true).pass, true);
  assert.equal(
    summarizeOwnedPhase("100-rps-20s-phase-2", 2000, rows.slice(1), 1, true).pass,
    false,
  );
  rows[1999] = row(1, { valid: false });
  const failed = summarizeOwnedPhase("100-rps-20s-phase-2", 2000, rows, 0, true);
  assert.equal(failed.pass, false);
  assert.equal(failed.rows.length, 2000, "Invalid responses remain in evidence");
});
test("one slow or late sample fails regardless of otherwise favorable percentiles", () => {
  const rows = Array.from({ length: 2000 }, () => row());
  rows[1999] = row(800);
  const result = summarizeOwnedPhase("100-rps", 2000, rows, 0, true);
  assert.equal(result.p99Ms, 100);
  assert.equal(result.maxMs, 800);
  assert.equal(result.pass, false);
  assert.equal(summarizeOwnedPhase("burst", 1, [row(100, { launchDelayMs: 100 })]).pass, false);
});
test("sustained p95/p99 thresholds are strict and do not apply to bursts", () => {
  assert.equal(
    summarizeOwnedPhase(
      "100-rps",
      2000,
      Array.from({ length: 2000 }, () => row(600)),
      0,
      true,
    ).pass,
    false,
  );
  const rows = Array.from({ length: 2000 }, (_, i) => row(i < 1960 ? 100 : 750));
  assert.equal(summarizeOwnedPhase("100-rps", 2000, rows, 0, true).pass, false);
  assert.equal(
    summarizeOwnedPhase(
      "warm-32",
      32,
      Array.from({ length: 32 }, () => row(799)),
    ).pass,
    true,
  );
});
