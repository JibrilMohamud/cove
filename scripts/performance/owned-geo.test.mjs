import assert from "node:assert/strict";
import test from "node:test";
import { measureOwnedGeo, ownedGeoColos } from "./owned-geo-probe-worker.mjs";
import { parseOwnedGeoEvidence } from "./owned-geo-evidence.mjs";

const sha = "a".repeat(40);
const env = {
  COVE_GEO_SHA: sha,
  COVE_GEO_CAMPAIGN: "b".repeat(32),
  COVE_GEO_EXPIRES: String(Date.now() + 240000),
  COVE_GEO_ISOLATED_SNAPSHOT: "15ce2ea3-17f8-4d99-9015-a78a6a3af05d",
  COVE_SSR_STAGING_GATE_KEY: "c".repeat(64),
};
const request = (suffix = "/4", cf = { country: "US", colo: "ORD" }) => {
  const value = new Request(
    "https://cove-owned-geo-measurement.cove-jibrilmohamud.workers.dev/" +
      env.COVE_GEO_CAMPAIGN +
      suffix,
    {
      headers: { cookie: "private-session", "x-cove-client-country": "ZZ" },
    },
  );
  Object.defineProperty(value, "cf", { value: cf });
  return value;
};
const response = (colo = "ORD", authority = "isolated-canonical-primary") =>
  new Response('<div class="book-card">licensed</div>', {
    headers: {
      "content-type": "text/html",
      "cache-control": "no-store",
      "cf-ray": "abc-" + colo,
      "x-cove-homepage-authority": authority,
      "server-timing": "cove_catalog;dur=12.1",
    },
  });

test("regional adapter can measure only the fixed isolated homepage and never returns its credential or HTML", async () => {
  let calls = 0;
  const result = await measureOwnedGeo(request(), env, async (url, init) => {
    calls++;
    assert.equal(url, "https://ssr-canary.covereads.com/");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.authorization, "Bearer " + env.COVE_SSR_STAGING_GATE_KEY);
    assert.equal(init.headers.cookie, undefined);
    assert.equal(init.headers["x-cove-client-country"], undefined);
    return response();
  });
  assert.equal(calls, 4);
  const raw = await result.text();
  assert.ok(!raw.includes(env.COVE_SSR_STAGING_GATE_KEY));
  assert.ok(!raw.includes("licensed"));
  assert.equal(
    JSON.parse(raw).rows.every((row) => row.valid),
    true,
  );
});

test("expiry, alternate upstream paths, query strings, forged country and region, and missing QA scope fail before fetch", async () => {
  for (const [input, vars] of [
    [request("/999"), env],
    [request("/4?target=https://attacker.test"), env],
    [request("/api/fore/account"), env],
    [request("/4", { country: "CA", colo: "ORD" }), env],
    [request("/4", { country: "US", colo: "SJC" }), env],
    [request(), { ...env, COVE_GEO_EXPIRES: String(Date.now() - 1) }],
    [request(), { ...env, COVE_GEO_EXPIRES: String(Date.now() + 600000) }],
    [request(), { ...env, COVE_GEO_ISOLATED_SNAPSHOT: "production" }],
    [request(), { ...env, COVE_SSR_STAGING_GATE_KEY: "" }],
  ]) {
    const result = await measureOwnedGeo(input, vars, () =>
      assert.fail("Denied request reached network"),
    );
    assert.ok(result.status >= 400);
  }
});

test("absent fresh authority, unexpected target region, backend failures and fetch exceptions remain invalid samples", async () => {
  for (const fetcher of [
    async () => response("ORD", "cached"),
    async () => response("IAD"),
    async () => new Response("failure", { status: 503 }),
    async () => {
      throw Error("sensitive backend exception");
    },
  ]) {
    const body = await (await measureOwnedGeo(request("/1"), env, fetcher)).json();
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].valid, false);
    assert.ok(!JSON.stringify(body).includes("sensitive"));
  }
});

const measurement = () => ({
  id: "measured-owned-geo",
  status: "finished",
  results: ownedGeoColos.map((colo) => ({
    probe: { country: "US" },
    result: {
      status: "finished",
      statusCode: 200,
      truncated: false,
      headers: { "cf-ray": "abc-" + colo },
      timings: { firstByte: 299, total: 400, download: 1 },
      rawBody: JSON.stringify({
        schema: "cove.owned-geo.v1",
        sha,
        colo,
        concurrency: 1,
        rows: [{ status: 200, ttfbMs: 150, targetColo: colo, cards: 24, valid: true }],
      }),
    },
  })),
});
test("regional evidence requires all four actual ingress colos, every response and both strict timing bounds", () => {
  assert.equal(parseOwnedGeoEvidence(measurement(), sha, 1).passed, true);
  for (const mutate of [
    (m) => m.results.pop(),
    (m) => {
      m.results[3] = m.results[0];
    },
    (m) => {
      m.results[0].result.truncated = true;
    },
    (m) => {
      m.results[0].result.statusCode = 503;
    },
    (m) => {
      m.results[0].result.timings.total = 801;
    },
    (m) => {
      m.results[0].result.rawBody = m.results[0].result.rawBody.replace(
        '"ttfbMs":150',
        '"ttfbMs":800',
      );
    },
    (m) => {
      m.results[0].result.rawBody = m.results[0].result.rawBody.replace(
        '"valid":true',
        '"valid":false',
      );
    },
    (m) => {
      m.results[0].result.rawBody = m.results[0].result.rawBody.replace(sha, "d".repeat(40));
    },
    (m) => {
      m.results[0].result.headers["cf-ray"] = "abc-LAX";
    },
  ]) {
    const changed = measurement();
    mutate(changed);
    assert.equal(parseOwnedGeoEvidence(changed, sha, 1).passed, false);
  }
});
