import assert from "node:assert/strict";

// These are requested PROBE cities, not a claim that traffic will enter the
// corresponding Cloudflare colo. Only the real cf-ray + Worker cf.colo pair
// can attest that. No identity, bearer or customer payload is sent to probes.
export const regionProbes = Object.freeze([
  { city: "Chicago", state: "IL", country: "US", colo: "ORD" },
  { city: "Los Angeles", state: "CA", country: "US", colo: "LAX" },
  { city: "Ashburn", state: "VA", country: "US", colo: "IAD" },
  { city: "Dallas", state: "TX", country: "US", colo: "DFW" },
]);

const service = "https://api.globalping.io/v1/measurements";
const agent = "CoveReleaseGeo/1.0 (+https://github.com/JibrilMohamud/cove)";

export function parseFourUsColoEvidence(measurement, expectedSha) {
  assert.match(expectedSha, /^[a-f0-9]{40}$/);
  assert.equal(measurement?.status, "finished", "US four-colo measurement is incomplete");
  const observations = (measurement.results || []).map((entry) => {
    const result = entry.result || {};
    let body = null;
    try {
      body =
        result.truncated === false && typeof result.rawBody === "string"
          ? JSON.parse(result.rawBody)
          : null;
    } catch {
      body = null;
    }
    const rayHeader = Object.entries(result.headers || {}).find(
      ([key]) => key.toLowerCase() === "cf-ray",
    )?.[1];
    const ray = Array.isArray(rayHeader) ? rayHeader[0] : rayHeader;
    const ingress = typeof ray === "string" ? /^[a-f0-9]{12,32}-([A-Z]{3})$/.exec(ray)?.[1] : null;
    const city = entry.probe?.city ?? null;
    const country = entry.probe?.country ?? null;
    const expected = regionProbes.find((region) => region.city === city);
    const valid =
      !!expected &&
      country === "US" &&
      result.status === "finished" &&
      result.statusCode === 200 &&
      body?.schema === "cove.geo-ingress.v1" &&
      body.sha === expectedSha &&
      body.country === "US" &&
      body.colo === expected.colo &&
      ingress === expected.colo &&
      Number.isFinite(result.timings?.firstByte) &&
      result.timings.firstByte >= 0;
    return {
      requestedCity: city,
      observedColo: ingress || null,
      targetColo: expected?.colo ?? null,
      firstByteMs: Number.isFinite(result.timings?.firstByte) ? result.timings.firstByte : null,
      valid,
    };
  });
  const seenCities = new Set(observations.filter((o) => o.valid).map((o) => o.requestedCity));
  const passed =
    observations.length === regionProbes.length &&
    observations.every((o) => o.valid) &&
    seenCities.size === regionProbes.length &&
    regionProbes.every((r) => seenCities.has(r.city));
  return {
    schema: "cove.qa.four-us-edge-colos.v1",
    source: "independent-globalping-public-content-free",
    measurementId: typeof measurement.id === "string" ? measurement.id : null,
    requiredColos: regionProbes.map((r) => r.colo),
    observations,
    passed,
    measuresCatalogTTFB: false,
    certifiesLegalRights: false,
    certifiesPerformance: false,
    credentialsShared: false,
  };
}

export async function verifyFourUsColoIngress(origin, sha, fetcher = fetch) {
  const url = new URL(origin);
  assert.equal(url.protocol, "https:");
  assert.match(
    url.hostname,
    /^cove-strangler-real-preview-\d+-\d+\.cove-jibrilmohamud\.workers\.dev$/,
  );
  assert.equal(url.pathname, "/");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.match(sha, /^[a-f0-9]{40}$/);
  const created = await fetcher(service, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": agent,
    },
    body: JSON.stringify({
      type: "http",
      target: url.hostname,
      locations: regionProbes.map(({ city, state, country }) => ({
        city,
        state,
        country,
        limit: 1,
      })),
      measurementOptions: {
        protocol: "HTTPS",
        request: { method: "GET", path: "/__cove_geo_probe" },
      },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(created.status, 202, "Four-region public probe could not be submitted");
  const queued = await created.json();
  assert.match(queued.id, /^[a-zA-Z0-9-]{10,100}$/);
  let measurement;
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await fetcher(service + "/" + queued.id, {
      headers: { accept: "application/json", "user-agent": agent },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(result.status, 200);
    measurement = await result.json();
    if (measurement.status !== "in-progress") break;
  }
  const report = parseFourUsColoEvidence(measurement, sha);
  assert.ok(
    report.passed,
    "Independent geographic probes did not attest all four required actual Cloudflare colos",
  );
  return report;
}
