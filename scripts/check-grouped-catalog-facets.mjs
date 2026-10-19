import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-facet-groups-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  const source = fs.readFileSync("src/features/fore/search.server.ts", "utf8");
  const frozen = JSON.parse(
    fs.readFileSync("scripts/fixtures/facets-before-grouping.json", "utf8"),
  );
  assert.equal(frozen.sourceSha, "69de52799859693699adda45a174197c40abd10e");
  const a = source.indexOf("async function d1Facets("),
    b = source.indexOf("\nfunction levenshtein(", a);
  const legacy = source.slice(0, a) + frozen.function + source.slice(b);
  for (const [name, contents] of [
    ["current", source],
    ["baseline", legacy],
  ]) {
    await build({
      stdin: {
        contents: contents + "\nexport {d1Facets,candidateParts,windowedCandidateCount};",
        resolveDir: path.resolve("src/features/fore"),
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: path.join(root, name + ".mjs"),
      logLevel: "silent",
    });
  }
  await build({
    entryPoints: ["src/features/fore/api.server.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: path.join(root, "api.mjs"),
    logLevel: "silent",
  });
  const current = await import(path.join(root, "current.mjs"));
  const baseline = await import(path.join(root, "baseline.mjs"));
  const { handleCoveApi } = await import(path.join(root, "api.mjs"));
  const env = localBindings(root);
  const ready = await handleCoveApi(
    new Request("https://cove.test/api/fore/storefront/bootstrap"),
    env,
  );
  assert.equal(ready.status, 200);
  // More than one primary quantum: prove no missing/double-counted products,
  // correct global bucket ordering, and parity after every complete window.
  const seed = await env.DB.prepare(
    "SELECT p.id,p.edition_id FROM products p JOIN catalog_search_documents d ON d.product_id=p.id ORDER BY p.id LIMIT 1",
  ).first();
  const copy = async (table, key, original, changes) => {
    const columns = (await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results.map(
      (row) => row.name,
    );
    await env.DB.prepare(
      `INSERT INTO ${table}(${columns.join(",")}) SELECT ${columns.map((column) => (Object.hasOwn(changes, column) ? "?" : column)).join(",")} FROM ${table} WHERE ${key}=?`,
    )
      .bind(
        ...columns
          .filter((column) => Object.hasOwn(changes, column))
          .map((column) => changes[column]),
        original,
      )
      .run();
  };
  for (let i = 0; i < 1200; i++) {
    const id = "facet-fixture-" + String(i).padStart(5, "0");
    await copy("products", "id", seed.id, { id, public_id: id, sku: id, source_external_id: id });
    await copy("catalog_search_documents", "product_id", seed.id, {
      product_id: id,
      external_book_id: id,
    });
  }
  for (const [index, name] of ["A", "Z", "\uE000", "\u{10000}"].entries()) {
    const id = "facet-unicode-" + index;
    await env.DB.prepare(
      "INSERT OR IGNORE INTO categories(id,scheme,name) VALUES(?,'facet-test',?)",
    )
      .bind(id, name)
      .run();
    const category = await env.DB.prepare(
      "SELECT id FROM categories WHERE scheme='facet-test' AND name=?",
    )
      .bind(name)
      .first();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO edition_categories(edition_id,category_id) VALUES(?,?)",
    )
      .bind(seed.edition_id, category.id)
      .run();
  }
  const catalogSize = Number(
    (await env.DB.prepare("SELECT COUNT(*) n FROM catalog_search_documents").first()).n,
  );
  const windowCount = Math.ceil(catalogSize / 1000);
  let queries = 0,
    fail = false,
    failAt = Infinity;
  const db = {
    ...env.DB,
    prepare(sql) {
      if (/scanned AS MATERIALIZED/.test(sql)) {
        assert.match(sql, /ORDER BY product_id LIMIT \?/);
        assert.doesNotMatch(
          sql,
          /LIMIT (40|30|20|10)\)/,
          "Window buckets must not truncate before global merging",
        );
      }
      if (/FROM candidate/.test(sql)) {
        queries++;
        if (fail || queries >= failAt) throw Error("aggregate unavailable");
      }
      return env.DB.prepare(sql);
    },
  };
  const trials = [
    ["", 1],
    ["minPrice=0", 2],
    ["maxPrice=0", 2],
    ["language=en", 2],
    ["format=ebook", 2],
    ["language=en&format=ebook", 3],
    ["language=en&minPrice=0", 3],
    ["category=Fiction&language=en&format=ebook&minPrice=0", 5],
    ["territory=CA&currency=CAD&language=fr", 2],
    ["q=pride&language=en&maxPrice=0", 3],
  ];
  for (const [query, expectedScans] of trials) {
    const input = current.parseSearchInput(new URL("https://cove.test/catalog?" + query));
    const expression = input.query ? '"pride"' : "";
    await env.DB.prepare("DELETE FROM api_cache WHERE key LIKE 'search-facets:%'").run();
    queries = 0;
    const expected = await baseline.d1Facets(db, input, expression);
    const oldQueries = queries;
    await env.DB.prepare("DELETE FROM api_cache WHERE key LIKE 'search-facets:%'").run();
    queries = 0;
    const result = await current.d1Facets(db, input, expression);
    assert.deepEqual(result, expected, `Disjunctive facet parity for ${query}`);
    assert.equal(
      queries,
      expression
        ? expectedScans
        : (await env.DB.prepare(
              "SELECT 1 ok FROM catalog_search_documents WHERE currency=? LIMIT 1",
            )
              .bind(input.currency)
              .first())
          ? expectedScans * windowCount
          : 0,
      `Only distinct candidate populations may scan for ${query}`,
    );
    if (!expression) {
      const part = current.candidateParts(input, expression);
      const expectedCount = await env.DB.prepare(
        `SELECT COUNT(*) n FROM ${part.from} WHERE ${part.where.join(" AND ")}`,
      )
        .bind(...part.binds)
        .first();
      assert.equal(
        await current.windowedCandidateCount(env.DB, {
          where: part.where.join(" AND "),
          binds: part.binds,
          currency: input.currency,
        }),
        Number(expectedCount.n),
      );
    }
    const before = queries;
    assert.deepEqual(await current.d1Facets(db, input, expression), result);
    assert.equal(queries, before, "A warm cache must not aggregate again");
    console.log(
      `facets ${query || "unfiltered"}: ${oldQueries} -> ${expectedScans} scans; exact parity`,
    );
  }
  await env.DB.prepare("DELETE FROM api_cache WHERE key LIKE 'search-facets:%'").run();
  const input = current.parseSearchInput(
    new URL("https://cove.test/catalog?language=en&minPrice=0"),
  );
  fail = true;
  await assert.rejects(current.d1Facets(db, input, ""), /aggregate unavailable/);
  fail = false;
  assert.deepEqual(
    await current.d1Facets(db, input, ""),
    await baseline.d1Facets(env.DB, input, ""),
  );
  // A failure after a completed window must never publish partial totals or
  // facet buckets. Cancel sibling groups before scheduling another quantum.
  await env.DB.prepare("DELETE FROM api_cache WHERE key LIKE 'search-facets:%'").run();
  queries = 0;
  failAt = 2;
  await assert.rejects(
    current.d1Facets(db, current.parseSearchInput(new URL("https://cove.test/catalog")), ""),
    /aggregate unavailable/,
  );
  assert.equal(
    Number(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) n FROM api_cache WHERE key LIKE 'search-facets:%'",
        ).first()
      ).n,
    ),
    0,
  );
  failAt = Infinity;
  queries = 0;
  let countReads = 0;
  const unavailable = {
    ...env.DB,
    prepare(sql) {
      if (/scanned AS MATERIALIZED/.test(sql) && ++countReads === 2)
        throw Error("count window unavailable");
      return env.DB.prepare(sql);
    },
  };
  const part = current.candidateParts(input, "");
  await assert.rejects(
    current.windowedCandidateCount(unavailable, {
      where: part.where.join(" AND "),
      binds: part.binds,
      currency: input.currency,
    }),
    /count window unavailable/,
  );
  // All populations must immediately reflect a current legal revocation on
  // their next numeric cache miss. Result IDs/reader rights remain separate.
  await env.DB.prepare("UPDATE rights_grants SET status='revoked' WHERE status='active'").run();
  await env.DB.prepare("DELETE FROM api_cache WHERE key LIKE 'search-facets:%'").run();
  const revoked = await current.d1Facets(db, input, "");
  assert.deepEqual(revoked.categories, []);
  assert.deepEqual(revoked.formats, []);
  console.log(
    "PASS: grouped facet parity, bounded population scans, cache reuse, failure recovery and revocation",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
