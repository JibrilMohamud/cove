import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

/** Entire test runs on local synthetic fixtures. No Cloudflare/Stripe/real D1. */
const tmp = mkdtempSync(path.join(tmpdir(), "cove-seo-fenced-"));
try {
  await build({
    entryPoints: [
      "src/features/fore/seo-count-projection.ts",
      "src/features/fore/seo-count-projection-producer.ts",
      "src/features/fore/seo.server.ts",
    ],
    outdir: tmp,
    bundle: true,
    platform: "node",
    format: "esm",
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const { verifiedSeoCounts, verifiedSeoCountsForServing, SEO_COUNT_PROJECTION_SCHEMA } =
    await import(pathToFileURL(path.join(tmp, "seo-count-projection.mjs")).href);
  const { handleSeoDocumentRequest } = await import(
    pathToFileURL(path.join(tmp, "seo.server.mjs")).href
  );
  const { buildSeoCountProjection } = await import(
    pathToFileURL(path.join(tmp, "seo-count-projection-producer.mjs")).href
  );

  const timestamp = Date.now();
  const generations = {
    ownerVersion: "worker-451",
    ownerDenialEpoch: "0",
    catalogGeneration: "catalog-99",
    rightsGeneration: "rights-18",
    withdrawalGeneration: "withdrawal-12",
    taxonomyGeneration: "tax-5",
    contributorGeneration: "contributors-11",
  };
  const base = {
    snapshot: {
      schema: SEO_COUNT_PROJECTION_SCHEMA,
      ...generations,
      createdAtMs: timestamp - 500,
      expiresAtMs: timestamp + 30_000,
      eligibilityValidUntilMs: timestamp + 45_000,
      counts: { books: 40_100, works: 20_001, editions: 40_040, authors: 2_001, categories: 73 },
    },
    fence: {
      ...generations,
      ownerEnabled: true,
      exclusiveWriter: true,
      primaryD1: true,
      dirty: false,
      pendingWithdrawals: 0,
      pendingWrites: 0,
      eligibilityValidUntilMs: timestamp + 45_000,
    },
  };
  const clone = () => structuredClone(base);
  const mustReject = (reason, apply) => {
    const bad = clone();
    apply(bad);
    assert.equal(verifiedSeoCounts(bad, timestamp), null, reason);
  };
  assert.equal(verifiedSeoCounts(clone(), timestamp).works, 20_001);
  for (const name of Object.keys(generations)) {
    mustReject("stale " + name, (x) => {
      x.fence[name] += "-new";
    });
  }
  mustReject("owner disabled", (x) => {
    x.fence.ownerEnabled = false;
  });
  mustReject("competing writer", (x) => {
    x.fence.exclusiveWriter = false;
  });
  mustReject("replica disallowed", (x) => {
    x.fence.primaryD1 = false;
  });
  mustReject("dirty publishing", (x) => {
    x.fence.dirty = true;
  });
  mustReject("withdrawal pending", (x) => {
    x.fence.pendingWithdrawals = 1;
  });
  mustReject("write pending", (x) => {
    x.fence.pendingWrites = 1;
  });
  mustReject("missing fence", (x) => {
    delete x.fence;
  });
  mustReject("missing generation", (x) => {
    delete x.fence.rightsGeneration;
  });
  mustReject("empty generation", (x) => {
    x.fence.rightsGeneration = "";
  });
  mustReject("additional unreviewed field", (x) => {
    x.snapshot.debug = "unreviewed";
  });
  mustReject("extra count field", (x) => {
    x.snapshot.counts.account_id = 1;
  });
  mustReject("unknown schema", (x) => {
    x.snapshot.schema = "v2";
  });
  mustReject("negative count", (x) => {
    x.snapshot.counts.works = -1;
  });
  mustReject("noninteger count", (x) => {
    x.snapshot.counts.books = 3.5;
  });
  mustReject("NaN count", (x) => {
    x.snapshot.counts.books = NaN;
  });
  mustReject("string count", (x) => {
    x.snapshot.counts.books = "2";
  });
  mustReject("too old", (x) => {
    x.snapshot.createdAtMs = timestamp - 60_001;
  });
  mustReject("expired", (x) => {
    x.snapshot.expiresAtMs = timestamp;
  });
  mustReject("future dated", (x) => {
    x.snapshot.createdAtMs = timestamp + 1;
  });
  mustReject("unbounded TTL", (x) => {
    x.snapshot.expiresAtMs = timestamp + 90_000;
  });
  // A rights grant or territorial window can expire with no D1 mutation.
  // A still-current generation must not override the owner's time boundary.
  mustReject("missing expiry review", (x) => {
    delete x.fence.eligibilityValidUntilMs;
  });
  mustReject("missing snapshot expiry review", (x) => {
    delete x.snapshot.eligibilityValidUntilMs;
  });
  mustReject("mismatched expiry review", (x) => {
    x.fence.eligibilityValidUntilMs += 1;
  });
  mustReject("rights expire before XML", (x) => {
    x.fence.eligibilityValidUntilMs = timestamp + 20_000;
    x.snapshot.eligibilityValidUntilMs = timestamp + 20_000;
  });
  mustReject("expiry review has elapsed", (x) => {
    x.fence.eligibilityValidUntilMs = timestamp;
    x.snapshot.eligibilityValidUntilMs = timestamp;
  });
  mustReject("expiry review is untrusted string", (x) => {
    x.fence.eligibilityValidUntilMs = String(timestamp + 45_000);
    x.snapshot.eligibilityValidUntilMs = String(timestamp + 45_000);
  });

  let sqlCounts = 0;
  let sqlPages = 0;
  let denyDuringPage = false;
  const db = {
    prepare(query) {
      if (/COUNT/i.test(query)) sqlCounts++;
      return {
        bind() {
          return this;
        },
        async first() {
          return { n: 42_635 };
        },
        async all() {
          sqlPages++;
          if (denyDuringPage) {
            // Durable owner denies WHILE an expensive OFFSET page is in flight.
            ownerEpoch = "2";
            denyDuringPage = false;
          }
          return { results: [{ ref: "book-1", updated_at: "2026-11-16T00:00:00Z" }] };
        },
      };
    },
  };
  let proof = clone();
  let reads = 0;
  let ownerEpoch = "0";
  const load = async () => {
    reads++;
    // The proof is modeled as a separate strongly consistent DO read
    // AFTER the primary-D1 snapshot. Never derive it from the D1 fence.
    return {
      ...structuredClone(proof),
      ownerDenialProof: {
        schema: "cove.seo.owner-denial-epoch.v1",
        ownerVersion: proof.fence.ownerVersion,
        denialEpoch: ownerEpoch,
        authority: "canonical-legal-durable-object",
      },
    };
  };
  const req = (url, method) => new Request("https://covereads.com" + url, { method });

  const root = await handleSeoDocumentRequest(req("/sitemap.xml"), db, undefined, load);
  assert.equal(root.status, 200);
  assert.equal(root.headers.get("cache-control"), "no-store");
  assert.equal(root.headers.get("Vercel-CDN-Cache-Control"), null);
  const rootXml = await root.text();
  assert.match(rootXml, /\/sitemaps\/works\/2\.xml/);
  assert.match(rootXml, /\/sitemaps\/books\/3\.xml/);
  assert.equal(reads, 1, "one primary-D1 fence read for five sitemap counts");
  assert.equal(sqlCounts, 0, "valid snapshot avoids full-catalog COUNT queries");

  const page2 = await handleSeoDocumentRequest(req("/sitemaps/works/2.xml"), db, undefined, load);
  assert.equal(page2.status, 200);
  assert.equal(page2.headers.get("cache-control"), "no-store");
  assert.match(await page2.text(), /\/work\/book-1/);
  assert.equal(sqlPages, 1, "live page SELECT remains necessary; counts do not authorize URLs");
  assert.equal(sqlCounts, 0);

  // The first owner proof can be valid, then a deny arrives during the
  // page SQL itself. The final private owner read must veto the XML body.
  const pageReadsBefore = reads;
  denyDuringPage = true;
  const duringPage = await handleSeoDocumentRequest(
    req("/sitemaps/works/2.xml"),
    db,
    undefined,
    load,
  );
  assert.equal(duringPage.status, 503);
  assert.equal(duringPage.headers.get("cache-control"), "no-store");
  assert.equal(reads, pageReadsBefore + 2, "page must recheck owner after SQL");
  assert.doesNotMatch(await duringPage.text(), /book-1|sitemaps\/works/);
  ownerEpoch = "0";

  // A clock-only transition need not change any SQL generation or DO epoch.
  // A newly published snapshot must never renew an in-flight page's OLD
  // authorization window, even when the latest evidence is independently valid.
  const realNow = Date.now;
  try {
    for (const method of ["GET", "HEAD"]) {
      for (const transition of ["expired-horizon", "expired-snapshot", "changed-horizon"]) {
        let clock = timestamp;
        Date.now = () => clock;
        const initial = await load();
        initial.snapshot.expiresAtMs = timestamp + 1_000;
        if (transition === "expired-horizon") {
          initial.snapshot.eligibilityValidUntilMs = timestamp + 1_000;
          initial.fence.eligibilityValidUntilMs = timestamp + 1_000;
        }
        const latest = structuredClone(initial);
        let windowReads = 0;
        const windowLoader = async () => {
          windowReads++;
          return structuredClone(windowReads === 1 ? initial : latest);
        };
        const expiringDb = {
          prepare(query) {
            assert.doesNotMatch(query, /COUNT/i, "expiry race must not fall back to COUNT");
            return {
              bind() {
                return this;
              },
              async all() {
                clock = timestamp + (transition === "changed-horizon" ? 500 : 1_000);
                latest.snapshot.createdAtMs = clock;
                latest.snapshot.expiresAtMs = clock + 30_000;
                if (transition !== "expired-snapshot") {
                  latest.snapshot.eligibilityValidUntilMs = timestamp + 40_000;
                  latest.fence.eligibilityValidUntilMs = timestamp + 40_000;
                }
                assert.ok(verifiedSeoCountsForServing(latest, clock), "renewed proof is valid");
                return { results: [{ ref: "expired-book", updated_at: "2026-11-16" }] };
              },
            };
          },
        };
        const result = await handleSeoDocumentRequest(
          req("/sitemaps/works/1.xml", method),
          expiringDb,
          undefined,
          windowLoader,
        );
        assert.equal(
          result.status,
          503,
          method + " must reject " + transition + " during page SQL",
        );
        assert.equal(result.headers.get("cache-control"), "no-store");
        assert.doesNotMatch(await result.text(), /expired-book/);
      }
      for (const document of ["/sitemap.xml", "/sitemaps/works.xml"]) {
        let clockReads = 0;
        Date.now = () => timestamp + (clockReads++ === 0 ? 0 : 1_000);
        const initial = await load();
        initial.snapshot.expiresAtMs = timestamp + 1_000;
        const result = await handleSeoDocumentRequest(
          req(document, method),
          db,
          undefined,
          async () => structuredClone(initial),
        );
        assert.equal(result.status, 503, document + " must recheck original expiry before release");
        assert.equal(result.headers.get("cache-control"), "no-store");
        assert.doesNotMatch(await result.text(), /sitemapindex/);
      }
    }
  } finally {
    Date.now = realNow;
  }

  const invalid = await handleSeoDocumentRequest(
    req("/sitemaps/works/99999.xml"),
    db,
    undefined,
    load,
  );
  assert.equal(invalid.status, 404);
  assert.equal(invalid.headers.get("cache-control"), "no-store");
  assert.equal(sqlPages, 2, "huge invalid OFFSET never reaches SQL");

  // Deny-first race: the owner DO has acknowledged a new denial but the
  // corresponding D1 rights mutation has NOT committed yet. Its D1 epoch
  // still looks current; the independent owner evidence must reject it.
  ownerEpoch = "1";
  const denyBeforeD1 = await handleSeoDocumentRequest(req("/sitemap.xml"), db, undefined, load);
  assert.equal(denyBeforeD1.status, 503);
  assert.equal(denyBeforeD1.headers.get("cache-control"), "no-store");
  assert.equal(sqlCounts, 0, "DO denial gap must not trigger SQL fallback");
  const ownerAdvanced = await load();
  assert.equal(verifiedSeoCountsForServing(ownerAdvanced, timestamp), null);
  assert.equal(
    verifiedSeoCounts(ownerAdvanced, timestamp).works,
    20_001,
    "D1-only comparison is insufficient while DO denial is ahead",
  );
  ownerEpoch = "0";

  // Forged, malformed, missing or wrong-owner proof must fail closed.
  const evidence = await load();
  for (const mutation of [
    (x) => {
      delete x.ownerDenialProof;
    },
    (x) => {
      x.ownerDenialProof.denialEpoch = "000";
    },
    (x) => {
      x.ownerDenialProof.denialEpoch = "1";
    },
    (x) => {
      x.ownerDenialProof.ownerVersion = "other-owner";
    },
    (x) => {
      x.ownerDenialProof.schema = "unknown";
    },
    (x) => {
      x.ownerDenialProof.authority = "client-header";
    },
    (x) => {
      x.ownerDenialProof.arbitrary = "extra";
    },
  ]) {
    const altered = structuredClone(evidence);
    mutation(altered);
    assert.equal(verifiedSeoCountsForServing(altered, timestamp), null);
  }

  // A withdrawal invalidates the old snapshot immediately at the primary fence.
  proof.fence.withdrawalGeneration = "withdrawal-13";
  const withdrawn = await handleSeoDocumentRequest(req("/sitemap.xml"), db, undefined, load);
  assert.equal(withdrawn.status, 503);
  assert.equal(withdrawn.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await withdrawn.text(), /book-1|sitemaps\/works/);
  assert.equal(sqlCounts, 0, "mismatch must NOT fall back to expensive SQL");

  // Canonical owner publishes a matching new snapshot *after* its write;
  // the second works page disappears immediately without cached response.
  proof.snapshot.withdrawalGeneration = "withdrawal-13";
  proof.snapshot.counts.works = 20_000;
  const refreshed = await handleSeoDocumentRequest(req("/sitemap.xml"), db, undefined, load);
  assert.equal(refreshed.status, 200);
  assert.doesNotMatch(await refreshed.text(), /\/sitemaps\/works\/2\.xml/);
  assert.equal(
    (await handleSeoDocumentRequest(req("/sitemaps/works/2.xml"), db, undefined, load)).status,
    404,
  );
  assert.equal(sqlCounts, 0);

  // Missing/failed read authorization is never treated like a cache miss.
  const throwing = await handleSeoDocumentRequest(req("/sitemap.xml"), db, undefined, async () => {
    throw new Error("read unavailable: sensitive detail must be suppressed");
  });
  assert.equal(throwing.status, 503);
  assert.doesNotMatch(await throwing.text(), /sensitive/);
  assert.equal(throwing.headers.get("cache-control"), "no-store");

  const head = await handleSeoDocumentRequest(req("/sitemap.xml", "HEAD"), db, undefined, load);
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(head.headers.get("cache-control"), "no-store");

  const robots = await handleSeoDocumentRequest(req("/robots.txt"), db, undefined, async () => {
    throw Error("robots is static and must not require authorization");
  });
  assert.equal(robots.status, 200);

  // The old unconfigured production path remains untouched until approved.
  const legacy = await handleSeoDocumentRequest(req("/sitemap.xml"), db);
  assert.equal(legacy.status, 200);
  assert.equal(sqlCounts, 5, "legacy still issues five full-catalog counts");
  assert.match(legacy.headers.get("cache-control"), /public/);

  // Production-safe publication is an explicit, externally implemented
  // atomic CAS interface, not an automatically enabled D1 or cron writer.
  const originalFence = () => structuredClone(base.fence);
  let currentFence = originalFence();
  let published = null;
  let readsForBuild = 0;
  let countCalls = 0;
  let casCalls = 0;
  const basePort = {
    nowMs: () => timestamp,
    readPrimaryFence: async () => {
      readsForBuild++;
      return structuredClone(currentFence);
    },
    countAuthoritative: async (kind) => {
      countCalls++;
      return base.snapshot.counts[kind];
    },
    compareAndPublish: async (expected, candidate) => {
      casCalls++;
      if (JSON.stringify(expected) !== JSON.stringify(currentFence)) return false;
      published = structuredClone(candidate);
      return true;
    },
  };
  const success = await buildSeoCountProjection(basePort);
  assert.deepEqual(success, { published: true, reason: "published" });
  assert.equal(readsForBuild, 2);
  assert.equal(countCalls, 5);
  assert.equal(casCalls, 1);
  assert.equal(published.eligibilityValidUntilMs, timestamp + 45_000);
  assert.equal(
    verifiedSeoCounts({ snapshot: published, fence: currentFence }, timestamp).works,
    20_001,
  );

  currentFence = originalFence();
  countCalls = 0;
  casCalls = 0;
  const midCountWithdrawal = await buildSeoCountProjection({
    ...basePort,
    countAuthoritative: async (kind) => {
      countCalls++;
      if (kind === "works") currentFence.withdrawalGeneration = "withdrawal-13";
      return base.snapshot.counts[kind];
    },
  });
  assert.deepEqual(midCountWithdrawal, { published: false, reason: "changed-during-count" });
  assert.equal(countCalls, 5);
  assert.equal(casCalls, 0, "no stale snapshot can reach the publisher");

  currentFence = originalFence();
  const lateWithdrawal = await buildSeoCountProjection({
    ...basePort,
    compareAndPublish: async (expected, candidate) => {
      casCalls++;
      currentFence.withdrawalGeneration = "withdrawal-14";
      assert.equal(
        verifiedSeoCounts({ snapshot: candidate, fence: currentFence }, timestamp),
        null,
      );
      return false; // the production adapter MUST enforce atomic CAS in D1
    },
  });
  assert.deepEqual(lateWithdrawal, { published: false, reason: "publish-lost-race" });

  // Future legal expiry is an independent clock transition. The producer
  // caps its new snapshot to that boundary, not an unconditional 60 seconds.
  currentFence = originalFence();
  currentFence.eligibilityValidUntilMs = timestamp + 5_000;
  let expiryPublished = null;
  assert.deepEqual(
    await buildSeoCountProjection({
      ...basePort,
      compareAndPublish: async (_expected, candidate) => {
        expiryPublished = candidate;
        return true;
      },
    }),
    { published: true, reason: "published" },
  );
  assert.equal(expiryPublished.expiresAtMs, timestamp + 5_000);
  assert.equal(
    verifiedSeoCounts({ snapshot: expiryPublished, fence: currentFence }, timestamp).works,
    20_001,
  );
  assert.equal(
    verifiedSeoCounts({ snapshot: expiryPublished, fence: currentFence }, timestamp + 5_000),
    null,
  );
  currentFence.eligibilityValidUntilMs = timestamp;
  assert.deepEqual(await buildSeoCountProjection(basePort), {
    published: false,
    reason: "unsafe-start",
  });
  currentFence = originalFence();
  currentFence.pendingWithdrawals = 1;
  countCalls = 0;
  assert.deepEqual(await buildSeoCountProjection(basePort), {
    published: false,
    reason: "unsafe-start",
  });
  assert.equal(countCalls, 0, "unsafe primary fence must skip all heavy COUNTs");

  currentFence = originalFence();
  casCalls = 0;
  assert.deepEqual(
    await buildSeoCountProjection({
      ...basePort,
      countAuthoritative: async () => -1,
    }),
    { published: false, reason: "invalid-count" },
  );
  assert.equal(casCalls, 0);

  assert.deepEqual(
    await buildSeoCountProjection({
      ...basePort,
      readPrimaryFence: async () => {
        throw Error("sensitive transport failure");
      },
    }),
    { published: false, reason: "unavailable" },
  );

  // The builder must match EVERY current SQL count exactly, not an inferred
  // catalog total. The works query intentionally differs from books: legacy
  // works-count does not filter edition.release_status. Preserve behavior.
  const sql = {
    books:
      "SELECT COUNT(*) n FROM products p JOIN editions e ON e.id=p.edition_id WHERE p.storefront_status='active' AND p.source_name<>'upload' AND e.release_status IN ('available','preorder')",
    works:
      "SELECT COUNT(DISTINCT w.id) n FROM works w JOIN editions e ON e.work_id=w.id JOIN products p ON p.edition_id=e.id WHERE p.storefront_status='active' AND p.source_name<>'upload' AND w.canonical_status<>'redirected'",
    editions:
      "SELECT COUNT(DISTINCT e.id) n FROM editions e JOIN products p ON p.edition_id=e.id WHERE p.storefront_status='active' AND p.source_name<>'upload' AND e.release_status IN ('available','preorder')",
    authors:
      "SELECT COUNT(DISTINCT c.id) n FROM contributors c JOIN edition_contributors ec ON ec.contributor_id=c.id AND ec.role='author' JOIN editions e ON e.id=ec.edition_id JOIN products p ON p.edition_id=e.id WHERE p.storefront_status='active' AND p.source_name<>'upload' AND e.release_status IN ('available','preorder')",
    categories:
      "SELECT COUNT(*) n FROM storefront_taxonomy_nodes n JOIN storefront_taxonomies t ON t.id=n.taxonomy_id WHERE t.is_default=1 AND t.status='active' AND n.visible=1",
  };
  const actualSeoSource = readFileSync("src/features/fore/seo.server.ts", "utf8");
  for (const kind of ["books", "works", "editions", "authors", "categories"]) {
    assert.ok(
      actualSeoSource.includes(sql[kind]),
      "live sitemap count changed without reviewed projection parity: " + kind,
    );
  }
  const catalogDb = new DatabaseSync(":memory:");
  try {
    catalogDb.exec(
      [
        "CREATE TABLE works (id TEXT PRIMARY KEY, canonical_status TEXT);",
        "CREATE TABLE editions (id TEXT PRIMARY KEY, work_id TEXT, release_status TEXT);",
        "CREATE TABLE products (id TEXT PRIMARY KEY, edition_id TEXT, storefront_status TEXT, source_name TEXT);",
        "CREATE TABLE contributors (id TEXT PRIMARY KEY);",
        "CREATE TABLE edition_contributors (edition_id TEXT, contributor_id TEXT, role TEXT);",
        "CREATE TABLE storefront_taxonomies (id TEXT PRIMARY KEY, is_default INTEGER, status TEXT);",
        "CREATE TABLE storefront_taxonomy_nodes (id TEXT PRIMARY KEY, taxonomy_id TEXT, visible INTEGER);",
        "INSERT INTO works VALUES ('w1','canonical'),('w2','redirected'),('w3','canonical');",
        "INSERT INTO editions VALUES ('e1','w1','available'),('e2','w1','preorder'),('e3','w2','available'),('e4','w3','unavailable');",
        "INSERT INTO products VALUES ('p1','e1','active','gutenberg'),('p2','e2','active','publisher-api'),('p3','e3','active','gutenberg'),('p4','e4','active','gutenberg'),('p5','e1','active','upload');",
        "INSERT INTO contributors VALUES ('c1'),('c2');",
        "INSERT INTO edition_contributors VALUES ('e1','c1','author'),('e2','c1','author'),('e3','c2','author'),('e2','c2','editor');",
        "INSERT INTO storefront_taxonomies VALUES ('tax1',1,'active'),('tax2',0,'active');",
        "INSERT INTO storefront_taxonomy_nodes VALUES ('n1','tax1',1),('n2','tax1',0),('n3','tax2',1);",
        "CREATE INDEX idx_editions_work ON editions(work_id);",
        "CREATE INDEX idx_products_edition ON products(edition_id);",
      ].join("\n"),
    );
    const actualCount = (kind) => Number(catalogDb.prepare(sql[kind]).get().n);
    const fixtureCounts = () =>
      Object.fromEntries(Object.keys(sql).map((kind) => [kind, actualCount(kind)]));
    assert.deepEqual(
      fixtureCounts(),
      {
        books: 3,
        works: 2,
        editions: 3,
        authors: 2,
        categories: 1,
      },
      "synthetic catalog fixture must retain distinct edition/work/author semantics",
    );

    let fence = originalFence();
    let projection = null;
    const sqlPort = {
      nowMs: () => timestamp,
      readPrimaryFence: async () => structuredClone(fence),
      countAuthoritative: async (kind) => actualCount(kind),
      compareAndPublish: async (expected, snapshot) => {
        if (JSON.stringify(expected) !== JSON.stringify(fence)) return false;
        projection = structuredClone(snapshot);
        return true;
      },
    };
    assert.equal((await buildSeoCountProjection(sqlPort)).published, true);
    assert.deepEqual(projection.counts, fixtureCounts());
    assert.ok(verifiedSeoCounts({ snapshot: projection, fence }, timestamp));

    // Change publication status under a new canonical owner generation.
    // Previously published counts become invalid BEFORE recomputation.
    catalogDb.exec("UPDATE products SET storefront_status='inactive' WHERE id IN ('p1','p2')");
    fence.catalogGeneration = "catalog-100";
    assert.equal(verifiedSeoCounts({ snapshot: projection, fence }, timestamp), null);
    assert.deepEqual(
      fixtureCounts(),
      {
        books: 1,
        works: 1,
        editions: 1,
        authors: 1,
        categories: 1,
      },
      "published-work and contributor counts must track active products exactly",
    );
    assert.equal((await buildSeoCountProjection(sqlPort)).published, true);
    assert.deepEqual(projection.counts, fixtureCounts());
    assert.ok(verifiedSeoCounts({ snapshot: projection, fence }, timestamp));
  } finally {
    catalogDb.close();
  }

  console.log(
    "PASS: version-fenced SEO counts fail closed, recheck withdrawals, bypass COUNT and disable CDN caching, enforce exact SQL count parity and prevent stale snapshot publication",
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
