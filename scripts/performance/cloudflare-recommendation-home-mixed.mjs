// Primary-rights homepage under genuine recommendation ranking contention, never a fake 401 probe.
// Uses only protected staging; no raw results/IDs, tokens or IPs in artifacts.
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  productionOrigin,
  validateHtml,
  percentile,
} from "../check-production-storefront-performance.mjs";

const origin = productionOrigin(process.env.COVE_SSR_STAGING_ORIGIN);
const secret = process.env.COVE_SSR_STAGING_GATE_KEY;
assert.match(secret || "", /^[a-f0-9]{64}$/);
assert.match(origin, /-staging\.[a-z0-9.-]+\.workers\.dev$/);
const allowed = { Authorization: "Bearer " + secret, "Cache-Control": "no-store" };
const waves = [1, 4, 8, 16];
const data = [];
const homeWaveIssuedAt = new Map();
async function home(concurrency) {
  const start = performance.now();
  let status = null,
    headersMs = null,
    phase = "headers";
  try {
    const res = await fetch(origin + "/", {
      headers: { ...allowed, Accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(18000),
    });
    const ttfb = Math.round(performance.now() - start);
    headersMs = ttfb;
    status = res.status;
    phase = "body";
    const html = await res.text();
    phase = "validation";
    const cards = validateHtml(res.status, res.headers.get("content-type") || "", html);
    assert.ok(cards >= 1, "Rights-checked homepage must contain actual books");
    assert.match(res.headers.get("cache-control") || "", /no-store/);
    assert.match(res.headers.get("server-timing") || "", /cove_ssr_local_rights;dur=0/);
    const colo = (res.headers.get("cf-ray") || "").match(/-([A-Z]{3})$/)?.[1] || "unknown";
    return { type: "home", concurrency, ttfb, status: res.status, colo, valid: true };
  } catch (error) {
    return {
      type: "home",
      concurrency,
      ttfb: headersMs,
      totalMs: Math.round(performance.now() - start),
      status,
      phase,
      reason: error instanceof Error ? error.name : "UnknownError",
      detail: error instanceof Error ? error.message.slice(0, 160) : "Request failed",
      valid: false,
    };
  }
}
async function recommendations(concurrency) {
  const start = performance.now();
  let status = null,
    headersMs = null,
    phase = "headers";
  const params = new URLSearchParams({ visitor: randomUUID(), limit: "4" });
  try {
    const res = await fetch(origin + "/api/fore/recommendations/home?" + params.toString(), {
      headers: { ...allowed, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(18000),
    });
    const ttfb = Math.round(performance.now() - start);
    headersMs = ttfb;
    status = res.status;
    phase = "body";
    const body = await res.json();
    phase = "validation";
    assert.equal(res.status, 200, "Real recommendation request must complete");
    assert.ok(Array.isArray(body.rails) && body.rails.length > 0);
    assert.ok(body.rails.some((rail) => Array.isArray(rail.books) && rail.books.length > 0));
    const colo = (res.headers.get("cf-ray") || "").match(/-([A-Z]{3})$/)?.[1] || "unknown";
    return {
      type: "recommendations",
      completedAt: performance.now(),
      concurrency,
      ttfb,
      status: res.status,
      count: body.rails.reduce((n, rail) => n + rail.books.length, 0),
      recommendationCategories: body.rails.length,
      colo,
      valid: true,
    };
  } catch (error) {
    return {
      type: "recommendations",
      completedAt: performance.now(),
      concurrency,
      ttfb: headersMs,
      totalMs: Math.round(performance.now() - start),
      status,
      phase,
      reason: error instanceof Error ? error.name : "UnknownError",
      detail: error instanceof Error ? error.message.slice(0, 160) : "Request failed",
      valid: false,
    };
  }
}
for (const concurrency of waves) {
  const searches = recommendations(concurrency);
  // Give the real catalog endpoint a short head start to reach D1 after its
  // initial application handler, then issue the homepage wave while recommendation
  // aggregation is in flight. An already-complete recommendation is still recorded,
  // never silently represented as evidence of concurrent primary contention.
  await new Promise((resolve) => setTimeout(resolve, 250));
  homeWaveIssuedAt.set(concurrency, performance.now());
  const homepage = Array.from({ length: concurrency }, () => home(concurrency));
  data.push(...(await Promise.all([...homepage, searches])));
}
const summaries = waves.map((concurrency) => {
  const h = data.filter((v) => v.type === "home" && v.concurrency === concurrency);
  const f = data.find((v) => v.type === "recommendations" && v.concurrency === concurrency);
  const t = h.filter((v) => v.valid).map((v) => v.ttfb);
  const max = t.length ? Math.max(...t) : null;
  return {
    concurrency,
    homepageCount: h.length,
    validated: t.length,
    homepageMaxMs: max,
    homepageP95Ms: percentile(t, 0.95),
    recommendationMs: f?.ttfb ?? null,
    recommendationValidated: f?.valid === true,
    // Prevent a pre-cached or already finished catalog response being counted
    // as a search request competing with homepage reads.
    httpRequestsOverlapped: Number(f?.completedAt) >= homeWaveIssuedAt.get(concurrency),
    recommendationCategories: f?.recommendationCategories ?? null,
    sharedColos: h.filter((v) => v.valid).some((v) => v.colo === f?.colo),
    pass:
      t.length === concurrency &&
      max !== null &&
      max < 800 &&
      f?.valid === true &&
      Number(f.completedAt) >= homeWaveIssuedAt.get(concurrency),
  };
});
const pass = summaries.every((v) => v.pass);
const artifact = { status: pass ? "pass" : "fail", summaries, data };
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync(
  "artifacts/cloudflare-recommendation-home-mixed.json",
  JSON.stringify(artifact, null, 2) + "\n",
);
console.log(
  summaries
    .map(
      (s) =>
        `mixed ${s.concurrency} home max=${s.homepageMaxMs}ms recommendation=${s.recommendationMs}ms valid=${s.recommendationValidated} overlapColo=${s.sharedColos} pass=${s.pass}`,
    )
    .join("\n"),
);
if (!pass) process.exitCode = 1;
