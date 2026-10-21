import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-prepared-m2-"));
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: {
      api: "src/features/fore/api.server.ts",
      prepared: "src/storefront-strangler/prepared-catalog.server.ts",
      canonical: "src/features/fore/search.server.ts",
      worker: "src/storefront-strangler/worker.ts",
      producer: "src/storefront-strangler/producer.worker.ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    logLevel: "silent",
  });
  const { handleCoveApi } = await import(path.join(root, "api.js"));
  const {
    produceCandidateSnapshot,
    servePreparedCatalog,
    privateCandidateKey,
    validateCandidateSnapshot,
  } = await import(path.join(root, "prepared.js"));
  const { firstPaintStorefrontShelf } = await import(path.join(root, "canonical.js"));
  const worker = (await import(path.join(root, "worker.js"))).default;
  const objects = new Map();
  const store = {
    async put(key, value) {
      objects.set(key, value);
    },
    async get(key) {
      const value = objects.get(key);
      return value === undefined
        ? null
        : {
            size: Buffer.byteLength(value),
            async text() {
              return value;
            },
          };
    },
  };
  const db = localBindings(root).DB;
  const env = {
    ...localBindings(root),
    DB: db,
    FORE_ENVIRONMENT: "production",
    COVE_SSR_STAGING: "1",
    COVE_STRANGLER_MODE: "isolated-evaluation",
    COVE_STRANGLER_DATABASE_ID: "e4cbb0ef-6288-4fa1-9dbb-fb42fe01d4f3",
    COVE_STRANGLER_READ_MODEL: "1",
    COVE_SSR_STAGING_GATE_KEY: "a".repeat(64),
    PRESENTATION: store,
    COVE_STOREFRONT_READ_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
    CORE: {
      async fetch() {
        return new Response("delegated");
      },
    },
  };
  const seed = await handleCoveApi(
    new Request("https://cove.test/api/fore/storefront/bootstrap", {
      headers: { "cf-ipcountry": "US" },
    }),
    { ...env, COVE_SSR_STAGING: "0", FORE_ENVIRONMENT: "development" },
  );
  assert.equal(seed.status, 200, await seed.text());
  function request(country = "US") {
    const req = new Request("https://cove.test/", {
      headers: {
        authorization: "Bearer " + env.COVE_SSR_STAGING_GATE_KEY,
        "cf-connecting-ip": "203.0.113.12",
        "cf-ipcountry": "JP",
        "x-cove-client-country": "CA",
      },
    });
    Object.defineProperty(req, "cf", { value: { country } });
    return req;
  }
  assert.equal((await worker.fetch(request(), env)).status, 503, "no fallback on missing model");

  // No Worker route can invoke the out-of-band candidate publisher.
  const producer = (await import(path.join(root, "producer.js"))).default;
  const config = JSON.parse(
    fs.readFileSync("wrangler.storefront-candidate-producer.stage.jsonc", "utf8"),
  );
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.ok(!config.routes && !config.route && !config.triggers);
  assert.equal(config.d1_databases.length, 1);
  assert.equal(config.d1_databases[0].database_id, env.COVE_STRANGLER_DATABASE_ID);
  assert.equal(config.r2_buckets.length, 1);
  assert.equal(config.r2_buckets[0].binding, "PRESENTATION");
  assert.equal((await producer.fetch()).status, 404);
  const pending = [];
  const ctx = {
    waitUntil(promise) {
      pending.push(promise);
    },
  };
  assert.throws(() => producer.scheduled({ cron: "* * * * *" }, env, ctx));
  assert.throws(() =>
    producer.scheduled(
      { cron: "*/5 * * * *" },
      {
        ...env,
        COVE_STRANGLER_DATABASE_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989",
      },
      ctx,
    ),
  );
  producer.scheduled({ cron: "*/5 * * * *" }, env, ctx);
  await Promise.all(pending);
  assert.ok(objects.has(privateCandidateKey("US")));

  for (const country of ["US", "CA", "SA", "JP"]) {
    const result = await produceCandidateSnapshot(db, country, store);
    const projected = await servePreparedCatalog(db, store, country);
    const expected = await firstPaintStorefrontShelf(env, null, country);
    assert.deepEqual(
      projected.results.map((book) => book.productId),
      expected.results.map((book) => book.productId),
      country + ": non-authoritative prepared ranking must match canonical fixture",
    );
    assert.equal(projected.count, projected.results.length);
    assert.ok(result.candidates <= 128);
    const htmlResponse = await worker.fetch(request(country), env);
    assert.equal(htmlResponse.status, 200, country);
    const html = await htmlResponse.text();
    assert.match(html, new RegExp('data-rights-country="' + country + '"'));
    assert.deepEqual(
      [...html.matchAll(/data-product="([^"]*)"/g)].map((row) => row[1]),
      projected.results.map((book) => book.productId),
    );
  }
  const usKey = privateCandidateKey("US");
  const valid = JSON.parse(objects.get(usKey));
  const original = objects.get(usKey);
  assert.ok(valid.productIds.length > 1);
  assert.equal(validateCandidateSnapshot(valid, "US").schema, "cove.home.candidates.v1");
  for (const bad of [
    { ...valid, country: "JP" },
    { ...valid, expiresAt: Date.now() - 1 },
    { ...valid, productIds: [...valid.productIds, valid.productIds[0]] },
    { ...valid, productIds: Array(129).fill("product-id") },
    { ...valid, productIds: [valid.productIds[0], "'); DROP TABLE products; --"] },
    { ...valid, currency: "CAD" },
  ]) {
    objects.set(usKey, JSON.stringify(bad));
    const response = await worker.fetch(request(), env);
    if (bad.currency === "CAD") {
      assert.equal(response.status, 200, "currency mismatch must filter, never authorize");
      assert.doesNotMatch(await response.text(), /data-product="/);
    } else {
      assert.equal(response.status, 503, "malformed model must fail closed");
    }
  }
  objects.set(usKey, original);
  const first = valid.productIds[0];
  await db
    .prepare(
      "UPDATE rights_grants SET status='revoked' WHERE edition_id=(SELECT edition_id FROM products WHERE id=?) AND decision='allow'",
    )
    .bind(first)
    .run();
  const revoked = await servePreparedCatalog(db, store, "US");
  assert.ok(
    !revoked.results.some((book) => book.productId === first),
    "revocation must be immediately effective",
  );
  assert.ok(
    !(await (await worker.fetch(request(), env)).text()).includes('data-product="' + first + '"'),
  );
  await produceCandidateSnapshot(db, "US", store);
  assert.ok(
    !JSON.parse(objects.get(usKey)).productIds.includes(first),
    "Regenerated candidate set must exclude revoked products",
  );
  await db
    .prepare("UPDATE products SET storefront_status='inactive' WHERE id=?")
    .bind(valid.productIds[1])
    .run();
  const disabled = await servePreparedCatalog(db, store, "US");
  assert.ok(!disabled.results.some((book) => book.productId === valid.productIds[1]));
  const brokenDb = {
    prepare() {
      throw Error("primary DB failed");
    },
    batch() {
      throw Error("primary DB failed");
    },
  };
  assert.equal((await worker.fetch(request(), { ...env, DB: brokenDb })).status, 503);
  assert.equal(
    (
      await worker.fetch(request(), {
        ...env,
        PRESENTATION: {
          async get() {
            throw Error("R2 down");
          },
        },
      })
    ).status,
    503,
  );
  assert.equal((await worker.fetch(request(), { ...env, PRESENTATION: undefined })).status, 503);
  assert.equal(
    (await worker.fetch(request(), { ...env, COVE_STRANGLER_READ_MODEL: "0" })).status,
    200,
    "disabled model keeps canonical rights path",
  );
  console.log(
    "PASS: independently prepared candidates, primary rights SQL parity, revocation, country/currency guards, expired/bad store rejection, no fallback, and disabled-model compatibility.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
