import assert from "node:assert/strict";
import test from "node:test";
import { pairedIngressShadowEvidence } from "./paired-ingress-shadow.mjs";

test("concurrent no-DB control preserves exact counts and paired schedule proximity", () => {
  const target = [
    { firstByteMs: 120, phaseOffsetMs: 0, secret: "nope" },
    { firstByteMs: 804.21, phaseOffsetMs: 2010, bearer: "not saved" },
    { firstByteMs: 100, phaseOffsetMs: 4000 },
  ];
  const controls = [
    { firstByteMs: 60, phaseOffsetMs: 0, valid: true, dropped: false },
    { firstByteMs: 83.12, phaseOffsetMs: 2000, valid: true, dropped: false },
    { firstByteMs: 90, phaseOffsetMs: 4000, valid: true, dropped: false },
  ];
  const result = pairedIngressShadowEvidence(target, controls, 3);
  assert.equal(result.passed, true);
  assert.equal(result.valid, 3);
  assert.equal(result.maxMs, 90);
  assert.equal(result.atOrAbove800Ms, 0);
  assert.equal(result.nearSlowestCursorControlCount, 1);
  assert.equal(result.nearSlowestCursorControlMaxMs, 83.12);
  assert.equal(result.nearestControlTtfbMs, 83.12);
  assert.equal(result.nearestControlScheduledSeparationMs, 10);
  assert.doesNotMatch(JSON.stringify(result), /bearer|secret|not saved|nope/);
});

test("a 200 OK shadow at the hard 800ms maximum blocks pass", () => {
  const result = pairedIngressShadowEvidence([], [
    { firstByteMs: 800, phaseOffsetMs: 0, valid: true, dropped: false },
  ], 1);
  assert.equal(result.passed, false);
  assert.equal(result.valid, 1);
  assert.equal(result.atOrAbove800Ms, 1);
});

test("drops, invalid results and unmeasured observations are not forgiven", () => {
  const dropped = pairedIngressShadowEvidence([], [
    { dropped: true, valid: false, phaseOffsetMs: 0 },
  ], 1);
  assert.equal(dropped.passed, false);
  assert.equal(dropped.dropped, 1);
  const invalid = pairedIngressShadowEvidence([], [
    { dropped: false, valid: false, phaseOffsetMs: 0, firstByteMs: 20 },
  ], 1);
  assert.equal(invalid.passed, false);
  const unmeasured = pairedIngressShadowEvidence([], [
    { dropped: false, valid: true, phaseOffsetMs: 0 },
  ], 1);
  assert.equal(unmeasured.passed, false);
});

test("unknown nearby control is not interpreted as external latency evidence", () => {
  const result = pairedIngressShadowEvidence(
    [{ firstByteMs: 1200, phaseOffsetMs: 10000 }],
    [{ firstByteMs: 50, phaseOffsetMs: 0, valid: true, dropped: false }],
    1,
  );
  assert.equal(result.nearSlowestCursorControlCount, 0);
  assert.equal(result.nearSlowestCursorControlMaxMs, null);
  assert.equal(result.nearestControlScheduledSeparationMs, 10000);
  assert.throws(() => pairedIngressShadowEvidence(null, [], 1), /Invalid/);
  assert.throws(() => pairedIngressShadowEvidence([], [], 0), /Invalid/);
});
