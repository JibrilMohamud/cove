import assert from "node:assert/strict";
import fs from "node:fs";
import { transform } from "esbuild";

const source = fs.readFileSync("src/lib/public-seo-document-path.ts", "utf8");
const server = fs.readFileSync("src/server.ts", "utf8");
const compiled = await transform(source, { loader: "ts", format: "esm" });
const { isPersistenceGatewayRoute, isPublicSeoDocumentPath } = await import(
  "data:text/javascript;base64," + Buffer.from(compiled.code).toString("base64")
);

for (const path of [
  "/api/fore/catalog",
  "/api/fore/auth/session",
  "/api/fore/internal/ingestion/catalog",
  "/api/fore/storefront/bootstrap",
  "/api/fore/books/123/epub",
  "/robots.txt",
  "/sitemap.xml",
  "/sitemaps/pages.xml",
  "/sitemaps/books.xml",
  "/sitemaps/works/12.xml",
]) {
  assert.ok(isPersistenceGatewayRoute(path), "Gateway route must remain eligible: " + path);
}
for (const path of [
  "/",
  "/store",
  "/search",
  "/books/123",
  "/account",
  "/reader",
  "/api",
  "/api/other",
  "/api/forecast",
  "/favicon.ico",
  "/assets/app.js",
  "/_build/client.js",
  "/sitemaps/books/100000.xml",
]) {
  assert.equal(isPersistenceGatewayRoute(path), false, "Must not import gateway on " + path);
}
assert.equal(isPublicSeoDocumentPath("/robots.txt"), true);
assert.ok(
  !server.includes('import { handleVercelIngestionControl, proxyPersistenceApi } from "./lib/persistence-backend"'),
  "Top-level SSR must not eagerly import persistence API routing",
);
assert.match(server, /if \(isPersistenceGatewayRoute\(gatewayPath\)\)/);
assert.match(server, /await import\("\.\/lib\/persistence-backend"\)/);
assert.match(server, /await handleVercelIngestionControl\(request, foreEnv\)/);
assert.match(server, /await proxyPersistenceApi\(request, foreEnv\)/);
console.log("SSR gateway route coverage: anonymous HTML bypass; API, ingestion and SEO preserved PASS");
