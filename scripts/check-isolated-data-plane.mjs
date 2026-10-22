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
  const { produceHomepagePresentation: produce, homepagePresentationKey: key } = await import(
    path.join(root, "presentation.js")
  );
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
  const us = JSON.parse(objects.get(key("US")));
  const first = us.candidates.productIds[0];
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
  for (const bad of [
    { ...us, candidates: { ...us.candidates, expiresAt: Date.now() - 1 } },
    { ...us, candidates: { ...us.candidates, country: "CA" } },
    { ...us, contexts: us.contexts.map((c) => ({ ...c, rightsCountry: "CA" })) },
    { ...us, candidates: { ...us.candidates, productIds: Array(129).fill(first) } },
  ]) {
    objects.set(key("US"), JSON.stringify(bad));
    const before = reads.length;
    await assert.rejects(() => serve(request("US"), env));
    assert.equal(reads.length, before, "bad snapshots must not launch catalog fallback");
  }
  objects.delete(key("US"));
  await assert.rejects(() => serve(request("US"), env));
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
  const qe = {
    FORE_CONTENT_PROCESSOR_ENABLED: "1",
    FORE_CONTENT_PREPARE_ENABLED: "1",
    FORE_CONTENT_PROCESSOR_ROLE: "literary-prepare",
  };
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
