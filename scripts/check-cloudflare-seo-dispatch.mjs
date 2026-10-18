import assert from "node:assert/strict";
import fs from "node:fs";
import { build } from "esbuild";

const built = await build({
  stdin: {
    contents: fs.readFileSync("src/lib/public-seo-document-path.ts", "utf8"),
    loader: "ts",
    resolveDir: process.cwd(),
    sourcefile: "public-seo-document-path.ts",
  },
  bundle: true,
  write: false,
  platform: "neutral",
  format: "esm",
  logLevel: "silent",
});
const { isSeoDocumentDispatchCandidate } = await import(
  "data:text/javascript;base64," + Buffer.from(built.outputFiles[0].contents).toString("base64")
);

for (const method of ["GET", "HEAD"]) {
  for (const path of [
    "/robots.txt",
    "/sitemap.xml",
    "/sitemaps/pages.xml",
    "/sitemaps/books.xml",
    "/sitemaps/books/1.xml",
    "/sitemaps/authors/999999.xml",
    "/sitemaps/malformed",
  ])
    assert.equal(isSeoDocumentDispatchCandidate(method, path), true, `${method} ${path}`);
  for (const path of [
    "/",
    "/store",
    "/books/123",
    "/search",
    "/api/fore/health/ready",
    "/api/fore/storefront/bootstrap",
    "/account",
    "/checkout",
    "/sitemap.xml/invalid",
    "/robots.txt/invalid",
  ])
    assert.equal(isSeoDocumentDispatchCandidate(method, path), false, `${method} ${path}`);
}
for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
  assert.equal(isSeoDocumentDispatchCandidate(method, "/sitemap.xml"), false);
  assert.equal(isSeoDocumentDispatchCandidate(method, "/sitemaps/books/1.xml"), false);
}
assert.match(
  fs.readFileSync("src/server.ts", "utf8"),
  /foreEnv\.DB\s*&&\s*isSeoDocumentDispatchCandidate\(request\.method,\s*new URL\(request\.url\)\.pathname\)/,
  "Cloudflare Worker entry must use the SEO dispatch guard before dynamically importing",
);
console.log("Cold SSR skips SEO module; crawler endpoints and HTTP methods retained: PASS");
