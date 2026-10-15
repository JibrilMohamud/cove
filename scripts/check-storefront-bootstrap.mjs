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
    entryPoints: ["src/features/fore/taxonomy.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "taxonomy.mjs"),
    logLevel: "silent",
  });
  const { upsertTaxonomyNode } = await import(path.join(root, "taxonomy.mjs"));
  const env = localBindings(root);
  for (const [country, locale] of [
    ["US", "en-US"],
    ["CA", "fr-FR"],
    ["SA", "ar-SA"],
    ["JP", "en-US"],
  ]) {
    const headers = { "cf-ipcountry": country, "accept-language": locale };
    const response = await handleCoveApi(
      new Request("https://cove.test/api/fore/storefront/bootstrap", { headers }),
      env,
    );
    assert.equal(response.status, 200);
    const bootstrap = await response.json();
    assert.equal(bootstrap.context.rightsCountry, country);
    assert.ok(bootstrap.context.availableMarkets.length);
    assert.ok(Array.isArray(bootstrap.taxonomy.nodes));
    const catalog = await handleCoveApi(
      new Request("https://cove.test/api/fore/catalog?" + bootstrap.catalogQuery, { headers }),
      env,
    );
    const expected = await catalog.json();
    assert.deepEqual(
      bootstrap.catalog.results.map((b) => b.id),
      expected.results.map((b) => b.id),
      country + ": SSR uses the ordinary rights-filtered catalog",
    );
    assert.equal(
      new URLSearchParams(bootstrap.catalogQuery).get("currency"),
      bootstrap.context.currency,
    );
    assert.ok(
      !("user" in bootstrap) && !("library" in bootstrap),
      "bootstrap includes no private reading records",
    );
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
      env,
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
    "PASS: combined storefront context/catalog/taxonomy bootstrap, matching first-page projections, currency and US/CA/SA/JP rights isolation.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
