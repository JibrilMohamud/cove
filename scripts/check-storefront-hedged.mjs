import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cove-storefront-hedge-"));
try {
  await build({
    entryPoints: ["src/features/fore/storefront-hedged-fetch.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(dir, "hedged.mjs"),
    logLevel: "silent",
  });
  const { hedgedStorefrontBootstrap } = await import(path.join(dir, "hedged.mjs"));
  const source = new Request("https://cove.test/api/fore/storefront/bootstrap", {
    headers: { "x-vercel-ip-country": "CA", "accept-language": "fr-CA" },
  });
  const payload = {
    context: {
      rightsCountry: "CA",
      locale: "fr-CA",
      currency: "CAD",
      availableMarkets: [],
    },
    page: { query: {}, pageType: "home" },
    catalog: { results: [{ productId: "prd_verified_1" }], count: 1 },
    catalogQuery: "search=&sort=popular&page=1&currency=CAD",
    at: Date.now(),
  };
  const verified = () =>
    Response.json(payload, { headers: { "x-cove-persistence": "remote-d1-r2" } });
  const never = (request) =>
    new Promise((resolve, reject) => {
      const onAbort = () => reject(request.signal.reason || new Error("aborted"));
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort();
    });

  let alternateCalls = 0;
  const phases = [];
  const started = performance.now();
  const hedged = await hedgedStorefrontBootstrap(
    source,
    never,
    async (request) => {
      alternateCalls++;
      assert.equal(request.headers.get("x-vercel-ip-country"), "CA");
      assert.equal(request.headers.get("accept-language"), "fr-CA");
      return verified();
    },
    {
      hedgeAfterMs: 15,
      timeoutMs: 350,
      onPhase: (...args) => phases.push(args),
    },
  );
  assert.equal(JSON.parse(hedged).catalog.results.length, 1);
  assert.equal(alternateCalls, 1);
  assert.ok(performance.now() - started < 200, "Independent hedge must beat the cold timeout");
  assert.ok(phases.some(([phase, kind]) => phase === "alternate" && kind === "ok"));

  alternateCalls = 0;
  const immediate = await hedgedStorefrontBootstrap(
    source,
    async () => verified(),
    async () => {
      alternateCalls++;
      return verified();
    },
    { hedgeAfterMs: 50, timeoutMs: 200 },
  );
  assert.ok(immediate);
  assert.equal(alternateCalls, 0, "Healthy primary does not duplicate rights queries");

  alternateCalls = 0;
  const denied = await hedgedStorefrontBootstrap(
    source,
    async () => new Response(null, { status: 403 }),
    async () => {
      alternateCalls++;
      return verified();
    },
    { hedgeAfterMs: 40, timeoutMs: 200 },
  );
  assert.equal(denied, null);
  assert.equal(alternateCalls, 0, "Explicit 403 must never fall back to a different edition");
  alternateCalls = 0;
  const denialWithBadCleanup = await hedgedStorefrontBootstrap(
    source,
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw new Error("Stream cleanup unavailable");
          },
        }),
        { status: 403 },
      ),
    async () => {
      alternateCalls++;
      return verified();
    },
    { hedgeAfterMs: 10, timeoutMs: 100 },
  );
  assert.equal(denialWithBadCleanup, null);
  assert.equal(alternateCalls, 0, "A failed stream cancellation cannot override live 403");

  for (const response of [
    () => Response.json(payload),
    () =>
      Response.json(
        { ...payload, context: { ...payload.context, rightsCountry: "US" } },
        { headers: { "x-cove-persistence": "remote-d1-r2" } },
      ),
    () =>
      Response.json(
        { ...payload, catalog: { ...payload.catalog, results: [] } },
        { headers: { "x-cove-persistence": "remote-d1-r2" } },
      ),
  ]) {
    const value = await hedgedStorefrontBootstrap(source, never, async () => response(), {
      hedgeAfterMs: 5,
      timeoutMs: 60,
    });
    assert.equal(value, null, "Invalid or unsigned alternate must not publish books");
  }

  const withoutCountry = new Headers(source.headers);
  withoutCountry.delete("x-vercel-ip-country");
  alternateCalls = 0;
  assert.equal(
    await hedgedStorefrontBootstrap(
      new Request(source, { headers: withoutCountry }),
      never,
      async () => {
        alternateCalls++;
        return verified();
      },
      { hedgeAfterMs: 5, timeoutMs: 60 },
    ),
    null,
  );
  assert.equal(alternateCalls, 0, "Unknown visitor country must not cross proxy boundary");
  alternateCalls = 0;
  const unassertedSuccess = await hedgedStorefrontBootstrap(
    new Request(source, { headers: withoutCountry }),
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return verified();
    },
    async () => {
      alternateCalls++;
      return verified();
    },
    { hedgeAfterMs: 5, timeoutMs: 100 },
  );
  assert.ok(unassertedSuccess, "An ordinary first request may complete without a country header");
  assert.equal(alternateCalls, 0);

  // A cold timeout must report whether legal country proof permitted a hedge.
  const coldDeadline = [];
  assert.equal(
    await hedgedStorefrontBootstrap(source, never, never, {
      hedgeAfterMs: 5,
      timeoutMs: 50,
      onDeadline: (state) => coldDeadline.push(state),
    }),
    null,
  );
  assert.deepEqual(coldDeadline, [{
    countryAsserted: true,
    primaryCompleted: false,
    alternateStarted: true,
    alternateCompleted: false,
  }]);
  const unknownDeadline = [];
  assert.equal(
    await hedgedStorefrontBootstrap(new Request(source, { headers: withoutCountry }), never, never, {
      hedgeAfterMs: 5,
      timeoutMs: 30,
      onDeadline: (state) => unknownDeadline.push(state),
    }),
    null,
  );
  assert.equal(unknownDeadline.length, 1);
  assert.equal(unknownDeadline[0].countryAsserted, false);
  assert.equal(unknownDeadline[0].alternateStarted, false);

  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(
    await hedgedStorefrontBootstrap(
      new Request(source, { signal: cancelled.signal }),
      async () => {
        throw new Error("No network on aborted page");
      },
      async () => {
        throw new Error("No network on aborted page");
      },
    ),
    null,
  );
  console.log("Live-rights hedged SSR, 403, region and provenance regressions passed.");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
