/** Native workerd/D1/SQLite-DO execution of the actual seven backend schedules.
 * Only disposable local fixtures and closed fake upstream responses. No tokens,
 * hosted resources or production permission. Empty external responses do not
 * prove supplier integration, populated commerce queues or production cutover.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  seedLocalCatalogFixture,
  markLocalRegionalSourcesFresh,
  seedLocalScheduledRecommendationJob,
} from "../test-local-catalog-fixture.mjs";
const { Miniflare, convertV4MiniflareOptions } = createRequire(import.meta.url)(
  process.env.COVE_MINIFLARE_MODULE || "miniflare",
);
const root = mkdtempSync(join(tmpdir(), "cove-native-schedules-"));
const raw = new DatabaseSync(":memory:");
const primary = "969f1ea0-5f57-4f3a-aa25-9c74e58f5af3";
const secret = "a".repeat(64);
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
    entryPoints: ["src/storefront-strangler/legal-authority.worker.ts"],
    outfile: join(root, "owner.mjs"),
  });
  await build({
    ...common,
    outfile: join(root, "caller.mjs"),
    stdin: {
      resolveDir: process.cwd(),
      loader: "ts",
      contents: `
import backend from './src/persistence-backend.worker';
export default {async fetch(request,env){
 if(new URL(request.url).pathname!=='/tick'){
   const tasks=[];
   const response=await backend.fetch(request,env,{waitUntil(p){p.catch(()=>{});tasks.push(p)}});
   await Promise.allSettled(tasks);
   return response;
 }
 if(Object.values(env).some(v=>v&&typeof v.prepare==='function'))throw Error('native_caller_binding');
 const input=await request.json();const tasks=[];let failed=false;
 try{await backend.scheduled(input,env,{waitUntil(p){p.catch(()=>{});tasks.push(p)}})}catch{failed=true}
 const settled=await Promise.allSettled(tasks);
 return Response.json({failed,tasks:tasks.length,rejected:settled.filter(x=>x.status==='rejected').length},{status:failed?503:200});
}};`,
    },
  });
  const bindings = {
    COVE_QA_SCHEDULE_OWNER_ENABLED: "1",
    COVE_QA_OPERATIONAL_OWNER_ENABLED: "1",
    COVE_QA_OWNER_UNBOUND_READ_ENABLED: "1",
    FORE_ENVIRONMENT: "staging",
    COVE_SSR_STAGING: "1",
    COVE_RIGHTS_OWNER_ENABLED: "1",
    COVE_RIGHTS_OWNER_PRIMARY_ID: primary,
    COVE_LEGAL_WRITER_PRIMARY_ID: primary,
    COVE_PUBLICATION_COMMAND_TERRITORY: "US",
    COVE_PUBLICATION_COMMAND_CURRENCY: "USD",
    COVE_RIGHTS_OWNER_SECRET: secret,
    COVE_RIGHTS_OWNER_TEST_EXPIRES_AT: String(Date.now() + 840000),
    FORE_CATALOG_PAGES_PER_TICK: "1",
    FORE_CATALOG_EPUBS_PER_TICK: "0",
    FORE_AUDIO_COMPUTE_MODE: "budgeted",
    FORE_PUBLIC_URL: "https://fixture.invalid",
    GUTENDEX_BASE_URL: "https://fixture.invalid",
    FORE_INGESTION_TRIGGER_TOKEN: "fixture-trigger-authentication-0000000000",
    FORE_BACKEND_TOKEN: "fixture-backend-authentication-0000000000",
  };
  const owner = {
    name: "owner",
    rootPath: root,
    modules: true,
    scriptPath: join(root, "owner.mjs"),
    compatibilityDate: "2026-10-17",
    compatibilityFlags: ["nodejs_compat"],
    bindings,
    d1Databases: { PRIMARY_DB: primary },
    durableObjects: { LEGAL_AUTHORITY: { className: "CoveLegalAuthority", useSQLite: true } },
    outboundService: async (request) => {
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
    bindings,
    durableObjects: {
      LEGAL_AUTHORITY: { className: "CoveLegalAuthority", scriptName: "owner", useSQLite: true },
    },
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
  const apiRoutes = [
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
  for (const route of apiRoutes) {
    const response = await client.fetch("https://fixture.invalid" + route, {
      headers: {
        "x-cove-backend-token": bindings.FORE_BACKEND_TOKEN,
        "x-cove-client-country": "US",
      },
    });
    const payload = await response.json();
    assert.equal(response.status, 200, route + ": " + JSON.stringify(payload));
    if (route.includes("/catalog?"))
      assert.ok(
        Array.isArray(payload.results) && payload.results.length > 0,
        "Catalog must return actual fixture books",
      );
    apiResults.push({ route, status: response.status });
    apiPayloads.set(route, payload);
  }
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
  // A 200 alone is not evidence that the best-effort operational writes
  // succeeded. Inspect the actual native owner's persisted rows.
  const counts = await db.prepare(
    "SELECT (SELECT count(*) FROM ops_http_requests) audit, (SELECT count(*) FROM search_query_events) impressions, (SELECT count(*) FROM api_cache WHERE key LIKE 'search-page:v1:%') pages, (SELECT count(*) FROM api_cache WHERE key LIKE 'search-facets:v2:%') facets, (SELECT count(*) FROM api_cache WHERE key LIKE 'taxonomy-counts:v1:%') taxonomy"
  ).first();
  assert.ok(counts.audit >= 1 && counts.impressions >= 1 && counts.pages >= 1 && counts.facets >= 1 && counts.taxonomy >= 1,
    "Actual native owner operational writes must persist: " + JSON.stringify(counts));
  console.log("PASS: native D1-unbound HTTP audit, anonymous impressions, facet/page/taxonomy caches: " + JSON.stringify(counts));
  const scheduledTime = Date.now();
  const tick = async (cron, time = scheduledTime) => {
    const response = await client.fetch("https://fixture.invalid/tick", {
      method: "POST",
      body: JSON.stringify({ cron, scheduledTime: time }),
    });
    return { status: response.status, ...(await response.json()) };
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
    assert.deepEqual(result, { status: 200, failed: false, tasks: 1, rejected: 0 }, cron);
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
  await db
    .prepare(
      "UPDATE recommendation_jobs SET job_type='unsupported-fixture-job',status='running',available_at='2000-01-01',lease_until='2000-01-01' WHERE id='qa_scheduled_rec'",
    )
    .run();
  const failed = await tick("41 4 * * *", scheduledTime + 60000);
  assert.equal(failed.status, 503);
  assert.equal(failed.rejected, 1);
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
  assert.equal(
    unavailable.status,
    503,
    "Unavailable upstream cannot acknowledge a successful tick",
  );
  const beforeUnavailableReplay = await changes();
  assert.deepEqual(await tick("7-57/10 * * * *", scheduledTime + 60000), unavailable);
  assert.equal(await changes(), beforeUnavailableReplay);
  const beforeRestart = await changes(),
    callsBeforeRestart = upstreamCalls;
  await mf.dispose();
  mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  db = await mf.getD1Database("PRIMARY_DB", "owner");
  client = await mf.getWorker("caller");
  for (const cron of crons)
    assert.equal(
      (await tick(cron)).status,
      200,
      "Durable success replay after runtime restart: " + cron,
    );
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
  console.log(
    JSON.stringify(
      {
        schema: "cove.native-owner-schedules.v1",
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
