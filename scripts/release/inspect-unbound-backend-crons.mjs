/** Exercise the actual seven cron entrypoints, real owner handlers and every
 * migration in disposable SQLite. No native caller D1, network, credentials or
 * production resources. This diagnoses migration gaps, never certifies them.
 * Run: node --no-warnings scripts/release/inspect-unbound-backend-crons.mjs
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  seedLocalCatalogFixture,
  markLocalRegionalSourcesFresh,
  seedLocalScheduledRecommendationJob,
} from "../test-local-catalog-fixture.mjs";

const root = mkdtempSync(join(tmpdir(), "cove-unbound-crons-"));
const savedFetch = globalThis.fetch;
const savedConsole = { info: console.info, warn: console.warn, error: console.error };
const databases = [];
const ownerExecution = process.argv.includes("--owner-execution");
const failingMaintenance = process.argv.includes("--failing-maintenance-job");
const seededServices = process.argv.includes("--seeded-services");
const assertContract = process.argv.includes("--assert-owner-contract");
const assertNegative = process.argv.includes("--assert-negative-owner-contract");
if (assertNegative) assert.ok(ownerExecution && !seededServices);
if (assertContract) assert.ok(ownerExecution && seededServices);
let observation;
const deniedTables = new Set([
  "literary_profile_state",
  "music_profile_state",
  "cove_runtime_config",
  "api_cache",
  "catalog_state",
  "soundtrack_recordings",
  "soundtrack_ingestion_state",
  "author_alert_scan_state",
  "recommendation_jobs",
]);
const deniedSite = (query) => {
  const table = query.match(
    /^\s*(?:INSERT(?: OR IGNORE)? INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/i,
  )?.[1];
  // Only code-owned table categories, never SQL, bind values, errors or IDs.
  observation.deniedWrites.push(deniedTables.has(table) ? table : "other-operational-write");
};
try {
  const gateFile = "src/storefront-strangler/qa-owner-primary-read-transport.mjs";
  const gate = readFileSync(gateFile, "utf8");
  const needle = ")\n    deny();\n  return sql;";
  assert.equal(
    gate.split(needle).length,
    2,
    "Read denial instrumentation must identify exactly one guard",
  );
  // Add a fixture-only observer IMMEDIATELY BEFORE the existing throw. The
  // actual lexical denial and return behavior are unchanged. No caller can
  // turn this observation hook into a successful SQL mutation.
  globalThis.__coveObserveDeniedCronSql = deniedSite;
  const outfile = join(root, "runtime.mjs");
  await build({
    stdin: {
      contents: `export {default as backend} from "./src/persistence-backend.worker.ts";
export {CoveLegalAuthority} from "./src/storefront-strangler/legal-authority.worker.ts";`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    alias: { jszip: "jszip/dist/jszip.min.js" },
    logLevel: "silent",
    plugins: [
      {
        name: "observe-denial-only",
        setup(builder) {
          builder.onLoad({ filter: /qa-owner-primary-read-transport\.mjs$/ }, () => ({
            contents: gate.replace(
              needle,
              ") { globalThis.__coveObserveDeniedCronSql(sql); deny(); }\n  return sql;",
            ),
            loader: "js",
          }));
        },
      },
      {
        name: "disposable-durable-host",
        setup(builder) {
          builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "host",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              "export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}",
          }));
        },
      },
    ],
  });
  const { backend, CoveLegalAuthority } = await import(pathToFileURL(outfile).href);
  const config = readFileSync("wrangler.backend.production.toml", "utf8");
  const crons = JSON.parse("[" + config.match(/^crons\s*=\s*\[([^\]]*)\]/m)[1] + "]");
  assert.equal(crons.length, 7);
  assert.equal(new Set(crons).size, 7);
  const migrations = readdirSync("drizzle")
    .filter((name) => name.endsWith(".sql"))
    .sort();
  globalThis.fetch = async (input) => {
    observation.networkAttempts++;
    const url = new URL(typeof input === "string" ? input : input.url || String(input));
    if (seededServices && url.origin === "https://fixture.invalid" && url.pathname === "/books/")
      return Response.json({ results: [], count: 0, next: null, previous: null });
    if (
      seededServices &&
      url.origin === "https://fixture.invalid" &&
      /^\/api\/fore\/internal\/ingestion\/audio-(scan|discover|align|track)$/.test(url.pathname)
    )
      return Response.json({ ok: true });
    if (
      seededServices &&
      url.origin === "https://commons.wikimedia.org" &&
      url.pathname === "/w/api.php"
    )
      return Response.json({ query: { pages: {} } });
    throw Error("fixture_external_network_denied");
  };
  for (const level of Object.keys(savedConsole))
    console[level] = () => {
      observation[level + "LogCount"]++;
    };
  const reports = [];
  for (const cron of crons) {
    observation = {
      deniedWrites: [],
      networkAttempts: 0,
      infoLogCount: 0,
      warnLogCount: 0,
      errorLogCount: 0,
    };
    const primary = new DatabaseSync(":memory:"),
      durable = new DatabaseSync(":memory:");
    databases.push(primary, durable);
    for (const name of migrations) primary.exec(readFileSync(join("drizzle", name), "utf8"));
    if (seededServices) {
      seedLocalCatalogFixture(primary);
      // Positive source fixtures are synthetic local data, never production
      // authority. Regional discovery has its own negative coverage; it is
      // fresh here while the US metadata lease processes an empty fake feed.
      markLocalRegionalSourcesFresh(primary);
      if (cron === "41 4 * * *") seedLocalScheduledRecommendationJob(primary, failingMaintenance);
    }
    let ownerReads = 0,
      ownerWrites = 0,
      ownerCommands = 0;
    const primaryDb = {
      prepare(query) {
        const bound = (params = []) => ({
          bind: (...values) => bound(values),
          async first() {
            if (/^\s*(?:SELECT|WITH)\b/i.test(query)) ownerReads++;
            else ownerWrites++;
            return primary.prepare(query).get(...params) || null;
          },
          async all() {
            if (/^\s*(?:SELECT|WITH)\b/i.test(query)) ownerReads++;
            else ownerWrites++;
            return { success: true, results: primary.prepare(query).all(...params) };
          },
          async run() {
            ownerWrites++;
            return {
              success: true,
              meta: { changes: Number(primary.prepare(query).run(...params).changes) },
            };
          },
        });
        return bound();
      },
      // Only a fixture bookmark: this does NOT prove managed D1 consistency.
      withSession() {
        return { ...primaryDb, getBookmark: () => "fixture-bookmark:1" };
      },
      async batch(items) {
        primary.exec("BEGIN");
        try {
          const results = [];
          for (const item of items) results.push(await item.run());
          primary.exec("COMMIT");
          return results;
        } catch (error) {
          primary.exec("ROLLBACK");
          throw error;
        }
      },
    };
    const sql = {
      exec(query, ...params) {
        if (!params.length && /^(CREATE|ALTER|DROP|PRAGMA)\b/i.test(query.trim())) {
          durable.exec(query);
          return { toArray: () => [] };
        }
        const statement = durable.prepare(query);
        const rows = statement.columns().length
          ? statement.all(...params)
          : (statement.run(...params), []);
        return { toArray: () => rows };
      },
    };
    const primaryId = "7c7ab994-f6b3-419d-a72d-71eb9ea22e7e";
    const env = {
      COVE_QA_OWNER_UNBOUND_READ_ENABLED: "1",
      ...(ownerExecution ? { COVE_QA_SCHEDULE_OWNER_ENABLED: "1" } : {}),
      FORE_ENVIRONMENT: "staging",
      COVE_SSR_STAGING: "1",
      COVE_RIGHTS_OWNER_ENABLED: "1",
      COVE_RIGHTS_OWNER_PRIMARY_ID: primaryId,
      COVE_LEGAL_WRITER_PRIMARY_ID: primaryId,
      COVE_RIGHTS_OWNER_TEST_EXPIRES_AT: String(Date.now() + 600_000),
      COVE_RIGHTS_OWNER_SECRET: "a".repeat(64),
      COVE_PUBLICATION_COMMANDS_ENABLED: "1",
      COVE_PUBLICATION_COMMAND_TERRITORY: "US",
      COVE_PUBLICATION_COMMAND_CURRENCY: "USD",
      FORE_CATALOG_PAGES_PER_TICK: "1",
      ...(seededServices ? { FORE_AUDIO_COMPUTE_MODE: "budgeted" } : {}),
      FORE_CATALOG_EPUBS_PER_TICK: "0",
      FORE_PUBLIC_URL: "https://fixture.invalid",
      GUTENDEX_BASE_URL: "https://fixture.invalid",
      FORE_INGESTION_TRIGGER_TOKEN: "fixture-trigger-authentication-0000000000",
      FORE_BACKEND_TOKEN: "fixture-backend-authentication-0000000000",
    };
    assert.equal(Object.hasOwn(env, "DB"), false);
    assert.equal(Object.hasOwn(env, "PRIMARY_DB"), false);
    const ownerEnv = { ...env, PRIMARY_DB: primaryDb };
    delete ownerEnv.COVE_QA_OWNER_UNBOUND_READ_ENABLED;
    const owner = new CoveLegalAuthority(
      {
        storage: {
          sql,
          transactionSync(fn) {
            durable.exec("BEGIN");
            try {
              const result = fn();
              durable.exec("COMMIT");
              return result;
            } catch (error) {
              durable.exec("ROLLBACK");
              throw error;
            }
          },
        },
      },
      ownerEnv,
    );
    env.LEGAL_AUTHORITY = {
      getByName() {
        return {
          async fetch(request) {
            if (new URL(request.url).pathname !== "/qa/private-primary-read") ownerCommands++;
            return owner.fetch(request);
          },
        };
      },
    };
    const tasks = [];
    const scheduledTime = Date.now();
    // Attach a rejection observer immediately; retain each original rejection
    // for the final settled evidence instead of swallowing waitUntil failures.
    let entrypointFailed = false;
    try {
      await backend.scheduled({ cron, scheduledTime }, env, {
        waitUntil(promise) {
          const task = Promise.resolve(promise);
          task.catch(() => {});
          tasks.push(task);
        },
      });
    } catch {
      entrypointFailed = true;
    }
    const settled = await Promise.allSettled(tasks);
    let replayRepeatedWrites = null;
    if (assertContract) {
      const expectedFailure = failingMaintenance && cron === "41 4 * * *";
      assert.equal(
        entrypointFailed,
        expectedFailure,
        "Actual scheduled entrypoint result: " + cron,
      );
      assert.equal(
        settled.some((x) => x.status === "rejected"),
        expectedFailure,
        cron,
      );
      assert.deepEqual(observation.deniedWrites, [], cron);
      if (cron === "41 4 * * *") {
        const job = primary
          .prepare("SELECT status,attempts FROM recommendation_jobs WHERE id='qa_scheduled_rec'")
          .get();
        assert.equal(job.status, failingMaintenance ? "pending" : "done");
        assert.equal(
          job.attempts,
          2,
          "Expired populated lease must be reclaimed and executed once",
        );
      }
      const before = { ownerReads, ownerWrites };
      const replay = () =>
        backend.scheduled({ cron, scheduledTime }, env, {
          waitUntil(p) {
            p.catch(() => {});
          },
        });
      if (expectedFailure) await assert.rejects(replay);
      else await replay();
      replayRepeatedWrites = ownerWrites !== before.ownerWrites;
      assert.deepEqual(
        { ownerReads, ownerWrites },
        before,
        "Exact tick replay must not repeat native work: " + cron,
      );
    }
    if (assertNegative) {
      const mustFail = ["*/5 * * * *", "7-57/10 * * * *"].includes(cron);
      assert.equal(
        entrypointFailed,
        mustFail,
        "Missing legal proof/upstream failures must be visible: " + cron,
      );
      assert.equal(
        settled.some((x) => x.status === "rejected"),
        mustFail,
        cron,
      );
      assert.deepEqual(
        observation.deniedWrites,
        [],
        "No borrower operational SQL remains: " + cron,
      );
      if (mustFail) {
        const before = { ownerReads, ownerWrites };
        await assert.rejects(() =>
          backend.scheduled({ cron, scheduledTime }, env, {
            waitUntil(p) {
              p.catch(() => {});
            },
          }),
        );
        assert.deepEqual(
          { ownerReads, ownerWrites },
          before,
          "Failed tick replay must not repeat side effects",
        );
      }
    }
    reports.push({
      cron,
      entrypointFailed,
      tasks: tasks.length,
      rejectedTasks: settled.filter((result) => result.status === "rejected").length,
      ownerReads,
      ownerWrites,
      ownerCommands,
      ...(assertContract ? { replayRepeatedWrites } : {}),
      ...observation,
    });
  }
  savedConsole.info(
    JSON.stringify(
      {
        schema: "cove.unbound-backend-cron-fixture-diagnostic.v1",
        sourceScope: "actual-backend-and-owner-with-all-migrations",
        migrations: migrations.length,
        callerNativeD1Bindings: 0,
        reports,
        limits: [
          seededServices
            ? "synthetic catalog, populated recommendation recovery, fake US/Commons/audio triggers; fresh regional queues"
            : "empty disposable schema",
          "no external services or R2",
          "fixture D1 bookmarks",
          "not managed Worker execution",
          "empty queues do not prove populated business operations",
        ],
        productionAccess: false,
        scheduledOperationsCertified: false,
        releaseCertified: false,
      },
      null,
      2,
    ),
  );
} finally {
  globalThis.fetch = savedFetch;
  delete globalThis.__coveObserveDeniedCronSql;
  Object.assign(console, savedConsole);
  for (const db of databases) db.close();
  rmSync(root, { recursive: true, force: true });
}
