/** Native workerd/D1/SQLite-DO execution of the actual seven backend schedules.
 * Only disposable local fixtures and closed fake upstream responses. No tokens,
 * hosted resources or production permission. Empty external responses do not
 * prove supplier integration, populated commerce queues or production cutover.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeReaderProvider,
  proveNativeOwnerReader,
} from "../test-native-owner-reader-fixture.mjs";
import {
  seedLocalCatalogFixture,
  markLocalRegionalSourcesFresh,
  seedLocalScheduledRecommendationJob,
  seedLocalProductionMaintenanceQueues,
  seedLocalBlockedProductionFeed,
} from "../test-local-catalog-fixture.mjs";
const { Miniflare, convertV4MiniflareOptions } = createRequire(import.meta.url)(
  process.env.COVE_MINIFLARE_MODULE || "miniflare",
);
const root = mkdtempSync(join(tmpdir(), "cove-native-schedules-"));
const raw = new DatabaseSync(":memory:");
const primary = "969f1ea0-5f57-4f3a-aa25-9c74e58f5af3";
const secret = "a".repeat(64);
const production = process.argv.includes("--production-maintenance");
const productionPrimaryLabel = "4bd657ac-8789-403e-a28c-93aba8d0a989";
const literary = "22222222-2222-4222-8222-222222222222";
// D1 exec treats each line as a command. Compact only lexical whitespace;
// preserve quoted values and remove comments outside strings/identifiers.
function compactSql(input) {
  let out = "",
    quote = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i],
      next = input[i + 1];
    if (quote) {
      assert.ok(c !== "\n" && c !== "\r", "Multiline literal needs explicit migration handling");
      out += c;
      if (c === quote) {
        if (next === quote) {
          out += next;
          i++;
        } else quote = null;
      }
    } else if (c === "-" && next === "-") {
      while (i < input.length && input[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && next === "*") {
      const end = input.indexOf("*/", i + 2);
      assert.ok(end >= 0);
      i = end + 1;
      out += " ";
    } else if (c === "'" || c === '\"' || c === "`" || c === "[") {
      quote = c === "[" ? "]" : c;
      out += c;
    } else out += c === "\n" || c === "\r" ? " " : c;
  }
  assert.equal(quote, null);
  return out;
}

