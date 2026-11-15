import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cove-compact-authority-"));
try {
  await build({
    entryPoints: ["src/features/fore/catalog-model.server.ts"],
    outfile: path.join(dir, "authority.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    alias: { jszip: "jszip/dist/jszip.min.js" },
    logLevel: "silent",
  });
  const { canonicalBoundedPopularPageByLiveRights } = await import(
    path.join(dir, "authority.mjs")
  );
  const scope = {
    where: [
      "p.storefront_status='active'",
      "p.source_name<>'upload'",
      "d.suppressed=0",
      "e.release_status IN ('available','preorder')",
      "d.availability=?",
      "EXISTS(SELECT 1 FROM retail_product_availability_rows rpa WHERE rpa.product_id=p.id AND rpa.territory_code=upper(?))",
      "d.currency=?",
    ],
    binds: ["available", "US", "USD"],
  };
  let lastSql = "";
  let lastBinds = [];
  let rows = [];
  const db = {
    prepare(sql) {
      lastSql = sql;
      return {
        bind(...values) {
          lastBinds = values;
          return { all: async () => ({ results: rows }) };
        },
      };
    },
  };
  const row = (i) => ({
    product_id: "synthetic-product-" + i,
    edition_id: "synthetic-edition-" + i,
    work_id: "synthetic-work-" + i,
    product_public_id: "synthetic-" + i,
    title: "Synthetic book " + i,
    source_name: "gutenberg",
    source_external_id: String(i + 1),
    edition_public_id: "synthetic-edition-" + i,
    source_project: "gutenberg",
    release_status: "available",
    drm_status: "none",
    downloadable: 0,
  });
  rows = Array.from({ length: 25 }, (_, i) => row(i));
  const books = await canonicalBoundedPopularPageByLiveRights(db, scope, 24);
  assert.equal(books?.length, 24, "25th rights witness is not displayed");
  assert.deepEqual(books.map((b) => b.productId), rows.slice(0, 24).map((r) => r.product_id));
  assert.deepEqual(lastBinds, ["available", "US", "USD", 25]);
  assert.match(lastSql, /WITH ranked AS MATERIALIZED/);
  assert.match(lastSql, /LIMIT 96/);
  assert.match(lastSql, /eligible AS MATERIALIZED/);
  assert.match(lastSql, /retail_product_availability_rows/);
  assert.match(lastSql, /FROM eligible selected CROSS JOIN products p ON p.id=selected.product_id/);
  assert.match(lastSql, /FROM offers o WHERE o.product_id=p.id/);
  assert.match(lastSql, /ORDER BY selected.sort_score DESC,selected.sort_source ASC,selected.product_id ASC/);
  assert.doesNotMatch(lastSql, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO|FROM|[A-Za-z])/i);
  rows = rows.slice(0, 24);
  assert.equal(
    await canonicalBoundedPopularPageByLiveRights(db, scope, 24),
    null,
    "Sparse shortlist may not silently truncate page or grant rights",
  );
  rows = Array.from({ length: 25 }, (_, i) => row(i));
  rows[24] = row(0);
  assert.equal(
    await canonicalBoundedPopularPageByLiveRights(db, scope, 24),
    null,
    "Duplicate authorizations must not pass the witness check",
  );
  rows = Array.from({ length: 25 }, (_, i) => row(i));
  let calls = 0;
  const guarded = {
    prepare() {
      calls += 1;
      throw Error("Unsafe scope must never reach D1");
    },
  };
  for (const invalid of [
    { ...scope, where: scope.where.filter((x) => !x.includes("retail_product_availability_rows")) },
    { ...scope, where: scope.where.filter((x) => x !== "d.currency=?") },
    { ...scope, where: scope.where.filter((x) => x !== "d.suppressed=0") },
  ]) {
    assert.equal(await canonicalBoundedPopularPageByLiveRights(guarded, invalid, 24), null);
  }
  assert.equal(await canonicalBoundedPopularPageByLiveRights(guarded, scope, 25), null);
  assert.equal(calls, 0);

  const search = fs.readFileSync("src/features/fore/search.server.ts", "utf8");
  const api = fs.readFileSync("src/features/fore/api.server.ts", "utf8");
  assert.match(search, /env\.FORE_GUEST_COMPACT_STAGE === "1"/);
  assert.match(search, /FORE_GUEST_COMPACT_SYNTHETIC_D1_ID ===/);
  assert.match(search, /e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3/);
  assert.match(search, /input\.limit === 24/);
  assert.match(search, /input\.territory === "US"/);
  assert.match(search, /compactGuestBooks \|\| canonicalBooksByProductIds/);
  assert.match(search, /guestCompactLiveRights: compactGuestBooks !== null/);
  assert.match(search, /delete safe\.subscriptionEligible/);
  assert.match(search, /delete safe\.libraryEligible/);
  assert.match(search, /: await contextualizeChannelEligibility\(env.DB, pageBooks, input\.territory\)/);
  assert.match(api, /FORE_GUEST_COMPACT_STAGE\?: string;/);
  for (const file of [
    "wrangler.backend.production.toml",
    "wrangler.backend.presentation-stage.toml",
  ]) {
    const contents = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(contents, /FORE_GUEST_COMPACT_STAGE|FORE_GUEST_COMPACT_SYNTHETIC_D1_ID/);
  }
  console.log("PASS: compact single-current-D1 full-shape selection, 25th witness, denied unsafe scopes, stage-only opt-in and retail-only flags");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
