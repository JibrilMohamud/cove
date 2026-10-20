import assert from "node:assert/strict";
import { assertAcceptedPlacement } from "./performance/placement-evidence.mjs";
const requested = { region: "aws:us-east-1" };
for (const actual of [requested, { mode: "targeted", target: [requested] }])
  assert.equal(assertAcceptedPlacement(actual, requested).verifiedBy, "explicit-region");
const actual = { mode: "targeted", target: [1] };
assert.equal(
  assertAcceptedPlacement(actual, requested, structuredClone(actual)).verifiedBy,
  "same-region-api-roundtrip",
);
for (const rejected of [
  undefined,
  {},
  { mode: "smart" },
  { region: "aws:us-west-2" },
  { mode: "targeted", target: [2] },
])
  assert.throws(() => assertAcceptedPlacement(rejected, requested, actual));
assert.throws(() => assertAcceptedPlacement(actual, requested));
console.log(
  "PASS: explicit and numeric accepted placement; missing, different and unverified targets rejected",
);
