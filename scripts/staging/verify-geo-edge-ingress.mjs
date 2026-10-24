import assert from "node:assert/strict";

const service = "https://api.globalping.io/v1/measurements";
const agent = "CoveReleaseGeo/1.0 (+https://github.com/JibrilMohamud/cove)";
const destinations = ["US", "GB", "DE", "JP"];

export function parseGeoIngressEvidence(measurement, expectedSha) {
  assert.match(expectedSha, /^[a-f0-9]{40}$/);
  assert.equal(measurement.status, "finished", "Geo measurement is not complete");
  const observations = (measurement.results || []).map((item) => {
    const result = item.result || {};
    const body = typeof result.rawBody === "string" && !result.truncated
      ? JSON.parse(result.rawBody)
      : {};
    const cfRay = Object.entries(result.headers || {}).find(
      ([key]) => key.toLowerCase() === "cf-ray",
    )?.[1];
    const ray = Array.isArray(cfRay) ? cfRay[0] : cfRay;
    const ingress = typeof ray === "string" ? /-([A-Z]{3})$/.exec(ray)?.[1] : null;
    const valid =
      result.status === "finished" &&
      result.statusCode === 200 &&
      body.schema === "cove.geo-ingress.v1" &&
      body.sha === expectedSha &&
      /^[A-Z]{3}$/.test(body.colo || "") &&
      body.colo === ingress &&
      /^[A-Z]{2}$/.test(body.country || "") &&
      Number.isFinite(result.timings?.firstByte) &&
      result.timings.firstByte >= 0;
    return {
      probeCountry: item.probe?.country || null,
      colo: body.colo || null,
      country: body.country || null,
      ray: ray || null,
      firstByteMs: result.timings?.firstByte ?? null,
      valid,
    };
  });
  const distinctColos = [...new Set(observations.filter((x) => x.valid).map((x) => x.colo))];
  const countries = [...new Set(observations.filter((x) => x.valid).map((x) => x.probeCountry))];
  const passed =
    observations.length >= 3 &&
    observations.every((x) => x.valid) &&
    distinctColos.length >= 3 &&
    countries.length >= 3 &&
    countries.some((country) => country !== "US");
  return {
    source: "independent-globalping-http-probes",
    type: "content-free-cloudflare-ingress",
    measurementId: measurement.id,
    count: observations.length,
    distinctColos,
    countries,
    observations,
    passed,
    measuresCatalogTTFB: false,
    customerRoutingChanged: false,
  };
}

export async function verifyGeoEdgeIngress(origin, expectedSha, fetcher = fetch) {
  const url = new URL(origin);
  assert.equal(url.protocol, "https:");
  assert.match(url.hostname, /^cove-strangler-real-preview-\d+-\d+\.cove-jibrilmohamud\.workers\.dev$/);
  assert.match(expectedSha, /^[a-f0-9]{40}$/);
  const create = await fetcher(service, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
      "user-agent": agent,
    },
    body: JSON.stringify({
      type: "http",
      target: url.hostname,
      locations: destinations.map((country) => ({ country, limit: 1 })),
      measurementOptions: {
        protocol: "HTTPS",
        request: { method: "GET", path: "/__cove_geo_probe" },
      },
    }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(create.status, 202, "Geo service did not accept distributed measurement");
  const queued = await create.json();
  assert.match(queued.id, /^[a-zA-Z0-9-]{10,100}$/);
  let measurement;
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const response = await fetcher(service + "/" + queued.id, {
      headers: { accept: "application/json", "user-agent": agent },
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, 200, "Geo measurement unavailable");
    measurement = await response.json();
    if (measurement.status !== "in-progress") break;
  }
  const report = parseGeoIngressEvidence(measurement, expectedSha);
  assert.ok(
    report.passed,
    "Independent geographic probe could not verify three distinct Cloudflare ingress locations",
  );
  return report;
}
