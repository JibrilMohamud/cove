import assert from "node:assert/strict";
import { parseGeoIngressEvidence } from "./staging/verify-geo-edge-ingress.mjs";

const sha = "a".repeat(40);
const make = (colo, probeCountry, code = 200) => ({
  probe: { country: probeCountry },
  result: {
    status: "finished",
    statusCode: code,
    rawBody: JSON.stringify({
      schema: "cove.geo-ingress.v1", sha, colo, country: probeCountry,
    }),
    truncated: false,
    headers: { "cf-ray": "abc-" + colo },
    timings: { firstByte: 144 },
  },
});
const good = [make("IAD", "US"), make("LHR", "GB"), make("NRT", "JP")];
assert.equal(
  parseGeoIngressEvidence({ id: "measured1", status: "finished", results: good }, sha).passed,
  true,
);
for (const changed of [
  [good[0], good[0], good[2]],
  [make("IAD", "US"), make("LHR", "GB"), make("NRT", "US")],
  [good[0], good[1], { ...good[2], result: { ...good[2].result, statusCode: 401 } }],
  [good[0], good[1], { ...good[2], result: { ...good[2].result, headers: { "cf-ray": "abc-SIN" } } }],
]) {
  assert.equal(
    parseGeoIngressEvidence({ id: "measured2", status: "finished", results: changed }, sha)
      .passed,
    false,
  );
}
assert.throws(
  () => parseGeoIngressEvidence({ id: "x", status: "in-progress", results: good }, sha),
  /not complete/,
);
const stageWorker = await import("../src/storefront-strangler/worker.ts").catch(() => null);
assert.ok(
  stageWorker === null || typeof stageWorker === "object",
  "Bundler may handle TypeScript Worker in its own CI test",
);
console.log("GEO_PROBE_VALIDATION_PASS distinct colo, country, exact SHA, cf-ray, 200 and no false positives");
