import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { parseThinConfig, parseBenchmarkConfig } from "./performance/thin-config.mjs";
import { localBindings } from "./local-api.mjs";
const configSource = fs.readFileSync("wrangler.storefront-thin.jsonc", "utf8");
parseThinConfig(configSource);
const ingressSource = fs.readFileSync("wrangler.storefront-benchmark.jsonc", "utf8");
parseBenchmarkConfig(ingressSource);
assert.throws(() =>
  parseBenchmarkConfig(
    ingressSource.replace(
      '"workers_dev": true',
      '"workers_dev": true, "routes": ["cove.example/*"]',
    ),
  ),
);
assert.throws(() =>
  parseBenchmarkConfig(
    ingressSource.replace('"workers_dev": true', '"workers_dev": true, "d1_databases": []'),
  ),
);
assert.throws(() =>
  parseThinConfig(
    configSource.replace(
      "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
      "4bd657ac-8789-403e-a28c-93aba8d0a989",
    ),
  ),
);
assert.throws(() => parseThinConfig(configSource.replace('"synthetic-only"', '"production"')));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-thin-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: {
      worker: "src/storefront-thin/worker.ts",
      "api.server": "src/features/fore/api.server.ts",
      client: "src/storefront-thin/synthetic-client.ts",
      render: "src/storefront-thin/render.ts",
      ingress: "src/storefront-thin/benchmark-ingress.ts",
      failure: "src/storefront-thin/failure.ts",
      "storefront-anonymous-bootstrap.server":
        "src/features/fore/storefront-anonymous-bootstrap.server.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    logLevel: "silent",
  });
  const { syntheticClient } = await import(path.join(root, "client.js"));
  for (const config of [
    { COVE_SSR_STAGING: "0" },
    { COVE_SSR_STAGING: "1", COVE_PERF_DATABASE_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989" },
  ])
    assert.throws(() =>
      syntheticClient(
        new Request("https://test/", { headers: { "x-cove-perf-client": "1" } }),
        config,
      ),
    );
  const modeled = syntheticClient(
    new Request("https://test/", { headers: { "x-cove-perf-client": "512" } }),
    { COVE_SSR_STAGING: "1", COVE_PERF_DATABASE_ID: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3" },
  );
  assert.equal(modeled.headers.get("cf-connecting-ip"), "198.18.2.0");
  assert.equal(modeled.headers.has("x-cove-perf-client"), false);
  const worker = (await import(path.join(root, "worker.js"))).default;
  const ingress = (await import(path.join(root, "ingress.js"))).default;
  const { bootstrapFailureKind } = await import(path.join(root, "failure.js"));
  assert.equal(bootstrapFailureKind(new Error("D1_ERROR: query failed")), "database");
  assert.equal(bootstrapFailureKind(new Error("opaque token private user SQL")), "unclassified");
  assert.equal(
    bootstrapFailureKind(new Error("outer", { cause: new Error("replica disconnected") })),
    "transient-service",
  );
  const { handleCoveApi } = await import(path.join(root, "api.server.js"));
  const { serveLeanAnonymousBootstrap } = await import(
    path.join(root, "storefront-anonymous-bootstrap.server.js")
  );
  const { renderThinStorefront } = await import(path.join(root, "render.js"));
  const env = {
    ...localBindings(root),
    FORE_ENVIRONMENT: "production",
    COVE_SSR_STAGING: "1",
    COVE_THIN_STOREFRONT: "synthetic-only",
    COVE_SSR_STAGING_GATE_KEY: "a".repeat(64),
    COVE_STOREFRONT_READ_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
    CORE: {
      async fetch(req) {
        return new Response("core:" + new URL(req.url).pathname);
      },
    },
  };
  // Seed the normal fixture through the real application before setting production.
  const seeded = await handleCoveApi(
    new Request("https://cove.test/api/fore/storefront/bootstrap", {
      headers: { "cf-ipcountry": "US" },
    }),
    { ...env, COVE_SSR_STAGING: "0", FORE_ENVIRONMENT: "development" },
  );
  assert.equal(seeded.status, 200, await seeded.text());
  function request(country = "US", extra = {}, pathname = "/") {
    const r = new Request("https://cove.test" + pathname, {
      headers: {
        authorization: "Bearer " + env.COVE_SSR_STAGING_GATE_KEY,
        "cf-connecting-ip": "203.0.113.3",
        ...extra,
      },
    });
    if (country) Object.defineProperty(r, "cf", { value: { country } });
    return r;
  }
  // Control must be available only after the exact staging bearer gate.
  // Unlike the homepage it must never touch primary D1, catalog or rights.
  const noDb = {
    ...env,
    DB: {
      prepare() {
        throw Error("No-D1 transport control reached primary database");
      },
      batch() {
        throw Error("No-D1 transport control reached primary database");
      },
    },
    COVE_STOREFRONT_READ_LIMITER: {
      async limit() {
        throw Error("Transport control unexpectedly called the read limiter");
      },
    },
  };
  const transport = await worker.fetch(request("US", {}, "/__cove_perf/transport"), noDb);
  assert.equal(transport.status, 200);
  assert.equal(transport.headers.get("x-cove-perf-control"), "thin-no-d1");
  assert.match(transport.headers.get("cache-control"), /no-store/);
  assert.equal(await transport.text(), "ok");
  assert.equal(
    (await worker.fetch(new Request("https://cove.test/__cove_perf/transport"), noDb)).status,
    401,
    "Unauthenticated requests may not reach the benchmark control",
  );
  assert.equal(
    (
      await worker.fetch(request("US", {}, "/__cove_perf/transport"), {
        ...noDb,
        COVE_THIN_STOREFRONT: "production",
      })
    ).status,
    503,
    "Production cannot enable the synthetic benchmark control",
  );
  assert.equal((await worker.fetch(new Request("https://cove.test"), env)).status, 401);
  for (const role of ["baseline", "thin"]) {
    const receive = (req) => {
      assert.equal(req.headers.has("x-cove-perf-renderer"), false);
      // Native Workers preserve cf when cloning a Request; Node's DOM shim
      // has no cf support. Model the platform metadata at the binding edge.
      Object.defineProperty(req, "cf", { value: { country: "US" } });
      return worker.fetch(req, env);
    };
    const bindings = {
      BASELINE: { fetch: receive },
      THIN: { fetch: receive },
    };
    assert.equal(
      (
        await ingress.fetch(
          new Request("https://test/", { headers: { "x-cove-perf-renderer": role } }),
          bindings,
        )
      ).status,
      401,
    );
    assert.equal(
      (await ingress.fetch(request("US", { "x-cove-perf-renderer": role }), bindings)).status,
      200,
    );
  }
  assert.equal((await ingress.fetch(request(), {})).status, 404);
  const diagnostic = await worker.fetch(request("US", {}, "/__cove_perf/bootstrap"), env);
  assert.equal(diagnostic.status, 200);
  const probe = await diagnostic.json();
  assert.equal(probe.renderer, "thin");
  assert.equal(probe.stage, "bootstrap");
  assert.ok(probe.ok && probe.books > 0 && probe.markets > 0);
  assert.equal(
    (await worker.fetch(request(), { ...env, COVE_THIN_STOREFRONT: "production" })).status,
    503,
  );
  assert.equal(
    (
      await worker.fetch(
        request(null, { "x-cove-client-country": "US", "cf-ipcountry": "US" }),
        env,
      )
    ).status,
    503,
  );
  for (const hint of ["cookie", "oai-authenticated-user-id", "x-fore-authenticated-user-id"])
    assert.equal(
      await (await worker.fetch(request("US", { [hint]: "session" }), env)).text(),
      "core:/",
    );
  for (const route of [
    "/store?search=pride",
    "/library",
    "/api/fore/account",
    "/reader/1342",
    "/?search=pride",
    "/assets/test.js",
  ])
    assert.match(await (await worker.fetch(request("US", {}, route), env)).text(), /^core:/);
  for (const country of ["US", "CA", "SA", "JP"]) {
    const result = await worker.fetch(
      request(country, { "x-cove-client-country": "XX", "x-vercel-ip-country": "US" }),
      env,
    );
    assert.equal(result.status, 200, country);
    assert.match(result.headers.get("cache-control"), /no-store/);
    assert.equal(result.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    assert.equal(result.headers.has("set-cookie"), false);
    const html = await result.text();
    assert.match(html, new RegExp(`data-rights-country="${country}"`));
    const bootstrap = await (
      await serveLeanAnonymousBootstrap(
        new Request("https://cove.test/api/fore/storefront/bootstrap", {
          headers: { "x-cove-client-country": country, "cf-connecting-ip": "203.0.113.3" },
        }),
        env,
      )
    ).json();
    const actual = [...html.matchAll(/data-product="([^"]*)"/g)].map((x) => x[1]);
    assert.deepEqual(
      actual,
      bootstrap.catalog.results.map((b) => b.productId),
      "same ordered live primary rights shelf",
    );
    assert.match(html, /role="search"/);
    assert.doesNotMatch(html, /<script/);
  }
  // The isolated metadata batch may be coalesced in flight, but cannot
  // reuse an already completed or failed promise; rights remain independent.
  const originalDb = env.DB;
  let batches = 0;
  let primaryRightsReads = 0;
  const countedDb = {
    prepare(sql) {
      if (String(sql).startsWith("WITH first_paint")) primaryRightsReads++;
      return originalDb.prepare(sql);
    },
    async batch(stmts) {
      batches++;
      await new Promise((resolve) => setTimeout(resolve, 35));
      return originalDb.batch(stmts);
    },
  };
  const singleflight = {
    ...env,
    DB: countedDb,
    COVE_THIN_METADATA_COALESCE: "1",
    COVE_SSR_DIAGNOSTICS: "1",
  };
  const together = await Promise.all([
    worker.fetch(request("US"), singleflight),
    worker.fetch(request("US"), singleflight),
  ]);
  assert.deepEqual(
    together.map((response) => response.status),
    [200, 200],
  );
  assert.equal(batches, 1, "Same-market concurrent anonymous reads share only the metadata batch");
  assert.equal(
    primaryRightsReads,
    2,
    "Every joined request must still execute its own primary rights SQL",
  );
  assert.match(together[1].headers.get("server-timing") || "", /cove_context_joined;dur=1/);
  const shelves = await Promise.all(together.map((response) => response.text()));
  assert.deepEqual(
    [...shelves[0].matchAll(/data-product="([^"]+)"/g)].map((x) => x[1]),
    [...shelves[1].matchAll(/data-product="([^"]+)"/g)].map((x) => x[1]),
  );
  assert.equal((await worker.fetch(request("US"), singleflight)).status, 200);
  assert.equal(batches, 2, "Completed context metadata must not be cached");
  const langs = await Promise.all([
    worker.fetch(request("US", { "accept-language": "fr-FR" }), singleflight),
    worker.fetch(request("US", { "accept-language": "en-US" }), singleflight),
  ]);
  assert.deepEqual(
    langs.map((x) => x.status),
    [200, 200],
  );
  assert.equal(batches, 4, "Different language preferences must not share a batch");
  const disabled = await Promise.all([
    worker.fetch(request("US", { "x-cove-perf-no-metadata-flight": "1" }), singleflight),
    worker.fetch(request("US", { "x-cove-perf-no-metadata-flight": "1" }), singleflight),
  ]);
  assert.deepEqual(
    disabled.map((x) => x.status),
    [200, 200],
  );
  assert.equal(batches, 6, "Protected synthetic A/B control must disable only metadata coalescing");
  const failingDb = {
    ...countedDb,
    async batch() {
      batches++;
      throw Error("synthetic context outage");
    },
  };
  assert.equal((await worker.fetch(request("US"), { ...singleflight, DB: failingDb })).status, 503);
  assert.equal((await worker.fetch(request("US"), { ...singleflight, DB: failingDb })).status, 503);
  assert.equal(batches, 8, "Failed context promise must not be reused");
  // Exercise a real rights revocation WITH coalescing enabled, not just
  // the unoptimized path; metadata reuse must never preserve stale offers.
  const firstJoinedProduct = /data-product="([^"]+)"/.exec(shelves[0])?.[1];
  assert.ok(firstJoinedProduct);
  const record = await originalDb
    .prepare("SELECT edition_id FROM products WHERE id=?")
    .bind(firstJoinedProduct)
    .first();
  assert.ok(record?.edition_id);
  const activeGrants = await originalDb
    .prepare(
      "SELECT id FROM rights_grants WHERE edition_id=? AND decision='allow' AND status='active'",
    )
    .bind(record.edition_id)
    .all();
  assert.ok(activeGrants.results.length);
  try {
    for (const grant of activeGrants.results) {
      await originalDb
        .prepare("UPDATE rights_grants SET status='revoked' WHERE id=?")
        .bind(grant.id)
        .run();
    }
    const afterRevocation = await worker.fetch(request("US"), singleflight);
    assert.equal(afterRevocation.status, 200);
    assert.doesNotMatch(
      await afterRevocation.text(),
      new RegExp('data-product="' + firstJoinedProduct + '"'),
      "Live primary rights revocation must apply with metadata singleflight enabled",
    );
  } finally {
    for (const grant of activeGrants.results) {
      await originalDb
        .prepare("UPDATE rights_grants SET status='active' WHERE id=?")
        .bind(grant.id)
        .run();
    }
  }
  const restored = await worker.fetch(request("US"), singleflight);
  assert.equal(restored.status, 200);
  assert.match(await restored.text(), new RegExp('data-product="' + firstJoinedProduct + '"'));
  const initial = await (
    await serveLeanAnonymousBootstrap(
      new Request("https://cove.test/api/fore/storefront/bootstrap", {
        headers: { "x-cove-client-country": "US", "cf-connecting-ip": "203.0.113.3" },
      }),
      env,
    )
  ).json();
  assert.ok(initial.catalog.results.length);
  const first = initial.catalog.results[0];
  await env.DB.prepare("UPDATE products SET storefront_status='inactive' WHERE id=?")
    .bind(first.productId)
    .run();
  assert.ok(
    !(await (await worker.fetch(request(), env)).text()).includes(
      `data-product="${first.productId}"`,
    ),
    "stale presentation cannot retain deactivated product",
  );
  // Actual grant revocation, not merely deactivating a product.
  const second = initial.catalog.results[1];
  await env.DB.prepare(
    "UPDATE rights_grants SET status='revoked' WHERE edition_id=? AND decision='allow'",
  )
    .bind(second.editionId)
    .run();
  assert.ok(
    !(await (await worker.fetch(request(), env)).text()).includes(
      `data-product="${second.productId}"`,
    ),
    "grant revocation effective on next response",
  );
  assert.equal(
    (
      await worker.fetch(request(), {
        ...env,
        DB: {
          prepare() {
            throw Error("outage");
          },
          batch() {
            throw Error("outage");
          },
        },
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await worker.fetch(request(), {
        ...env,
        COVE_STOREFRONT_READ_LIMITER: {
          async limit() {
            return { success: false };
          },
        },
      })
    ).status,
    429,
  );
  const bad = structuredClone(initial);
  bad.catalog.results = [
    {
      ...first,
      title: "<script>alert(1)</script>",
      formats: { "image/jpeg": "javascript:alert(1)" },
    },
  ];
  const escaped = renderThinStorefront(bad, "https://cove.test");
  assert.doesNotMatch(escaped, /<script|javascript:/);
  assert.match(escaped, /&lt;script&gt;/);
  console.log(
    "PASS: thin storefront ordered rights parity across US/CA/SA/JP; immediate grant revocation; identity fallback; forged geo rejection; outage/limiter fail-closed; escaping.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
