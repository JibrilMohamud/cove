import assert from "node:assert/strict";
import { projectedRequestFailure, strictProjectionPhasePass } from "./performance/capacity-release-gate.mjs";
const ok = { ok: true, ms: 799.999, status: 200 };
assert.equal(projectedRequestFailure(ok), null);
for (const [row, code] of [
  [{ ...ok, ms: 800 }, "request-max-800ms"],
  [{ ...ok, ms: 800.001 }, "request-max-800ms"],
  [{ ...ok, ms: Infinity }, "invalid-duration"],
  [{ ...ok, ms: NaN }, "invalid-duration"],
  [{ ...ok, ok: false, ms: 15, status: 503 }, "invalid-response"],
  [null, "invalid-response"],
]) assert.equal(projectedRequestFailure(row), code);
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
