import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const compiled = await build({
  entryPoints: ["src/storefront-strangler/legal-authority.worker.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  logLevel: "silent",
  plugins: [
    {
      name: "test-host",
      setup(b) {
        b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
          path: "host",
          namespace: "test",
        }));
        b.onLoad({ filter: /.*/, namespace: "test" }, () => ({
          contents:
            "export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }",
        }));
      },
    },
  ],
});
const { default: owner } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64")
);
const route = "/__cove/sounds/publication-source",
  secret = "c".repeat(64);
const queries = [],
  env = {
    COVE_RIGHTS_OWNER_ENABLED: "0",
    COVE_RIGHTS_OWNER_PRIMARY_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989",
    COVE_SOUNDS_SOURCE_READER_SECRET: secret,
    LEGAL_AUTHORITY: {
      getByName() {
        throw Error("Advisory source reads must not reach legal commands");
      },
    },
    PRIMARY_DB: {
      prepare(sql) {
        assert.match(sql.trim(), /^SELECT\b/);
        assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE|PRAGMA|ATTACH|ALTER|DROP)\b/i);
        assert.ok(!sql.includes(";"));
        queries.push(sql);
        return {
          bind(...params) {
            if (sql.includes("FROM storefront_markets")) assert.deepEqual(params, ["US"]);
            else {
              assert.equal(params.length, 1);
              assert.ok(JSON.parse(params[0]).length > 0);
            }
            return this;
          },
          async all() {
            return {
              results: sql.includes("FROM storefront_markets") ? [{ currency: "USD" }] : [],
            };
          },
        };
      },
    },
  };
const call = (body = { territory: "US" }, options = {}, customEnv = env) =>
  owner.fetch(
    new Request("https://legal-authority.internal" + route, {
      method: "POST",
      headers: {
        authorization: "Bearer " + secret,
        "content-type": "application/json",
        ...options.headers,
      },
      body: JSON.stringify(body),
      ...options,
    }),
    customEnv,
  );
for (const custom of [
  { ...env, COVE_SOUNDS_SOURCE_READER_SECRET: undefined },
  { ...env, COVE_RIGHTS_OWNER_PRIMARY_ID: "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e" },
])
  assert.equal((await call(undefined, {}, custom)).status, 503);
assert.equal((await call(undefined, { headers: { authorization: "Bearer forged" } })).status, 401);
for (const body of [
  { territory: "us" },
  { territory: "US", sql: "DELETE FROM products" },
  { territory: "US", titles: ["private title"] },
  ["US"],
  null,
])
  assert.equal((await call(body)).status, 400);
assert.equal((await call("x".repeat(129))).status, 413);
assert.equal(
  (
    await owner.fetch(
      new Request("https://legal-authority.internal" + route, {
        method: "GET",
        headers: { authorization: "Bearer " + secret },
      }),
      env,
    )
  ).status,
  405,
);
assert.equal(queries.length, 0, "Rejected input must not touch primary D1");
const response = await call();
assert.equal(response.status, 200);
assert.equal(response.headers.get("cache-control"), "no-store");
assert.deepEqual(await response.json(), {
  schema: "cove.sounds-publication-source.v1",
  territory: "US",
  currency: "USD",
  commons: [],
  external: [],
  editions: [],
});
assert.equal(queries.length, 4, "Exactly four fixed, bounded source reads");
assert.equal(
  (
    await owner.fetch(
      new Request("https://legal-authority.internal/commercial/publish-verified", {
        method: "POST",
        headers: { authorization: "Bearer " + secret },
      }),
      env,
    )
  ).status,
  503,
  "Source reader credential cannot enable legal operations on the disabled owner",
);
assert.equal(
  (
    await call(
      undefined,
      {},
      {
        ...env,
        PRIMARY_DB: {
          prepare() {
            throw Error("outage");
          },
        },
      },
    )
  ).status,
  503,
);
for (const path of [
  "wrangler.sounds-publication.prod-isolated.jsonc",
  "wrangler.sounds-publication.prod-disabled.jsonc",
]) {
  const config = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(config.d1_databases || [], [], "Publisher must have no D1 capability");
  assert.deepEqual(config.services, [
    { binding: "SOUNDS_SOURCE_READER", service: "cove-legal-authority-production" },
  ]);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
}
const publisher = readFileSync("src/storefront-strangler/sounds-publication.worker.ts", "utf8");
assert.ok(!publisher.includes("SOURCE_DB") && !publisher.includes(".prepare("));
console.log(
  "PASS: actual disabled owner provides four authenticated fixed advisory reads; no SQL input, legal commands, QA primary, or publisher D1 capability",
);
