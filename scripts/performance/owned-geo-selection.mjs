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
