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
const request = (suffix = "/ORD/4", cf = { country: "US", colo: "ORD" }) => {
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
    [request("/ORD/4?target=https://attacker.test"), env],
    [request("/api/fore/account"), env],
    [request("/ORD/4", { country: "CA", colo: "ORD" }), env],
    [request("/ORD/4", { country: "US", colo: "SJC" }), env],
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
    const body = await (await measureOwnedGeo(request("/ORD/1"), env, fetcher)).json();
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
        expectedColo: colo,
        concurrency: 1,
        rows: [{ status: 200, ttfbMs: 150, targetColo: colo, cards: 24, valid: true }],
      }),
    },
  })),
});
test("regional evidence requires all four actual ingress colos, every response and strict homepage TTFB", () => {
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
      m.results[0].result.timings.total = -1;
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

test("route discovery never prewarms the catalog, and pins probes only by actual ingress", async () => {
  const result = await measureOwnedGeo(request("/route"), env, () =>
    assert.fail("Route selection contacted catalog"),
  );
  assert.deepEqual(await result.json(), {
    schema: "cove.owned-geo-route.v1",
    sha,
    country: "US",
    colo: "ORD",
  });
  const { routeCandidates, pinnedRoute } = await import("./owned-geo-selection.mjs");
  const m = measurement();
  m.results = m.results.slice(0, 1);
  m.results[0].probe = { country: "US", city: "Chicago", asn: 12345 };
  m.results[0].result.rawBody = JSON.stringify({
    schema: "cove.owned-geo-route.v1",
    sha,
    country: "US",
    colo: "ORD",
  });
  const pin = pinnedRoute(m, sha, "ORD");
  assert.equal(pin.measurementId, m.id);
  assert.deepEqual(pin.location, { country: "US", city: "Chicago", asn: 12345, limit: 1 });
  m.results[0].result.timings.total = 99999;
  assert.deepEqual(pinnedRoute(m, sha, "ORD"), pin, "No latency-based probe selection");
  assert.equal(pinnedRoute(m, sha, "IAD"), null);
  m.results.push(m.results[0]);
  assert.equal(pinnedRoute(m, sha, "ORD"), null, "Pins must identify a single probe");
  m.results = m.results.slice(0, 1);
  for (const raw of [
    { schema: "cove.owned-geo-route.v1", sha, country: "US", colo: "CMH" },
    { schema: "cove.owned-geo-route.v1", sha: "d".repeat(40), country: "US", colo: "ORD" },
    { schema: "cove.owned-geo-route.v1", sha, country: "ZZ", colo: "ORD" },
  ]) {
    m.results[0].result.rawBody = JSON.stringify(raw);
    assert.deepEqual(routeCandidates(m, sha), []);
  }
});

test("regional timed phases retain all four real measurement IDs", () => {
  const m = measurement();
  const phases = m.results.map((item, index) => ({
    id: "actual-measurement-" + index,
    status: "finished",
    results: [item],
  }));
  const phase = parseOwnedGeoEvidence(phases, sha, 1);
  assert.equal(phase.passed, true);
  assert.deepEqual(
    phase.measurementIds,
    phases.map((value) => value.id),
  );
  phases[0].status = "in-progress";
  assert.throws(() => parseOwnedGeoEvidence(phases, sha, 1));
});

test("broad route discovery retains ORD beyond rerouted Chicago networks without selecting by latency", async () => {
  const { routeCandidates } = await import("./owned-geo-selection.mjs");
  const m = measurement();
  const sample = m.results[0];
  m.results = Array.from({ length: 20 }, (_, index) => {
    const colo = index < 10 ? "ATL" : "ORD";
    return {
      probe: { country: "US", city: "Chicago", asn: 400000 + index },
      result: {
        ...sample.result,
        headers: { "cf-ray": "abc-" + colo },
        timings: { firstByte: index < 10 ? 1 : 99999 },
        rawBody: JSON.stringify({ schema: "cove.owned-geo-route.v1", sha, country: "US", colo }),
      },
    };
  });
  const candidates = routeCandidates(m, sha);
  assert.equal(candidates.length, 10);
  assert.ok(candidates.every((candidate) => candidate.colo === "ORD"));
  assert.deepEqual(
    candidates.map((candidate) => candidate.location.asn),
    Array.from({ length: 10 }, (_, index) => 400010 + index),
  );
});

test("reproduce latest 32-concurrency incident: all 128 homepage TTFBs pass while adapter receipts are slower", () => {
  const m = measurement();
  const actual = [760, 710, 747, 749];
  const receipts = [962, 853, 867, 854];
  for (const [i, item] of m.results.entries()) {
    const body = JSON.parse(item.result.rawBody);
    body.concurrency = 32;
    body.rows = Array.from({ length: 32 }, (_, j) => ({
      ...body.rows[0],
      ttfbMs: j === 31 ? actual[i] : 250,
    }));
    item.result.rawBody = JSON.stringify(body);
    item.result.timings.total = receipts[i] + 1;
  }
  const result = parseOwnedGeoEvidence(m, sha, 32);
  assert.equal(result.passed, true);
  assert.deepEqual(
    result.observations.map((o) => o.maxHomepageTtfbMs),
    actual,
  );
  assert.deepEqual(
    result.observations.map((o) => o.receiptMs),
    receipts,
  );
  for (const invalid of [
    (row) => {
      row.ttfbMs = 800;
    },
    (row) => {
      row.status = 503;
    },
    (row) => {
      row.valid = false;
    },
    (row) => {
      row.targetColo = "ATL";
    },
    (row) => {
      row.ttfbMs = null;
    },
  ]) {
    const copy = structuredClone(m);
    const body = JSON.parse(copy.results[0].result.rawBody);
    invalid(body.rows[31]);
    copy.results[0].result.rawBody = JSON.stringify(body);
    assert.equal(parseOwnedGeoEvidence(copy, sha, 32).passed, false);
  }
  const missing = structuredClone(m);
  const body = JSON.parse(missing.results[0].result.rawBody);
  body.rows.pop();
  missing.results[0].result.rawBody = JSON.stringify(body);
  assert.equal(parseOwnedGeoEvidence(missing, sha, 32).passed, false);
});

test("wrong ingress (including another required colo) rejects before any homepage request", async () => {
  for (const colo of ["ATL", "IAD"]) {
    const result = await measureOwnedGeo(request("/ORD/4", { country: "US", colo }), env, () =>
      assert.fail("Wrong ingress issued upstream traffic"),
    );
    assert.equal(result.status, 409);
    assert.deepEqual(await result.json(), {
      schema: "cove.owned-geo-not-admitted.v1",
      sha,
      campaign: env.COVE_GEO_CAMPAIGN,
      country: "US",
      colo,
      expectedColo: "ORD",
      concurrency: 4,
      upstreamRequests: 0,
    });
  }
});

test("only attested zero-work rerouting can be replaced; timed failures never retry", async () => {
  const { zeroWorkRouteRejection, measurePinnedRegion } = await import("./owned-geo-selection.mjs");
  const makeRejection = async () => {
    const result = await measureOwnedGeo(
      request("/ORD/4", { country: "US", colo: "ATL" }),
      env,
      () => assert.fail("Route rejection issued work"),
    );
    return {
      id: "route-reject-1",
      status: "finished",
      results: [
        {
          probe: { country: "US" },
          result: {
            status: "finished",
            statusCode: 409,
            truncated: false,
            headers: { "cf-ray": "abc-ATL" },
            rawBody: await result.text(),
          },
        },
      ],
    };
  };
  const rejected = await makeRejection();
  const campaign = env.COVE_GEO_CAMPAIGN;
  assert.ok(zeroWorkRouteRejection(rejected, sha, campaign, "ORD", 4));
  for (const change of [
    (r) => {
      r.statusCode = 503;
    },
    (r) => {
      r.truncated = true;
    },
    (r) => {
      r.headers["cf-ray"] = "abc-ORD";
    },
    (r) => {
      r.rawBody = r.rawBody.replace(campaign, "e".repeat(32));
    },
    (r) => {
      r.rawBody = r.rawBody.replace('"upstreamRequests":0', '"upstreamRequests":1');
    },
    (r) => {
      r.rawBody = r.rawBody.replace('"concurrency":4', '"concurrency":8');
    },
    (r) => {
      r.rawBody = "{}";
    },
  ]) {
    const copy = structuredClone(rejected);
    change(copy.results[0].result);
    assert.equal(zeroWorkRouteRejection(copy, sha, campaign, "ORD", 4), null);
  }
  const first = { colo: "ORD", measurementId: "pin-original" };
  const next = { colo: "ORD", measurementId: "pin-replacement" };
  const timed = measurement();
  timed.results = timed.results.slice(0, 1);
  const calls = [],
    admissions = [];
  const result = await measurePinnedRegion({
    pin: first,
    sha,
    campaign,
    concurrency: 4,
    measure: async (id, path) => {
      calls.push([id, path]);
      return calls.length === 1 ? rejected : timed;
    },
    rePin: async () => next,
    onRejected: (r) => admissions.push(r),
  });
  assert.deepEqual(calls, [
    ["pin-original", "ORD/4"],
    ["pin-replacement", "ORD/4"],
  ]);
  assert.equal(admissions.length, 1);
  assert.equal(result.measurement, timed);
  assert.equal(result.pin, next);
  for (const measured of [timed, { ...timed, status: "in-progress" }, { ...timed, results: [] }]) {
    let count = 0;
    const value = await measurePinnedRegion({
      pin: first,
      sha,
      campaign,
      concurrency: 4,
      measure: async () => {
        count++;
        return measured;
      },
      rePin: async () => assert.fail("Timed result repinned"),
      onRejected: () => assert.fail("Timed result discarded"),
    });
    assert.equal(count, 1);
    assert.equal(value.measurement, measured);
  }
  let count = 0;
  await measurePinnedRegion({
    pin: first,
    sha,
    campaign,
    concurrency: 4,
    measure: async () => {
      count++;
      return rejected;
    },
    rePin: async () => null,
    onRejected: () => {},
  });
  assert.equal(count, 3);
});
