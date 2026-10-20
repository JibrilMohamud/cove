import assert from "node:assert/strict";

export function assertAcceptedPlacement(actual, requested, reference) {
  const region = actual?.region || actual?.target?.[0]?.region;
  if (region) {
    assert.equal(region, requested.region, "Deployed region must match the experiment");
    return { actual, requested, verifiedBy: "explicit-region", executionColo: null };
  }
  // The live settings API can return {mode:'targeted',target:[1]} although
  // its published schema describes objects. Do not invent an enum mapping.
  // Compare with a fresh API roundtrip for the identical requested region.
  assert.equal(actual?.mode, "targeted", "Targeted placement must be active");
  assert.equal(actual?.target?.length, 1);
  assert.ok(Number.isInteger(actual.target[0]) && actual.target[0] > 0);
  assert.deepEqual(actual, reference, "Placement must match the same-region API reference");
  return {
    actual,
    requested,
    verifiedBy: "same-region-api-roundtrip",
    executionColo: null,
  };
}
