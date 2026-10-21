import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import ts from "typescript";
import { localBindings } from "./local-api.mjs";

const PROD_DB = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const STAGE_DB = "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3";
const configPath = "wrangler.storefront-strangler.stage.jsonc";
const source = fs.readFileSync(configPath, "utf8");
function validateConfig(raw) {
  const parsed = ts.parseConfigFileTextToJson(configPath, raw);
  assert.equal(parsed.error, undefined, "Wrangler config must parse");
  const c = parsed.config;
  assert.equal(c.workers_dev, false);
  assert.equal(c.preview_urls, false);
  assert.ok(!("routes" in c) && !("route" in c));
  assert.equal(c.d1_databases?.length, 1);
  assert.equal(c.d1_databases[0].database_id, STAGE_DB);
  assert.ok(!raw.includes(PROD_DB));
  assert.ok(!c.r2_buckets && !c.kv_namespaces && !c.queues);
  assert.equal(c.services?.length, 1);
  assert.equal(c.services[0].binding, "CORE");
  assert.equal(c.vars?.COVE_SSR_STAGING, "1");
  assert.equal(c.vars?.COVE_STRANGLER_MODE, "isolated-evaluation");
  assert.equal(c.vars?.COVE_STRANGLER_EXPERIENCE, "1");
  assert.equal(c.vars?.COVE_STRANGLER_DATABASE_ID, STAGE_DB);
  assert.equal(c.ratelimits?.length, 1);
  assert.equal(c.ratelimits[0].simple.limit, 180);
}
validateConfig(source);
assert.throws(() => validateConfig(source.replace(STAGE_DB, PROD_DB)));
assert.throws(() => validateConfig(source.replace('"workers_dev": false', '"workers_dev": true')));
assert.throws(() => validateConfig(source.replace('"isolated-evaluation"', '"production"')));
assert.throws(() =>
  validateConfig(source.replace('"preview_urls": false', '"preview_urls": true')),
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-strangler-m1-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: {
      worker: "src/storefront-strangler/worker.ts",
      "api.server": "src/features/fore/api.server.ts",
      "storefront-anonymous-bootstrap.server":
        "src/features/fore/storefront-anonymous-bootstrap.server.ts",
      render: "src/storefront-strangler/render.ts",
      "fast-country": "src/lib/fast-storefront-relay.server.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    logLevel: "silent",
  });
  const worker = (await import(path.join(root, "worker.js"))).default;
  const { handleCoveApi } = await import(path.join(root, "api.server.js"));
  const { serveLeanAnonymousBootstrap } = await import(
    path.join(root, "storefront-anonymous-bootstrap.server.js")
  );
  const { renderStranglerStorefront } = await import(path.join(root, "render.js"));
  const { signFastCountryClaim } = await import(path.join(root, "fast-country.js"));
  let delegated = 0;
  const forwarded = [];
  const env = {
    ...localBindings(root),
    FORE_ENVIRONMENT: "production",
    COVE_SSR_STAGING: "1",
    COVE_STRANGLER_MODE: "isolated-evaluation",
    COVE_STRANGLER_EXPERIENCE: "1",
    COVE_THIN_RIGHTS_SHORTLIST: "1",
    COVE_THIN_PRESENTATION_CACHE: "1",
    COVE_SSR_DIAGNOSTICS: "1",
    COVE_STRANGLER_DATABASE_ID: STAGE_DB,
    COVE_SSR_STAGING_GATE_KEY: "a".repeat(64),
    COVE_STOREFRONT_READ_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
    CORE: {
      async fetch(req) {
        delegated++;
        forwarded.push({
          authorization: req.headers.get("authorization"),
          cookie: req.headers.get("cookie"),
        });
        return new Response("core:" + new URL(req.url).pathname);
      },
    },
  };
  // Build the fixture via Cove's actual canonical API and production schema.
  const seeded = await handleCoveApi(
    new Request("https://cove.test/api/fore/storefront/bootstrap", {
      headers: { "cf-ipcountry": "US" },
    }),
    { ...env, FORE_ENVIRONMENT: "development", COVE_SSR_STAGING: "0" },
  );
  assert.equal(seeded.status, 200, await seeded.text());
  function request(country = "US", extra = {}, route = "/") {
    const r = new Request("https://cove.test" + route, {
      headers: {
        authorization: "Bearer " + env.COVE_SSR_STAGING_GATE_KEY,
        "cf-connecting-ip": "203.0.113.3",
        ...extra,
      },
    });
    if (country) Object.defineProperty(r, "cf", { value: { country } });
    return r;
  }
  assert.equal((await worker.fetch(new Request("https://cove.test"), env)).status, 401);
  const transport = await worker.fetch(request(null, {}, "/__cove_perf/transport"), {
    ...env,
    DB: {
      prepare() {
        throw Error("Transport control must not query D1");
      },
    },
  });
  assert.equal(transport.status, 200);
  assert.equal(transport.headers.get("x-cove-renderer"), "transport-control");
  assert.equal(await transport.text(), "ok");
  assert.equal((await worker.fetch(request(), { ...env, COVE_SSR_STAGING: "0" })).status, 503);
  assert.equal(
    (await worker.fetch(request(), { ...env, COVE_STRANGLER_MODE: "production" })).status,
    503,
  );
  assert.equal(
    (await worker.fetch(request(), { ...env, COVE_STRANGLER_DATABASE_ID: PROD_DB })).status,
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
  for (const route of [
    "/library",
    "/store?search=pride",
    "/api/fore/orders",
    "/read/1342",
    "/assets/test.js",
    "/?search=pride",
  ]) {
    assert.equal(
      await (await worker.fetch(request("US", {}, route), env)).text(),
      "core:" + new URL("https://cove.test" + route).pathname,
    );
  }
  assert.ok(delegated >= 6);
  assert.equal(
    (
      await worker.fetch(request("US", {}, "/library"), {
        ...env,
        COVE_INTERNAL_CORE_STAGE_GATE_KEY: "b".repeat(64),
        CORE: {
          async fetch(req) {
            assert.equal(req.headers.get("authorization"), "Bearer " + "b".repeat(64));
            assert.notEqual(
              req.headers.get("authorization"),
              "Bearer " + env.COVE_SSR_STAGING_GATE_KEY,
            );
            return new Response("private-internal");
          },
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await worker.fetch(request("US", {}, "/library"), {
        ...env,
        COVE_INTERNAL_CORE_STAGE_GATE_KEY: env.COVE_SSR_STAGING_GATE_KEY,
      })
    ).status,
    503,
    "Core key cannot reuse exposed staging credential",
  );
  assert.ok(
    forwarded.every((entry) => entry.authorization === null),
    "Stage bearer must never leave the gateway",
  );
  for (const hint of ["cookie", "oai-authenticated-user-id", "x-fore-authenticated-user-id"]) {
    assert.equal(
      await (await worker.fetch(request("US", { [hint]: "private" }), env)).text(),
      "core:/",
    );
  }
  assert.ok(
    forwarded.some((entry) => entry.cookie === "private"),
    "Existing customer session cookies must survive delegation",
  );
  const diagnostic = await worker.fetch(request("US", {}, "/__cove_perf/bootstrap"), env);
  assert.equal(diagnostic.status, 200);
  const probe = await diagnostic.json();
  assert.equal(probe.stage, "bootstrap");
  assert.equal(probe.renderer, "thin");
  assert.ok(probe.ok && probe.books > 0);
  let firstBootstrap;
  for (const country of ["US", "CA", "SA", "JP"]) {
    const result = await worker.fetch(
      request(country, {
        "x-cove-client-country": "XX",
        "cf-ipcountry": "JP",
        "x-vercel-ip-country": "CA",
      }),
      env,
    );
    assert.equal(result.status, 200, country);
    assert.match(result.headers.get("cache-control"), /no-store/);
    assert.equal(result.headers.get("x-cove-renderer"), "strangler-evaluation");
    assert.equal(result.headers.has("set-cookie"), false);
    const html = await result.text();
    assert.match(html, new RegExp('data-rights-country="' + country + '"'));
    assert.match(html, /id="thin-discovery-form"/);
    assert.match(html, /id="thin-merchandising"/);
    assert.match(html, /data-thin-filter/);
    assert.match(html, /<nav[^>]+aria-label="Main"/);
    assert.match(html, /(?:\/library|\/cart|\/orders|\/wishlist)/);
    assert.match(html, /\/api\/fore\/recommendations\/discover/);
    assert.match(html, /\/api\/fore\/merchandising/);
    assert.doesNotMatch(html, /javascript:/i);

    const current = await (
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
      current.catalog.results.map((b) => b.productId),
    );
    if (country === "US") firstBootstrap = current;
  }
  // A direct Cloudflare request from the *Vercel egress* region cannot
  // authorize books for that region. The HMAC-verified client territory
  // must win, and the independently enforced primary D1 retail view remains.
  const relaySecret = "b".repeat(64);
  const customerEnv = {
    ...env,
    COVE_SSR_STAGING: "0",
    COVE_STRANGLER_MODE: "customer-gateway",
    COVE_STRANGLER_RELEASE_CERTIFIED: "1",
    COVE_STRANGLER_DATABASE_ID: PROD_DB,
    COVE_FAST_RELAY_KEY: relaySecret,
  };
  const relayHeaders = await signFastCountryClaim(
    {
      country: "CA",
      ip: "203.0.113.15",
      timestamp: Date.now(),
      nonce: "1".repeat(32),
    },
    relaySecret,
  );
  const relayRequest = (headers = relayHeaders, route = "/", init = {}) => {
    const signed = new Request("https://cove.test" + route, {
      ...init,
      headers,
    });
    Object.defineProperty(signed, "cf", { value: { country: "JP" } });
    return signed;
  };
  const liveSigned = await worker.fetch(relayRequest(), customerEnv);
  assert.equal(liveSigned.status, 200);
  assert.equal(liveSigned.headers.get("x-cove-renderer"), "strangler-live");
  assert.match(await liveSigned.text(), /data-rights-country="CA"/);
  assert.equal((await worker.fetch(relayRequest(new Headers()), customerEnv)).status, 401);
  const forgedRelay = new Headers(relayHeaders);
  forgedRelay.set("x-cove-fast-country", "US");
  assert.equal((await worker.fetch(relayRequest(forgedRelay), customerEnv)).status, 401);
  assert.equal(
    (await worker.fetch(relayRequest(relayHeaders, "/checkout"), customerEnv)).status,
    404,
  );
  const cookieRelay = new Headers(relayHeaders);
  cookieRelay.set("cookie", "fore-auth=customer-session");
  assert.equal((await worker.fetch(relayRequest(cookieRelay), customerEnv)).status, 404);
  assert.equal(
    (
      await worker.fetch(relayRequest(), {
        ...customerEnv,
        COVE_STRANGLER_RELEASE_CERTIFIED: "0",
      })
    ).status,
    503,
  );
  // Test the real-preview read-only wrapper against a local synthetic fixture,
  // proving its stable identity permits presentation reuse while each new
  // request still performs an authoritative primary rights query.
  const realPreviewEnv = {
    ...env,
    COVE_STRANGLER_MODE: "production-acceptance",
    COVE_STRANGLER_DATABASE_ID: PROD_DB,
    COVE_THIN_RIGHTS_SHORTLIST: "1",
    COVE_THIN_PRESENTATION_CACHE: "1",
    COVE_SSR_DIAGNOSTICS: "1",
  };
  const firstRealPreview = await worker.fetch(request(), realPreviewEnv);
  const secondRealPreview = await worker.fetch(request(), realPreviewEnv);
  assert.equal(firstRealPreview.status, 200);
  assert.equal(secondRealPreview.status, 200);
  assert.match(
    secondRealPreview.headers.get("server-timing") || "",
    /cove_catalog_presentation_reused;dur=1\.0/,
  );
  assert.ok(firstBootstrap.catalog.results.length > 1);
  // The real seeded, rights-checked synthetic HTML is reused for interaction
  // testing in Chromium rather than testing a disconnected hand-written page.
  fs.mkdirSync("artifacts", { recursive: true });
  fs.writeFileSync(
    "artifacts/strangler-fixture.html",
    renderStranglerStorefront(firstBootstrap, "http://127.0.0.1", true),
  );

  // A presentation-only shortlist may persist, but every request must
  // revalidate each visible title against the current D1 rights view.
  const seedFirst = await worker.fetch(request(), env);
  assert.equal(seedFirst.status, 200);
  const seedSecond = await worker.fetch(request(), env);
  assert.equal(seedSecond.status, 200);
  assert.match(seedSecond.headers.get("server-timing") || "", /cove_catalog_seeded;dur=1/);
  assert.match(
    seedSecond.headers.get("server-timing") || "",
    /cove_catalog_presentation_reused;dur=1/,
  );
  const first = firstBootstrap.catalog.results[0];
  await env.DB.prepare("UPDATE products SET storefront_status='inactive' WHERE id=?")
    .bind(first.productId)
    .run();
  assert.ok(
    !(await (await worker.fetch(request(), env)).text()).includes(
      'data-product="' + first.productId + '"',
    ),
  );
  const second = firstBootstrap.catalog.results[1];
  await env.DB.prepare(
    "UPDATE rights_grants SET status='revoked' WHERE edition_id=? AND decision='allow'",
  )
    .bind(second.editionId)
    .run();
  assert.ok(
    !(await (await worker.fetch(request(), env)).text()).includes(
      'data-product="' + second.productId + '"',
    ),
  );
  const down = await worker.fetch(request(), {
    ...env,
    DB: {
      prepare() {
        throw Error("D1 unavailable");
      },
      batch() {
        throw Error("D1 unavailable");
      },
    },
  });
  assert.equal(down.status, 503);
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
  const malicious = structuredClone(firstBootstrap);
  malicious.catalog.results = [
    {
      ...first,
      title: "<script>alert(1)</script>",
      formats: { "image/jpeg": "javascript:alert(1)" },
    },
  ];
  const escaped = renderStranglerStorefront(malicious, "https://cove.test");
  assert.doesNotMatch(escaped, /<script|javascript:/);
  assert.match(escaped, /&lt;script&gt;/);
  console.log(
    "PASS: clean main-base strangler; live rights shelf parity US/CA/SA/JP, revocation, stage gates, fail-closed, identity delegation, escaping.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
