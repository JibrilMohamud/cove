import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { architectureReviewCheckpoint } from "./d1-span-attribution.mjs";

const ledger = JSON.parse(readFileSync("docs/performance/architecture-iteration-ledger.json", "utf8"));
assert.equal(ledger.schema, "cove.performance-architecture-checkpoint.v1");
assert.equal(ledger.releaseCertified, false, "A performance architecture review is not a release certificate");
assert.ok(Array.isArray(ledger.iterations));
const state = architectureReviewCheckpoint(ledger.iterations);
assert.equal(state.architectureReviewRequired, false,
  `Optimization loop requires an architecture review: ${state.reason}`);
console.log("Architecture checkpoint documented; release thresholds remain unchanged: PASS");
