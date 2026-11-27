import assert from "node:assert/strict";
import { ownedGeoColos } from "./owned-geo-probe-worker.mjs";

export function parseOwnedGeoEvidence(measurement, sha, concurrency) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  const measurements = Array.isArray(measurement) ? measurement : [measurement];
  for (const value of measurements)
    assert.equal(value.status, "finished", "Regional measurement incomplete");
  const observations = measurements
    .flatMap((value) => value.results || [])
    .map((item) => {
      const result = item.result || {};
      let body = {};
      try {
        if (!result.truncated) body = JSON.parse(result.rawBody);
      } catch {
        // Invalid or truncated evidence fails rather than reducing the sample.
      }
      const rawRay = Object.entries(result.headers || {}).find(
        ([key]) => key.toLowerCase() === "cf-ray",
      )?.[1];
      const ray = Array.isArray(rawRay) ? rawRay[0] : rawRay;
      const ingress = /-([A-Z]{3})$/.exec(ray || "")?.[1];
      const rows = Array.isArray(body.rows) ? body.rows : [];
      // Globalping firstByte excludes DNS/TCP/TLS. Include those costs by
      // subtracting only body download from total; never call the shorter
      // server-wait field end-to-end TTFB.
      const total = result.timings?.total;
      const download = result.timings?.download;
      const receiptMs =
        Number.isFinite(total) && Number.isFinite(download) && download >= 0 && total >= download
          ? total - download
          : null;
      const valid =
        result.status === "finished" &&
        result.statusCode === 200 &&
        item.probe?.country === "US" &&
        body.schema === "cove.owned-geo.v1" &&
        body.sha === sha &&
        body.colo === ingress &&
        ownedGeoColos.includes(ingress) &&
        body.concurrency === concurrency &&
        rows.length === concurrency &&
        Number.isFinite(receiptMs) &&
        receiptMs >= 0 &&
        receiptMs < 800 &&
        rows.every(
          (row) =>
            row.status === 200 &&
            row.valid === true &&
            row.targetColo === ingress &&
            Number.isInteger(row.cards) &&
            row.cards > 0 &&
            Number.isFinite(row.ttfbMs) &&
            row.ttfbMs >= 0 &&
            row.ttfbMs < 800,
        );
      return {
        colo: ingress || null,
        probeCountry: item.probe?.country || null,
        receiptMs,
        rows,
        valid,
      };
    });
  return {
    measurementIds: measurements.map((value) => value.id),
    concurrency,
    observations,
    passed:
      observations.length === 4 &&
      observations.every((item) => item.valid) &&
      ownedGeoColos.every((colo) => observations.filter((item) => item.colo === colo).length === 1),
  };
}
