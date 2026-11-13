import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cove-v2-primary-prefix-"));
try {
  const moduleFile = path.join(temporary, "homepage.mjs");
  await build({
    entryPoints: ["src/storefront-strangler/homepage-presentation.server.ts"],
    outfile: moduleFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
    logLevel: "silent",
  });
  const { authorizeHomepagePresentation, assembleAuthorizedHomepagePresentation } =
    await import(pathToFileURL(moduleFile).href);
  const ids = Array.from({ length: 128 }, (_, i) => "prod_" + String(i).padStart(3, "0"));
  const snapshot = () => ({
    candidates: { productIds: [...ids], country: "US", currency: "USD" },
    displayBooks: ids.map((id, i) => ({
      productId: id,
      editionId: "edition_" + i,
      title: "Book " + i,
      authors: [],
      subjects: [],
      bookshelves: [],
      languages: ["en"],
      formats: {},
      download_count: 0,
      // Forged public data must never win over an actual primary offer.
      offer: { type: "retail", currency: "USD", amountMinor: 999999 },
    })),
  });
  const revoked = new Set();
  let throwPrimary = false;
  const calls = [];
  function db() {
    return {
      prepare(sql) {
        assert.match(sql, /retail_product_availability_rows/);
        assert.match(sql, /offers o/);
        return {
          bind(country, jsonIds, currency, expected, territory) {
            assert.equal(country, "US");
            assert.equal(currency, "USD");
            assert.equal(expected, "USD");
            assert.equal(territory, "US");
            const selection = JSON.parse(jsonIds);
            return {
              async all() {
                if (throwPrimary) throw Error("authoritative primary failure");
                calls.push(selection.length);
                return {
                  results: selection
                    .filter((id) => !revoked.has(id))
                    .slice(0, 25)
                    .map((id) => ({
                      product_id: id,
                      product_public_id: "public_" + id,
                      edition_id: "edition_" + Number(id.slice(5)),
                      edition_public_id: "public_edition_" + id,
                      offer_json: JSON.stringify({
                        type: "retail",
                        currency: "USD",
                        amountMinor: 0,
                      }),
                    })),
                  meta: { rows_read: 12 * selection.length, timings: { sql_duration_ms: 2 } },
                };
              },
            };
          },
        };
      },
    };
  }
  const primary = db();
  const p = snapshot();
  const diagnostics = {};
  const fast = await authorizeHomepagePresentation(primary, p, diagnostics);
  assert.deepEqual(calls, [25], "A full authorized prefix must need only 25 checks");
  assert.equal(fast.count, 24);
  assert.equal(fast.results.length, 24);
  assert.ok(fast.next, "25th authorized row proves the next page");
  assert.equal(fast.results[0].offer.amountMinor, 0, "Live offer overrides forged display");
  assert.equal(diagnostics.rowsRead, 300);
  calls.length = 0;

  // Immediate withdrawn first candidate: refuse cached grant, then recheck
  // the original full list so the 25th book can replace the missing first.
  revoked.add(ids[0]);
  const withdrawn = await authorizeHomepagePresentation(primary, p);
  assert.deepEqual(calls, [25, 128]);
  assert.equal(withdrawn.results.length, 24);
  assert.equal(withdrawn.results[0].productId, ids[1]);
  assert.ok(!withdrawn.results.some((book) => book.productId === ids[0]));
  assert.ok(withdrawn.next);
  const oldFullAuthorized = ids
    .filter((id) => !revoked.has(id))
    .slice(0, 25)
    .map((id) => ({
      product_id: id,
      product_public_id: "public_" + id,
      edition_id: "edition_" + Number(id.slice(5)),
      edition_public_id: "public_edition_" + id,
      offer_json: JSON.stringify({ type: "retail", currency: "USD", amountMinor: 0 }),
    }));
  assert.deepEqual(
    withdrawn,
    assembleAuthorizedHomepagePresentation(p, oldFullAuthorized),
    "Withdrawal fallback must be identical to the old 128-ID authority",
  );
  calls.length = 0;
  revoked.clear();

  // A stale presentation edition is not a legal match even when primary
  // authorized the product ID. Full candidates must supply replacements.
  const stale = snapshot();
  stale.displayBooks[0].editionId = "stale-edition";
  const replaced = await authorizeHomepagePresentation(primary, stale);
  assert.deepEqual(calls, [25, 128]);
  assert.equal(replaced.results[0].productId, ids[1]);
  assert.equal(
    replaced.next,
    null,
    "A stale edition cannot count as the 25th authorized display book",
  );
  calls.length = 0;

  // Sparse markets and mass withdrawals remain empty/short, with no
  // unauthorized fallback, fabricated grant, or positive rights caching.
  for (const id of ids.slice(5)) revoked.add(id);
  const sparse = await authorizeHomepagePresentation(primary, p);
  assert.deepEqual(calls, [25, 128]);
  assert.equal(sparse.count, 5);
  assert.equal(sparse.next, null);
  calls.length = 0;
  throwPrimary = true;
  await assert.rejects(authorizeHomepagePresentation(primary, p), /authoritative primary failure/);
  assert.deepEqual(calls, [], "A primary failure must not reuse a previous rights result");
  console.log(
    "PASS: live 25-ID prefix, 128-ID fallback, immediate withdrawal, stale display, sparse market, live offers, no grant cache",
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
