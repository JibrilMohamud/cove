import assert from "node:assert/strict";
import test from "node:test";
import { strictTtfbTailAttribution } from "./strict-ttfb-tail-attribution.mjs";

test("outlier is attributed using paired request timing without secrets", () => {
  const rows = [
    {
      firstByteMs: 190,
      workerMs: 100,
      downstreamFirstByteMs: 93,
      valid: true,
      token: "must-never-appear",
    },
    {
      firstByteMs: 4344.16,
      workerMs: 210,
      downstreamFirstByteMs: 195,
      valid: true,
      cursorToken: "must-not-be-recorded",
    },
    {
      firstByteMs: 1020,
      workerMs: 900,
      downstreamFirstByteMs: 800,
      valid: false,
      clientIp: "must-not-be-recorded",
    },
    { valid: false, dropped: true },
  ];
  const result = strictTtfbTailAttribution(rows);
  assert.equal(result.thresholdMs, 800);
  assert.equal(result.observedAtOrAboveCount, 2);
  assert.equal(result.validAtOrAboveCount, 1);
  assert.equal(result.invalidAtOrAboveCount, 1);
  assert.equal(result.driverAtOrAboveCount, 1);
  assert.equal(result.driverBelowCount, 1);
  assert.equal(result.driverUnmeasuredCount, 0);
  assert.equal(result.candidateTimingObservedCount, 2);
  assert.equal(result.maxDriverWorkerMs, 900);
  assert.equal(result.maxCandidateFirstByteMs, 800);
  assert.deepEqual(result.slowestRequestPaired, {
    externalFirstByteMs: 4344.16,
    driverWorkerMs: 210,
    candidateFirstByteMs: 195,
    externalMinusDriverMs: 4134.16,
    validResponse: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /token|cursor|clientIp|must-never|must-not/);
});

test("slow requests with no driver timing are classified as unknown, not transport", () => {
  const result = strictTtfbTailAttribution([
    { firstByteMs: 890, valid: true },
    { firstByteMs: 100, workerMs: 90, downstreamFirstByteMs: 85, valid: true },
  ]);
  assert.equal(result.observedAtOrAboveCount, 1);
  assert.equal(result.driverAtOrAboveCount, 0);
  assert.equal(result.driverBelowCount, 0);
  assert.equal(result.driverUnmeasuredCount, 1);
  assert.equal(result.candidateTimingObservedCount, 0);
  assert.equal(result.slowestRequestPaired.externalMinusDriverMs, null);
});

test("the hard ceiling counts 800ms as failure and handles no measured timing", () => {
  const atLimit = strictTtfbTailAttribution([{ firstByteMs: 800, workerMs: 799, valid: true }]);
  assert.equal(atLimit.observedAtOrAboveCount, 1);
  assert.equal(atLimit.driverBelowCount, 1);
  const empty = strictTtfbTailAttribution([{ status: 0, dropped: true }]);
  assert.equal(empty.observedAtOrAboveCount, 0);
  assert.equal(empty.slowestRequestPaired, null);
  assert.equal(empty.maxDriverWorkerMs, null);
  assert.throws(() => strictTtfbTailAttribution(null), /Invalid/);
  assert.throws(() => strictTtfbTailAttribution([], -800), /Invalid/);
});
