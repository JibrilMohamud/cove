import assert from "node:assert/strict";
import {
  parseFourUsColoEvidence,
  regionProbes,
  verifyFourUsColoIngress,
} from "./staging/verify-four-us-colo-ingress.mjs";

const sha = "b".repeat(40);
const make = (region, overrides = {}) => ({
  probe: { city: region.city, country: "US", state: region.state },
  result: {
    status: "finished",
    statusCode: 200,
    rawBody: JSON.stringify({
      schema: "cove.geo-ingress.v1",
      sha,
      colo: region.colo,
      country: "US",
    }),
    truncated: false,
    headers: { "cf-ray": "0123456789abcdef-" + region.colo },
    timings: { firstByte: 154 },
    ...overrides,
  },
});
const good = regionProbes.map((region) => make(region));
const measurement = { id: "geo-measurement-123", status: "finished", results: good };
const parsed = parseFourUsColoEvidence(measurement, sha);
assert.equal(parsed.passed, true);
assert.deepEqual(parsed.requiredColos, ["ORD", "LAX", "IAD", "DFW"]);
assert.equal(parsed.measuresCatalogTTFB, false);
assert.equal(parsed.certifiesPerformance, false);
assert.equal(parsed.certifiesLegalRights, false);
assert.equal(parsed.credentialsShared, false);

const prefix = good.slice(0, 3);
const wrongRay = make(regionProbes[3], {
  headers: { "cf-ray": "0123456789abcdef-IAD" },
});
const status503 = make(regionProbes[3], { statusCode: 503 });
const truncated = make(regionProbes[3], { truncated: true });
const invalidTime = make(regionProbes[3], {
  timings: { firstByte: Number.NaN },
});
const badShaBody = JSON.stringify({
  schema: "cove.geo-ingress.v1",
  sha: "c".repeat(40),
  colo: "DFW",
  country: "US",
});
const badSha = make(regionProbes[3], { rawBody: badShaBody });
const wrongCity = {
  ...good[3],
  probe: { city: "Houston", country: "US" },
};
for (const bad of [
  prefix,
  [...prefix, good[2]],
  [...prefix, wrongRay],
  [...prefix, status503],
  [...prefix, truncated],
  [...prefix, invalidTime],
  [...prefix, badSha],
  [...prefix, wrongCity],
]) {
  const report = parseFourUsColoEvidence(
    { id: "geo-measurement-bad", status: "finished", results: bad },
    sha,
  );
  assert.equal(report.passed, false, "Malformed or substituted geo evidence must deny");
}
const unfinished = { id: "123", status: "in-progress", results: good };
assert.throws(() => parseFourUsColoEvidence(unfinished, sha));

const origin = "https://cove-strangler-real-preview-1234567-1.cove-jibrilmohamud.workers.dev";
let posted;
let polls = 0;
const evidence = await verifyFourUsColoIngress(origin, sha, async (url, options) => {
  assert.equal(options.redirect, "error");
  assert.doesNotMatch(JSON.stringify(options), /authorization|bearer|cookie|secret/i);
  if (url.endsWith("/measurements")) {
    assert.equal(options.method, "POST");
    posted = JSON.parse(options.body);
    return { status: 202, json: async () => ({ id: "geo-measurement-123" }) };
  }
  polls++;
  assert.equal(url, "https://api.globalping.io/v1/measurements/geo-measurement-123");
  return {
    status: 200,
    json: async () => ({ id: "geo-measurement-123", status: "finished", results: good }),
  };
});
assert.equal(evidence.passed, true);
assert.equal(polls, 1);
assert.equal(posted.target, new URL(origin).hostname);
assert.deepEqual(
  posted.locations,
  regionProbes.map(({ city, state, country }) => ({
    city,
    state,
    country,
    limit: 1,
  })),
);
assert.deepEqual(posted.measurementOptions.request, {
  method: "GET",
  path: "/__cove_geo_probe",
});
assert.ok(!JSON.stringify(posted).includes("Bearer"));
await assert.rejects(verifyFourUsColoIngress("https://covereads.com", sha));
console.log(
  "FOUR_US_COLO_CONTRACT_PASS exact real ingress, immutable SHA, no third-party credentials and no catalog TTFB misclaim",
);
