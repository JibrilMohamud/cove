// Real engine acceptance on isolated synthetic SQLite. This does not certify Cloudflare latency.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { localBindings } from "./local-api.mjs";
import { offeredLoad } from "./performance/offered-load.mjs";
const binary = process.env.COVE_MEILISEARCH_BINARY;
assert.ok(binary, "Set COVE_MEILISEARCH_BINARY to a verified real Meilisearch executable");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-real-search-")),
  key = randomBytes(32).toString("hex");
let child;
const originalFetch = globalThis.fetch;
try {
  const log = fs.openSync(path.join(root, "engine.log"), "a");
  child = spawn(
    binary,
    [
      "--http-addr",
      "127.0.0.1:7700",
      "--env",
      "production",
      "--no-analytics",
      "--db-path",
      path.join(root, "meili-data"),
    ],
    { env: { ...process.env, MEILI_MASTER_KEY: key }, stdio: ["ignore", log, log] },
  );
  const origin = "http://127.0.0.1:7700";
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null)
      throw Error(
        "Real engine exited before readiness: " +
          fs.readFileSync(path.join(root, "engine.log"), "utf8").slice(-1500),
      );
    try {
      if ((await fetch(origin + "/health")).ok) {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(healthy, "Real Meilisearch must become ready");
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: ["src/features/fore/search.server.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: path.join(root, "search.mjs"),
    logLevel: "silent",
  });
  const search = await import(path.join(root, "search.mjs"));
  const raw = localBindings(root);
  const generated = spawnSync(
    process.execPath,
    ["scripts/performance/generate-synthetic-d1-fixture.mjs", path.join(root, "fixture")],
    { env: { ...process.env, COVE_SYNTHETIC_BOOKS: "50000" }, encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const sqlite = new DatabaseSync(path.join(root, ".sites-runtime/fore.sqlite"));
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const f of fs
    .readdirSync(path.join(root, "fixture"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(fs.readFileSync(path.join(root, "fixture", f), "utf8"));
  const a = "perf-synth-000001",
    b = "perf-synth-000002",
    c = "perf-synth-000003";
  for (const [id, title] of [
    [a, "Quasar Drift"],
    [b, "Quasar Journey"],
    [c, "Ocean Solitude"],
  ]) {
    sqlite
      .prepare("UPDATE catalog_search_documents SET title=?,title_sort=? WHERE product_id=?")
      .run(title, title.toLowerCase(), id);
    sqlite
      .prepare("UPDATE editions SET title=? WHERE id=(SELECT edition_id FROM products WHERE id=?)")
      .run(title, id);
  }
  let binds = 0,
    serving = false;
  const servingSql = [];
  function statement(sql, wrapped) {
    return new Proxy(wrapped, {
      get(target, k) {
        const v = target[k];
        if (k === "bind")
          return (...args) => {
            binds = Math.max(binds, args.length);
            assert.ok(args.length <= 100, `D1 bind budget exceeded: ${args.length}`);
            return statement(sql, v.apply(target, args));
          };
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }
  const db = {
    ...raw.DB,
    prepare(sql) {
      if (serving) servingSql.push(sql);
      return statement(sql, raw.DB.prepare(sql));
    },
  };
  const env = {
    DB: db,
    FORE_SEARCH_BACKEND: "meilisearch",
    FORE_SEARCH_FALLBACK: "disabled",
    FORE_SEARCH_URL: origin,
    FORE_SEARCH_SEARCH_KEY: key,
    FORE_SEARCH_ADMIN_KEY: key,
    FORE_SEARCH_INDEX: "cove-acceptance-" + randomUUID(),
  };
  let indexed = await search.rebuildSearchIndex(env, 500),
    iterations = 1;
  while (indexed.pending > 0) {
    assert.ok(iterations++ < 110, "Indexing backlog must drain");
    indexed = await search.syncSearchIndex(env, 500);
  }
  const stats = await (
    await fetch(`${origin}/indexes/${env.FORE_SEARCH_INDEX}/stats`, {
      headers: { authorization: `Bearer ${key}` },
    })
  ).json();
  const eligibleDocuments = sqlite
    .prepare(
      "SELECT COUNT(*) n FROM catalog_search_documents d JOIN products p ON p.id=d.product_id WHERE d.suppressed=0 AND p.storefront_status='active' AND p.source_name<>'upload'",
    )
    .get().n;
  assert.equal(
    stats.numberOfDocuments,
    eligibleDocuments,
    "Real engine must hold exactly the eligible source projection",
  );
  assert.ok(eligibleDocuments > 49000);
  const input = (q) => search.parseSearchInput(new URL("http://test/api/fore/catalog?" + q));
  serving = true;
  const result = await search.searchCatalog(env, input("q=Quasar+Drift&territory=US"), null, {
    analytics: false,
  });
  assert.equal(result.backend, "meilisearch");
  assert.equal(result.books[0].productId, a, "Exact title must rank first");
  const all = await search.searchCatalog(env, input("q=Quasar&territory=US"), null, {
    analytics: false,
  });
  assert.ok(all.books.some((x) => x.productId === a) && all.books.some((x) => x.productId === b));
  assert.ok(
    all.facets.languages.length > 0 && all.facets.formats.length > 0,
    "Real engine returns facets",
  );
  const en = await search.searchCatalog(env, input("q=Quasar&language=en&territory=US"), null, {
    analytics: false,
  });
  assert.ok(en.books.length > 0);
  const absent = await search.searchCatalog(env, input("q=Quasar&language=zz&territory=US"), null, {
    analytics: false,
  });
  assert.equal(absent.books.length, 0);
  assert.ok(
    absent.facets.languages.some((x) => x.value === "en"),
    "Disjunctive language facets exclude their own active filter",
  );
  const ca = await search.searchCatalog(env, { ...input("q=Quasar"), territory: "CA" }, null, {
    analytics: false,
  });
  assert.ok(
    ca.books.every((x) => x.productId !== a),
    "US-only license cannot leak to Canada",
  );
  // Do not synchronize the index after the legal change: this specifically tests stale-index safety.
  sqlite
    .prepare(
      "UPDATE rights_grants SET status='revoked' WHERE edition_id=(SELECT edition_id FROM products WHERE id=?) AND territory_code='US'",
    )
    .run(a);
  const revoked = await search.searchCatalog(env, input("q=Quasar+Drift&territory=US"), null, {
    analytics: false,
  });
  assert.ok(
    revoked.books.every((x) => x.productId !== a),
    "Primary revocation overrides the real stale index",
  );
  serving = false;
  sqlite
    .prepare(
      "UPDATE catalog_search_documents SET title='Nebula Passage',title_sort='nebula passage' WHERE product_id=?",
    )
    .run(b);
  await search.syncSearchIndex(env, 500);
  serving = true;
  const updated = await search.searchCatalog(env, input("q=Nebula+Passage&territory=US"), null, {
    analytics: false,
  });
  assert.ok(
    updated.books.some((x) => x.productId === b),
    "Incremental title changes reach real index",
  );
  serving = false;
  sqlite.prepare("UPDATE catalog_search_documents SET suppressed=1 WHERE product_id=?").run(b);
  await search.syncSearchIndex(env, 500);
  serving = true;
  const removed = await search.searchCatalog(env, input("q=Nebula+Passage&territory=US"), null, {
    analytics: false,
  });
  assert.ok(
    removed.books.every((x) => x.productId !== b),
    "Suppression removes an indexed document",
  );
  const load = [];
  for (const rps of [10, 25]) {
    const phase = await offeredLoad({
      rps,
      durationMs: 5000,
      request: async () => {
        const start = performance.now();
        try {
          const r = await search.searchCatalog(env, input("q=Ocean+Solitude&territory=US"), null, {
            analytics: false,
          });
          return {
            valid: r.backend === "meilisearch" && r.books.some((x) => x.productId === c),
            ttfbMs: performance.now() - start,
          };
        } catch {
          return { valid: false, failure: "search-error" };
        }
      },
    });
    assert.ok(phase.summary.allValid, "Every offered real-engine diagnostic request must succeed");
    load.push({ rps, ...phase.summary });
  }
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(origin)) throw Error("injected real-engine outage");
    return originalFetch(url, init);
  };
  await assert.rejects(
    search.searchCatalog(env, input("q=Ocean+Solitude&territory=US"), null, { analytics: false }),
    /temporarily unavailable/,
  );
  assert.ok(
    !servingSql.some((sql) => /\b(catalog_search_fts|book_search_fts)\b/i.test(sql)),
    "Serving/outage must never run primary FTS fallback",
  );
  fs.mkdirSync("artifacts/real-meilisearch", { recursive: true });
  fs.writeFileSync(
    "artifacts/real-meilisearch/results.json",
    JSON.stringify(
      {
        sha: process.env.GITHUB_SHA,
        realEngine: true,
        fixtureBooks: 50000,
        largestBind: binds,
        load,
        cloudflareCapacityCertified: false,
        releaseApproved: false,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ realEngine: true, fixtureBooks: 50000, largestBind: binds, load }));
  console.log(
    "PASS: real 50k index, exact-title relevance, filters, disjunctive facets, incremental updates, suppression, live rights after revocation, offered-load accounting and outage isolation",
  );
  sqlite.close();
} finally {
  globalThis.fetch = originalFetch;
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((r) => {
      child.once("exit", r);
      setTimeout(r, 3000);
    });
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  fs.rmSync(root, { recursive: true, force: true });
}