const crons = JSON.parse(
  "[" +
    readFileSync("wrangler.backend.production.toml", "utf8").match(
      /^crons\s*=\s*\[([^\]]*)\]/m,
    )[1] +
    "]",
);
assert.equal(crons.length, 7);
let mf;
let failUpstream = false;
let upstreamCalls = 0;
try {
  const migrations = readdirSync("drizzle")
    .filter((n) => n.endsWith(".sql"))
    .sort();
  for (const name of migrations) raw.exec(readFileSync(join("drizzle", name), "utf8"));
  // Fixture helpers run only in Node, never in a production Worker bundle.
  const fixtureStatements = [];
  const fixtureDb = {
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      const statement = raw.prepare(sql);
      return {
        get: (...p) => statement.get(...p),
        all: (...p) => statement.all(...p),
        run(...params) {
          fixtureStatements.push({ sql, params });
          return statement.run(...params);
        },
      };
    },
  };
  seedLocalCatalogFixture(fixtureDb);
  markLocalRegionalSourcesFresh(fixtureDb);
  seedLocalScheduledRecommendationJob(fixtureDb);
  if (production) seedLocalProductionMaintenanceQueues(fixtureDb);
  const common = {
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    alias: { jszip: "jszip/dist/jszip.min.js" },
    mainFields: ["browser", "module", "main"],
    external: ["cloudflare:*", "node:*"],
    logLevel: "silent",
  };
  await build({
    ...common,
    entryPoints: [
      production
        ? "src/storefront-strangler/production-consolidated-owner.worker.ts"
        : "src/storefront-strangler/consolidated-owner-qa.worker.ts",
    ],
    outfile: join(root, "owner.mjs"),
  });
  await build({
    ...common,
    outfile: join(root, "caller.mjs"),
    entryPoints: [
      production
        ? "src/storefront-strangler/production-consolidated-gateway.worker.ts"
        : "src/storefront-strangler/consolidated-gateway-qa.worker.ts",
    ],
  });
  const backendToken = "fixture-backend-authentication-0000000000";
  const tokenHash = createHash("sha256").update(backendToken).digest("hex");
  const bindings = {
    ...(production
      ? {
          COVE_PRODUCTION_PERSISTENCE_OWNER_ENABLED: "1",
          COVE_PRODUCTION_PERSISTENCE_CRON_ENABLED: "1",
          FORE_ENVIRONMENT: "production",
          FORE_AUTH_MODE: "supabase",
          COVE_RIGHTS_OWNER_ENABLED: "0",
          COVE_RIGHTS_OWNER_PRIMARY_ID: productionPrimaryLabel,
          COVE_LEGAL_WRITER_PRIMARY_ID: productionPrimaryLabel,
        }
      : {
          COVE_CONSOLIDATED_OWNER_QA: "1",
          COVE_QA_SCHEDULE_OWNER_ENABLED: "1",
          FORE_ENVIRONMENT: "staging",
          COVE_SSR_STAGING: "1",
          COVE_RIGHTS_OWNER_ENABLED: "1",
          COVE_RIGHTS_OWNER_PRIMARY_ID: primary,
          COVE_LEGAL_WRITER_PRIMARY_ID: primary,
          COVE_RIGHTS_OWNER_TEST_EXPIRES_AT: String(Date.now() + 840000),
        }),
    FORE_BACKEND_TOKEN_SHA256: tokenHash,
    FORE_AUTH_MODE: "supabase",
    SUPABASE_URL: "https://native-auth.invalid",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_local_native_fixture",
    COVE_PUBLICATION_COMMAND_TERRITORY: "US",
    COVE_PUBLICATION_COMMAND_CURRENCY: "USD",
    COVE_RIGHTS_OWNER_SECRET: secret,
    FORE_CATALOG_PAGES_PER_TICK: "1",
    FORE_CATALOG_EPUBS_PER_TICK: "0",
    FORE_AUDIO_COMPUTE_MODE: "budgeted",
    FORE_PUBLIC_URL: "https://fixture.invalid",
    GUTENDEX_BASE_URL: "https://fixture.invalid",
    FORE_INGESTION_TRIGGER_TOKEN: "fixture-trigger-authentication-0000000000",
  };
  const owner = {
    name: "owner",
    rootPath: root,
    modules: true,
    scriptPath: join(root, "owner.mjs"),
    compatibilityDate: "2026-10-17",
    compatibilityFlags: ["nodejs_compat"],
    bindings,
    d1Databases: {
      PRIMARY_DB: primary,
      ...(production ? { LITERARY_CONTENT_DB: literary } : {}),
    },
    durableObjects: { LEGAL_AUTHORITY: { className: "CoveLegalAuthority", useSQLite: true } },
    outboundService: async (request) => {
      const provider = nativeReaderProvider(request);
      if (provider) return provider;
      upstreamCalls++;
      if (failUpstream) return new Response(null, { status: 503 });
      const url = new URL(request.url);
      if (url.origin === "https://fixture.invalid" && url.pathname === "/books/")
        return Response.json({ results: [], count: 0, next: null, previous: null });
      if (
        url.origin === "https://fixture.invalid" &&
        /^\/api\/fore\/internal\/ingestion\/audio-(scan|discover|align|track)$/.test(url.pathname)
      )
        return Response.json({ ok: true });
      if (url.origin === "https://commons.wikimedia.org" && url.pathname === "/w/api.php")
        return Response.json({ query: { pages: {} } });
      throw Error("fixture_external_network_denied");
    },
  };
  const caller = {
    name: "caller",
    rootPath: root,
    modules: true,
    scriptPath: join(root, "caller.mjs"),
    compatibilityDate: "2026-10-17",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      ...(production
        ? {
            COVE_PRODUCTION_PERSISTENCE_GATEWAY_ENABLED: "1",
            FORE_ENVIRONMENT: "production",
          }
        : {
            COVE_CONSOLIDATED_GATEWAY_QA: "1",
            FORE_ENVIRONMENT: "staging",
            COVE_SSR_STAGING: "1",
          }),
      FORE_BACKEND_TOKEN_SHA256: tokenHash,
    },
    serviceBindings: { BUSINESS_OWNER: { name: "owner", entrypoint: "CoveBusinessEntrypoint" } },
  };
  assert.equal(caller.d1Databases, undefined);
  const options = {
    workers: [caller, owner],
    // Miniflare 5 uses resource paths; older v4 uses the per-product paths.
    // Both are explicit so a restart really reopens the same physical files.
    resourcePersistencePath: join(root, "resources"),
    isolatedResourcePersistencePath: join(root, "isolated"),
    d1Persist: join(root, "d1"),
    durableObjectsPersist: join(root, "do"),
  };
  mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  let db = await mf.getD1Database("PRIMARY_DB", "owner");
  for (const name of migrations)
    await db.exec(compactSql(readFileSync(join("drizzle", name), "utf8")));
  // Replay the original synthetic fixture statements in their original order.
  // Never disable source-controlled legal triggers or native D1 constraints.
  for (let at = 0; at < fixtureStatements.length; at += 25)
    await db.batch(
      fixtureStatements
        .slice(at, at + 25)
        .map(({ sql, params }) => db.prepare(sql).bind(...params)),
    );
  let client = await mf.getWorker("caller");
  let ownerClient = await mf.getWorker("owner");
  assert.equal((await client.fetch("https://fixture.invalid/__cove/health")).status, 401);
  assert.equal(
    (
      await client.fetch("https://fixture.invalid/__cove/health", {
        headers: { "x-cove-backend-token": "invalid-backend-token-0000000" },
      })
    ).status,
    401,
  );
  assert.notEqual(
    (
      await ownerClient.fetch("https://fixture.invalid/__cove/health", {
        headers: { "x-cove-backend-token": backendToken },
      })
    ).status,
    200,
    "Legal default entrypoint must not serve business routes",
  );
  const apiRoutes = production
    ? [
        "/__cove/health",
        "/api/fore/health/live",
        "/api/fore/health/ready",
        "/api/fore/service-status",
      ]
    : [
        "/__cove/health",
        "/api/fore/storefront/context",
        "/api/fore/taxonomy",
        "/api/fore/catalog?currency=USD&sort=popular&page=1",
        "/api/fore/catalog?currency=USD&search=Pride&sort=relevance&page=1",
        "/api/fore/catalog?currency=USD&sort=title&limit=6&page=1",
        "/api/fore/catalog?currency=USD&sort=title&limit=6&page=2",
        "/api/fore/catalog?currency=USD&sort=price_asc&language=en&format=ebook&limit=6&page=1",
      ];
  const apiResults = [];
  const apiPayloads = new Map();
  const routeFailures = [];
  for (const route of apiRoutes) {
    const response = await client.fetch("https://fixture.invalid" + route, {
      headers: {
        "x-cove-backend-token": backendToken,
        "x-cove-client-country": "US",
      },
    });
    const payload = await response.json();
    if (response.status !== 200) {
      routeFailures.push({ route, status: response.status });
      continue;
    }
    if (route.includes("/catalog?"))
      assert.ok(
        Array.isArray(payload.results) && payload.results.length > 0,
        "Catalog must return actual fixture books",
      );
    apiResults.push({ route, status: response.status });
    apiPayloads.set(route, payload);
  }
  assert.deepEqual(routeFailures, [], "All original HTTP routes must succeed");
  let counts = null;
  if (production) {
    for (const path of [
      "/api/fore/catalog",
      "/api/fore/storefront/context",
      "/api/fore/stripe/webhook",
      "/api/fore/library",
      "/api/fore/reader/content",
    ]) {
      const response = await client.fetch("https://fixture.invalid" + path, {
        headers: { "x-cove-backend-token": backendToken },
      });
      assert.equal(response.status, 503, "Maintenance must not grant unverified rights: " + path);
    }
    const isolated = await mf.getD1Database("LITERARY_CONTENT_DB", "owner");
    await isolated.exec(
      "CREATE TABLE isolated_sentinel(n INTEGER); INSERT INTO isolated_sentinel VALUES(1)",
    );
  } else {
    const firstPage = apiPayloads.get(apiRoutes[5]),
      secondPage = apiPayloads.get(apiRoutes[6]);
    assert.equal(firstPage.results.length, 6);
    assert.equal(secondPage.results.length, 6);
    assert.equal(firstPage.count, secondPage.count);
    assert.equal(
      new Set([...firstPage.results, ...secondPage.results].map((b) => b.productId || b.id)).size,
      12,
      "Native pagination must not duplicate books",
    );
    assert.ok(
      firstPage.facets && typeof firstPage.facets === "object",
      "Original catalog facets must be retained",
    );
    // The original HTTP functions must persist real operational state, not
    // just return HTTP 200 while writes fail. Allow owner waitUntil to drain.
    for (let attempt = 0; attempt < 40; attempt++) {
      counts = await db
        .prepare(
          "SELECT (SELECT count(*) FROM ops_http_requests) audit, (SELECT count(*) FROM search_query_events) impressions, (SELECT count(*) FROM api_cache WHERE key LIKE 'search-page:v1:%') pages, (SELECT count(*) FROM api_cache WHERE key LIKE 'search-facets:v2:%') facets, (SELECT count(*) FROM api_cache WHERE key LIKE 'taxonomy-counts:v1:%') taxonomy",
        )
        .first();
      if (
        counts.audit >= 1 &&
        counts.impressions >= 1 &&
        counts.pages >= 1 &&
        counts.facets >= 1 &&
        counts.taxonomy >= 1
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      counts.audit >= 1 &&
        counts.impressions >= 1 &&
        counts.pages >= 1 &&
        counts.facets >= 1 &&
        counts.taxonomy >= 1,
      "Native owner operational rows: " + JSON.stringify(counts),
    );
    console.log(
      "PASS: native gateway HTTP parity and operational row persistence",
      JSON.stringify(counts),
    );
  }
  const readerRows = await proveNativeOwnerReader({ client, db, backendToken, production });
  const scheduledTime = Date.now();
  const tick = async (cron, time = scheduledTime) => {
    try {
      const result = await ownerClient.scheduled({ cron, scheduledTime: new Date(time) });
      if (result.outcome !== "ok") console.error("Native schedule outcome", cron, result.outcome);
      return result.outcome === "ok" ? 200 : 503;
    } catch (error) {
      // Local synthetic runtime only: retain the exception name to distinguish
      // harness/API errors from an actual scheduled handler failure.
      console.error("Native schedule rejected", cron, error?.name, error?.message);
      return 503;
    }
  };
  // D1's internal bookmark bookkeeping changes SQLite total_changes even
  // for read-only RPCs. Count actual application-table writes with local-only
  // observer triggers instead; retain every original legal trigger unchanged.
  await db.exec(
    "CREATE TABLE qa_native_schedule_mutation_count(n INTEGER NOT NULL); INSERT INTO qa_native_schedule_mutation_count VALUES(0);",
  );
  const observedTables = raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'",
    )
    .all()
    .filter(({ name }) => !/_fts(?:_|$)/.test(name));
  const observerDdl = observedTables.flatMap(({ name }, index) =>
    ["INSERT", "UPDATE", "DELETE"].map((op, k) =>
      db.prepare(
        "CREATE TRIGGER qa_native_observer_" +
          index +
          "_" +
          k +
          " AFTER " +
          op +
          ' ON "' +
          name +
          '" BEGIN UPDATE qa_native_schedule_mutation_count SET n=n+1; END',
      ),
    ),
  );
  for (let at = 0; at < observerDdl.length; at += 25)
    await db.batch(observerDdl.slice(at, at + 25));
  const changes = async () =>
    Number((await db.prepare("SELECT n FROM qa_native_schedule_mutation_count").first()).n);
  const results = [];
  for (const cron of crons) {
    const result = await tick(cron);
    assert.equal(result, 200, cron);
    const before = await changes();
    assert.deepEqual(await tick(cron), result, "Exact native tick replay: " + cron);
    assert.equal(await changes(), before, "Replay repeated D1 work: " + cron);
    results.push({ cron, completed: true, replayRepeatedWrites: false });
  }
  assert.deepEqual(
    await db
      .prepare("SELECT status,attempts FROM recommendation_jobs WHERE id='qa_scheduled_rec'")
      .first(),
    { status: "done", attempts: 2 },
    "Populated expired lease must be reclaimed and completed",
  );
  if (production) {
    assert.equal(
      (
        await db
          .prepare("SELECT status FROM account_deletion_requests WHERE id='qa_maintenance_erasure'")
          .first()
      ).status,
      "blocked_legal_hold",
      "A real queued erasure must persist its publisher-ownership hold",
    );
    assert.equal(
      (
        await db
          .prepare("SELECT status FROM publisher_feed_submissions WHERE id='qa_maintenance_feed'")
          .first()
      ).status,
      "applied",
      "A real queued sandbox preview must persist application",
    );
    assert.equal(
      (
        await db
          .prepare(
            "SELECT applied_entity_type FROM publisher_feed_items WHERE id='qa_maintenance_item'",
          )
          .first()
      ).applied_entity_type,
      "sandbox_preview",
    );
    await seedLocalBlockedProductionFeed(db);
    const denied = await tick("23 * * * *", scheduledTime + 60000);
    assert.equal(denied, 503, "An actual pending live feed requires positive authority");
    assert.equal(
      (
        await db
          .prepare(
            "SELECT status FROM publisher_feed_submissions WHERE id='qa_unverified_live_feed'",
          )
          .first()
      ).status,
      "accepted",
      "The unverified production feed must remain untouched",
    );
    const beforeDeniedReplay = await changes();
    assert.equal(await tick("23 * * * *", scheduledTime + 60000), 503);
    assert.equal(await changes(), beforeDeniedReplay);
  }
  await db
    .prepare(
      "UPDATE recommendation_jobs SET job_type='unsupported-fixture-job',status='running',available_at='2000-01-01',lease_until='2000-01-01' WHERE id='qa_scheduled_rec'",
    )
    .run();
  const failed = await tick("41 4 * * *", scheduledTime + 60000);
  assert.equal(failed, 503);
  const beforeFailedReplay = await changes();
  assert.deepEqual(await tick("41 4 * * *", scheduledTime + 60000), failed);
  assert.equal(await changes(), beforeFailedReplay, "Failed receipt cannot repeat side effects");
  assert.equal(
    (await db.prepare("SELECT status FROM recommendation_jobs WHERE id='qa_scheduled_rec'").first())
      .status,
    "pending",
  );
  failUpstream = true;
  const unavailable = await tick("7-57/10 * * * *", scheduledTime + 60000);
  assert.equal(unavailable, 503, "Unavailable upstream cannot acknowledge a successful tick");
  const beforeUnavailableReplay = await changes();
  assert.deepEqual(await tick("7-57/10 * * * *", scheduledTime + 60000), unavailable);
  assert.equal(await changes(), beforeUnavailableReplay);
  const beforeRestart = await changes(),
    callsBeforeRestart = upstreamCalls;
  await mf.dispose();
  mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  db = await mf.getD1Database("PRIMARY_DB", "owner");
  client = await mf.getWorker("caller");
  ownerClient = await mf.getWorker("owner");
  for (const cron of crons)
    assert.equal(await tick(cron), 200, "Durable success replay after runtime restart: " + cron);
  assert.deepEqual(await tick("41 4 * * *", scheduledTime + 60000), failed);
  assert.deepEqual(await tick("7-57/10 * * * *", scheduledTime + 60000), unavailable);
  assert.equal(
    await changes(),
    beforeRestart,
    "Runtime restart must not repeat native side effects",
  );
  assert.equal(
    upstreamCalls,
    callsBeforeRestart,
    "Runtime restart replay must not repeat external work",
  );
  if (production) {
    const isolated = await mf.getD1Database("LITERARY_CONTENT_DB", "owner");
    assert.equal((await isolated.prepare("SELECT n FROM isolated_sentinel").first()).n, 1);
    // A gateway rollback to closed maintenance admission retains the same
    // owner journal and native primary. Never restore a direct writer.
    await mf.dispose();
    caller.bindings.COVE_PRODUCTION_PERSISTENCE_GATEWAY_ENABLED = "0";
    mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
    client = await mf.getWorker("caller");
    assert.equal(
      (
        await client.fetch("https://fixture.invalid/__cove/health", {
          headers: { "x-cove-backend-token": backendToken },
        })
      ).status,
      503,
    );
    await mf.dispose();
    caller.bindings.COVE_PRODUCTION_PERSISTENCE_GATEWAY_ENABLED = "1";
    mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
    db = await mf.getD1Database("PRIMARY_DB", "owner");
    ownerClient = await mf.getWorker("owner");
    for (const cron of crons) assert.equal(await tick(cron), 200);
    assert.equal(await changes(), beforeRestart);
  }
  console.log(
    JSON.stringify(
      {
        schema: production
          ? "cove.production-maintenance-native.v1"
          : "cove.consolidated-owner-native.v1",
        productionMaintenanceMode: production,
        ...(production ? { positiveRightsEnrolled: false } : {}),
        closedGatewayRollbackRehearsed: production,
        nativeBusinessEntrypoint: true,
        operationalRows: counts,
        readerRows,
        ownerNativeD1Bindings: 1,
        runtime: "workerd",
        compatibilityDate: "2026-10-17",
        migrations: migrations.length,
        callerNativeD1Bindings: 0,
        apiResults,
        results,
        populatedRecommendationRecovered: true,
        failedJobPending: true,
        failedReplayRepeatedWrites: false,
        journalRestartReplayedWithoutWrites: true,
        upstreamFailureAcknowledged: false,
        upstreamCalls,
        productionAccess: false,
        hosted: false,
        releaseCertified: false,
      },
      null,
      2,
    ),
  );
} finally {
  await mf?.dispose();
  raw.close();
  rmSync(root, { recursive: true, force: true });
}
