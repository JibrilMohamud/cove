import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-authoritative-ssr-"));
try {
  await build({
    entryPoints: [
      "src/features/fore/storefront-bootstrap-fetch.ts",
      "src/features/fore/storefront-bootstrap-recovery.ts",
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const { requestStorefrontBootstrap } = await import(
    path.join(root, "storefront-bootstrap-fetch.mjs")
  );
  const { recoverStorefrontBootstrap, storefrontRecoveryTransport } = await import(
    path.join(root, "storefront-bootstrap-recovery.mjs")
  );
  const source = new Request("https://cove.test/api/fore/storefront/bootstrap", {
    headers: { "x-vercel-ip-country": "CA", "accept-language": "fr-CA,fr;q=0.9" },
  });
  const context = {
    rightsCountry: "CA",
    locale: "fr-CA",
    currency: "CAD",
    availableMarkets: [],
  };
  const page = { query: {}, title: "Bookstore" };
  const catalog = {
    results: [{ id: "ca-1", productId: "prd_ca_1" }],
    count: 1,
    next: null,
  };
  const trusted = (value) =>
    Response.json(value, { headers: { "x-cove-persistence": "remote-d1-r2" } });

  const calls = [];
  const fetchApi = async (request) => {
    const url = new URL(request.url);
    calls.push(url.pathname);
    assert.equal(request.headers.get("x-vercel-ip-country"), "CA");
    assert.equal(request.headers.get("accept-language"), "fr-CA,fr;q=0.9");
    if (url.pathname.endsWith("/bootstrap")) return new Response(null, { status: 503 });
    if (url.pathname.endsWith("/context")) return trusted(context);
    if (url.pathname.endsWith("/page")) {
      assert.equal(url.searchParams.get("path"), "/");
      return trusted(page);
    }
    if (url.pathname.endsWith("/catalog")) {
      assert.equal(url.searchParams.get("currency"), "CAD");
      assert.equal(url.searchParams.get("sort"), "popular");
      return trusted(catalog);
    }
    throw new Error("Unexpected API path");
  };
  const htmlInitial = await requestStorefrontBootstrap(source, fetchApi, {
    timeoutMs: 2_000,
    firstAttemptMs: 300,
    recover: (request, api) => recoverStorefrontBootstrap(request, api, true),
  });
  const result = JSON.parse(htmlInitial);
  assert.equal(result.context.rightsCountry, "CA");
  assert.equal(result.catalog.results[0].productId, "prd_ca_1");
  assert.equal(result.catalogQuery, "search=&sort=popular&page=1&currency=CAD");
  assert.deepEqual(calls, [
    "/api/fore/storefront/bootstrap",
    "/api/fore/storefront/context",
    "/api/fore/storefront/page",
    "/api/fore/catalog",
  ]);

  // A genuinely stalled all-in-one endpoint must not need the complete
  // ten-second budget if the individual live endpoints remain healthy.
  let stalledAttempts = 0;
  const recoveryEvents = [];
  const timed = await requestStorefrontBootstrap(
    source,
    async (request) => {
      if (new URL(request.url).pathname.endsWith("/bootstrap")) {
        stalledAttempts++;
        return new Promise((resolve, reject) => {
          const watchdog = setTimeout(() => reject(new Error("Missing upstream abort")), 1000);
          request.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(watchdog);
              reject(request.signal.reason);
            },
            { once: true },
          );
        });
      }
      return fetchApi(request);
    },
    {
      timeoutMs: 400,
      firstAttemptMs: 20,
      recover: (request, api) => recoverStorefrontBootstrap(request, api, true),
      onRecovery: (result) => recoveryEvents.push(result),
    },
  );
  assert.equal(
    stalledAttempts,
    1,
    "A successful split recovery avoids retrying a stalled bootstrap",
  );
  assert.equal(JSON.parse(timed).catalog.results[0].productId, "prd_ca_1");
  assert.equal(recoveryEvents.length, 1);
  assert.equal(recoveryEvents[0].success, true);

  let directCalls = 0;
  let independentCalls = 0;
  const independent = storefrontRecoveryTransport(
    async () => {
      directCalls++;
      throw new Error("Stalled direct gateway must not run during recovery");
    },
    async (request) => {
      independentCalls++;
      assert.equal(request.cache, "no-store");
      assert.equal(request.redirect, "manual");
      assert.equal(request.headers.get("x-vercel-ip-country"), "CA");
      return fetchApi(request);
    },
    true,
  );
  const splitValue = await recoverStorefrontBootstrap(source, independent, true, true);
  assert.equal(JSON.parse(splitValue).context.rightsCountry, "CA");
  assert.equal(directCalls, 0);
  assert.equal(independentCalls, 3, "Context, page and catalog use the independent proxy");
  assert.equal(
    await recoverStorefrontBootstrap(
      source,
      async (request) => {
        if (request.url.includes("/context")) return trusted({ ...context, rightsCountry: "US" });
        if (request.url.includes("/page")) return trusted(page);
        return trusted(catalog);
      },
      true,
      true,
    ),
    null,
    "A server-country response must not replace the reader's territorial rights",
  );
  const absentCountryHeaders = new Headers(source.headers);
  absentCountryHeaders.delete("x-vercel-ip-country");
  const noTrustedCountry = new Request(source, { headers: absentCountryHeaders });
  assert.equal(
    await recoverStorefrontBootstrap(
      noTrustedCountry,
      async () => {
        throw new Error("An ungrounded region must not call a remote storefront");
      },
      true,
      true,
    ),
    null,
    "No original trusted country means no cross-region proxy recovery",
  );

  let called = false;
  assert.equal(
    await requestStorefrontBootstrap(source, async () => new Response(null, { status: 403 }), {
      recover: async () => {
        called = true;
        return htmlInitial;
      },
    }),
    null,
  );
  assert.equal(called, false, "Denied bootstrap must never invoke recovery");

  assert.equal(
    await recoverStorefrontBootstrap(
      source,
      async (request) => {
        if (request.url.includes("/context"))
          return Response.json({ ...context, rightsCountry: "US" });
        if (request.url.includes("/page")) return trusted(page);
        return trusted(catalog);
      },
      true,
    ),
    null,
    "A Vercel seed without remote D1 provenance must not override rights",
  );

  assert.equal(
    await recoverStorefrontBootstrap(
      source,
      async (request) => {
        if (request.url.includes("/context")) return trusted(context);
        if (request.url.includes("/page")) return trusted(page);
        return new Response(null, { status: 403 });
      },
      true,
    ),
    null,
    "Denied live rights in the catalog must produce no SSR shelf",
  );

  assert.equal(
    await recoverStorefrontBootstrap(
      source,
      async (request) => {
        if (request.url.includes("/context")) return trusted(context);
        if (request.url.includes("/page")) return trusted(page);
        return trusted({ ...catalog, results: [] });
      },
      true,
    ),
    null,
    "An empty rights-scoped catalog is not replaced with another territory",
  );
  console.log("Authoritative SSR recovery and territorial-denial regressions passed.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
