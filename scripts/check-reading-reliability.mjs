import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { build } from "esbuild";
import { localBindings } from "./local-api.mjs";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-reading-reliability-"));
const fetchBefore = globalThis.fetch;
try {
  fs.cpSync("drizzle", path.join(root, "drizzle"), { recursive: true });
  await build({
    entryPoints: [
      ...["api.server", "stored-epub.server"].map((n) => `src/features/fore/${n}.ts`),
      "src/storefront-strangler/publication-owner-routing.server.ts",
    ],
    splitting: true,
    entryNames: "[name]",
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const { handleCoveApi } = await import(path.join(root, "api.server.mjs"));
  const { validateStoredEpub } = await import(path.join(root, "stored-epub.server.mjs"));
  let env = localBindings(root);
  const db = env.DB;
  const request = (route) => handleCoveApi(new Request("https://cove.test/api/fore" + route), env);
  await request("/catalog");
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
  );
  zip.file(
    "book.opf",
    '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="text" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="text"/></spine></package>',
  );
  zip.file(
    "chapter.xhtml",
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>QA</title></head><body><p>Readable QA text.</p></body></html>',
  );
  const bytes = await zip.generateAsync({ type: "uint8array" });
  await validateStoredEpub(bytes);
  zip.file("chapter.xhtml", "<html><body><p>broken</body></html>");
  // The synthetic transport is deliberately isolated to this QA process.
  // It cannot supply production legal authority or customer purchase rights.
  const { bindPublicationOwner } = await import(
    path.join(root, "publication-owner-routing.server.mjs"),
  );
  const secret = "a".repeat(64);
  const owner = {
    async fetch(request) {
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("authorization"), "Bearer " + secret);
      const pathname = new URL(request.url).pathname;
      const payload = await request.json();
      if (pathname === "/catalog/negative-source") {
        assert.equal(payload.action, "mark-us-retry");
        assert.equal(payload.cacheId, "1342");
        const row = await db
          .prepare("SELECT source_id FROM gutenberg_source_cache WHERE id=?")
          .bind(payload.cacheId)
          .first();
        if (!row || row.source_id !== "pg_us")
          return new Response(null, { status: 409 });
        const outcome = await db
          .prepare(
            "UPDATE gutenberg_source_cache SET epub_status='retry',epub_next_attempt_at='',epub_last_error='Stored EPUB failed validation; repair required.' WHERE id=? AND source_id='pg_us' AND ingest_status<>'quarantined'",
          )
          .bind(payload.cacheId)
          .run();
        return Response.json({
          schema: "cove.owner-catalog-negative-source.v1",
          ownerFirst: true,
          cacheId: payload.cacheId,
          action: payload.action,
          denied: true,
          changed: Number(outcome.meta?.changes || 0) > 0,
        });
      }
      assert.equal(pathname, "/catalog/verified-us-epub-cache");
      const { cacheId, assetVersionId, sha256 } = payload;
      assert.equal(cacheId, "1342");
      const source = await db
        .prepare(
          "SELECT c.id FROM gutenberg_source_cache c JOIN products p ON p.source_external_id=c.id AND p.source_name='gutenberg' JOIN digital_assets da ON da.edition_id=p.edition_id AND da.kind='epub' JOIN asset_versions av ON av.asset_id=da.id WHERE c.id=? AND av.id=? AND c.source_id='pg_us' AND c.copyright=0 AND c.rights_status='public-domain' AND c.commercial_use_status='approved' AND c.ingest_status='active'",
        )
        .bind(cacheId, assetVersionId)
        .first();
      if (!source) return new Response(null, { status: 409 });
      const obj = await env.BUCKET.get("epubs/" + cacheId + ".epub");
      if (!obj || obj.size > 25 * 1024 * 1024)
        return new Response(null, { status: 409 });
      const storedBytes = new Uint8Array(await obj.arrayBuffer());
      await validateStoredEpub(storedBytes);
      const digest = await crypto.subtle.digest("SHA-256", storedBytes);
      const actual = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      if (actual !== sha256) return new Response(null, { status: 409 });
      const at = new Date().toISOString();
      await db.batch([
        db
          .prepare(
            "UPDATE gutenberg_source_cache SET epub_status='completed',epub_cached_at=?,epub_last_error='',epub_next_attempt_at='',content_hash=?,canonicalization_version='pgus-upstream-v1' WHERE id=? AND source_id='pg_us' AND copyright=0 AND rights_status='public-domain' AND commercial_use_status='approved' AND ingest_status='active'",
          )
          .bind(at, sha256, cacheId),
        db
          .prepare(
            "UPDATE asset_versions SET object_key=?,sha256=? WHERE id=? AND EXISTS(SELECT 1 FROM digital_assets da JOIN products p ON p.edition_id=da.edition_id JOIN gutenberg_source_cache c ON c.id=p.source_external_id WHERE da.id=asset_versions.asset_id AND da.kind='epub' AND p.source_name='gutenberg' AND c.id=? AND c.source_id='pg_us' AND c.copyright=0 AND c.rights_status='public-domain' AND c.commercial_use_status='approved' AND c.ingest_status='active')",
          )
          .bind("epubs/" + cacheId + ".epub", sha256, assetVersionId, cacheId),
      ]);
      return Response.json({
        schema: "cove.owner-us-epub-cache.v1",
        ownerFirst: true,
        cacheId,
        assetVersionId,
        sha256,
        saved: true,
      });
    },
  };
  const bad = await zip.generateAsync({ type: "uint8array" });
  await assert.rejects(() => validateStoredEpub(bad), /Invalid EPUB XML/);
  let upstream = bytes,
    fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return new Response(upstream, { headers: { "Content-Type": "application/epub+zip" } });
  };
  await db
    .prepare(
      "UPDATE asset_versions SET object_key=NULL,sha256=NULL WHERE asset_id='asset_epub_gutenberg_1342'",
    )
    .run();
  await env.BUCKET.delete("epubs/1342.epub");
  const beforeOwnerless = await db
    .prepare("SELECT epub_status,content_hash FROM gutenberg_source_cache WHERE id='1342'")
    .first();
  const ownerless = await request("/books/1342/epub");
  assert.equal(ownerless.status, 200, "verified public-US EPUB bytes may be streamed without a canonical write");
  assert.equal((await ownerless.arrayBuffer()).byteLength, bytes.length);
  const unpersisted = await db
    .prepare("SELECT epub_status,content_hash FROM gutenberg_source_cache WHERE id='1342'")
    .first();
  assert.deepEqual(unpersisted, beforeOwnerless,
    "A public read without an owner must never mint or update canonical cache state");
  await env.BUCKET.delete("epubs/1342.epub");
  env = {
    ...env,
    DB: bindPublicationOwner(db, {
      owner,
      secret,
      territory: "US",
      currency: "USD",
    }),
  };
  const first = await request("/books/1342/epub");
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal((await first.arrayBuffer()).byteLength, bytes.length);
  const stored = await db
    .prepare("SELECT epub_status,content_hash FROM gutenberg_source_cache WHERE id='1342'")
    .first();
  assert.equal(stored.epub_status, "completed");
  assert.match(stored.content_hash, /^[a-f0-9]{64}$/);
  const total = fetches;
  assert.equal((await request("/books/1342/epub")).status, 200);
  assert.equal(fetches, total, "verified R2 file avoids upstream I/O");
  await env.BUCKET.put("epubs/1342.epub", new TextEncoder().encode("corrupt"));
  assert.equal(
    (await request("/books/1342/epub")).status,
    200,
    "public stored corruption repairs through validated declared source",
  );
  assert.equal(fetches, total + 1);
  await env.BUCKET.delete("epubs/1342.epub");
  upstream = bad;
  assert.equal(
    (await request("/books/1342/epub")).status,
    502,
    "malformed chapter never becomes a stored success",
  );
  assert.equal(await env.BUCKET.head("epubs/1342.epub"), null);
  await db
    .prepare("UPDATE asset_versions SET object_key=NULL WHERE asset_id='asset_epub_gutenberg_1342'")
    .run();
  await db.prepare("UPDATE gutenberg_source_cache SET epub_status='failed' WHERE id='1342'").run();
  const detail = await (await request("/books/1342")).json();
  assert.equal(detail.readingAvailability.state, "unavailable");
  assert.equal(detail.formats["application/epub+zip"], undefined);
  // The specialized retail view must remain identical to the generic live-rights rules.
  const difference = await db
    .prepare(
      "SELECT product_id,edition_id,territory_code,format,rights_grant_id FROM retail_product_availability EXCEPT SELECT product_id,edition_id,territory_code,format,rights_grant_id FROM product_channel_availability WHERE sales_channel='retail'",
    )
    .all();
  assert.equal(difference.results.length, 0);
  const reverse = await db
    .prepare(
      "SELECT product_id,edition_id,territory_code,format,rights_grant_id FROM product_channel_availability WHERE sales_channel='retail' EXCEPT SELECT product_id,edition_id,territory_code,format,rights_grant_id FROM retail_product_availability",
    )
    .all();
  assert.equal(reverse.results.length, 0);
  const membershipPlan = await db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT p.id FROM products p WHERE p.id=? AND EXISTS(SELECT 1 FROM retail_product_availability_rows rpa WHERE rpa.product_id=p.id AND rpa.territory_code='US')",
    )
    .bind("prd_gutenberg_1342")
    .all();
  assert.ok(
    !membershipPlan.results.some((row) =>
      /CO-ROUTINE retail_product_availability_rows/.test(row.detail),
    ),
    "correlated retail membership must flatten rather than build a catalog-wide rights coroutine",
  );
  const plan = await db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM retail_product_availability WHERE product_id=? AND territory_code='US'",
    )
    .bind("prd_gutenberg_1342")
    .all();
  assert.ok(
    !plan.results.some((r) => /MATERIALIZE effective_grants/.test(r.detail)),
    "single-product eligibility cannot materialize the full grant catalog",
  );
  console.log(
    "PASS: real EPUB delivery, chapter validation, R2 integrity repair, truthful unavailable metadata and equivalent indexable live rights.",
  );
} finally {
  globalThis.fetch = fetchBefore;
  fs.rmSync(root, { recursive: true, force: true });
}
