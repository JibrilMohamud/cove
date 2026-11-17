import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
      "src/features/fore/seo.server.ts",
    ],
    outdir: tmp,
    bundle: true,
    platform: "node",
    format: "esm",
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const { verifiedSeoCounts, SEO_COUNT_PROJECTION_SCHEMA } = await import(
    pathToFileURL(path.join(tmp, "seo-count-projection.mjs")).href
  );
  const { handleSeoDocumentRequest } = await import(
    pathToFileURL(path.join(tmp, "seo.server.mjs")).href
  );

  const timestamp = Date.now();
  const generations = {
    ownerVersion: "worker-451",
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
    mustReject("stale " + name, (x) => { x.fence[name] += "-new"; });
  }
  mustReject("owner disabled", (x) => { x.fence.ownerEnabled = false; });
  mustReject("competing writer", (x) => { x.fence.exclusiveWriter = false; });
  mustReject("replica disallowed", (x) => { x.fence.primaryD1 = false; });
  mustReject("dirty publishing", (x) => { x.fence.dirty = true; });
  mustReject("withdrawal pending", (x) => { x.fence.pendingWithdrawals = 1; });
  mustReject("write pending", (x) => { x.fence.pendingWrites = 1; });
  mustReject("missing fence", (x) => { delete x.fence; });
  mustReject("missing generation", (x) => { delete x.fence.rightsGeneration; });
  mustReject("empty generation", (x) => { x.fence.rightsGeneration = ""; });
  mustReject("additional unreviewed field", (x) => { x.snapshot.debug = "unreviewed"; });
  mustReject("extra count field", (x) => { x.snapshot.counts.account_id = 1; });
  mustReject("unknown schema", (x) => { x.snapshot.schema = "v2"; });
  mustReject("negative count", (x) => { x.snapshot.counts.works = -1; });
  mustReject("noninteger count", (x) => { x.snapshot.counts.books = 3.5; });
  mustReject("NaN count", (x) => { x.snapshot.counts.books = NaN; });
  mustReject("string count", (x) => { x.snapshot.counts.books = "2"; });
  mustReject("too old", (x) => { x.snapshot.createdAtMs = timestamp - 60_001; });
  mustReject("expired", (x) => { x.snapshot.expiresAtMs = timestamp; });
  mustReject("future dated", (x) => { x.snapshot.createdAtMs = timestamp + 1; });
  mustReject("unbounded TTL", (x) => { x.snapshot.expiresAtMs = timestamp + 90_000; });

  let sqlCounts = 0;
  let sqlPages = 0;
  const db = {
    prepare(query) {
      if (/COUNT/i.test(query)) sqlCounts++;
      return {
        bind() { return this; },
        async first() { return { n: 42_635 }; },
        async all() {
          sqlPages++;
          return { results: [{ ref: "book-1", updated_at: "2026-11-16T00:00:00Z" }] };
        },
      };
    },
  };
  let proof = clone();
  let reads = 0;
  const load = async () => {
    reads++;
    return structuredClone(proof);
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

  const invalid = await handleSeoDocumentRequest(req("/sitemaps/works/99999.xml"), db, undefined, load);
  assert.equal(invalid.status, 404);
  assert.equal(invalid.headers.get("cache-control"), "no-store");
  assert.equal(sqlPages, 1, "huge invalid OFFSET never reaches SQL");

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
  assert.equal((await handleSeoDocumentRequest(req("/sitemaps/works/2.xml"), db, undefined, load)).status, 404);
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

  console.log("PASS: version-fenced SEO counts fail closed, recheck withdrawals, bypass COUNT and disable CDN caching");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
