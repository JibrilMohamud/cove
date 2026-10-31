import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
import ts from "typescript";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cove-publication-"));
const ledger = new DatabaseSync(":memory:");
const realNow = Date.now;
let clock = realNow();
try {
  ledger.exec(fs.readFileSync("infra/discovery/0001_publication_feed.sql", "utf8"));
  for (const lane of ["export", "publish"]) {
    const file = `wrangler.publication-${lane}.stage.jsonc`;
    const parsed = ts.parseConfigFileTextToJson(file, fs.readFileSync(file, "utf8"));
    assert.ok(!parsed.error);
    const c = parsed.config;
    assert.equal(c.workers_dev, false);
    assert.equal(c.preview_urls, false);
    assert.equal(c.vars.COVE_PUBLICATION_ENABLED, "0");
    assert.ok(!c.triggers && !c.routes && !c.route && !c.queues);
    if (lane === "publish") {
      assert.equal(c.d1_databases.length, 1);
      assert.equal(c.d1_databases[0].binding, "DISCOVERY_DB");
      assert.ok(!JSON.stringify(c).includes("4bd657ac-8789-403e-a28c-93aba8d0a989"));
    }
  }
  fs.cpSync("drizzle", path.join(dir, "drizzle"), { recursive: true });
  await build({
    entryPoints: {
      feed: "src/storefront-strangler/publication-feed.server.ts",
      api: "src/features/fore/api.server.ts",
      presentation: "src/storefront-strangler/homepage-presentation.server.ts",
      driver: "src/storefront-strangler/publication-driver.worker.ts",
      capture: "src/storefront-strangler/publication-capture.server.ts",
      sourceReader: "src/storefront-strangler/publication-source-reader.ts",
    },
    outdir: dir,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const { exportPublicPresentation: productionExport, publishPublicPresentation: publish } =
    await import(path.join(dir, "feed.js"));
  const exportFeed = (env) => productionExport(env, { allowCanonicalStageFixture: true });
  const {
    readHomepagePresentation: read,
    authorizeHomepagePresentation: authorize,
    homepagePresentationKey: key,
  } = await import(path.join(dir, "presentation.js"));
  const { handleCoveApi } = await import(path.join(dir, "api.js"));
  const { default: driver } = await import(path.join(dir, "driver.js"));
  const { capturePublicSource } = await import(path.join(dir, "capture.js"));
  const { readPublicationSource } = await import(path.join(dir, "sourceReader.js"));
  let invoked = 0;
  const control = {
    GATE: "a".repeat(64),
    EXPORTER: {
      async fetch() {
        invoked++;
        return Response.json({ ok: true });
      },
    },
  };
  assert.equal(
    (await driver.fetch(new Request("https://private/export", { method: "POST" }), control)).status,
    401,
  );
  assert.equal(invoked, 0);
  assert.equal(
    (
      await driver.fetch(
        new Request("https://private/export", {
          method: "POST",
          headers: { authorization: "Bearer " + control.GATE },
        }),
        control,
      )
    ).status,
    200,
  );
  assert.equal(invoked, 1);
  const primary = localBindings(dir);
  const initial = await handleCoveApi(new Request("https://test/api/fore/storefront/bootstrap"), {
    ...primary,
    FORE_ENVIRONMENT: "development",
  });
  assert.equal(initial.status, 200, await initial.text());
  await primary.DB.prepare(
    "UPDATE storefront_markets SET market_status='paused' WHERE country_code NOT IN ('US','CA','SA','JP')",
  ).run();
  const sourceSql = [];
  let sessions = 0;
  let failOneRead = true;
  const SOURCE_DB = {
    ...primary.DB,
    withSession(constraint) {
      assert.ok(["first-primary", "first-unconstrained"].includes(constraint));
      sessions++;
      return {
        ...primary.DB,
        prepare(sql) {
          sourceSql.push(sql);
          assert.match(sql.trim(), /^(SELECT|WITH)\b/i);
          if (failOneRead) {
            failOneRead = false;
            return {
              bind() {
                return {
                  async all() {
                    throw Error("D1_ERROR: Network connection lost");
                  },
                };
              },
            };
          }
          return primary.DB.prepare(sql);
        },
      };
    },
  };
  let loseAck = false;
  const DISCOVERY_DB = {
    prepare(sql) {
      function stmt(values = []) {
        return {
          bind(...args) {
            return stmt(args);
          },
          async first() {
            if (loseAck && sql.includes("published_at=?")) {
              loseAck = false;
              throw Error("lost_ack");
            }
            return ledger.prepare(sql).get(...values) ?? null;
          },
          async all() {
            return { results: ledger.prepare(sql).all(...values) };
          },
          async run() {
            return ledger.prepare(sql).run(...values);
          },
        };
      }
      return stmt();
    },
    async batch() {
      throw Error("not required");
    },
  };
  const objects = new Map();
  let puts = 0,
    conflict = false;
  const PRESENTATION = {
    async head(k) {
      return objects.get(k) ?? null;
    },
    async get(k) {
      const o = objects.get(k);
      return o
        ? {
            size: Buffer.byteLength(o.body),
            async text() {
              return o.body;
            },
          }
        : null;
    },
    async put(k, body, opts) {
      if (conflict) {
        conflict = false;
        return null;
      }
      const old = objects.get(k);
      if (
        (opts.onlyIf.etagMatches && old?.etag !== opts.onlyIf.etagMatches) ||
        (opts.onlyIf.etagDoesNotMatch === "*" && old)
      )
        return null;
      puts++;
      const o = {
        body,
        etag: createHash("sha256").update(body).digest("hex"),
        customMetadata: opts.customMetadata,
      };
      objects.set(k, o);
      return o;
    },
  };
  const base = {
    DISCOVERY_DB,
    COVE_PUBLICATION_ENABLED: "1",
    COVE_PRESENTATION_PREFIX: "feed/test/",
  };
  Date.now = () => clock;
  // Overlapping scheduled export attempts must not start any source read,
  // even when there are due markets waiting to be published.
  ledger
    .prepare("INSERT OR IGNORE INTO discovery_publications(country,active) VALUES('ZZ',0)")
    .run();
  ledger
    .prepare(
      "UPDATE discovery_publications SET lease_token='busy',lease_until=? WHERE country='ZZ'",
    )
    .run(clock + 30_000);
  const busy = await exportFeed({ ...base, SOURCE_DB });
  assert.equal(busy.skipped, true);
  assert.equal(sessions, 0, "fenced exporter must not open a source session");
  ledger
    .prepare("UPDATE discovery_publications SET lease_token='',lease_until=0 WHERE country='ZZ'")
    .run();
  const exported = await exportFeed({ ...base, SOURCE_DB });
  assert.equal(exported.results.length, 4, JSON.stringify(exported));
  assert.ok(
    exported.results.every((r) => r.exported),
    JSON.stringify(ledger.prepare("SELECT country,last_error FROM discovery_publications").all()),
  );
  assert.equal(puts, 0, "source exporter cannot publish");
  assert.equal(
    ledger.prepare("SELECT lease_token FROM discovery_publications WHERE country='ZZ'").get()
      .lease_token,
    "",
    "successful export releases independent writer lease",
  );
  assert.equal(sessions, 2, "a single transport failure uses exactly one fresh session");
  assert.equal(exported.source.retries, 1, "validated publication reads retry transport loss once");
  // The production entrypoint must refuse a canonical-source binding even
  // when the stage correctness entrypoint is deliberately allowed to read it.
  // Only the small identity lookup may run; no catalog/publication scan follows.
  const beforeGuardedSource = sourceSql.length;
  await assert.rejects(
    () => productionExport({ ...base, SOURCE_DB }),
    /publication_independent_source_required/,
  );
  const deniedStatements = sourceSql.slice(beforeGuardedSource);
  assert.equal(deniedStatements.length, 1);
  assert.match(deniedStatements[0], /cove_publication_source_identity/);

  assert.ok(exported.source.statements > 4);
  assert.equal(
    exported.source.unknown,
    exported.source.statements,
    "unknown routing must not be called replica",
  );
  // Two concurrent exporters cannot claim already-ready generations.
  assert.equal((await exportFeed({ ...base, SOURCE_DB })).results.length, 0);
  const pub = await publish({ ...base, PRESENTATION });
  assert.equal(pub.length, 4);
  assert.ok(
    pub.every((r) => r.published),
    JSON.stringify(ledger.prepare("SELECT country,last_error FROM discovery_publications").all()),
  );
  assert.equal(puts, 4);

  // A distinct, PUBLIC-ONLY source D1 owns the materialized presentation.
  // The canonical public catalog is read only by bounded capture; normal
  // export and R2 publication cannot access the canonical source at all.
  const sourceDomain = new DatabaseSync(":memory:");
  sourceDomain.exec(fs.readFileSync("infra/publication-source/0001_identity.sql", "utf8"));
  const PUBLIC_SOURCE_DB = {
    prepare(sql) {
      function stmt(values = []) {
        return {
          bind(...params) {
            return stmt(params);
          },
          async first() {
            return sourceDomain.prepare(sql).get(...values) ?? null;
          },
          async all() {
            return { results: sourceDomain.prepare(sql).all(...values) };
          },
          async run() {
            const result = sourceDomain.prepare(sql).run(...values);
            return { meta: { changes: result.changes } };
          },
        };
      }
      return stmt();
    },
  };
  await assert.rejects(
    () => capturePublicSource({ SOURCE_DB, PUBLIC_SOURCE_DB }),
    /capture_disabled/,
  );
  const capturing = { SOURCE_DB, PUBLIC_SOURCE_DB, COVE_PUBLICATION_CAPTURE_ENABLED: "1" };
  let captureLostOnce = true;
  let captureSessions = 0;
  const RESILIENT_CAPTURE_DB = {
    ...SOURCE_DB,
    withSession(constraint) {
      captureSessions++;
      const session = SOURCE_DB.withSession(constraint);
      return {
        ...session,
        prepare(sql) {
          const stmt = session.prepare(sql);
          if (!captureLostOnce || !sql.includes("storefront_markets")) return stmt;
          const flakyRead = (statement) => ({
            ...statement,
            bind(...values) {
              return flakyRead(statement.bind(...values));
            },
            async all() {
              if (captureLostOnce) {
                captureLostOnce = false;
                throw Error("D1_ERROR: Network connection lost");
              }
              return statement.all();
            },
          });
          return flakyRead(stmt);
        },
      };
    },
  };
  const firstCapture = await capturePublicSource({
    ...capturing,
    SOURCE_DB: RESILIENT_CAPTURE_DB,
  });
  assert.equal(captureLostOnce, false, "the read-only capture retry was actually exercised");
  assert.equal(captureSessions, 2, "failed source read reopens exactly one fresh D1 session");
  assert.equal(firstCapture.countries.length, 2);
  assert.equal(firstCapture.complete, false);
  assert.equal(
    sourceDomain.prepare("SELECT COUNT(*) n FROM cove_publication_source_identity").get().n,
    0,
  );
  const secondCapture = await capturePublicSource(capturing);
  assert.equal(secondCapture.countries.length, 2);
  assert.equal(secondCapture.complete, true);
  assert.equal(
    sourceDomain.prepare("SELECT COUNT(*) n FROM cove_publication_source_snapshots").get().n,
    4,
  );
  assert.equal(
    sourceDomain.prepare("SELECT COUNT(*) n FROM cove_publication_source_identity").get().n,
    1,
  );
  // The deployed continuous capture has no canonical D1 binding. Exercise
  // the actual fixed private reader and capture adapter together.
  const readerSecret = "d".repeat(64);
  const readerEnv = {
    PRIMARY_DB: SOURCE_DB,
    COVE_RIGHTS_OWNER_PRIMARY_ID: "4bd657ac-8789-403e-a28c-93aba8d0a989",
    COVE_PUBLICATION_SOURCE_READER_SECRET: readerSecret,
  };
  const readerCall = (body, secret = readerSecret, customEnv = readerEnv) =>
    readPublicationSource(
      new Request("https://legal-authority.internal/__cove/publication/advisory-source", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + secret },
        body: JSON.stringify(body),
      }),
      customEnv,
    );
  const readsBefore = sourceSql.length;
  assert.equal((await readerCall({}, "forged")).status, 401);
  assert.equal((await readerCall({ sql: "DELETE FROM products" })).status, 400);
  assert.equal((await readerCall({ country: "US", userId: "someone" })).status, 400);
  assert.equal(
    (await readerCall({}, readerSecret, { ...readerEnv, COVE_RIGHTS_OWNER_PRIMARY_ID: "qa" }))
      .status,
    503,
  );
  assert.equal(sourceSql.length, readsBefore, "Rejected private source requests must not touch D1");
  const privateCapture = {
    PUBLIC_SOURCE_DB,
    COVE_PUBLICATION_CAPTURE_ENABLED: "1",
    COVE_PUBLICATION_SOURCE_READER_SECRET: readerSecret,
    SOURCE_READER: { fetch: (request) => readPublicationSource(request, readerEnv) },
  };
  const privateResult = await capturePublicSource(privateCapture);
  assert.equal(privateResult.countries.length, 2);
  assert.ok(privateResult.countries.every((c) => ["CA", "JP", "SA", "US"].includes(c)));
  await assert.rejects(() => capturePublicSource({ ...privateCapture, SOURCE_DB }), /ambiguous/);
  await assert.rejects(
    () =>
      capturePublicSource({
        ...privateCapture,
        SOURCE_READER: {
          async fetch() {
            return new Response(null, { status: 503 });
          },
        },
      }),
    /reader_unavailable/,
  );
  const privateConfig = JSON.parse(
    fs.readFileSync("wrangler.publication-capture.prod-private.jsonc", "utf8"),
  );
  assert.ok(
    !privateConfig.d1_databases.some(
      (b) => b.binding === "SOURCE_DB" || b.database_id === "4bd657ac-8789-403e-a28c-93aba8d0a989",
    ),
  );
  assert.equal(privateConfig.services[0].service, "cove-legal-authority-production");
  let materializedReads = 0;
  const MATERIALIZED_DB = {
    ...PUBLIC_SOURCE_DB,
    withSession(constraint) {
      assert.ok(["first-primary", "first-unconstrained"].includes(constraint));
      return {
        prepare(sql) {
          materializedReads++;
          assert.doesNotMatch(
            sql,
            /\b(?:rights_grants|commerce_orders|entitlements|storefront_markets|catalog_search_documents)\b/i,
          );
          return PUBLIC_SOURCE_DB.prepare(sql);
        },
      };
    },
  };
  ledger.prepare("UPDATE discovery_publications SET due_at=0 WHERE country<>'ZZ'").run();
  const primaryReadsBeforeExport = sourceSql.length;
  const independent = await productionExport({ ...base, SOURCE_DB: MATERIALIZED_DB });
  assert.equal(independent.results.length, 4);
  assert.ok(independent.results.every((row) => row.exported));
  assert.equal(
    sourceSql.length,
    primaryReadsBeforeExport,
    "normal publisher must never query canonical D1",
  );
  assert.ok(materializedReads >= 6);
  assert.equal((await publish({ ...base, PRESENTATION })).filter((r) => r.published).length, 4);
  sourceDomain
    .prepare("UPDATE cove_publication_source_identity SET last_synced_at=?")
    .run(clock - 180_000);
  await assert.rejects(
    () => productionExport({ ...base, SOURCE_DB: MATERIALIZED_DB }),
    /publication_independent_source_stale/,
  );
  sourceDomain.prepare("UPDATE cove_publication_source_identity SET last_synced_at=?").run(clock);
  sourceDomain.close();

  const request = new Request("https://test/", { headers: { "accept-language": "en-US" } });
  const scoped = { get: (k) => PRESENTATION.get(base.COVE_PRESENTATION_PREFIX + k) };
  const snapshot = await read(scoped, request, "US", clock);
  const id = snapshot.candidates.productIds[0];
  assert.ok(id);
  assert.ok(
    snapshot.displayBooks.every(
      (b) => !b.offer && !b.subscriptionEligible && !b.formats["application/epub+zip"],
    ),
  );
  await primary.DB.prepare(
    "UPDATE rights_grants SET status='revoked' WHERE edition_id=(SELECT edition_id FROM products WHERE id=?) AND decision='allow'",
  )
    .bind(id)
    .run();
  const books = await authorize(primary.DB, snapshot);
  assert.ok(
    !books.results.some((b) => b.productId === id),
    "publication never preserves a revoked primary grant",
  );
  // Actual source changes are picked up by a full bounded rebuild, rather
  // than relying on a manually seeded fixture or every mutation site.
  await primary.DB.prepare(
    "UPDATE editions SET title='Updated live source title' WHERE id=(SELECT edition_id FROM products WHERE id=?)",
  )
    .bind(snapshot.candidates.productIds[1])
    .run();
  ledger.prepare("UPDATE discovery_publications SET due_at=0 WHERE country='US'").run();
  await exportFeed({ ...base, SOURCE_DB });
  loseAck = true;
  const replay = await publish({ ...base, PRESENTATION });
  assert.equal(replay[0].published, false);
  const written = puts;
  clock += 70_000;
  const retried = await publish({ ...base, PRESENTATION });
  assert.equal(retried[0].published, true);
  assert.equal(puts, written, "lost ACK replay must not rewrite the published generation");
  const refreshed = await read(scoped, request, "US", clock);
  assert.ok(refreshed.displayBooks.some((b) => b.title === "Updated live source title"));
  // A stale CAS does not count as publication; subsequent replay can finish.
  ledger.prepare("UPDATE discovery_publications SET due_at=0 WHERE country='US'").run();
  await exportFeed({ ...base, SOURCE_DB });
  conflict = true;
  assert.equal((await publish({ ...base, PRESENTATION }))[0].published, false);
  clock += 70_000;
  assert.equal((await publish({ ...base, PRESENTATION }))[0].published, true);
  // Final-attempt crashes are recovered, with bounded rebuilding delay.
  ledger
    .prepare(
      "UPDATE discovery_publications SET status='publishing',attempts=4,lease_until=0 WHERE country='US'",
    )
    .run();
  await publish({ ...base, PRESENTATION });
  const recovered = ledger
    .prepare("SELECT status,attempts,due_at FROM discovery_publications WHERE country='US'")
    .get();
  assert.equal(recovered.status, "delivered");
  assert.equal(recovered.attempts, 0);
  assert.ok(recovered.due_at > clock);
  // Expired payloads, malformed digests and contaminated DBs fail closed.
  ledger
    .prepare(
      "UPDATE discovery_publications SET status='ready',attempts=0,due_at=0,body='{}' WHERE country='US'",
    )
    .run();
  const before = puts;
  assert.equal((await publish({ ...base, PRESENTATION }))[0].published, false);
  assert.equal(puts, before);
  await assert.rejects(() => read(scoped, request, "US", clock + 20 * 60_000));
  await assert.rejects(() => exportFeed({ ...base, SOURCE_DB, COVE_PUBLICATION_ENABLED: "0" }));
  await assert.rejects(() => exportFeed({ ...base, SOURCE_DB, COVE_PRESENTATION_PREFIX: "../" }));
  ledger.exec("CREATE TABLE rights_grants(id TEXT)");
  await assert.rejects(() => publish({ ...base, PRESENTATION }));
  assert.ok(sourceSql.every((sql) => !/\b(INSERT|UPDATE|DELETE|CREATE|DROP)\b/i.test(sql)));
  console.log(
    "PASS: live source refresh, independent publication ledger, bounded export, fresh primary revocation, conditional publication, lost ACK replay, crash recovery, expiry and contamination rejection.",
  );
} finally {
  Date.now = realNow;
  ledger.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
