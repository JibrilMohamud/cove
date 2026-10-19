// Primary-rights homepage under genuine search-facet contention, never a fake 401 probe.
// Uses only protected staging; no raw results/IDs, tokens or IPs in artifacts.
import assert from "node:assert/strict";
import fs from "node:fs";
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
const variants = [
  "newRelease=false",
  "minPrice=0",
  "maxPrice=0",
  "", // Unavoidably shared ordinary catalog key: give it to CONTROL, not candidate.
  "minPrice=0&maxPrice=0",
  "newRelease=false&minPrice=0",
  "newRelease=false&maxPrice=0",
  "newRelease=false&minPrice=0&maxPrice=0",
];
const waves = [1, 4, 8, 16];
const data = [];
const homeWaveIssuedAt = new Map();
let next = 0;
async function home(concurrency) {
  const start = performance.now();
  try {
    const res = await fetch(origin + "/", {
      headers: { ...allowed, Accept: "text/html" },
      redirect: "manual",
      signal: AbortSignal.timeout(18000),
    });
    const ttfb = Math.round(performance.now() - start);
    const html = await res.text();
    const cards = validateHtml(res.status, res.headers.get("content-type") || "", html);
    assert.ok(cards >= 1, "Rights-checked homepage must contain actual books");
    assert.match(res.headers.get("cache-control") || "", /no-store/);
    assert.match(res.headers.get("server-timing") || "", /cove_ssr_local_rights;dur=0/);
    const colo = (res.headers.get("cf-ray") || "").match(/-([A-Z]{3})$/)?.[1] || "unknown";
    return { type: "home", concurrency, ttfb, status: res.status, colo, valid: true };
  } catch {
    return {
      type: "home",
      concurrency,
      ttfb: Math.round(performance.now() - start),
      valid: false,
    };
  }
}
async function facets(concurrency, variant) {
  const start = performance.now();
  const params = new URLSearchParams(variant);
  params.set("sort", "popular");
  params.set("limit", "1");
  params.set("page", "1");
  try {
    const res = await fetch(origin + "/api/fore/catalog?" + params.toString(), {
      headers: { ...allowed, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(18000),
    });
    const ttfb = Math.round(performance.now() - start);
    const body = await res.json();
    assert.equal(res.status, 200, "Only an actual rights-checked catalog counts");
    assert.ok(Array.isArray(body.results) && body.results.length === 1);
    assert.ok(body.facets && Array.isArray(body.facets.categories));
    assert.ok(Array.isArray(body.facets.languages));
    assert.ok(Number.isFinite(body.count) && body.count >= 1);
    const colo = (res.headers.get("cf-ray") || "").match(/-([A-Z]{3})$/)?.[1] || "unknown";
    return {
      type: "facets",
      completedAt: performance.now(),
      concurrency,
      variant,
      ttfb,
      status: res.status,
      count: body.count,
      facetCategories: body.facets.categories.length,
      colo,
      valid: true,
    };
  } catch {
    return {
      type: "facets",
      completedAt: performance.now(),
      concurrency,
      variant,
      ttfb: Math.round(performance.now() - start),
      valid: false,
    };
  }
}
for (const concurrency of waves) {
  // Every cohort/wave gets an independent, nearly equivalent search-filter
  // identity to avoid baseline cache warming the candidate. The source catalog
  // in this dataset has exclusively nonnegative zero-dollar retail prices.
  // These are LIVE uncached count aggregates, NOT mock or error responses.
  const variant = variants[(next + Number(process.env.COVE_FACET_VARIANT_OFFSET || 0)) % 8];
  next += 1;
  const searches = facets(concurrency, variant);
  // Give the real catalog endpoint a short head start to reach D1 after its
  // initial application handler, then issue the homepage wave while facet
  // aggregation is in flight. An already-complete facet is still recorded,
  // never silently represented as evidence of concurrent primary contention.
  await new Promise((resolve) => setTimeout(resolve, 250));
  homeWaveIssuedAt.set(concurrency, performance.now());
  const homepage = Array.from({ length: concurrency }, () => home(concurrency));
  data.push(...(await Promise.all([...homepage, searches])));
}
const summaries = waves.map((concurrency) => {
  const h = data.filter((v) => v.type === "home" && v.concurrency === concurrency);
  const f = data.find((v) => v.type === "facets" && v.concurrency === concurrency);
  const t = h.filter((v) => v.valid).map((v) => v.ttfb);
  const max = t.length ? Math.max(...t) : null;
  return {
    concurrency,
    homepageCount: h.length,
    validated: t.length,
    homepageMaxMs: max,
    homepageP95Ms: percentile(t, 0.95),
    facetMs: f?.ttfb ?? null,
    facetValidated: f?.valid === true,
    // Prevent a pre-cached or already finished catalog response being counted
    // as a search request competing with homepage reads.
    httpRequestsOverlapped: Number(f?.completedAt) >= homeWaveIssuedAt.get(concurrency),
    facetCategories: f?.facetCategories ?? null,
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
  "artifacts/cloudflare-facet-home-mixed.json",
  JSON.stringify(artifact, null, 2) + "\n",
);
console.log(
  summaries
    .map(
      (s) =>
        `mixed ${s.concurrency} home max=${s.homepageMaxMs}ms facet=${s.facetMs}ms valid=${s.facetValidated} overlapColo=${s.sharedColos} pass=${s.pass}`,
    )
    .join("\n"),
);
if (!pass) process.exitCode = 1;
