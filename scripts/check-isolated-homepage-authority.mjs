import { requireIsolatedMembershipProfile } from "./staging/isolated-membership-profile.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-isolated-authority-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: {
      authority: "src/storefront-strangler/isolated-homepage-authority.ts",
      canonical: "src/features/fore/catalog-model.server.ts",
      fast: "src/storefront-strangler/isolated-contractless-authority.ts",
      failure: "src/storefront-strangler/failure.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    logLevel: "silent",
  });
  const [
    { default: authority },
    { authorizeStorefrontPresentationIds: canonical },
    { authorizeIsolatedContractlessPrefix: fast },
    { bootstrapFailureKind },
  ] = await Promise.all(
    ["authority", "canonical", "fast", "failure"].map(
      (name) => import(path.join(root, name + ".js")),
    ),
  );
  const local = localBindings(root);
  assert.match((await requireIsolatedMembershipProfile(local.DB)).viewSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(() =>
    requireIsolatedMembershipProfile({
      prepare() {
        return {
          async first() {
            return { sql: "CREATE VIEW retail_product_availability_rows AS SELECT 1" };
          },
        };
      },
    }),
  );
  const seed = JSON.parse(fs.readFileSync("src/features/fore/catalog-seed.json", "utf8"))
    .results[0];
  local.seedAdditionalLocalCatalogBooks(
    Array.from({ length: 30 }, (_, i) => ({
      ...seed,
      id: 99999000 + i,
      title: "Isolated authorization fixture " + i,
    })),
  );
  const ids = Array.from({ length: 30 }, (_, i) => "prd_gutenberg_" + (99999000 + i));
  const product = ids[0],
    edition = "ed_gutenberg_99999000";
  const run = (sql, ...args) =>
    local.DB.prepare(sql)
      .bind(...args)
      .run();
  const grant = (
    await local.DB.prepare(
      "SELECT id FROM rights_grants WHERE edition_id=? AND sales_channel='retail' AND decision='allow' LIMIT 1",
    )
      .bind(edition)
      .first()
  ).id;
  const env = {
    COVE_SSR_STAGING: "1",
    COVE_STRANGLER_MODE: "isolated-real-catalog",
    COVE_STRANGLER_DATABASE_ID: "15ce2ea3-17f8-4d99-9015-a78a6a3af05d",
    COVE_HOMEPAGE_AUTHORITY_KEY: "b".repeat(64),
  };
  let reads = 0,
    sessions = 0;
  const primary = {
    prepare(sql) {
      reads++;
      return local.DB.prepare(sql);
    },
    withSession(mode) {
      assert.equal(mode, "first-primary");
      sessions++;
      return primary;
    },
  };
  async function compare(label, territory = "US", currency = "USD", expectedReads = 2) {
    const expected = await canonical(local.DB, ids, territory, currency);
    reads = 0;
    const response = await authority.fetch(
      new Request("https://legal-authority.internal/storefront/authorize-batch", {
        method: "POST",
        headers: { authorization: "Bearer " + env.COVE_HOMEPAGE_AUTHORITY_KEY },
        body: JSON.stringify({ ids, territory, currency }),
      }),
      { ...env, DB: primary },
    );
    assert.equal(response.status, 200, label);
    assert.deepEqual((await response.json()).rows, JSON.parse(JSON.stringify(expected)), label);
    assert.equal(reads, expectedReads, label + " query count");
    return expected;
  }
  const baseline = await compare("contractless prefix", "US", "USD", 1);
  assert.equal(baseline.length, 25);
  const cases = [
    ["withdrawal", "UPDATE products SET storefront_status='withdrawn' WHERE id=?", product],
    ["suppression", "UPDATE catalog_search_documents SET suppressed=1 WHERE product_id=?", product],
    [
      "unavailable document",
      "UPDATE catalog_search_documents SET availability='unavailable' WHERE product_id=?",
      product,
    ],
    [
      "currency mismatch",
      "UPDATE catalog_search_documents SET currency='EUR' WHERE product_id=?",
      product,
    ],
    ["unreleased edition", "UPDATE editions SET release_status='draft' WHERE id=?", edition],
    ["revoked grant", "UPDATE rights_grants SET status='revoked' WHERE edition_id=?", edition],
    ["expired grant", "UPDATE rights_grants SET ends_at='2000-01-01' WHERE edition_id=?", edition],
    ["future grant", "UPDATE rights_grants SET starts_at='2999-01-01' WHERE edition_id=?", edition],
    ["explicit deny", "UPDATE rights_grants SET decision='deny' WHERE id=?", grant],
    ["upload excluded", "UPDATE products SET source_name='upload' WHERE id=?", product],
    [
      "other source canonical fallback",
      "UPDATE products SET source_name='commons' WHERE id=?",
      product,
    ],
    ...["required", "drm-free", "watermark", "lcp", "adobe", "unknown"].map((drm) => [
      "DRM " + drm,
      "UPDATE rights_grants SET drm_requirement=? WHERE id=?",
      drm,
      grant,
    ]),
  ];
  for (const [label, sql, ...args] of cases) {
    await run("SAVEPOINT test_case");
    try {
      await run(sql, ...args);
      await compare(label);
    } finally {
      await run("ROLLBACK TO test_case");
      await run("RELEASE test_case");
    }
  }
  // Case folding, trivial DRM and ignored non-retail/other-format grants must
  // remain identical to the canonical live view, without acquiring a grant cache.
  for (const drm of ["none", "optional", "any", ""]) {
    await run("SAVEPOINT test_case");
    try {
      await run(
        "UPDATE rights_grants SET drm_requirement=?,format='EBOOK' WHERE edition_id=?",
        drm,
        edition,
      );
      await compare("trivial DRM " + drm, "US", "USD", 1);
    } finally {
      await run("ROLLBACK TO test_case");
      await run("RELEASE test_case");
    }
  }
  for (const status of ["active", "suspended", "expired", "terminated"]) {
    await run("SAVEPOINT test_case");
    try {
      await run(
        "INSERT INTO rights_contracts(id,reference_code,name,status,created_at,updated_at) VALUES('test-contract','test-contract','Local fixture',?,datetime('now'),datetime('now'))",
        status,
      );
      await run("UPDATE rights_grants SET contract_id='test-contract' WHERE id=?", grant);
      await compare("contract " + status);
      await run(
        "INSERT INTO rights_contract_languages(id,contract_id,language_code,decision,created_at) VALUES('test-language','test-contract','en','deny',datetime('now'))",
      );
      await compare("contract language deny " + status);
      await run(
        "UPDATE rights_contract_languages SET decision='allow',language_code='zz' WHERE id='test-language'",
      );
      await compare("contract language mismatch " + status);
    } finally {
      await run("ROLLBACK TO test_case");
      await run("RELEASE test_case");
    }
  }
  await compare("other territory", "GB", "GBP");
  await compare("market currency rejects wrong projection", "US", "EUR");
  // Any subset the fast statement does return must match the canonical row,
  // including the exact live offer proof. A deny cannot silently disappear.
  await run("UPDATE offers SET amount_minor=321 WHERE product_id=?", product);
  assert.deepEqual(
    JSON.parse(JSON.stringify(await fast(local.DB, ids.slice(0, 25), "US", "USD"))),
    JSON.parse(JSON.stringify(await canonical(local.DB, ids.slice(0, 25), "US", "USD"))),
  );
  await compare("fresh price proof", "US", "USD", 1);
  assert.ok(sessions > 30);
  const failed = await authority.fetch(
    new Request("https://legal-authority.internal/storefront/authorize-batch", {
      method: "POST",
      headers: { authorization: "Bearer " + env.COVE_HOMEPAGE_AUTHORITY_KEY },
      body: JSON.stringify({ ids, territory: "US", currency: "USD" }),
    }),
    {
      ...env,
      DB: {
        prepare() {
          throw Error(
            "D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.",
          );
        },
      },
    },
  );
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("x-cove-isolated-authority-failure"), "d1-resource-window");
  assert.equal(await failed.text(), "");
  assert.equal(
    bootstrapFailureKind(Error("isolated_authority:d1-resource-window")),
    "d1-resource-window",
  );
  assert.equal(bootstrapFailureKind(Error("isolated_authority:private-data")), "unclassified");
  console.log(
    "PASS: full-schema fresh-primary prefix differential across denial, terms, contracts/languages, DRM, withdrawal, markets, offers and fail-closed diagnostics",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
