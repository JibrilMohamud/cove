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
    entryPoints: ["api.server", "stored-epub.server"].map((n) => `src/features/fore/${n}.ts`),
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: root,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  const { handleCoveApi } = await import(path.join(root, "api.server.mjs"));
  const { validateStoredEpub } = await import(path.join(root, "stored-epub.server.mjs"));
  const env = localBindings(root),
    db = env.DB;
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
  const beforeUnboundHydration = await db
    .prepare("SELECT epub_status,content_hash FROM gutenberg_source_cache WHERE id='1342'")
    .first();
  const first = await request("/books/1342/epub");
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal((await first.arrayBuffer()).byteLength, bytes.length);
  const stored = await db
    .prepare("SELECT epub_status,content_hash FROM gutenberg_source_cache WHERE id='1342'")
    .first();
  assert.deepEqual(stored,beforeUnboundHydration,
    "Ownerless public-US EPUB reading must not persist canonical cache or asset authority");
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
