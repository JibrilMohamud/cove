import assert from "node:assert/strict";
import { discoveryResponse } from "./performance/discovery-response.mjs";
const book = { productId: "perf-synth-000001" };
assert.equal(
  discoveryResponse("/api/fore/storefront/bootstrap", { catalog: { results: [book] } }).valid,
  true,
);
assert.equal(discoveryResponse("/api/fore/storefront/bootstrap", { results: [book] }).valid, false);
assert.equal(
  discoveryResponse("/api/fore/recommendations/home", { rails: [{ books: [book] }] }).valid,
  true,
);
assert.equal(
  discoveryResponse("/api/fore/recommendations/home", { rails: [{ books: [] }] }).valid,
  false,
);
assert.equal(discoveryResponse("/api/fore/merchandising", { slots: {} }).valid, true);
assert.equal(discoveryResponse("/api/fore/merchandising", { slots: [] }).valid, false);
assert.equal(
  discoveryResponse("/api/fore/storefront/bootstrap", { catalog: { results: [{}] } }).valid,
  false,
);
console.log(
  "PASS: real bootstrap/recommendation/merchandising response envelopes and canonical product IDs",
);
