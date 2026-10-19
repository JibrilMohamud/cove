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
        contents: contents + "\nexport {d1Facets};",
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
  let queries = 0,
    fail = false;
  const db = {
    ...env.DB,
    prepare(sql) {
      if (/FROM candidate/.test(sql)) {
        queries++;
        if (fail) throw Error("aggregate unavailable");
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
      expectedScans,
      `Only distinct candidate populations may scan for ${query}`,
    );
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
  // All populations must immediately reflect a current legal revocation on
  // their next numeric cache miss. Result IDs/reader rights remain separate.
  await env.DB.prepare("UPDATE rights_grants SET status='revoked' WHERE status='active'").run();
  await env.DB.prepare("DELETE FROM api_cache WHERE key LIKE 'search-facets:%'").run();
  const revoked = await current.d1Facets(db, input, "");
  assert.deepEqual(revoked.categories, []);
  assert.deepEqual(revoked.formats, []);
  console.log(
    "PASS: grouped facet parity, distinct population scans, cache reuse, failure recovery and revocation",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
