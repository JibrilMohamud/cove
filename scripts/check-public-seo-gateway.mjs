import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cove-public-seo-"));
const originalFetch = globalThis.fetch;
try {
  await build({
    entryPoints: [
      "src/lib/persistence-backend.ts",
      "src/lib/public-seo-document-path.ts",
      "src/features/fore/seo.server.ts",
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: temp,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const { proxyPersistenceApi } = await import(path.join(temp, "persistence-backend.mjs"));
  const { isPublicSeoDocumentPath } = await import(path.join(temp, "public-seo-document-path.mjs"));
  const env = {
    FORE_BACKEND_URL: "https://cove-worker.test",
    FORE_BACKEND_TOKEN: "this-test-token-is-at-least-24-chars",
    FORE_PUBLIC_URL: "https://cove.example",
  };
  const allowed = [
    "/robots.txt",
    "/sitemap.xml",
    "/sitemaps/pages.xml",
    "/sitemaps/books.xml",
    "/sitemaps/books/1.xml",
    "/sitemaps/authors/9999.xml",
    "/sitemaps/editions.xml",
    "/sitemaps/works/2.xml",
    "/sitemaps/categories/3.xml",
  ];
  for (const path of allowed) assert.equal(isPublicSeoDocumentPath(path), true, path);
  for (const path of [
    "/",
    "/store",
    "/account",
    "/books/1",
    "/api/fore/catalog",
    "/sitemaps/books/0.xml",
    "/sitemaps/books/100000.xml",
    "/sitemaps/secrets.xml",
    "/sitemaps/private/user.xml",
    "/robots.txt/extra",
  ])
    assert.equal(isPublicSeoDocumentPath(path), false, path);

  let calls = 0;
  let nextStatus = 200;
  let nextHeaders = {};
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(new URL(url).origin, "https://cove-worker.test");
    assert.equal(init.headers.get("x-cove-backend-token"), env.FORE_BACKEND_TOKEN);
    assert.equal(init.redirect, "manual");
    return new Response("<urlset></urlset>", {
      status: nextStatus,
      headers: {
        "content-type": "application/xml",
        "cache-control": "public, max-age=900, stale-while-revalidate=3600",
        ...nextHeaders,
      },
    });
  };

  let result = await proxyPersistenceApi(new Request("https://cove.example/sitemap.xml"), env);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Vercel-CDN-Cache-Control"), "public, s-maxage=900");
  assert.equal(await result.text(), "<urlset></urlset>");
  assert.equal(calls, 1);

  result = await proxyPersistenceApi(new Request("https://cove.example/robots.txt"), env);
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
  result = await proxyPersistenceApi(
    new Request("https://cove.example/sitemaps/books/1.xml", { method: "HEAD" }),
    env,
  );
  assert.equal(result.status, 200);
  assert.equal(result.body, null);
  assert.equal(calls, 3);

  for (const request of [
    new Request("https://cove.example/"),
    new Request("https://cove.example/account"),
    new Request("https://cove.example/api/fore/internal/ingestion/catalog"),
  ])
    assert.equal(await proxyPersistenceApi(request, env), null);
  assert.equal(calls, 3, "Noncrawler routes never enter the public SEO gateway");

  for (const request of [
    new Request("https://cove.example/sitemap.xml?page=1"),
    new Request("https://cove.example/robots.txt", { method: "POST" }),
  ])
    assert.equal((await proxyPersistenceApi(request, env)).status, 404);
  assert.equal(calls, 3, "Mutations and cache-busting query strings never hit D1");

  result = await proxyPersistenceApi(
    new Request("https://cove.example/sitemap.xml", {
      headers: { Cookie: "session=private" },
    }),
    env,
  );
  assert.equal(result.headers.has("Vercel-CDN-Cache-Control"), false);
  nextStatus = 503;
  result = await proxyPersistenceApi(new Request("https://cove.example/sitemap.xml"), env);
  assert.equal(result.status, 503);
  assert.equal(result.headers.has("Vercel-CDN-Cache-Control"), false);

  nextStatus = 200;
  nextHeaders = { "set-cookie": "session=private; HttpOnly" };
  result = await proxyPersistenceApi(new Request("https://cove.example/sitemap.xml"), env);
  assert.equal(result.headers.has("Vercel-CDN-Cache-Control"), false);
  // Unknown sitemap pages must never perform huge OFFSET scans in D1.
  const { handleSeoDocumentRequest } = await import(path.join(temp, "seo.server.mjs"));
  let selectScans = 0;
  const db = {
    prepare(query) {
      return {
        bind() {
          return this;
        },
        async first() {
          assert.match(query, /COUNT/);
          return { n: 42_635 };
        },
        async all() {
          selectScans++;
          return { results: [] };
        },
      };
    },
  };
  const invalid = await handleSeoDocumentRequest(
    new Request("https://cove.example/sitemaps/books/99999.xml"),
    db,
  );
  assert.equal(invalid.status, 404);
  assert.equal(selectScans, 0, "Invalid sitemap pages must not scan a large SQL OFFSET");
  const valid = await handleSeoDocumentRequest(
    new Request("https://cove.example/sitemaps/books/1.xml"),
    db,
  );
  assert.equal(valid.status, 200);
  assert.equal(selectScans, 1);

  console.log("Public crawler-document proxy and privacy/cache safety checks passed.");
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(temp, { recursive: true, force: true });
}
