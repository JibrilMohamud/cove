import assert from "node:assert/strict";
import test from "node:test";
import {
  summarizeOwnedPhase,
  ownedServerTiming,
  ownedStageFailureKind,
} from "./check-owned-ssr-capacity.mjs";
const row = (ttfbMs = 100, extra = {}) => ({
  ttfbMs,
  launchDelayMs: 0,
  valid: true,
  colo: "IAD",
  ...extra,
});
test("numeric D1 diagnostic names survive without copying descriptions or private text", () => {
  assert.deepEqual(
    ownedServerTiming(
      'cove_ssr_read_catalog;dur=0, cove_ssr_read_d1_resource_window;dur=0, cove_ssr_read_d1_queue_full;dur=0, cove_ssr_read_d1_queue_wait;dur=0, cove_ssr_primary_d1_overload;dur=0, cove_gateway;dur=42.5, cove_secret;dur=7;desc="TOKEN", cookie;desc="TOKEN", cove_bad;dur=NaN, cove_bad;dur=-1',
    ),
    {
      cove_ssr_read_catalog: 0,
      cove_ssr_read_d1_resource_window: 0,
      cove_ssr_read_d1_queue_full: 0,
      cove_ssr_read_d1_queue_wait: 0,
      cove_ssr_primary_d1_overload: 0,
      cove_gateway: 42.5,
    },
  );
  assert.deepEqual(ownedServerTiming(null), {});
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

test("protected stage failure breakdown remains bounded and cannot hide invalid responses", () => {
  assert.equal(ownedStageFailureKind("d1-resource-window"), "d1-resource-window");
  assert.equal(ownedStageFailureKind("d1-queue-full"), "d1-queue-full");
  assert.equal(ownedStageFailureKind("d1-queue-wait"), "d1-queue-wait");
  assert.equal(ownedStageFailureKind("service-overloaded"), "service-overloaded");
  assert.equal(
    ownedStageFailureKind(null, { cove_ssr_read_d1_resource_window: 0 }),
    "d1-resource-window",
  );
  assert.equal(ownedStageFailureKind(null, { cove_ssr_read_d1_queue_full: 0 }), "d1-queue-full");
  assert.equal(ownedStageFailureKind(null, { cove_ssr_read_d1_queue_wait: 0 }), "d1-queue-wait");
  assert.equal(
    ownedStageFailureKind(null, { cove_ssr_primary_d1_overload: 0 }),
    "service-overloaded",
  );
  assert.equal(
    ownedStageFailureKind("private token", { cove_ssr_read_d1_resource_window: 12 }),
    null,
    "Never infer an overload subtype from a nonzero or arbitrary marker",
  );
  assert.equal(ownedStageFailureKind("sensitive D1 error or SQL"), null);
  assert.equal(ownedStageFailureKind(null), null);
  const rows = [
    row(100, { status: 200 }),
    row(90, { valid: false, status: 503, failureKind: "d1-resource-window" }),
    row(90, { valid: false, status: 503, failureKind: "d1-queue-full" }),
    row(90, { valid: false, status: 503, failureKind: "private token" }),
    row(90, {
      valid: false,
      status: 503,
      failureKind: ownedStageFailureKind(null, { cove_ssr_read_d1_resource_window: 0 }),
    }),
    row(90, { valid: false, status: 429, failureKind: "rate-limited" }),
    row(90, { valid: false, status: 0, failureKind: null }),
  ];
  const result = summarizeOwnedPhase("burst", rows.length, rows);
  assert.equal(result.pass, false);
  assert.equal(result.valid, 1);
  assert.equal(result.rows.length, rows.length);
  assert.deepEqual(result.httpFailures, { 429: 1, 503: 4 });
  assert.deepEqual(result.failureKinds, {
    "d1-resource-window": 2,
    "d1-queue-full": 1,
    "unclassified-503": 1,
    "rate-limited": 1,
    "request-failed": 1,
  });
});
