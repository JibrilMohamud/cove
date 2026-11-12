import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cove-stage-public-market-"));
try {
  const outfile = path.join(tmp, "market.mjs");
  await build({
    entryPoints: ["src/features/fore/storefront-inflight-public-metadata.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  const { withInFlightAnonymousMarketReads: join } = await import(pathToFileURL(outfile).href);
  const marketSql =
    "WITH RECURSIVE active_market AS MATERIALIZED (SELECT 1), " +
    "chosen_locale AS MATERIALIZED (SELECT 1) " +
    "SELECT * FROM active_market m LEFT JOIN chosen_locale l ON 1=1";
  const locales = JSON.stringify(["en-US", "en"]);
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    return { promise, resolve, reject };
  };
  function fakeDb() {
    const invocations = [];
    const outstanding = [];
    const db = {
      prepare: (sql) => ({
        bind: (...args) => ({
          all: () => {
            invocations.push({ sql, args });
            const task = deferred();
            outstanding.push(task);
            return task.promise;
          },
        }),
      }),
      batch: () => "original-batch",
    };
    return { db, invocations, outstanding };
  }

  // The same live SELECT, DB binding, country and language negotiation may
  // share a single unresolved promise. Every caller independently receives it.
  const a = fakeDb();
  let joined = 0;
  const db1 = join(a.db, () => joined++);
  const db2 = join(a.db, () => joined++);
  assert.equal(db1.batch(), "original-batch");
  const p1 = db1.prepare(marketSql).bind("US", locales).all();
  const p2 = db2.prepare(marketSql).bind("US", locales).all();
  await Promise.resolve();
  assert.equal(a.invocations.length, 1);
  assert.equal(joined, 1);
  const rows = { results: [{ active_locale: "en-US" }] };
  a.outstanding[0].resolve(rows);
  assert.strictEqual(await p1, rows);
  assert.strictEqual(await p2, rows);
  await Promise.resolve();
  const fresh = db1.prepare(marketSql).bind("US", locales).all();
  await Promise.resolve();
  assert.equal(a.invocations.length, 2, "Completed metadata is never cached");
  a.outstanding[1].resolve({ results: [] });
  await fresh;

  // Country, language and binding are isolation boundaries; never merge
  // different market data or signals between independent database targets.
  const b = fakeDb();
  const dbB = join(b.db);
  const countries = [
    db1.prepare(marketSql).bind("US", locales).all(),
    db1.prepare(marketSql).bind("CA", locales).all(),
    db1.prepare(marketSql).bind("US", JSON.stringify(["fr-CA", "fr"])).all(),
    dbB.prepare(marketSql).bind("US", locales).all(),
  ];
  await Promise.resolve();
  assert.equal(a.invocations.length, 5);
  assert.equal(b.invocations.length, 1);
  a.outstanding.slice(2).forEach((x) => x.resolve({ results: [] }));
  b.outstanding[0].resolve({ results: [] });
  await Promise.all(countries);

  // No share for arbitrary SQL, invalid/unbounded Accept-Language, or
  // malformed locale parameters—even when the attacker repeats a key.
  const other = [
    db1.prepare("SELECT * FROM rights_grants").bind("US", locales).all(),
    db1.prepare(marketSql).bind("US", JSON.stringify(["invalid_locale"])).all(),
    db1.prepare(marketSql).bind("US", JSON.stringify(Array(11).fill("en-US"))).all(),
    db1.prepare(marketSql).bind("US", "{invalid-json").all(),
  ];
  await Promise.resolve();
  assert.equal(a.invocations.length, 9);
  a.outstanding.slice(5).forEach((x) => x.resolve({ results: [] }));
  await Promise.all(other);

  // A rejected in-flight read must be evicted; no stale fallback is invented.
  const failure = db1.prepare(marketSql).bind("GB", locales).all();
  await Promise.resolve();
  a.outstanding[9].reject(new Error("D1 unavailable"));
  await assert.rejects(failure, /D1 unavailable/);
  const retry = db1.prepare(marketSql).bind("GB", locales).all();
  await Promise.resolve();
  assert.equal(a.invocations.length, 11, "Failure must never be replayed");
  a.outstanding[10].resolve({ results: [{ active_locale: "en-GB" }] });
  await retry;

  // Safe staging-only wiring, and a separate live D1 legal-rights path.
  const bootstrap = fs.readFileSync(
    "src/features/fore/storefront-anonymous-bootstrap.server.ts",
    "utf8",
  );
  assert.match(bootstrap, /env\.COVE_SSR_STAGING === "1"/);
  assert.match(bootstrap, /withInFlightAnonymousMarketReads\(rawDb/);
  assert.match(bootstrap, /firstPaintStorefrontShelf\(env, null, trustedCountry, d1Metrics\)/);
  assert.match(bootstrap, /context\.rightsCountry !== trustedCountry/);
  assert.match(bootstrap, /await timed\("limit", enforceFirstPaintRateLimit/);
  const timing = fs.readFileSync("src/features/fore/storefront-hedged-fetch.ts", "utf8");
  assert.match(timing, /"context_joined"/);
  console.log(
    "Bounded in-flight anonymous presentation joins: PASS; rights remain separately authoritative.",
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
