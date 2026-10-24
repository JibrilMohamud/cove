import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import ts from "typescript";
function config(file) {
  const parsed = ts.parseConfigFileTextToJson(file, fs.readFileSync(file, "utf8"));
  assert.ok(!parsed.error);
  return parsed.config;
}
import { localBindings } from "./local-api.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-data-plane-"));
try {
  await build({
    entryPoints: {
      api: "src/features/fore/api.server.ts",
      presentation: "src/storefront-strangler/homepage-presentation.server.ts",
      prepared: "src/storefront-strangler/prepared-catalog.server.ts",
      bootstrap: "src/storefront-strangler/bootstrap-optimized.server.ts",
      queue: "src/lib/literary-preparation-queue.server.ts",
    },
    outdir: root,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { handleCoveApi } = await import(path.join(root, "api.js"));
  const {
    produceHomepagePresentation: produce,
    homepagePresentationKey: key,
    readHomepagePresentation: read,
  } = await import(path.join(root, "presentation.js"));
  const { namespacedPresentationStore: scoped } = await import(path.join(root, "prepared.js"));
  const { serveLeanAnonymousBootstrap: serve } = await import(path.join(root, "bootstrap.js"));
  const { consumePreparationQueue: consume } = await import(path.join(root, "queue.js"));
  const domains = [];
  for (const name of ["primary", "discovery"]) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.cpSync("drizzle", path.join(dir, "drizzle"), { recursive: true });
    const env = { ...localBindings(dir), FORE_ENVIRONMENT: "development" };
    const res = await handleCoveApi(new Request("https://test/api/fore/storefront/bootstrap"), env);
    assert.equal(res.status, 200, await res.text());
    domains.push(env);
  }
  const [primary, discovery] = domains;
  const objects = new Map();
  const store = {
    async put(k, v) {
      objects.set(k, v);
    },
    async get(k) {
      const v = objects.get(k);
      return v === undefined ? null : { size: Buffer.byteLength(v), text: async () => v };
    },
  };
  const reads = [];
  const observedPrimary = {
    prepare(sql) {
      const statement = primary.DB.prepare(sql);
      return {
        ...statement,
        bind(...args) {
          reads.push({ sql, args });
          return statement.bind(...args);
        },
      };
    },
    async batch() {
      throw Error("v2 must not perform metadata or rights batches");
    },
  };
  const env = {
    ...primary,
    DB: observedPrimary,
    COVE_SSR_STAGING: "1",
    COVE_SSR_DIAGNOSTICS: "1",
    COVE_STRANGLER_READ_MODEL: "2",
    PRESENTATION: store,
    COVE_STOREFRONT_READ_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
  };
  const request = (country, lang = "en-US") =>
    new Request("https://test/api/fore/storefront/bootstrap", {
      headers: {
        "x-cove-client-country": country,
        "cf-connecting-ip": "203.0.113.1",
        "accept-language": lang,
      },
    });
  for (const country of ["US", "CA", "SA", "JP"]) {
    await produce(discovery.DB, country, store);
    for (const lang of ["en-US", "fr-CA,fr;q=0.8", "ar", "ja"]) {
      const before = reads.length;
      const result = await serve(request(country, lang), env);
      const body = await result.json();
      assert.equal(result.status, 200);
      assert.equal(reads.length - before, 1, "exactly one fresh authority query, no metadata D1");
      const canonical = await (
        await serve(request(country, lang), {
          ...env,
          DB: primary.DB,
          COVE_STRANGLER_READ_MODEL: "0",
        })
      ).json();
      assert.deepEqual(body.context, canonical.context, `${country}/${lang} presentation parity`);
      assert.deepEqual(body.page, canonical.page);
      assert.deepEqual(
        body.catalog.results.map((b) => b.productId),
        canonical.catalog.results.map((b) => b.productId),
      );
    }
  }
  const query = reads.at(-1);
  const plan = await primary.DB.prepare("EXPLAIN QUERY PLAN " + query.sql)
    .bind(...query.args)
    .all();
  assert.ok(
    plan.results.some((r) => /SEARCH p USING INDEX sqlite_autoindex_products/.test(r.detail)),
    JSON.stringify(plan),
  );
  assert.ok(
    !plan.results.some((r) => /SCAN (?:p|d|e)\b/.test(r.detail)),
    "Bounded candidates must drive indexed lookup",
  );
  assert.doesNotMatch(
    query.sql,
    /edition_contributors|edition_subjects|series_memberships|asset_versions|JOIN works/i,
    "primary must not hydrate presentation metadata",
  );
  const us = JSON.parse(objects.get(key("US")));
  const first = us.candidates.productIds[0];
  // Cached offers/channel claims have no authority. Display metadata can
  // remain stale while the live primary offer changes on the next request.
  for (const b of us.displayBooks) {
    b.offer = { currency: "USD", amountMinor: 999999 };
    b.formats["application/epub+zip"] = "https://untrusted.invalid/book.epub";
    b.libraryEligible = true;
    b.subscriptionEligible = true;
  }
  objects.set(key("US"), JSON.stringify(us));
  const offer = await primary.DB.prepare(
    "SELECT id FROM offers WHERE product_id=? AND currency='USD' AND active=1 ORDER BY created_at DESC LIMIT 1",
  )
    .bind(first)
    .first();
  assert.ok(offer);
  await primary.DB.prepare("UPDATE offers SET amount_minor=123,offer_type='purchase' WHERE id=?")
    .bind(offer.id)
    .run();
  const fresh = await (await serve(request("US"), env)).json();
  const priced = fresh.catalog.results.find((b) => b.productId === first);
  assert.equal(priced.offer.amountMinor, 123);
  assert.equal(priced.formats["application/epub+zip"], undefined);
  assert.equal(priced.libraryEligible, undefined);
  assert.equal(priced.subscriptionEligible, undefined);
  await primary.DB.prepare(
    "UPDATE rights_grants SET status='revoked' WHERE edition_id=(SELECT edition_id FROM products WHERE id=?) AND decision='allow'",
  )
    .bind(first)
    .run();
  const revoked = await (await serve(request("US"), env)).json();
  assert.ok(
    !revoked.catalog.results.some((b) => b.productId === first),
    "stale discovery grants cannot survive live revocation",
  );
  const saved = objects.get(key("US"));
  // Reuse only completed bytes, bounded by binding/key/age; validation of an
  // expired snapshot still fails even when its bytes are available in memory.
  let objectReads = 0;
  const countedStore = {
    async get(k) {
      objectReads++;
      return store.get(k);
    },
  };
  await read(scoped(countedStore, "", true), request("US"), "US");
  await read(scoped(countedStore, "", true), request("US"), "US");
  assert.equal(objectReads, 1);
  await assert.rejects(() => read(scoped(countedStore, "other/", true), request("US"), "US"));
  assert.equal(objectReads, 2, "cache must respect deployment namespace");
  await assert.rejects(() =>
    read(scoped(countedStore, "", true), request("US"), "US", us.candidates.expiresAt),
  );
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 30_001;
    await read(scoped(countedStore, "", true), request("US"), "US");
    assert.equal(objectReads, 3, "completed presentation must refresh within 30 seconds");
  } finally {
    Date.now = realNow;
  }
  for (const bad of [
    { ...us, candidates: { ...us.candidates, expiresAt: Date.now() - 1 } },
    { ...us, candidates: { ...us.candidates, country: "CA" } },
    { ...us, contexts: us.contexts.map((c) => ({ ...c, rightsCountry: "CA" })) },
    { ...us, candidates: { ...us.candidates, productIds: Array(129).fill(first) } },
  ]) {
    objects.set(key("US"), JSON.stringify(bad));
    const before = reads.length;
    await assert.rejects(() => serve(request("US"), { ...env, PRESENTATION: { ...store } }));
    assert.equal(reads.length, before, "bad snapshots must not launch catalog fallback");
  }
  objects.delete(key("US"));
  await assert.rejects(() => serve(request("US"), { ...env, PRESENTATION: { ...store } }));
  objects.set(key("US"), saved);
  await assert.rejects(() =>
    serve(request("US"), {
      ...env,
      DB: {
        prepare() {
          throw Error("primary unavailable");
        },
      },
    }),
  );
  objects.set("campaign/123/real/" + key("US"), saved);
  // Stage KV is an advisory presentation accelerator, never an authority.
  // A missing KV object must use private R2, not a global catalog fallback.
  const kvObjects = new Map([["campaign/123/real/" + key("US"), saved]]);
  let kvReads = 0;
  const kv = {
    async get(k, options) {
      kvReads++;
      assert.deepEqual(options, { type: "text", cacheTtl: 30 });
      return kvObjects.get(k) ?? null;
    },
  };
  const accelerated = {
    ...env,
    PRESENTATION_KV: kv,
    COVE_PRESENTATION_KV_ACCELERATE: "1",
    COVE_PRESENTATION_PREFIX: "campaign/123/real/",
  };
  const beforeKv = reads.length;
  assert.equal((await serve(request("US"), accelerated)).status, 200);
  assert.equal(reads.length - beforeKv, 1, "KV display bytes cannot cache primary authorization");
  assert.equal(kvReads, 1);
  kvObjects.clear();
  assert.equal(
    (await serve(request("US"), { ...accelerated, PRESENTATION: { ...store } })).status,
    200,
    "KV miss must return to the versioned private R2 object",
  );
  kvObjects.set("campaign/123/real/" + key("US"), "{bad-json");
  const beforeInvalidKv = reads.length;
  await assert.rejects(() => serve(request("US"), { ...accelerated, PRESENTATION: { ...store } }));
  assert.equal(reads.length, beforeInvalidKv, "invalid KV bytes cannot authorize retail access");
  await assert.rejects(() => serve(request("US"), { ...accelerated, COVE_SSR_STAGING: "0" }));
  await assert.rejects(() => serve(request("US"), { ...accelerated, PRESENTATION_KV: undefined }));
  // A production customer gateway may use private KV display bytes only when
  // certified, versioned and still performing a fresh primary D1 rights query.
  const prodNamespace = "production/current/";
  objects.set(prodNamespace + key("US"), saved);
  const production = {
    ...accelerated,
    COVE_SSR_STAGING: "0",
    COVE_STRANGLER_MODE: "customer-gateway",
    COVE_STRANGLER_RELEASE_CERTIFIED: "1",
    COVE_PRESENTATION_PREFIX: prodNamespace,
    PRESENTATION: { ...store },
    PRESENTATION_KV: {
      async get(key, options) {
        assert.deepEqual(options, { type: "text", cacheTtl: 30 });
        return objects.get(key) ?? null;
      },
    },
  };
  const beforeProduction = reads.length;
  assert.equal((await serve(request("US"), production)).status, 200);
  assert.equal(reads.length - beforeProduction, 1, "production KV cannot cache rights");
  await assert.rejects(() =>
    serve(request("US"), { ...production, COVE_STRANGLER_RELEASE_CERTIFIED: "0" }),
  );
  await assert.rejects(() =>
    serve(request("US"), { ...production, COVE_PRESENTATION_PREFIX: "campaign/stage/" }),
  );
  assert.equal(
    (await serve(request("US"), { ...env, COVE_PRESENTATION_PREFIX: "campaign/123/real/" })).status,
    200,
  );
  await assert.rejects(() =>
    serve(request("US"), { ...env, COVE_PRESENTATION_PREFIX: "campaign/other/" }),
  );
  await assert.rejects(() => serve(request("US"), { ...env, COVE_PRESENTATION_PREFIX: "../" }));
  const beforeDenied = reads.length;
  await assert.rejects(() =>
    serve(request("US"), {
      ...env,
      COVE_STOREFRONT_READ_LIMITER: {
        async limit() {
          return { success: false };
        },
      },
    }),
  );
  assert.equal(
    reads.length,
    beforeDenied,
    "rate-limited arrivals must not consume primary rights capacity",
  );
  await assert.rejects(() =>
    serve(request("US"), { ...env, COVE_STRANGLER_READ_MODEL: "invalid" }),
  );
  const events = [];
  const msg = {
    body: { schema: "cove.literary.prepare.v1", jobId: "a".repeat(64) },
    attempts: 1,
    ack() {
      events.push("ack");
    },
    retry(v) {
      events.push(v.delaySeconds);
    },
  };
  let queueOwner = "isolated";
  const qe = {
    FORE_CONTENT_PROCESSOR_ENABLED: "1",
    FORE_CONTENT_PREPARE_ENABLED: "1",
    FORE_CONTENT_PROCESSOR_ROLE: "literary-prepare",
    DB: {
      prepare(sql) {
        assert.equal(
          sql,
          "SELECT value FROM cove_runtime_config WHERE key='literary_processing_owner'",
        );
        return {
          async first() {
            return { value: queueOwner };
          },
        };
      },
    },
  };
  queueOwner = "legacy";
  await consume({ messages: [msg] }, qe, async () => {
    throw Error("legacy owner must not run queued preparation");
  });
  assert.deepEqual(events.splice(0), [300]);
  queueOwner = "isolated";
  await consume({ messages: [msg] }, qe, async (_env, id) => {
    assert.equal(id, msg.body.jobId);
    return { prepared: id };
  });
  assert.deepEqual(events, ["ack"]);
  await consume({ messages: [msg] }, qe, async () => ({ failed: "job", retryAfterSeconds: 120 }));
  assert.equal(events.at(-1), 120);
  await consume({ messages: [msg] }, qe, async () => {
    throw Error("service unavailable");
  });
  assert.ok(events.at(-1) >= 60 && events.at(-1) < 90);
  await assert.rejects(() => consume({ messages: [{ ...msg, body: { schema: "wrong" } }] }, qe));
  await assert.rejects(() =>
    consume({ messages: [msg] }, { ...qe, FORE_CONTENT_PROCESSOR_ENABLED: "0" }),
  );
  const producer = config("wrangler.discovery-isolated.stage.jsonc");
  assert.equal(producer.d1_databases.length, 1);
  assert.equal(producer.d1_databases[0].binding, "DISCOVERY_DB");
  assert.notEqual(producer.d1_databases[0].database_id, "4bd657ac-8789-403e-a28c-93aba8d0a989");
  const queue = config("wrangler.content-queue.stage.jsonc").queues.consumers[0];
  assert.equal(queue.max_concurrency, 1);
  assert.equal(queue.max_batch_size, 1);
  assert.equal(queue.max_retries, 4);
  assert.ok(queue.dead_letter_queue);
  console.log(
    "PASS: independent discovery fixture, 16 country/locale parity checks, one indexed live authority SELECT, stale-rights revocation, invalid/expired/missing projection rejection, no heavy fallback, and queue retry/backpressure.",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
