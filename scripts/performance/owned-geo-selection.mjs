import assert from "node:assert/strict";
import { ownedGeoColos } from "./owned-geo-probe-worker.mjs";

// No timing field participates in routing selection. The retained route-only
// measurements contain no catalog reads or content, positive grants or keys.
export function routeCandidates(measurement, sha) {
  assert.equal(measurement.status, "finished");
  const candidates = [];
  for (const item of measurement.results || []) {
    const result = item.result || {};
    if (result.status !== "finished" || result.statusCode !== 200 || result.truncated) continue;
    let body;
    try {
      body = JSON.parse(result.rawBody);
    } catch {
      continue;
    }
    const ray = Object.entries(result.headers || {}).find(
      ([name]) => name.toLowerCase() === "cf-ray",
    )?.[1];
    const ingress = /-([A-Z]{3})$/.exec(Array.isArray(ray) ? ray[0] : ray || "")?.[1];
    if (
      body.schema !== "cove.owned-geo-route.v1" ||
      body.sha !== sha ||
      body.country !== "US" ||
      item.probe?.country !== "US" ||
      body.colo !== ingress ||
      !ownedGeoColos.includes(ingress) ||
      typeof item.probe?.city !== "string" ||
      !Number.isSafeInteger(item.probe?.asn) ||
      item.probe.asn <= 0
    )
      continue;
    candidates.push({
      colo: ingress,
      location: { country: "US", city: item.probe.city, asn: item.probe.asn, limit: 1 },
    });
  }
  return candidates;
}

export function pinnedRoute(measurement, sha, colo) {
  assert.match(measurement.id || "", /^[a-zA-Z0-9-]{10,100}$/);
  const candidates = routeCandidates(measurement, sha);
  return measurement.results?.length === 1 && candidates.length === 1 && candidates[0].colo === colo
    ? { colo, measurementId: measurement.id, location: candidates[0].location }
    : null;
}

export function routeSelectionEvidence(measurement, sha) {
  return {
    measurementId: measurement.id,
    status: measurement.status,
    candidates: routeCandidates(measurement, sha),
    observations: (measurement.results || []).map((item) => {
      const result = item.result || {};
      let body = {};
      try {
        if (!result.truncated) body = JSON.parse(result.rawBody);
      } catch {}
      const ray = Object.entries(result.headers || {}).find(
        ([key]) => key.toLowerCase() === "cf-ray",
      )?.[1];
      const colo = /-([A-Z]{3})$/.exec(Array.isArray(ray) ? ray[0] : ray || "")?.[1];
      return {
        country: item.probe?.country || null,
        city: item.probe?.city || null,
        asn: Number.isSafeInteger(item.probe?.asn) ? item.probe.asn : null,
        statusCode: result.statusCode || null,
        colo: colo || null,
        sourceMatched:
          body.schema === "cove.owned-geo-route.v1" && body.sha === sha && body.colo === colo,
      };
    }),
  };
}

/** Only an exact, run-bound, zero-upstream admission rejection is retryable.
 * Neither a slow valid response, target-colo drift after fetch, missing rows,
 * generic 409, timeout, truncated result nor any other error can qualify. */
export function zeroWorkRouteRejection(measurement, sha, campaign, colo, concurrency) {
  if (measurement.status !== "finished" || measurement.results?.length !== 1 ||
      !/^[a-zA-Z0-9-]{10,100}$/.test(measurement.id || "")) return null;
  const item = measurement.results[0];
  const result = item.result || {};
  if (result.status !== "finished" || result.statusCode !== 409 || result.truncated ||
      item.probe?.country !== "US") return null;
  let body;
  try { body = JSON.parse(result.rawBody); } catch { return null; }
  const rawRay = Object.entries(result.headers || {}).find(
    ([key]) => key.toLowerCase() === "cf-ray",
  )?.[1];
  const ingress = /-([A-Z]{3})$/.exec(Array.isArray(rawRay) ? rawRay[0] : rawRay || "")?.[1];
  if (body?.schema !== "cove.owned-geo-not-admitted.v1" ||
      body.sha !== sha || body.campaign !== campaign ||
      body.country !== "US" || !ingress || body.colo !== ingress ||
      body.expectedColo !== colo || ingress === colo || !ownedGeoColos.includes(colo) ||
      body.concurrency !== concurrency || body.upstreamRequests !== 0 ||
      Object.hasOwn(body, "rows")) return null;
  return { measurementId: measurement.id, expectedColo: colo, observedColo: ingress,
    concurrency, upstreamRequests: 0 };
}

/** A maximum of three routing admissions. The first measurement that might
 * have issued homepage traffic is final, regardless of its result or latency. */
export async function measurePinnedRegion({ pin, sha, campaign, concurrency, measure, rePin, onRejected }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const measurement = await measure(pin.measurementId, pin.colo + "/" + concurrency);
    const rejected = zeroWorkRouteRejection(measurement, sha, campaign, pin.colo, concurrency);
    if (!rejected) return { measurement, pin };
    onRejected(rejected);
    if (attempt === 2) return { measurement, pin };
    const replacement = await rePin(pin);
    if (replacement) {
      assert.equal(replacement.colo, pin.colo);
      pin = replacement;
    }
  }
  throw Error("Unreachable regional admission");
}
