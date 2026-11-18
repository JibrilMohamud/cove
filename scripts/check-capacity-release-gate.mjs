import assert from "node:assert/strict";
import {
  projectedRequestFailure,
  strictProjectionPhasePass,
} from "./performance/capacity-release-gate.mjs";
import { responseCompletionSummary } from "./performance/response-completion-diagnostics.mjs";
const drains = responseCompletionSummary([
  { ok: true, ms: 40, completeMs: 90, bodyDrainMs: 50, wireBytes: 100, decodedBytes: 200 },
  { ok: true, ms: 40, completeMs: 1200, bodyDrainMs: 1160, wireBytes: 500, decodedBytes: 1000 },
  { ok: false, ms: 55, completeMs: null, bodyDrainMs: null, wireBytes: null, decodedBytes: null },
]);
assert.equal(drains.received, 3);
assert.equal(drains.completed, 2);
assert.equal(drains.drained, 2);
assert.equal(drains.incomplete, 1);
assert.equal(drains.completionMaxMs, 1200);
assert.equal(drains.bodyDrainP95Ms, 1160);
assert.equal(drains.slowBodyOver500Ms, 1);
assert.equal(drains.wireBytes, 600);
assert.equal(drains.decodedBytes, 1200);
// A slow body is diagnostic, not permission to discard the request or
// rewrite the 800ms header-TTFB and zero-dropped-arrival release gates.
assert.equal(projectedRequestFailure({ ok: true, ms: 799, completeMs: 1200 }), null);
assert.equal(projectedRequestFailure({ ok: true, ms: 800, completeMs: 800 }), "request-max-800ms");
const ok = { ok: true, ms: 799.999, status: 200 };
assert.equal(projectedRequestFailure(ok), null);
for (const [row, code] of [
  [{ ...ok, ms: 800 }, "request-max-800ms"],
  [{ ...ok, ms: 800.001 }, "request-max-800ms"],
  [{ ...ok, ms: Infinity }, "invalid-duration"],
  [{ ...ok, ms: NaN }, "invalid-duration"],
  [{ ...ok, ok: false, ms: 15, status: 503 }, "invalid-response"],
  [null, "invalid-response"],
])
  assert.equal(projectedRequestFailure(row), code);
const phase = {
  model: "projection",
  offered: 12000,
  total: 12000,
  valid: 12000,
  dropped: 0,
  cancelledUnsent: 0,
  earlyStopped: false,
  p95: 120,
  p99: 240,
  max: 799,
  transportControls: { total: 78, valid: 78, max: 70 },
  background: [{ ok: true }],
};
assert.equal(strictProjectionPhasePass(phase), true);
for (const change of [
  { model: "canonical" },
  { valid: 11999 },
  { total: 11999 },
  { offered: 11999 },
  { dropped: 1 },
  { cancelledUnsent: 1 },
  { earlyStopped: true },
  { p95: 600 },
  { p99: 750 },
  { max: 800 },
  { transportControls: { total: 78, valid: 77, max: 70 } },
  { background: [{ ok: false }] },
]) {
  assert.equal(strictProjectionPhasePass({ ...phase, ...change }), false, JSON.stringify(change));
}
console.log("CAPACITY_HARD_GATES_PASS");
