import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-bootstrap-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["src/features/fore/api.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "api.mjs"),
    logLevel: "silent",
  });
  const { handleCoveApi } = await import(path.join(root, "api.mjs"));
  await build({
    entryPoints: ["src/features/fore/storefront-anonymous-bootstrap.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "anonymous.mjs"),
    logLevel: "silent",
  });
  const { canUseLeanAnonymousBootstrap, serveLeanAnonymousBootstrap } = await import(
    path.join(root, "anonymous.mjs")
  );
  await build({
    entryPoints: ["src/features/fore/taxonomy.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "taxonomy.mjs"),
    logLevel: "silent",
  });
  const { upsertTaxonomyNode, taxonomyTree } = await import(path.join(root, "taxonomy.mjs"));
  const env = localBindings(root);
  // Guard the cold SSR path itself, not merely its JSON shape: a future
  // refactor must not silently bring large live taxonomy scans back into
  // the render-blocking bootstrap.
  let joinedMarketLocaleReads = 0;
  let atomicRightsShelfQueries = 0;
  let localePaymentBatches = 0;
  const fastFirstPaintEnv = {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements) => {
            if (statements.length === 2) localePaymentBatches++;
            return target.batch(statements);
          };
        if (property === "prepare")
          return (sql) => {
            assert.ok(
              !/GROUP\s+BY\s+et\.taxonomy_node_id/i.test(sql),
              "first-paint bootstrap must defer taxonomy count aggregation",
            );
            assert.ok(
              !/SELECT l\.\*,ml\.priority FROM storefront_market_locales/i.test(sql),
              "first paint must not perform separate supported-locale round trips",
            );
            if (/FROM storefront_markets m\s+LEFT JOIN storefront_market_locales ml/i.test(sql))
              joinedMarketLocaleReads += 1;
            if (/WITH eligible AS MATERIALIZED/i.test(sql)) {
              assert.match(sql, /JOIN eligible selected ON selected\.product_id=p\.id/);
              assert.match(sql, /retail_product_availability_rows/i);
              assert.match(
                sql,
                /currency_probe INDEXED BY idx_search_price/i,
                "Live first-paint selection must reject empty currencies via existing indexed primary D1",
              );
              atomicRightsShelfQueries += 1;
            }
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  for (const [country, locale] of [
    ["US", "en-US"],
    ["CA", "fr-FR"],
    ["SA", "ar-SA"],
    ["JP", "en-US"],
  ]) {
    const headers = { "cf-ipcountry": country, "accept-language": locale };
    const response = await handleCoveApi(
      new Request("https://cove.test/api/fore/storefront/bootstrap", { headers }),
      fastFirstPaintEnv,
    );
    assert.equal(response.status, 200);
    const bootstrap = await response.json();
    assert.equal(bootstrap.context.rightsCountry, country);
    assert.ok(bootstrap.context.availableMarkets.length);
    const legacySupported = await env.DB.prepare(
      `SELECT l.locale,l.language_code,l.direction,ml.priority
       FROM storefront_market_locales ml JOIN storefront_locales l ON l.locale=ml.locale
       WHERE ml.country_code=? AND ml.active=1 AND l.status='active'
       ORDER BY ml.priority,l.locale`,
    )
      .bind(country)
      .all();
    assert.ok(
      legacySupported.results.some((row) => row.locale === bootstrap.context.locale),
      "Combined market/locale query must preserve supported locale for " + country,
    );
    assert.equal(
      "taxonomy" in bootstrap,
      false,
      "slow category counts cannot gate the first book shelf",
    );
    const categoryResponse = await handleCoveApi(
      new Request("https://cove.test/api/fore/taxonomy", { headers }),
      env,
    );
    assert.equal(categoryResponse.status, 200);
    const categories = await categoryResponse.json();
    assert.equal(categories.territory, country);
    assert.ok(
      Array.isArray(categories.nodes),
      "category browsing still fetches the rights-scoped taxonomy",
    );
    const catalog = await handleCoveApi(
      new Request("https://cove.test/api/fore/catalog?" + bootstrap.catalogQuery, { headers }),
      env,
    );
    const expected = await catalog.json();
    assert.equal(bootstrap.catalog.preview, true, "first paint defers global counts/facets");
    assert.equal(bootstrap.catalog.facets, undefined);
    assert.equal(bootstrap.catalog.count, bootstrap.catalog.results.length);
    assert.deepEqual(
      bootstrap.catalog.results.map((b) => b.id),
      expected.results.map((b) => b.id),
      country + ": SSR uses the ordinary rights-filtered catalog",
    );
    // Lean first-paint projection must preserve every field the book cards
    // display. Detail-only metadata remains deferred to the full catalog.
    for (let i = 0; i < bootstrap.catalog.results.length; i++) {
      const first = bootstrap.catalog.results[i];
      const full = expected.results[i];
      assert.equal(first.title, full.title);
      assert.deepEqual(first.authors, full.authors);
      assert.deepEqual(first.offer, full.offer);
      assert.deepEqual(first.series, full.series);
      assert.deepEqual(first.bookshelves, full.bookshelves);
      assert.deepEqual(first.subjects, full.subjects);
      assert.deepEqual(first.formats, full.formats);
      assert.deepEqual(first.readingAvailability, full.readingAvailability);
      // Live retail rights already filtered the entire SSR book list. The
      // anonymous BookCard never displays secondary subscription/library
      // badges, so preview access flags must remain unknown until the full
      // channel-verified catalog response arrives after hydration.
      assert.equal("subscriptionEligible" in first, false);
      assert.equal("libraryEligible" in first, false);
      assert.equal(typeof full.subscriptionEligible, "boolean");
      assert.equal(typeof full.libraryEligible, "boolean");
    }
    assert.equal(
      new URLSearchParams(bootstrap.catalogQuery).get("currency"),
      bootstrap.context.currency,
    );
    assert.ok(
      !("user" in bootstrap) && !("library" in bootstrap),
      "bootstrap includes no private reading records",
    );
  }
  // Compare the independently bundled, lean Cloudflare SSR path to the
  // canonical API in four countries. A replica may supply presentation-only
  // configuration, but the live retail rights filter must remain on primary.
  for (const [country, language] of [
    ["US", "en-US"],
    ["CA", "fr-FR"],
    ["SA", "ar-SA"],
    ["JP", "en-US"],
  ]) {
    const visitorHeaders = {
      "x-cove-client-country": country,
      "cf-connecting-ip": "203.0.113.123",
      "accept-language": language,
    };
    const req = new Request("https://cove.test/api/fore/storefront/bootstrap", {
      headers: visitorHeaders,
    });
    let failPrimary = false;
    let limitCalls = 0,
      authoritativeRights = 0,
      anonymousPresentationBatches = 0;
    const sessionModes = [];
    const proxyDb = new Proxy(env.DB, {
      get(target, property) {
        if (property === "withSession")
          return (mode) => {
            sessionModes.push(mode);
            return new Proxy(target, {
              get(reader, key) {
                if (key === "batch")
                  return (statements) => {
                    anonymousPresentationBatches++;
                    assert.equal(
                      statements.length,
                      4,
                      "Guest first paint must collect market, locale, payments and page in one D1 batch",
                    );
                    return reader.batch(statements);
                  };
                if (key === "prepare")
                  return (sql) => {
                    assert.doesNotMatch(
                      sql,
                      /retail_product_availability_rows/i,
                      "Anonymous replica may never authorize an edition",
                    );
                    return reader.prepare(sql);
                  };
                const value = Reflect.get(reader, key);
                return typeof value === "function" ? value.bind(reader) : value;
              },
            });
          };
        if (property === "prepare")
          return (sql) => {
            if (/\beligible AS MATERIALIZED/i.test(sql)) {
              if (failPrimary) throw new Error("Primary rights authority unavailable");
              assert.match(sql, /retail_product_availability_rows/i);
              assert.match(
                sql,
                /currency_probe INDEXED BY idx_search_price/i,
                "Live first-paint selection must reject empty currencies via existing indexed primary D1",
              );
              assert.match(
                sql,
                /first_paint_currency\(currency\) AS MATERIALIZED/i,
                "Anonymous active-market currency must resolve in isolated primary-D1 CTE",
              );
              authoritativeRights++;
            }
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const liveEnv = {
      ...env,
      DB: proxyDb,
      FORE_ENVIRONMENT: "production",
      COVE_STOREFRONT_READ_LIMITER: {
        async limit(input) {
          limitCalls++;
          assert.equal(input.key, "search:catalog:ip:203.0.113.123");
          return { success: true };
        },
      },
    };
    assert.equal(canUseLeanAnonymousBootstrap(req, liveEnv), true);
    for (const key of ["cookie", "authorization", "oai-authenticated-user-id"]) {
      const guarded = new Request(req, {
        headers: { ...visitorHeaders, [key]: "non-empty" },
      });
      assert.equal(
        canUseLeanAnonymousBootstrap(guarded, liveEnv),
        false,
        `Authenticated/session-bearing request must not use lean SSR: ${key}`,
      );
    }
    const lean = await serveLeanAnonymousBootstrap(req, liveEnv);
    assert.equal(lean.status, 200);
    assert.match(lean.headers.get("cache-control") || "", /no-store/);
    assert.match(lean.headers.get("server-timing") || "", /cove_lean;dur=0/);
    assert.equal(lean.headers.has("set-cookie"), false);
    const value = await lean.json();
    const canonical = await handleCoveApi(
      new Request("https://cove.test/api/fore/storefront/bootstrap", {
        headers: {
          "cf-ipcountry": country,
          "accept-language": language,
        },
      }),
      { ...env, FORE_ENVIRONMENT: "production" },
    );
    assert.equal(canonical.status, 200);
    const expected = await canonical.json();
    assert.equal(value.context.rightsCountry, country);
    assert.equal(value.context.locale, expected.context.locale);
    assert.equal(value.context.currency, expected.context.currency);
    assert.deepEqual(
      value.context,
      expected.context,
      "Guest single-batch metadata must preserve every canonical locale, translation and payment field",
    );
    assert.deepEqual(
      value.context.availableMarkets,
      expected.context.availableMarkets,
      "One combined D1 read must preserve the exact country/locale market list",
    );
    assert.deepEqual(value.page, expected.page);
    assert.deepEqual(
      value.catalog.results.map((book) => book.productId),
      expected.catalog.results.map((book) => book.productId),
      "No change to geographically authorized first paint products",
    );
    assert.equal(value.catalogQuery, expected.catalogQuery);
    assert.equal(authoritativeRights, 1, "Exactly one primary rights query");
    assert.equal(limitCalls, 1, "Exactly one enforced Cloudflare edge limit");
    assert.equal(
      anonymousPresentationBatches,
      1,
      "Guest context must use exactly one combined presentation D1 service call",
    );
    assert.deepEqual(
      sessionModes,
      ["first-unconstrained"],
      "Exactly one replica presentation session combines market, locale, messages and page",
    );
    // Keep public metadata warm while changing the real SQLite rights state.
    // Cached presentation must never cache an allow or hide a failed primary.
    const actualNow = Date.now;
    const fixedNow = actualNow();
    Date.now = () => fixedNow;
    try {
      const warm = await (await serveLeanAnonymousBootstrap(req, liveEnv)).json();
      const batchesBefore = anonymousPresentationBatches;
      const rightsBefore = authoritativeRights;
      const again = await (await serveLeanAnonymousBootstrap(req, liveEnv)).json();
      assert.equal(
        anonymousPresentationBatches,
        batchesBefore,
        "Completed public metadata is reused",
      );
      assert.equal(
        authoritativeRights,
        rightsBefore + 1,
        "Every cache hit still checks live primary rights",
      );
      assert.deepEqual(again.context, warm.context);
      if (country === "US") {
        const productId = warm.catalog.results[0]?.productId;
        assert.ok(productId, "Revocation fixture needs a displayed product");
        const grants = await env.DB.prepare(
          "SELECT id,status FROM rights_grants WHERE edition_id=(SELECT edition_id FROM products WHERE id=?)",
        )
          .bind(productId)
          .all();
        assert.ok(grants.results.length);
        await env.DB.prepare(
          "UPDATE rights_grants SET status='revoked' WHERE edition_id=(SELECT edition_id FROM products WHERE id=?)",
        )
          .bind(productId)
          .run();
        try {
          const revoked = await (await serveLeanAnonymousBootstrap(req, liveEnv)).json();
          assert.ok(
            !revoked.catalog.results.some((book) => book.productId === productId),
            "Revocation applies immediately while metadata stays warm",
          );
          assert.equal(anonymousPresentationBatches, batchesBefore);
        } finally {
          for (const grant of grants.results)
            await env.DB.prepare("UPDATE rights_grants SET status=? WHERE id=?")
              .bind(grant.status, grant.id)
              .run();
        }
      }
      failPrimary = true;
      await assert.rejects(
        serveLeanAnonymousBootstrap(req, liveEnv),
        /Primary rights authority unavailable/,
      );
      failPrimary = false;
      await assert.rejects(
        serveLeanAnonymousBootstrap(req, {
          ...liveEnv,
          COVE_STOREFRONT_READ_LIMITER: {
            async limit() {
              return { success: false };
            },
          },
        }),
      );
    } finally {
      failPrimary = false;
      Date.now = actualNow;
    }
  }
  assert.ok(joinedMarketLocaleReads >= 4, "One live joined market/locale read per bootstrap");
  assert.ok(
    localePaymentBatches >= 4,
    "Every regional canonical context must batch payment metadata and translations",
  );
  // Simulate native D1's Sessions API. Configuration may use a
  // geographically close session, but licensed eligibility MUST continue
  // through the non-session, authoritative DB binding.
  const nativeSessions = [];
  let primaryRightsSelections = 0;
  const sessionProbeDb = new Proxy(env.DB, {
    get(target, property) {
      if (property === "withSession")
        return (constraint) => {
          nativeSessions.push(constraint);
          return new Proxy(target, {
            get(sessionTarget, key) {
              if (key === "prepare")
                return (sql) => {
                  assert.doesNotMatch(
                    sql,
                    /retail_product_availability_rows/i,
                    "Never evaluate territorial retail rights through a potentially lagged read replica",
                  );
                  return sessionTarget.prepare(sql);
                };
              const value = Reflect.get(sessionTarget, key);
              return typeof value === "function" ? value.bind(sessionTarget) : value;
            },
          });
        };
      if (property === "prepare")
        return (sql) => {
          if (/WITH eligible AS MATERIALIZED/i.test(sql)) {
            assert.match(sql, /retail_product_availability_rows/i);
            primaryRightsSelections++;
          }
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const anchoredResponse = await handleCoveApi(
    new Request("https://cove.test/api/fore/storefront/bootstrap", {
      headers: { "cf-ipcountry": "US", "accept-language": "en-US" },
    }),
    { ...env, FORE_ENVIRONMENT: "production", DB: sessionProbeDb },
  );
  assert.equal(anchoredResponse.status, 200);
  const anchored = await anchoredResponse.json();
  assert.equal(anchored.context.rightsCountry, "US");
  assert.ok(anchored.catalog.results.length > 0);
  assert.deepEqual(
    nativeSessions,
    ["first-unconstrained", "first-unconstrained"],
    "Anonymous presentation-only requests may read replicas in separate sessions",
  );
  assert.equal(primaryRightsSelections, 1, "Firstpaint legal rights must query primary once");

  assert.ok(
    atomicRightsShelfQueries >= 4,
    "Every tested territory must select eligible candidates and hydrate in one D1 statement",
  );
  // Guard against accidentally using unknown channel eligibility in the
  // server-rendered BookCard. Any future visible channel badge must receive
  // a fresh authoritative answer, not a default-false preview.
  const storeSource = fs.readFileSync("src/features/fore/Store.tsx", "utf8");
  const firstCard = storeSource.slice(0, storeSource.indexOf("type FacetValue"));
  assert.doesNotMatch(firstCard, /subscriptionEligible|libraryEligible/);

  // Materializing eligible books once must preserve the former live category
  // counts across territories and content-language filters.
  const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children)]);
  for (const [country, language] of [
    ["US", ""],
    ["CA", "en"],
    ["SA", "ar"],
    ["JP", "fr"],
  ]) {
    const previous = await env.DB.prepare(
      `
      SELECT et.taxonomy_node_id node_id,COUNT(DISTINCT p.id) product_count
      FROM edition_taxonomy_nodes et JOIN products p ON p.edition_id=et.edition_id
      JOIN editions e ON e.id=p.edition_id
      WHERE p.storefront_status='active' AND p.source_name<>'upload'
        AND e.release_status IN ('available','preorder')
        AND (?='' OR EXISTS(SELECT 1 FROM edition_languages el WHERE el.edition_id=e.id AND lower(el.language_code)=lower(?)))
        AND EXISTS(SELECT 1 FROM retail_product_availability rpa WHERE rpa.product_id=p.id AND rpa.territory_code=upper(?))
      GROUP BY et.taxonomy_node_id`,
    )
      .bind(language, language, country)
      .all();
    const expected = new Map(previous.results.map((row) => [row.node_id, row.product_count]));
    const tree = await taxonomyTree(env.DB, country, language);
    for (const node of flatten(tree.nodes)) assert.equal(node.count, expected.get(node.id) || 0);
  }
  // Presentation language must be selectable independently of the legally
  // determined storefront country. A cookie does not grant Saudi-region rights.
  for (const locale of ["ar-SA", "es-ES", "fr-FR", "de-DE"]) {
    const response = await handleCoveApi(
      new Request("https://cove.test/api/fore/storefront/bootstrap", {
        headers: {
          "cf-ipcountry": "US",
          cookie: "fore-locale=" + locale + "; fore-storefront-country=SA",
        },
      }),
      fastFirstPaintEnv,
    );
    assert.equal(response.status, 200);
    const bootstrap = await response.json();
    assert.equal(bootstrap.context.locale, locale);
    assert.equal(bootstrap.context.storefrontCountry, "US");
    assert.equal(bootstrap.context.rightsCountry, "US");
    assert.equal(bootstrap.context.currency, "USD");
    assert.equal(bootstrap.context.direction, locale === "ar-SA" ? "rtl" : "ltr");
    if (locale === "de-DE") {
      assert.equal(bootstrap.context.messages["account.create"], "Konto erstellen");
      assert.equal(bootstrap.context.messages["reader.social.heading"], "Gemeinsames Lesen");
    }
    const us = bootstrap.context.availableMarkets.find((x) => x.countryCode === "US");
    assert.ok(us.locales.includes(locale), "US readers may choose " + locale);
  }
  // Retail reads must not repeat catalog seeding writes after production
  // initialization. The scheduler still exercises seedCatalog independently.
  const productionEnv = {
    ...env,
    FORE_ENVIRONMENT: "production",
    DB: new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql) => {
            assert.ok(!sql.includes("INSERT OR IGNORE INTO catalog_state"), "GET seeded catalog");
            assert.ok(
              !sql.includes("SELECT 1 present FROM gutenberg_source_cache LIMIT 1"),
              "GET repeated source seeding probe",
            );
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  const productionCatalog = await handleCoveApi(
    new Request("https://cove.test/api/fore/catalog?search=pride", {
      headers: { "cf-ipcountry": "US" },
    }),
    productionEnv,
  );
  assert.equal(productionCatalog.status, 200);
  assert.ok((await productionCatalog.json()).results.length);

  const created = await upsertTaxonomyNode(env.DB, {
    slug: "sandbox-category",
    name: "Sandbox category",
  });
  assert.equal(created.path, "sandbox-category");
  const child = await upsertTaxonomyNode(env.DB, {
    slug: "child",
    name: "Child",
    parentId: created.id,
  });
  await upsertTaxonomyNode(env.DB, {
    id: created.id,
    slug: "renamed-category",
    name: "Renamed category",
  });
  assert.equal(
    (
      await env.DB.prepare("SELECT path FROM storefront_taxonomy_nodes WHERE id=?")
        .bind(child.id)
        .first()
    ).path,
    "renamed-category/child",
  );
  console.log(
    "PASS: first-paint storefront context/catalog without blocking on taxonomy, deferred rights-scoped categories, currency and US/CA/SA/JP isolation.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
