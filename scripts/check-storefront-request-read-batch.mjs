import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cove-first-paint-batch-"));
try {
  const helperFile = path.join(directory, "helper.mjs");
  await build({
    entryPoints: ["src/features/fore/storefront-request-read-batch.ts"],
    outfile: helperFile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { withRequestFirstPaintReadBatch: batchReads } = await import(helperFile);
  const metaSql =
    "WITH RECURSIVE active_market AS MATERIALIZED (), chosen_locale AS MATERIALIZED () SELECT * FROM active_market m LEFT JOIN chosen_locale l";
  const rightsSql =
    "WITH first_paint_currency(currency) AS MATERIALIZED (), eligible AS MATERIALIZED () SELECT * FROM retail_product_availability_rows";
  let calls = 0;
  const native = {
    prepare: (sql) => ({
      bind() {
        return this;
      },
      all: async () => ({ results: [sql] }),
    }),
    batch: async (statements) => {
      calls++;
      return Promise.all(statements.map((statement) => statement.all()));
    },
  };
  const single = batchReads(native);
  assert.deepEqual(
    await single.prepare(metaSql).all(),
    { results: [metaSql] },
    "A missing peer must flush without hanging",
  );
  assert.equal(calls, 1);
  const a = batchReads(native),
    b = batchReads(native);
  const values = await Promise.all([
    a.prepare(metaSql).all(),
    a.prepare(rightsSql).all(),
    b.prepare(metaSql).all(),
    b.prepare(rightsSql).all(),
  ]);
  assert.equal(calls, 3, "Two visitors must execute TWO independent batches");
  assert.deepEqual(
    values.map((value) => value.results[0]),
    [metaSql, rightsSql, metaSql, rightsSql],
  );
  const ordinary = batchReads(native);
  assert.deepEqual(await ordinary.prepare("SELECT 1").all(), { results: ["SELECT 1"] });
  assert.equal(calls, 3, "Unrelated SQL passes through unchanged");
  for (const result of [
    null,
    [{ results: [] }],
    [{ success: false, results: [] }, { results: [] }],
  ]) {
    const fail = batchReads({ ...native, batch: async () => result });
    const outcomes = await Promise.allSettled([
      fail.prepare(metaSql).all(),
      fail.prepare(rightsSql).all(),
    ]);
    assert.ok(
      outcomes.every((outcome) => outcome.status === "rejected"),
      "Incomplete/error batches must fail both reads closed",
    );
  }
  const error = new Error("Synthetic database failure");
  const failed = batchReads({
    ...native,
    batch: async () => {
      throw error;
    },
  });
  const outcomes = await Promise.allSettled([
    failed.prepare(metaSql).all(),
    failed.prepare(rightsSql).all(),
  ]);
  assert.ok(outcomes.every((outcome) => outcome.status === "rejected" && outcome.reason === error));

  fs.cpSync("drizzle", path.join(directory, "drizzle"), { recursive: true });
  const output = path.join(directory, "bootstrap.mjs");
  await build({
    entryPoints: ["src/features/fore/storefront-anonymous-bootstrap.server.ts"],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { serveLeanAnonymousBootstrap: bootstrap } = await import(output);
  const env = localBindings(directory, { seedCatalogFixture: true });
  const counts = { batches: 0, standalone: 0, statements: [] };
  const wrap = (statement) =>
    new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values) => wrap(target.bind(...values));
        if (key === "all")
          return () => {
            counts.standalone++;
            return target.all();
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql) => {
          counts.statements.push(sql);
          return wrap(target.prepare(sql));
        };
      if (key === "batch")
        return (statements) => {
          counts.batches++;
          assert.equal(statements.length, 2, "Exactly the two original independent reads");
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const request = (country, language) =>
    new Request("https://cove.test/api/fore/storefront/bootstrap", {
      headers: {
        "x-cove-client-country": country,
        "cf-connecting-ip": "192.0.2.1",
        "accept-language": language,
      },
    });
  const limiter = { limit: async () => ({ success: true }) };
  const normalize = (value) => {
    delete value.at;
    delete value.catalog.search.processingTimeMs;
    return value;
  };
  for (const [country, language] of [
    ["US", "en-US"],
    ["CA", "fr-CA"],
    ["GB", "en-GB"],
    ["SA", "ar-SA"],
    ["JP", "ja-JP"],
  ]) {
    const base = { ...env, COVE_STOREFRONT_READ_LIMITER: limiter };
    const expected = await (await bootstrap(request(country, language), base)).json();
    const batches = counts.batches;
    const standalone = counts.standalone;
    const actual = await (
      await bootstrap(request(country, language), { ...base, DB: db, COVE_SSR_STAGING: "1" })
    ).json();
    assert.deepEqual(
      normalize(actual),
      normalize(expected),
      `${country}: unchanged live context/catalog`,
    );
    assert.equal(counts.batches - batches, 1);
    assert.equal(counts.standalone - standalone, 0, "No second D1 service request");
  }
  const failedEnv = {
    ...env,
    COVE_SSR_STAGING: "1",
    COVE_STOREFRONT_READ_LIMITER: limiter,
    DB: new Proxy(env.DB, {
      get(target, key) {
        return key === "batch"
          ? async () => {
              throw error;
            }
          : Reflect.get(target, key);
      },
    }),
  };
  const failures = [];
  await assert.rejects(
    bootstrap(request("US", "en-US"), failedEnv, undefined, (phase, cause) =>
      failures.push({ phase, cause }),
    ),
    /Synthetic database failure/,
  );
  assert.ok(
    failures.length > 0 &&
      failures.every(
        (failure) => ["context", "catalog"].includes(failure.phase) && failure.cause === error,
      ),
  );

  // An empty current-rights view must still remove books in the next batch.
  const staged = { ...env, DB: db, COVE_SSR_STAGING: "1", COVE_STOREFRONT_READ_LIMITER: limiter };
  const before = await (await bootstrap(request("US", "en-US"), staged)).json();
  assert.ok(before.catalog.results.length > 0);
  await env.DB.prepare("UPDATE products SET storefront_status='withdrawn'").run();
  const after = await (await bootstrap(request("US", "en-US"), staged)).json();
  assert.equal(
    after.catalog.results.length,
    0,
    "A new request must observe withdrawal immediately",
  );
  assert.ok(counts.statements.some((sql) => sql.includes("retail_product_availability_rows")));
  assert.ok(counts.statements.some((sql) => sql.includes("active_market AS MATERIALIZED")));
  console.log(
    "Request-local primary D1 batching: exact projection, one service call, country isolation and immediate withdrawal PASS",
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
